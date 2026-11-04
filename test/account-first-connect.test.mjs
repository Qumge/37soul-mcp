import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {main,loginCommand} from '../dist/cli.js';
import {openStore} from '../dist/local/store.js';
import {captureSourcePointer} from '../dist/agentd/source-index.js';
const base='https://account.example';
const token='SYNTHETIC-ACCOUNT-FIRST-TOKEN';
const roles=[{id:277,nickname:'Sophia Ramirez',soul_uid:'10000000-0000-4000-8000-000000000277'},{id:278,nickname:'Nyx',soul_uid:'10000000-0000-4000-8000-000000000278'}];
const flags=['--agent','claude-code','--session','current-session'];
function output(){const out={stdout:'',stderr:''};return {out,stdout:s=>out.stdout+=s,stderr:s=>out.stderr+=s,stdin:async()=>''};}
async function read(root){const s=await openStore(root,'p1');try{return await s.read();}finally{await s.close();}}
async function fixture(t){
 const home=await mkdtemp(path.join(tmpdir(),'account-first-'));const root=path.join(home,'.37soul');const previous={home:process.env.SOUL37_HOME,base:process.env.SOUL37_BASE_URL,fetch:globalThis.fetch};process.env.SOUL37_HOME=home;delete process.env.SOUL37_BASE_URL;
 t.after(async()=>{globalThis.fetch=previous.fetch;for(const [name,value] of [['SOUL37_HOME',previous.home],['SOUL37_BASE_URL',previous.base]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}await rm(home,{recursive:true,force:true});});
 await mkdir(path.join(root,'profiles','p1'),{recursive:true});await writeFile(path.join(root,'profiles','p1','device.json'),JSON.stringify({device_id:'device'}));const store=await openStore(root,'p1');await store.transact(d=>{d.owner_id='owner';d.cloud_device_uid='cloud-device';d.cloud_issuer=base;});await store.close();
 const config={api_base_url:base,machine_id:'device',active_profile_id:'p1',tokens:{},credentials:[{issuer:base,token,owner_id:'owner',cloud_device_uid:'cloud-device',runtime_kind:'claude-code',profile_id:'p1'}]};await writeFile(path.join(root,'config.json'),JSON.stringify(config));await writeFile(path.join(root,'accounts.json'),JSON.stringify({owner:{profile_id:'p1',cloud_issuer:base,default_soul_uid:null,soul_sync_mode:'assets_only'}}));
 const file=path.join(home,'native.jsonl');await writeFile(file,'history before the choice\n');await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'claude-code',native_session_id:'current-session',path:file,captured_at:new Date().toISOString()});
 const calls=[];const selected=new Set();const consent=r=>({cloud_device_uid:'cloud-device',soul_uid:r.soul_uid,revision:1,categories:['identity','relationship','experience'],enabled:true});
 const soul=r=>({soul_uid:r.soul_uid,legacy_host_id:r.id,identity_revision:1,identity:{name:r.nickname,character:'Curious and considerate.',description:'',greeting:''},state:'active',avatar_url:'https://example.org/photo.webp'});
 const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
 globalThis.fetch=async(url,options={})=>{
  const u=new URL(url);calls.push({path:u.pathname,query:u.searchParams,method:options.method??'GET'});
  if(u.pathname.endsWith('/device_codes'))return response({device_code:'synthetic-code',user_code:'TEST',verification_url:base+'/cli/approve?code=TEST'},201);
  if(u.pathname.endsWith('/tokens'))return response({protocol:'soul-assets/v1',mode:'assets_only',owner_id:'owner',cloud_device_uid:'cloud-device',default_soul_uid:null,tokens:[{agent_kind:'claude-code',token}]},201);
  assert.equal((options.headers.Authorization??options.headers.authorization),`Bearer ${token}`);assert.equal(options.redirect,'error');
  if(u.pathname==='/api/v1/me/hosts'){let found=roles;if(u.searchParams.has('name'))found=found.filter(r=>r.nickname.toLowerCase()===u.searchParams.get('name').trim().toLowerCase());if(u.searchParams.has('host_id'))found=found.filter(r=>r.id===Number(u.searchParams.get('host_id')));return response({hosts:found,pagination:{total:found.length,limit:50,offset:0,has_more:false}});}
  const r=roles.find(r=>u.pathname.startsWith(`/api/v1/me/hosts/${r.id}/`));
  if(r&&u.pathname.endsWith('/connection')){selected.add(r.id);return response({protocol:'soul-assets/v1',host_id:r.id,soul_uid:r.soul_uid,consent:consent(r),replay_from:'0'});}
  if(r&&u.pathname.endsWith('/soul'))return response({you_are:`You are ${r.nickname}`,host:{id:r.id,nickname:r.nickname}});
  if(u.pathname.includes('/soul_sync/'))return response({protocol:'soul-assets/v1',events:roles.filter(r=>selected.has(r.id)).flatMap(r=>[{event_uid:`c${r.id}`,object_type:'consent',object:consent(r)},{event_uid:`s${r.id}`,object_type:'soul',object:soul(r)}]),next_cursor:'2',has_more:false});
  throw Error('Unexpected endpoint');
 };
 return {home,root,config,calls,selected,response,consent,soul};
}

