import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, appendFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {main} from '../dist/cli.js';
import {deviceLogin} from '../dist/install.js';
import {openStore} from '../dist/local/store.js';
import {resolveBinding, bindingKey, assertBindingCurrent} from '../dist/local/bindings.js';
import {captureSourcePointer, readSourceRefs, sessionSourceBoundary} from '../dist/agentd/source-index.js';
import {runHookCommand} from '../dist/hook.js';
import {startWriter, sendWriter} from '../dist/local/writer.js';

const uid='10000000-0000-4000-8000-000000000277';
const oldUid='10000000-0000-4000-8000-000000000312';
const token='SYNTHETIC-ACTIVE-DEVICE-TOKEN';
const issuer='https://soul.example';
const identity={you_are:'You are Sophia Ramirez',host:{id:277,nickname:'Sophia Ramirez'},mood:{line:'curious'}};
const key={profile_id:'p1',device_id:'local-device',runtime_kind:'claude-code',native_session_id:'native-session'};
const argv=['--host','277','--agent','claude-code'];
function io(){const out={stdout:'',stderr:''};return {out,stdout:t=>{out.stdout+=t;},stderr:t=>{out.stderr+=t;},stdin:async()=>''};}
async function snapshot(root){const store=await openStore(root,'p1');try{return await store.read();}finally{await store.close();}}
async function fixture(t,{souls=true,credentials=true}={}){
 const home=await mkdtemp(path.join(tmpdir(),'soul-connect-')); const root=path.join(home,'.37soul');
 const previous={home:process.env.SOUL37_HOME,base:process.env.SOUL37_BASE_URL,fetch:globalThis.fetch};
 process.env.SOUL37_HOME=home; delete process.env.SOUL37_BASE_URL;
 t.after(async()=>{globalThis.fetch=previous.fetch;if(previous.home===undefined)delete process.env.SOUL37_HOME;else process.env.SOUL37_HOME=previous.home;if(previous.base===undefined)delete process.env.SOUL37_BASE_URL;else process.env.SOUL37_BASE_URL=previous.base;await rm(home,{recursive:true,force:true});});
 await mkdir(path.join(root,'profiles','p1'),{recursive:true});
 await writeFile(path.join(root,'profiles','p1','device.json'),JSON.stringify({device_id:key.device_id}));
 const store=await openStore(root,'p1');await store.transact(d=>{d.owner_id='owner';d.cloud_device_uid='cloud-device';d.cloud_issuer=issuer;if(souls){for(const [id,name,host] of [[uid,'Sophia Ramirez',277],[oldUid,'Previous Soul',312]]){d.souls[id]={soul_uid:id,legacy_host_id:host,identity:{name,sex:'female',age:28,character:'A curious and thoughtful character.'},identity_revision:1,origin:'cloud'};d.consents[`cloud-device:${id}`]={cloud_device_uid:'cloud-device',soul_uid:id,revision:1,categories:['identity','relationship','experience'],enabled:true};}}});await store.close();
 const config={api_base_url:issuer,machine_id:'machine',active_profile_id:'p1',tokens:{},credentials:credentials?[{issuer,token,owner_id:'owner',cloud_device_uid:'cloud-device',runtime_kind:'claude-code',profile_id:'p1',obtained_at:'2026-11-03T00:00:00Z'}]:[]};
 await writeFile(path.join(root,'config.json'),JSON.stringify(config));await writeFile(path.join(root,'accounts.json'),JSON.stringify({owner:{profile_id:'p1',cloud_issuer:issuer,default_soul_uid:souls?uid:null,soul_sync_mode:'assets_only'}}));
 return {home,root,config};
}
function cloudRead(){globalThis.fetch=async(url,options)=>{assert.equal(url,issuer+'/api/v1/me/hosts/277/soul');assert.equal(options.headers.Authorization,`Bearer ${token}`);assert.equal(options.redirect,'error');assert.ok(options.signal);return new Response(JSON.stringify(identity),{status:200});};}

