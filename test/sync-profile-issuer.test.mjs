import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../dist/cli.js';
import { runDoctor } from '../dist/doctor.js';
import { openStore, snapshotPath } from '../dist/local/store.js';
import { saveConfig } from '../dist/agentd/state.js';
import { writeAccountsIndex } from '../dist/local/profiles.js';
import { syncOnce, configureSyncHttp } from '../dist/sync/client.js';
import { runSyncProfiles } from '../dist/sync/run.js';
import { startWriter, sendWriter } from '../dist/local/writer.js';

const TARGET = 'https://b.test/team';
const SOUL = '10000000-0000-4000-8000-000000000001';
const identity = { name: 'Synthetic', description: '', character: 'synthetic only', greeting: '' };
const soul = { soul_uid: SOUL, legacy_host_id: 42, identity_revision: 1, identity, state: 'active', origin: 'cloud' };
function response(body) { return { status: 200, ok: true, headers: { get: () => null }, json: async () => body }; }
async function fixture(issuer, run, anonymous = false) {
 const home=mkdtempSync(path.join(tmpdir(),'sync-profile-issuer-')),root=path.join(home,'.37soul');
 await saveConfig(root,{api_base_url:TARGET,machine_id:'machine',active_profile_id:'work',tokens:{},credentials:[{issuer:TARGET,token:'FAKE-B',owner_id:'owner',cloud_device_uid:'device',runtime_kind:'claude-code',profile_id:'work',obtained_at:'fixture'}]});
 await writeAccountsIndex(root,anonymous?{}:{owner:{profile_id:'work',cloud_issuer:TARGET,soul_sync_mode:'assets_only',default_soul_uid:SOUL}});
 const image=path.join(home,'fake.png');writeFileSync(image,'SYNTHETIC-IMAGE');
 const store=await openStore(root,'work');
 await store.transact(d=>{
  d.owner_id=anonymous?null:'owner';d.cloud_device_uid=anonymous?null:'device';
  if(issuer===undefined)delete d.cloud_issuer;else d.cloud_issuer=issuer;
  d.souls[SOUL]={...soul,local_avatar_path:image,avatar_uploaded:false,...(anonymous?{origin:'local',legacy_host_id:null}:{})};
  if(!anonymous)d.consents['device:'+SOUL]={cloud_device_uid:'device',soul_uid:SOUL,revision:1,categories:['identity'],enabled:true};
 });await store.close();
 const calls=[];
 const http=async(url,init={})=>{calls.push({url:String(url),method:init.method??'GET'});return response(init.method==='PUT'?{protocol:'soul-assets/v1',avatar_url:'https://cdn.test/synthetic.png'}:{protocol:'soul-assets/v1',events:[],next_cursor:null,has_more:false});};
 const unchanged=()=>[snapshotPath(root,'work'),path.join(root,'config.json'),path.join(root,'accounts.json')].map(p=>readFileSync(p,'utf8'));
 const before=unchanged();
 try{await run({home,root,http,calls,before,unchanged});}finally{configureSyncHttp(null);rmSync(home,{recursive:true,force:true});}
}
for(const [label,issuer] of [['missing',undefined],['mismatch','https://a.test/team'],['malformed','not a URL']]) {
 test(`explicit CLI sync rejects ${label} snapshot issuer despite matching B credential; zero HTTP and unchanged store`,()=>fixture(issuer,async f=>{
  const oldHome=process.env.SOUL37_HOME,oldFetch=globalThis.fetch;process.env.SOUL37_HOME=f.home;globalThis.fetch=f.http;
  let out='';try{
   assert.equal(await main(['sync','--profile','work'],{stdout:s=>out+=s,stderr:s=>out+=s,stdin:async()=>''}),1);
   assert.match(out,/issuer|server|profile/i);assert.deepEqual(f.calls,[]);assert.deepEqual(f.unchanged(),f.before);
  }finally{if(oldHome===undefined)delete process.env.SOUL37_HOME;else process.env.SOUL37_HOME=oldHome;globalThis.fetch=oldFetch;}
 }));
 test(`daemon direct sync rejects ${label} snapshot issuer before HTTP or mutation`,()=>fixture(issuer,async f=>{
  configureSyncHttp(f.http);const reports=await runSyncProfiles(f.root);
  assert.equal(reports.length,1);assert.match(reports[0].report.error??'',/issuer|server|profile/);
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.unchanged(),f.before);
 }));
 test(`avatar direct writer rejects ${label} snapshot issuer before HTTP or mutation`,()=>fixture(issuer,async f=>{
  configureSyncHttp(f.http);const writer=await startWriter(f.root);
  try{const r=await sendWriter(f.root,{request_uid:'avatar',command:'upload_avatar',profile_id:'work',payload:{soul_uid:SOUL,local_avatar_path:'/synthetic/new-avatar.png'}});
   assert.ok(!r.ok || r.result.status==='not_logged_in' || r.result.status==='failed');
   assert.deepEqual(f.calls,[]);assert.deepEqual(f.unchanged(),f.before);
  }finally{await writer.close();}
 }));
 test(`doctor refuses false scoped green for ${label} snapshot issuer`,()=>fixture(issuer,async f=>{
  const report=await runDoctor({home:f.home,apiBase:TARGET,fetch:f.http,runCommand:async()=>({code:0,stdout:'',stderr:''}),nodePath:process.execPath,cliScriptPath:'/fake/cli.js',lang:'en',inspectRuntime:async()=>({ok:false,detail:'synthetic offline runtime'})});
  assert.equal(report.checks.find(c=>c.name==='claude-code: sync credential')?.ok,false);
  assert.ok(report.notes.some(n=>n.includes('37soul login')));
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.unchanged(),f.before);
 }));
}
test('normalized matching cloud profile remains syncable without rewriting snapshot issuer',()=>fixture('https://B.TEST:443/team/',async f=>{
 const report=await syncOnce('work',f.http,{root:f.root});assert.equal(report.error,undefined);assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.url.startsWith(TARGET+'/')));
}));
test('truly anonymous local profile may register for the first time with explicitly issuer-bound authorization',()=>fixture(undefined,async f=>{
 const store=await openStore(f.root,'work');await store.transact(d=>{d.outbox.register={operation_id:'register',operation_kind:'register_soul',request:{soul_uid:SOUL,identity,consent_categories:['identity']},predecessor_operation_ids:[]};});await store.close();
 const http=async(url,init={})=>{f.calls.push({url:String(url),method:init.method??'GET'});return response(init.method==='POST'?{protocol:'soul-assets/v1',soul,consent:{cloud_device_uid:'device',soul_uid:SOUL,revision:1,categories:['identity'],enabled:true}}:{protocol:'soul-assets/v1',events:[],next_cursor:null,has_more:false});};
 const report=await syncOnce('work',http,{root:f.root,token:'EXPLICIT-FAKE',tokenIssuer:TARGET});
 assert.equal(report.error,undefined);assert.equal(report.accepted,1);assert.ok(f.calls.some(c=>c.method==='POST'&&c.url.endsWith('/souls')));
},true));