test('account-only login is complete without choosing or downloading a Soul',async t=>{
 const f=await fixture(t);const out=output();assert.equal(await loginCommand(f.root,[],out,{apiBase:base,fetch:globalThis.fetch,openBrowser:false,runCommand:async()=>({code:0,stdout:'',stderr:''}),log:()=>{}}),0);assert.match(out.out.stdout,/Account ready|choose.*Agent|37soul hosts/i);assert.ok(!out.out.stderr.includes('login --host'));assert.equal(Object.keys((await read(f.root)).souls).length,0);assert.equal(f.selected.size,0);
});
test('one account login exposes every owned Soul directory entry without selecting any',async t=>{
 const f=await fixture(t);const before=await readFile(path.join(f.root,'profiles','p1','snapshot.json'),'utf8');const out=output();assert.equal(await main(['hosts'],out),0,out.out.stderr);assert.deepEqual(JSON.parse(out.out.stdout).hosts.map(r=>r.id),[277,278]);assert.equal(f.selected.size,0);assert.equal(await readFile(path.join(f.root,'profiles','p1','snapshot.json'),'utf8'),before);assert.ok(!out.out.stdout.includes(token));
});
test('a named first connection selects and restores only Sophia using the existing account credential',async t=>{
 const f=await fixture(t);const out=output();assert.equal(await main(['connect','--name','Sophia Ramirez',...flags],out),0,out.out.stderr);const identity=JSON.parse(out.out.stdout);assert.equal(identity.host.id,277);assert.equal(identity.connection.state,'attached');const snap=await read(f.root);assert.deepEqual(Object.keys(snap.souls),[roles[0].soul_uid]);assert.equal(Object.values(snap.bindings)[0].soul_uid,roles[0].soul_uid);assert.deepEqual([...f.selected],[277]);assert.equal(f.calls.filter(c=>c.path.endsWith('/device_codes')).length,0);assert.equal(Object.values(snap.outbox).filter(op=>op.operation_kind==='register_soul').length,0);assert.ok(!out.out.stdout.includes(token));
});
test('the same login can switch to another owned Soul without another browser authorization',async t=>{
 const f=await fixture(t);for(const name of ['Sophia Ramirez','Nyx']){const out=output();assert.equal(await main(['connect','--name',name,...flags],out),0,out.out.stderr);}const snap=await read(f.root);assert.equal(Object.values(snap.bindings)[0].soul_uid,roles[1].soul_uid);assert.equal(Object.keys(snap.souls).length,2);assert.equal(f.calls.filter(c=>c.path.endsWith('/tokens')||c.path.endsWith('/device_codes')).length,0);
});
test('duplicate names require an explicit Host ID, never choosing the first directory row',async t=>{
 const f=await fixture(t);globalThis.fetch=async()=>f.response({hosts:[roles[0],{...roles[1],nickname:'Sophia Ramirez'}],pagination:{total:2,has_more:false}});const out=output();assert.equal(await main(['connect','--name','Sophia Ramirez',...flags],out),1);assert.match(out.out.stderr,/multiple|ambiguous|more than one/i);assert.match(out.out.stderr,/277/);assert.match(out.out.stderr,/278/);assert.deepEqual((await read(f.root)).bindings,{});
});
test('an unknown name cannot create a replacement Soul or change current bindings',async t=>{
 const f=await fixture(t);const out=output();assert.equal(await main(['connect','--name','Missing Person',...flags],out),1);assert.match(out.out.stderr,/no.*Soul|not found/i);assert.equal(f.selected.size,0);assert.deepEqual((await read(f.root)).bindings,{});
});
test('a plain identity read never grants consent for an unselected Soul',async t=>{
 const f=await fixture(t);const out=output();assert.equal(await main(['whoami','--host','277','--agent','claude-code'],out),1);assert.equal(f.selected.size,0);assert.equal(f.calls.length,0);assert.deepEqual((await read(f.root)).souls,{});assert.match(out.out.stderr,/37soul connect/);assert.ok(!out.out.stderr.includes('login --host'));
});
test('first connection refuses locally revoked target consent even when its identity cache is absent',async t=>{
 const f=await fixture(t);const store=await openStore(f.root,'p1');await store.transact(d=>{d.consents[`cloud-device:${roles[0].soul_uid}`]={...f.consent(roles[0]),enabled:false,revision:3,categories:[]};});await store.close();const out=output();assert.equal(await main(['connect','--name','Sophia Ramirez',...flags],out),1);assert.match(out.out.stderr,/revoked|disabled|consent/i);assert.equal(f.selected.size,0);
});
test('first connection does not guess a native session or grant consent without one',async t=>{
 const f=await fixture(t);const out=output();assert.equal(await main(['connect','--name','Sophia Ramirez'],out),2);assert.match(out.out.stderr,/session/);assert.equal(f.calls.length,0);assert.equal(f.selected.size,0);
});
test('owner directory errors never expose credential-bearing response or exception bodies',async t=>{
 await fixture(t);globalThis.fetch=async()=>{throw Error(token);};const out=output();assert.equal(await main(['hosts'],out),1);assert.ok(!out.out.stderr.includes(token));assert.match(out.out.stderr,/network|timeout/);
});