test('local whoami uses the active runtime credential without OAuth or local mutation',async t=>{
 const {root}=await fixture(t);cloudRead();const before=await readFile(path.join(root,'profiles','p1','snapshot.json'),'utf8');const config=await readFile(path.join(root,'config.json'),'utf8');const output=io();assert.equal(await main(['whoami',...argv],output),0);assert.equal(JSON.parse(output.out.stdout).host.id,277);assert.ok(!output.out.stdout.includes(token));assert.equal(await readFile(path.join(root,'config.json'),'utf8'),config);assert.equal(await readFile(path.join(root,'profiles','p1','snapshot.json'),'utf8'),before);
});
test('local whoami never borrows another runtime or issuer credential',async t=>{
 const {root,config}=await fixture(t);config.credentials[0].runtime_kind='pi';await writeFile(path.join(root,'config.json'),JSON.stringify(config));let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};const output=io();assert.equal(await main(['whoami',...argv],output),1);assert.match(output.out.stderr,/37soul login/);assert.equal(calls,0);assert.ok(!output.out.stderr.includes(token));
});
test('local whoami rejects a cross-server override before sending credentials',async t=>{
 await fixture(t);process.env.SOUL37_BASE_URL='https://foreign.example';let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};const output=io();assert.equal(await main(['whoami',...argv],output),1);assert.equal(calls,0);assert.match(output.out.stderr,/server|issuer/);
});
test('local whoami errors hide response bodies, exceptions and credentials',async t=>{
 await fixture(t);globalThis.fetch=async()=>new Response(JSON.stringify({error:token}),{status:401});const unauthorized=io();assert.equal(await main(['whoami',...argv],unauthorized),1);assert.match(unauthorized.out.stderr,/37soul login/);assert.ok(!unauthorized.out.stderr.includes(token));globalThis.fetch=async()=>{throw Error(token);};const failed=io();assert.equal(await main(['whoami',...argv],failed),1);assert.ok(!failed.out.stderr.includes(token));assert.match(failed.out.stderr,/network|timeout/);
});
test('local whoami rejects invalid host and runtime flags before network',async t=>{
 await fixture(t);let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};for(const args of [['--host','277/escape'],['--host','277','--agent','unknown'],['--host']]){const output=io();assert.equal(await main(['whoami',...args],output),2);}assert.equal(calls,0);
});
test('connect requires exact native-session context, never chooses by cwd or recency',async t=>{
 const {root}=await fixture(t);const before=await snapshot(root);const output=io();assert.equal(await main(['connect',...argv],output),2);assert.match(output.out.stderr,/session/);assert.deepEqual((await snapshot(root)).bindings,before.bindings);
});
test('connect attaches one consented Soul to the exact live native session and is idempotent',async t=>{
 const {root,home}=await fixture(t);cloudRead();const file=path.join(home,'native.jsonl');await writeFile(file,'old transcript must stay behind the boundary\n');await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'claude-code',native_session_id:key.native_session_id,path:file,captured_at:new Date().toISOString()});
 const first=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],first),0,first.out.stderr);const snap=await snapshot(root);const binding=snap.bindings[bindingKey(key)];assert.equal(binding.soul_uid,uid);assert.equal(JSON.parse(first.out.stdout).connection.state,'attached');assert.ok(binding.source_boundary.start_offset>0);assert.ok(!JSON.stringify(snap.outbox).includes(file));assert.ok(!JSON.stringify(snap.outbox).includes(key.native_session_id));
 const second=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],second),0,second.out.stderr);assert.equal((await snapshot(root)).bindings[bindingKey(key)].binding_uid,binding.binding_uid);
});
test('connect switches an injected session without assigning old jobs or source to the new Soul',async t=>{
 const {root,home}=await fixture(t);cloudRead();const old=await resolveBinding(key,oldUid,{root});const store=await openStore(root,'p1');await store.transact(d=>{d.receipts.test={binding_uid:old.binding_uid,binding_revision:old.revision,stage:'injected'};});await store.close();
 const file=path.join(home,'native.jsonl');await writeFile(file,'old soul history\n');const boundary=(await readFile(file)).length;await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'claude-code',native_session_id:key.native_session_id,path:file,captured_at:new Date().toISOString()});const output=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],output),0,output.out.stderr);const current=(await snapshot(root)).bindings[bindingKey(key)];assert.notEqual(current.binding_uid,old.binding_uid);assert.equal(current.source_boundary.start_offset,boundary);await assert.rejects(assertBindingCurrent(key,old.binding_uid,old.revision,{root}));
 await appendFile(file,'new soul history\n');const ref=randomUUID();const writer=await startWriter(root);try{const event={key,event_ref:ref,kind:'request',internal_job_uid:null};assert.ok((await sendWriter(root,{request_uid:randomUUID(),profile_id:'p1',command:'runtime_event',payload:{event,source_path:file}})).ok);assert.equal(await readSourceRefs(root,[ref]),'new soul history\n');}finally{await writer.close();}
});
test('connect refuses a Soul without identity consent instead of silently authorizing it',async t=>{
 const {root,home}=await fixture(t);cloudRead();const file=path.join(home,'revoked-session.jsonl');await writeFile(file,'session source\n');await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'claude-code',native_session_id:key.native_session_id,path:file,captured_at:new Date().toISOString()});const store=await openStore(root,'p1');await store.transact(d=>{for(const consent of Object.values(d.consents))consent.enabled=false;});await store.close();const output=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],output),1);assert.match(output.out.stderr,/login --host 277|consent/);assert.deepEqual((await snapshot(root)).bindings,{});
});
test('hook gives an unbound existing session an exact local attachment command',async t=>{
 const {root,home}=await fixture(t,{souls:false});const writer=await startWriter(root);try{let stdout='';await runHookCommand({home,agentKind:'claude-code',event:'UserPromptSubmit',fetch:globalThis.fetch,stdin:JSON.stringify({session_id:key.native_session_id,prompt:'connect Sophia',cwd:home}),stdout:t=>{stdout+=t;},stderr:()=>{}});const context=JSON.parse(stdout).hookSpecificOutput;assert.equal(context.hookEventName,'UserPromptSubmit');assert.match(context.additionalContext,/37soul connect/);assert.match(context.additionalContext,/--agent claude-code/);assert.match(context.additionalContext,/--session 'native-session'/);assert.ok(!stdout.includes(token));}finally{await writer.close();}
});
test('targeted device login preserves code and pins the requested host in the approval URL',async()=>{
 const logs=[];const opened=[];const result=await deviceLogin({apiBase:issuer,fetch:async url=>new Response(JSON.stringify(url.endsWith('device_codes')?{device_code:'device-secret',user_code:'CODE',verification_url:issuer+'/cli/approve?code=CODE'}:{tokens:[{agent_kind:'claude-code',token}],owner_id:'owner',default_soul_uid:uid}),{status:url.endsWith('device_codes')?201:201}),runCommand:async args=>{opened.push(args);return {code:0,stdout:'',stderr:''};},platform:'darwin',log:s=>logs.push(s)},['claude-code'],{assetsMode:true,machineId:'machine',hostId:277});assert.equal(result.default_soul_uid,uid);const approval=new URL(opened[0][1]);assert.equal(approval.searchParams.get('host_id'),'277');assert.equal(approval.searchParams.get('code'),'CODE');assert.ok(!logs.join('').includes(token));
});