for(const issuer of [undefined,'https://a.test/team'])test(`explicit issuer-bound override cannot bypass profile guard before capabilities (${issuer??'missing'})`,()=>fixture(issuer,async f=>{
 const store=await openStore(f.root,'work');await store.transact(d=>{d.outbox.capability={operation_id:'capability',operation_kind:'register_soul',request:{soul_uid:SOUL,identity,consent_categories:['identity'],publish_profile:true},predecessor_operation_ids:[]};});await store.close();
 const before=f.unchanged();const report=await syncOnce('work',f.http,{root:f.root,token:'EXPLICIT-FAKE',tokenIssuer:TARGET});
 assert.match(report.error??'',/issuer|server|profile/);assert.deepEqual(f.calls,[]);assert.deepEqual(f.unchanged(),before);
}));
for(const kind of ['cloud-origin-soul','registered-local-soul','synced-asset'])test(`empty ownership metadata cannot relabel ${kind} as anonymous local data`,()=>fixture(undefined,async f=>{
 const store=await openStore(f.root,'work');await store.transact(d=>{
  if(kind==='cloud-origin-soul')d.souls[SOUL].origin='cloud';
  if(kind==='registered-local-soul')d.souls[SOUL].legacy_host_id=42;
  if(kind==='synced-asset')d.assets.cloud={asset_uid:'cloud',soul_uid:SOUL,kind:'relationship',trait:'preference',content:'SYNTHETIC CLOUD FACT',applicability:'',tags:[],evidence:'explicit_user_statement',verification:'unverified',sensitivity:'normal',state:'active',revision:1,supersedes_uid:null,pinned:false,source:{runtime_kind:'claude-code',session_ref:'fake',event_ref:'fake',occurred_at:'2026-11-02T00:00:00Z'},sync_state:'synced',cloud_revision:1};
 });await store.close();
 const before=f.unchanged();const report=await syncOnce('work',f.http,{root:f.root,token:'EXPLICIT-FAKE',tokenIssuer:TARGET});
 assert.match(report.error??'',/issuer|server|profile/);assert.deepEqual(f.calls,[]);assert.deepEqual(f.unchanged(),before);
},true));
test('doctor rejects account-index issuer mismatch even when snapshot and credential agree',()=>fixture(TARGET,async f=>{
 await writeAccountsIndex(f.root,{owner:{profile_id:'work',cloud_issuer:'https://a.test/team',soul_sync_mode:'assets_only',default_soul_uid:SOUL}});
 const before=f.unchanged();const report=await runDoctor({home:f.home,apiBase:TARGET,fetch:f.http,runCommand:async()=>({code:0,stdout:'',stderr:''}),nodePath:process.execPath,cliScriptPath:'/fake/cli.js',lang:'en',inspectRuntime:async()=>({ok:false,detail:'synthetic offline runtime'})});
 assert.equal(report.checks.find(c=>c.name==='claude-code: sync credential')?.ok,false);assert.ok(report.notes.some(n=>n.includes('37soul login')));assert.deepEqual(f.calls,[]);assert.deepEqual(f.unchanged(),before);
}));

