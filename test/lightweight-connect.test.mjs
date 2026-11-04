import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, appendFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {main} from '../dist/cli.js';
import {runDoctor} from '../dist/doctor.js';
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


const rich={...identity,host:{...identity.host,sex:'female',age:28,character:'Curious, practical and thoughtful.'},photos:[{url:'https://example.test/photo'}],videos:[{url:'https://example.test/video'}],upcoming:[{content:'x'.repeat(2000)}],circle:[{nickname:'friend'}],guidance:'x'.repeat(3000),directive:'Continue the user task.'};
async function source(root,home){const file=path.join(home,'native.jsonl');await writeFile(file,'native source\n');await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'claude-code',native_session_id:key.native_session_id,path:file,captured_at:new Date().toISOString()});}
test('lightweight connect: attached output retains persona and mood but omits media and long feed',async t=>{
 const {root,home}=await fixture(t);await source(root,home);globalThis.fetch=async()=>new Response(JSON.stringify(rich));const output=io();assert.equal(await main(['connect',...argv,'--session',key.native_session_id],output),0,output.out.stderr);const result=JSON.parse(output.out.stdout);assert.equal(result.connection.state,'attached');assert.equal(result.host.id,277);assert.equal(result.you_are,identity.you_are);assert.equal(result.mood.line,'curious');assert.match(result.guidance,/first.person/i);for(const k of ['photos','videos','upcoming','circle','thread'])assert.ok(!(k in result));assert.ok(Buffer.byteLength(output.out.stdout)<2500);
});
test('lightweight connect: read-only whoami still returns the full detailed identity',async t=>{await fixture(t);globalThis.fetch=async()=>new Response(JSON.stringify(rich));const output=io();assert.equal(await main(['whoami',...argv],output),0);assert.ok(JSON.parse(output.out.stdout).photos.length===1);});
test('lightweight connect: cached exact-name target overlaps live directory and identity reads without skipping either authority check',async t=>{
 const {root,home}=await fixture(t);await source(root,home);let release,seenResolve;const gate=new Promise(r=>release=r),seen=new Promise(r=>seenResolve=r);const calls=[];
 globalThis.fetch=async url=>{calls.push(String(url));if(calls.length===2)seenResolve();await gate;return new URL(String(url)).pathname.endsWith('/soul')?new Response(JSON.stringify(rich)):new Response(JSON.stringify({hosts:[{id:277,nickname:'Sophia Ramirez',soul_uid:uid}],pagination:{total:1,has_more:false}}));};
 const output=io(),running=main(['connect','--name','Sophia Ramirez','--agent','claude-code','--session',key.native_session_id],output);let timer;const overlapping=await Promise.race([seen.then(()=>true),new Promise(r=>timer=setTimeout(()=>r(false),400))]);clearTimeout(timer);release();const code=await running;assert.equal(code,0,output.out.stderr);assert.equal(overlapping,true,'two independent live reads should start before either response');assert.equal(calls.length,2);assert.equal(JSON.parse(output.out.stdout).connection.state,'attached');
});
test('lightweight connect: parallel identity success cannot bypass an ambiguous directory',async t=>{
 const {root,home}=await fixture(t);await source(root,home);globalThis.fetch=async url=>new URL(String(url)).pathname.endsWith('/soul')?new Response(JSON.stringify(rich)):new Response(JSON.stringify({hosts:[{id:277,nickname:'Sophia Ramirez',soul_uid:uid},{id:312,nickname:'Sophia Ramirez',soul_uid:oldUid}],pagination:{total:2,has_more:false}}));const output=io();assert.equal(await main(['connect','--name','Sophia Ramirez','--agent','claude-code','--session',key.native_session_id],output),1);assert.equal(output.out.stdout,'');assert.equal(Object.keys((await snapshot(root)).bindings).length,0);assert.match(output.out.stderr,/Multiple/);
});
test('lightweight doctor: local resource deferrals are visible without exposing memory or claiming billed fees',async t=>{
 const {root,home}=await fixture(t);const store=await openStore(root,'p1');await store.transact(d=>{d.extraction_usage={[new Date().toISOString().slice(0,10)]:{calls:40,reserved_units:12345,sessions:{}}};d.extraction_watermarks.pending={completed:false,attempts:0,state:'pending',last_error:null,request:{job_uid:'j',runtime_kind:'claude-code',native_session_id:'native',source_event_refs:['e'],binding_uid:'missing',binding_revision:1,soul_uid:uid,internal_task:true}};});await store.close();const report=await runDoctor({home,apiBase:issuer,fetch:async()=>{throw Error('no network');},nodePath:process.execPath,runCommand:async()=>({code:0,stdout:'v24.18.0',stderr:''})});const c=report.checks.find(x=>x.name==='memory resources');assert.ok(c);assert.match(c.detail,/40/);assert.match(c.detail,/12345/);assert.match(c.detail,/stale.*1|1.*stale/);assert.doesNotMatch(c.detail,/SYNTHETIC|Preference|billed|\$/);
});
test('lightweight connect: a consent narrowed while the directory waits filters prefetched relationship data',async t=>{
 const {root,home}=await fixture(t);await source(root,home);let ready;const identityStarted=new Promise(r=>ready=r);
 globalThis.fetch=async url=>{if(new URL(String(url)).pathname.endsWith('/soul')){ready();return new Response(JSON.stringify({...rich,relationship:{facts:['PRIVATE-RELATIONSHIP']}}));}
 await identityStarted;const store=await openStore(root,'p1');await store.transact(d=>{d.consents[`cloud-device:${uid}`].categories=['identity'];});await store.close();return new Response(JSON.stringify({hosts:[{id:277,nickname:'Sophia Ramirez',soul_uid:uid}],pagination:{total:1,has_more:false}}));};const output=io();assert.equal(await main(['connect','--name','Sophia Ramirez','--agent','claude-code','--session',key.native_session_id],output),0,output.out.stderr);assert.ok(!output.out.stdout.includes('PRIVATE-RELATIONSHIP'));assert.ok(!JSON.parse(output.out.stdout).relationship);
});