test('connect refuses missing source context without changing existing session bindings',async t=>{
 const {root}=await fixture(t);cloudRead();const before=await resolveBinding(key,oldUid,{root});const output=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],output),1);assert.match(output.out.stderr,/hook source context/);assert.equal((await snapshot(root)).bindings[bindingKey(key)].binding_uid,before.binding_uid);
});
test('a replaced transcript cannot cross an attached session source boundary',async t=>{
 const {root,home}=await fixture(t);cloudRead();const file=path.join(home,'native.jsonl');await writeFile(file,'private old history\n');await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'claude-code',native_session_id:key.native_session_id,path:file,captured_at:new Date().toISOString()});assert.equal(await main(['connect',...argv,'--session',key.native_session_id],io()),0);
 const boundary=(await snapshot(root)).bindings[bindingKey(key)].source_boundary;await writeFile(path.join(home,'replacement'),'replacement history must not be extracted\n');const {rename}=await import('node:fs/promises');await rename(path.join(home,'replacement'),file);const ref=randomUUID();await captureSourcePointer(root,'p1',ref,{runtime_kind:'claude-code',native_session_id:key.native_session_id,path:file,captured_at:new Date().toISOString(),source_boundary:boundary});assert.equal(await readSourceRefs(root,[ref]),'');
});
test('targeted login does not report connection-ready when no Soul was approved',async t=>{
 await fixture(t,{souls:false});globalThis.fetch=async url=>{const endpoint=String(url);if(endpoint.endsWith('device_codes'))return new Response(JSON.stringify({device_code:'synthetic-device',user_code:'TEST',verification_url:issuer+'/cli/approve?code=TEST'}),{status:201});if(endpoint.endsWith('/tokens'))return new Response(JSON.stringify({protocol:'soul-assets/v1',mode:'assets_only',owner_id:'owner',cloud_device_uid:'cloud-device',tokens:[{agent_kind:'claude-code',token}]}),{status:201});return new Response(JSON.stringify({protocol:'soul-assets/v1',events:[],next_cursor:null,has_more:false}),{status:200});};const output=io();const {loginCommand}=await import('../dist/cli.js');assert.equal(await loginCommand(path.join(process.env.SOUL37_HOME,'.37soul'),['--host','277'],output,{apiBase:issuer,fetch:globalThis.fetch,runCommand:async()=>({code:0,stdout:'',stderr:''}),openBrowser:false,log:()=>{}}),1);assert.match(output.out.stderr,/Account authorized.*277.*not ready/);assert.ok(!output.out.stdout.includes('Soul restored'));
});