for(const anonymous of [true,false])test(`offline avatar choice remains locally pending without credentials (anonymous=${anonymous})`,()=>fixture(anonymous?undefined:TARGET,async f=>{
 const config=JSON.parse(readFileSync(path.join(f.root,'config.json'),'utf8'));await saveConfig(f.root,{...config,credentials:[]});
 configureSyncHttp(f.http);const writer=await startWriter(f.root);
 try{
  const r=await sendWriter(f.root,{request_uid:'local-pending-avatar',command:'upload_avatar',profile_id:'work',payload:{soul_uid:SOUL,local_avatar_path:'/synthetic/pending-avatar.png'}});
  assert.equal(r.ok,true);assert.equal(r.result.status,'not_logged_in');
  const store=await openStore(f.root,'work');const snapshot=await store.read();await store.close();
  assert.equal(snapshot.souls[SOUL].local_avatar_path,'/synthetic/pending-avatar.png');assert.equal(snapshot.souls[SOUL].avatar_uploaded,false);assert.deepEqual(f.calls,[]);
 }finally{await writer.close();}
},anonymous));

for (const action of ['sync','avatar']) for (const issuer of [undefined,'https://a.test/team']) test(`associated index ${issuer??'unknown'} blocks ${action} before HTTP or mutation`,()=>fixture(TARGET,async f=>{
 await writeAccountsIndex(f.root,{owner:{profile_id:'work',cloud_issuer:issuer,soul_sync_mode:'assets_only',default_soul_uid:SOUL}});
 const before=f.unchanged();
 if(action==='sync'){
  const r=await syncOnce('work',f.http,{root:f.root,token:'EXPLICIT-FAKE',tokenIssuer:TARGET});assert.match(r.error??'',/issuer|server|profile/);
 }else{
  configureSyncHttp(f.http);const writer=await startWriter(f.root);
  try{const r=await sendWriter(f.root,{request_uid:'index-avatar',command:'upload_avatar',profile_id:'work',payload:{soul_uid:SOUL,local_avatar_path:'/synthetic/new.png'}});assert.equal(r.ok,false);}finally{await writer.close();}
 }
 assert.deepEqual(f.calls,[]);assert.deepEqual(f.unchanged(),before);
}));
test('anonymous residual cloud cursor cannot be sent to another server with explicit authorization',()=>fixture(undefined,async f=>{
 const store=await openStore(f.root,'work');await store.transact(d=>{d.pull_cursor='PRIVATE-A-CURSOR';});await store.close();
 const before=f.unchanged();const r=await syncOnce('work',f.http,{root:f.root,token:'EXPLICIT-FAKE',tokenIssuer:TARGET});
 assert.match(r.error??'',/issuer|server|profile/);assert.deepEqual(f.calls,[]);assert.deepEqual(f.unchanged(),before);
},true));
test('unrelated same-owner A index does not block independent anonymous B registration',()=>fixture(undefined,async f=>{
 await writeAccountsIndex(f.root,{owner:{profile_id:'other-a',cloud_issuer:'https://a.test/team',soul_sync_mode:'assets_only',default_soul_uid:null}});
 const r=await syncOnce('work',f.http,{root:f.root,token:'EXPLICIT-FAKE',tokenIssuer:TARGET});assert.equal(r.error,undefined);assert.ok(f.calls.length>0);
},true));