test('retrying an interrupted first restore keeps the pull checkpoint instead of restarting forever',async t=>{
 const f=await fixture(t);const original=globalThis.fetch;let failPull=true;let resumedCursor;
 globalThis.fetch=async(url,init)=>{const parsed=new URL(url);if(parsed.pathname.endsWith('/pull')){if(failPull)return f.response({error:'temporary'},503);resumedCursor=parsed.searchParams.get('cursor');}return original(url,init);};
 assert.equal(await main(['connect','--name','Sophia Ramirez',...flags],output()),1);
 const store=await openStore(f.root,'p1');await store.transact(d=>{d.pull_cursor='resume-42';});await store.close();
 failPull=false;const out=output();assert.equal(await main(['connect','--name','Sophia Ramirez',...flags],out),0,out.out.stderr);assert.equal(resumedCursor,'resume-42');
});

test('Codex connects a chosen Soul from its native environment without any hook or source pointer',async t=>{
 const f=await fixture(t);const old=process.env.CODEX_THREAD_ID;const sid='10000000-0000-4000-8000-000000000001';process.env.CODEX_THREAD_ID=sid;
 t.after(()=>{if(old===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=old;});
 f.config.credentials[0].runtime_kind='codex';await writeFile(path.join(f.root,'config.json'),JSON.stringify(f.config));
 const dir=path.join(f.home,'.codex','sessions','2026','11','04');await mkdir(dir,{recursive:true});const file=path.join(dir,`rollout-test-${sid}.jsonl`);
 await writeFile(file,JSON.stringify({type:'session_meta',payload:{id:sid}})+'\n');
 const out=output();assert.equal(await main(['connect','--name','Sophia Ramirez'],out),0,out.out.stderr);
 assert.equal(JSON.parse(out.out.stdout).connection.state,'attached');const b=Object.values((await read(f.root)).bindings).find(x=>!x.retired);assert.equal(b.native_session_id,sid);assert.equal(b.source_boundary.path,file);assert.equal(b.source_mode,'codex-native');assert.equal(b.codex_cursor.offset,b.source_boundary.start_offset);
 const before=f.calls.length;const context=output();assert.equal(await main(['context'],context),0,context.out.stderr);assert.match(context.out.stdout,/Sophia Ramirez/);assert.equal(f.calls.length,before,'context restoration stays local');
});

test('Codex native ID conflicts cannot select another session or grant consent',async t=>{
 const f=await fixture(t);const old=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID='10000000-0000-4000-8000-000000000001';
 t.after(()=>{if(old===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=old;});
 for(const agent of ['codex','claude-code']){const out=output();assert.notEqual(await main(['connect','--host','277','--agent',agent,'--session','10000000-0000-4000-8000-000000000002'],out),0);assert.match(out.out.stderr,/conflict|does not match/i);}assert.equal(f.calls.length,0);assert.equal(f.selected.size,0);
});