test('same-Soul reconnect recovers a compacted source without reading the previous transcript',async t=>{
 const {root,home}=await fixture(t);cloudRead();const file=path.join(home,'native.jsonl');await writeFile(file,'old history\n');await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'claude-code',native_session_id:key.native_session_id,path:file,captured_at:new Date().toISOString()});assert.equal(await main(['connect',...argv,'--session',key.native_session_id],io()),0);const before=(await snapshot(root)).bindings[bindingKey(key)];const replacement=path.join(home,'compacted.jsonl');await writeFile(replacement,'compacted old content\n');
 const ref=randomUUID();const writer=await startWriter(root);try{const result=await sendWriter(root,{request_uid:randomUUID(),profile_id:'p1',command:'runtime_event',payload:{event:{key,event_ref:ref,kind:'turn_completed',internal_job_uid:null},source_path:replacement}});assert.equal(result.result.reason,'source_boundary_unavailable');assert.equal(Object.keys((await snapshot(root)).extraction_watermarks).length,0);}finally{await writer.close();}
 const output=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],output),0,output.out.stderr);const after=(await snapshot(root)).bindings[bindingKey(key)];assert.notEqual(after.binding_uid,before.binding_uid);assert.equal(after.source_boundary.path,replacement);assert.equal(after.source_boundary.start_offset,Buffer.byteLength('compacted old content\n'));
});

test('rewriting a transcript in place cannot reuse an old byte boundary',async t=>{
 const {root,home}=await fixture(t);cloudRead();const file=path.join(home,'native.jsonl');await writeFile(file,'old history\n');await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'claude-code',native_session_id:key.native_session_id,path:file,captured_at:new Date().toISOString()});assert.equal(await main(['connect',...argv,'--session',key.native_session_id],io()),0);const boundary=(await snapshot(root)).bindings[bindingKey(key)].source_boundary;await writeFile(file,'rewritten compressed history that exceeds the previous byte position\n');const ref=randomUUID();await captureSourcePointer(root,'p1',ref,{runtime_kind:'claude-code',native_session_id:key.native_session_id,path:file,captured_at:new Date().toISOString(),source_boundary:boundary});assert.equal(await readSourceRefs(root,[ref]),'');
});

test('Gemini BeforeAgent and Cursor sessionStart use their native context envelopes',async t=>{
 const {root,home}=await fixture(t,{souls:false});const writer=await startWriter(root);try{for(const [kind,event,payload] of [['gemini-cli','UserPromptSubmit',{session_id:'gemini-session',prompt:'hello'}],['cursor','SessionStart',{conversation_id:'cursor-session',hook_event_name:'sessionStart'}]]){let stdout='';await runHookCommand({home,agentKind:kind,event,fetch:globalThis.fetch,stdin:JSON.stringify(payload),stdout:s=>{stdout+=s;},stderr:()=>{}});const output=JSON.parse(stdout);if(kind==='gemini-cli')assert.equal(output.hookSpecificOutput.hookEventName,'BeforeAgent');else{assert.match(output.additional_context,/--agent cursor/);assert.equal(output.hookSpecificOutput,undefined);}}}finally{await writer.close();}
});
test('unknown native session identity never produces a guessed attachment hint',async t=>{
 const {root,home}=await fixture(t,{souls:false});const writer=await startWriter(root);try{let stdout='';await runHookCommand({home,agentKind:'gemini-cli',event:'UserPromptSubmit',fetch:globalThis.fetch,stdin:JSON.stringify({prompt:'hello'}),stdout:s=>{stdout+=s;},stderr:()=>{}});assert.equal(stdout,'');}finally{await writer.close();}
});

test('whoami refuses revoked per-Soul identity consent before any identity request',async t=>{
 const {root}=await fixture(t);const store=await openStore(root,'p1');await store.transact(d=>{d.consents[`cloud-device:${uid}`].enabled=false;});await store.close();let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify(identity));};const output=io();assert.equal(await main(['whoami',...argv],output),1);assert.match(output.out.stderr,/revoked|disabled/);assert.equal(calls,0);assert.equal(output.out.stdout,'');
});
test('whoami identity-only consent cannot expose relationship or work-derived directives',async t=>{
 const {root}=await fixture(t);const store=await openStore(root,'p1');await store.transact(d=>{d.consents[`cloud-device:${uid}`].categories=['identity'];});await store.close();globalThis.fetch=async()=>new Response(JSON.stringify({...identity,relationship:{facts:['PRIVATE-RELATIONSHIP']},recent_work:'PRIVATE-WORK',upcoming:[{bring_back:'PRIVATE-RELATIONSHIP'}],directive:{instruction:'PRIVATE-RELATIONSHIP'}}));const output=io();assert.equal(await main(['whoami',...argv],output),0);assert.ok(!output.out.stdout.includes('PRIVATE-'));assert.equal(JSON.parse(output.out.stdout).host.id,277);
});
test('a concurrent active-account switch cannot acknowledge attachment to the previous profile',async t=>{
 const {root,home,config}=await fixture(t);const file=path.join(home,'native.jsonl');await writeFile(file,'history\n');await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'claude-code',native_session_id:key.native_session_id,path:file,captured_at:new Date().toISOString()});globalThis.fetch=async()=>{config.active_profile_id='changed-profile';await writeFile(path.join(root,'config.json'),JSON.stringify(config));return new Response(JSON.stringify(identity));};const output=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],output),1);assert.match(output.out.stderr,/active.*profile|account.*changed/i);assert.ok(!output.out.stdout.includes('attached'));assert.deepEqual((await snapshot(root)).bindings,{});
});
test('revoked Soul content stays suppressed while its native session can recover to another Soul',async t=>{
 const {root,home}=await fixture(t);await resolveBinding(key,uid,{root});const store=await openStore(root,'p1');await store.transact(d=>{d.consents[`cloud-device:${uid}`].enabled=false;});await store.close();const writer=await startWriter(root);try{let stdout='';await runHookCommand({home,agentKind:'claude-code',event:'UserPromptSubmit',fetch:globalThis.fetch,stdin:JSON.stringify({session_id:key.native_session_id,prompt:'switch to another approved Soul'}),stdout:s=>{stdout+=s;},stderr:()=>{}});const context=JSON.parse(stdout).hookSpecificOutput.additionalContext;assert.match(context,/--session 'native-session'/);assert.ok(!context.includes('Sophia'));assert.ok(!context.includes('[Soul]'));}finally{await writer.close();}
});

test('whoami rechecks identity consent after a pending server response',async t=>{
 const {root}=await fixture(t);globalThis.fetch=async()=>{const store=await openStore(root,'p1');await store.transact(d=>{d.consents[`cloud-device:${uid}`].enabled=false;});await store.close();return new Response(JSON.stringify(identity));};const output=io();assert.equal(await main(['whoami',...argv],output),1);assert.equal(output.out.stdout,'');assert.match(output.out.stderr,/revoked|disabled/);
});
test('whoami filters using categories narrowed while identity response was pending',async t=>{
 const {root}=await fixture(t);globalThis.fetch=async()=>{const store=await openStore(root,'p1');await store.transact(d=>{d.consents[`cloud-device:${uid}`].categories=['identity'];});await store.close();return new Response(JSON.stringify({...identity,relationship:{facts:['PRIVATE-AFTER-REVOKE']},recent_work:'PRIVATE-WORK-AFTER-REVOKE',upcoming:[{bring_back:'PRIVATE-AFTER-REVOKE'}]}));};const output=io();assert.equal(await main(['whoami',...argv],output),0);assert.ok(!output.out.stdout.includes('PRIVATE-'));assert.equal(JSON.parse(output.out.stdout).host.id,277);
});

async function firstMessageHook(home, root, file, nativeSession = key.native_session_id) {
 const writer = await startWriter(root);
 try {
  let output = '';
  await runHookCommand({home, agentKind:'claude-code', event:'UserPromptSubmit', stdin:JSON.stringify({session_id:nativeSession, transcript_path:file, prompt:'Connect the explicitly chosen Soul'}), stdout:t=>output+=t, stderr:()=>{}, fetch:async()=>{throw Error('hook must stay local');}});
  assert.match(output, /37soul connect/);
 } finally { await writer.close(); }
}

test('first-message: native transcript created after the first hook still permits connect in the same turn', async t => {
 const {root,home}=await fixture(t);cloudRead();
 const file=path.join(home,'not-created-until-after-hook.jsonl');
 await firstMessageHook(home,root,file);
 assert.equal(await sessionSourceBoundary(root,key),null,'an absent file is not yet usable');
 assert.equal(Object.keys((await snapshot(root)).extraction_watermarks).length,0);
 const prefix='first user request and tool trace before explicit attachment\n';
 await writeFile(file,prefix);
 const result=io();
 assert.equal(await main(['connect',...argv,'--session',key.native_session_id],result),0,result.out.stderr);
 const binding=(await snapshot(root)).bindings[bindingKey(key)];
 assert.equal(binding.soul_uid,uid);
 assert.equal(binding.source_boundary.start_offset,Buffer.byteLength(prefix),'capture the actual connect-time cutoff, never replay earlier content');
 assert.equal(JSON.parse(result.out.stdout).connection.state,'attached');
 assert.ok(!result.out.stdout.includes(token));
});

test('first-message: a prospective source never guesses another native session or an absent file', async t => {
 const {root,home}=await fixture(t);cloudRead();
 const file=path.join(home,'still-absent.jsonl');
 await firstMessageHook(home,root,file);
 const other=path.join(home,'other-session.jsonl');await writeFile(other,'different session private history\n');
 await firstMessageHook(home,root,other,'different-native-session');
 const result=io();
 assert.equal(await main(['connect',...argv,'--session',key.native_session_id],result),1);
 assert.match(result.out.stderr,/hook source context/);
 assert.equal(Object.keys((await snapshot(root)).extraction_watermarks).length,0);
});

test('prospective source: a newer native file hint prevents attachment to an older transcript', async t => {
 const {root,home}=await fixture(t);cloudRead();
 const previous=path.join(home,'old-source.jsonl');await writeFile(previous,'old source must not be chosen\n');
 await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:key.runtime_kind,native_session_id:key.native_session_id,path:previous,captured_at:'2026-11-01T00:00:00.000Z'});
 const next=path.join(home,'new-source-created-later.jsonl');
 await firstMessageHook(home,root,next);
 const absent=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],absent),1,'do not silently use an older source while the new native source is missing');
 await writeFile(next,'new native source\n');
 const ready=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],ready),0,ready.out.stderr);
 assert.equal((await snapshot(root)).bindings[bindingKey(key)].source_boundary.path,next);
});

test('first-message: pending source metadata never copies extra event-key conversation fields', async t => {
 const {root,home}=await fixture(t);const writer=await startWriter(root);
 try {
  const result=await sendWriter(root,{request_uid:randomUUID(),profile_id:'p1',command:'runtime_event',payload:{event:{key:{...key,raw_conversation:'SYNTHETIC-RAW-KEY-CANARY'},event_ref:randomUUID(),kind:'request',internal_job_uid:null},source_path:path.join(home,'later.jsonl')}});
  assert.equal(result.ok,true);
  const dir=path.join(root,'session-source-hints','p1');const files=await readdir(dir);
  assert.equal(files.length,1);
  const saved=await readFile(path.join(dir,files[0]),'utf8');
  assert.ok(!saved.includes('SYNTHETIC-RAW-KEY-CANARY'),'only known path/session metadata may be saved');
  assert.equal(Object.keys((await snapshot(root)).extraction_watermarks).length,0);
 } finally {await writer.close();}
});

test('first-message: a later valid native source retires a same-millisecond pending path', async t => {
 const {root,home}=await fixture(t);cloudRead();
 const NativeDate=globalThis.Date, fixed=NativeDate.now();
 globalThis.Date=class extends NativeDate {constructor(...args){if(args.length)super(...args);else super(fixed);}static now(){return fixed;}};
 const writer=await startWriter(root);
 const emit=async file=>{const response=await sendWriter(root,{request_uid:randomUUID(),profile_id:'p1',command:'runtime_event',payload:{event:{key,event_ref:randomUUID(),kind:'request',internal_job_uid:null},source_path:file}});assert.equal(response.ok,true);};
 try {
  const pending=path.join(home,'earlier-pending.jsonl'), current=path.join(home,'later-current.jsonl');
  await emit(pending);await writeFile(current,'CURRENT SOURCE\n');await emit(current);
  const result=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],result),0,result.out.stderr);
  assert.equal((await snapshot(root)).bindings[bindingKey(key)].source_boundary.path,current);
  await writeFile(pending,'LATE SUPERSEDED SOURCE\n');
  const again=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],again),0,again.out.stderr);
  assert.equal((await snapshot(root)).bindings[bindingKey(key)].source_boundary.path,current,'a superseded pending path cannot resurrect when it appears later');
 } finally {globalThis.Date=NativeDate;await writer.close();}
});
