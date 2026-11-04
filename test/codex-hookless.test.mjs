import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm,stat,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {findCodexRollout,observeCodexBinding} from '../dist/agentd/codex-native.js';
import {captureSourcePointer,sessionSourceBoundary,readSourceRefs} from '../dist/agentd/source-index.js';
import {renderCodexTurn} from '../dist/adapters/codex.js';
import {openStore} from '../dist/local/store.js';
import {bindingKey} from '../dist/local/bindings.js';
import {startWriter,sendWriter} from '../dist/local/writer.js';
import '../dist/extraction/scheduler.js';
const sid='10000000-0000-4000-8000-000000000001',turn='20000000-0000-4000-8000-000000000001';
const line=x=>JSON.stringify(x)+'\n';
const start=id=>line({type:'event_msg',payload:{type:'task_started',turn_id:id}});
const end=id=>line({type:'event_msg',payload:{type:'task_complete',turn_id:id}});
const msg=(role,text)=>line({type:'response_item',payload:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text}]}});
async function fixture(t){
 const home=await mkdtemp(path.join(tmpdir(),'codex-hookless-'));t.after(()=>rm(home,{recursive:true,force:true}));const root=path.join(home,'.37soul');const dir=path.join(home,'.codex','sessions','2026','11','04');await mkdir(dir,{recursive:true});const file=path.join(dir,`rollout-test-${sid}.jsonl`);await writeFile(file,line({type:'session_meta',payload:{id:sid}}));
 const key={profile_id:'p1',device_id:'d1',runtime_kind:'codex',native_session_id:sid};await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'codex',native_session_id:sid,path:file,captured_at:new Date().toISOString()});const boundary=await sessionSourceBoundary(root,key);
 const binding={...key,binding_uid:randomUUID(),session_ref:randomUUID(),soul_uid:randomUUID(),revision:1,state:'bound',source_boundary:boundary,source_mode:'codex-native',codex_cursor:{offset:boundary.start_offset,size:boundary.start_offset}};
 return {home,root,file,key,binding};
}
test('native discovery validates the header and refuses duplicate or symlink sources',async t=>{
 const f=await fixture(t);assert.equal(await findCodexRollout(f.home,sid),f.file);const other=path.join(path.dirname(f.file),`rollout-other-${sid}.jsonl`);await writeFile(other,line({type:'session_meta',payload:{id:sid}}));assert.equal(await findCodexRollout(f.home,sid),null);await writeFile(other,line({type:'session_meta',payload:{id:randomUUID()}}));assert.equal(await findCodexRollout(f.home,sid),f.file);await rm(other);await rm(f.file);await symlink('/dev/null',f.file);assert.equal(await findCodexRollout(f.home,sid),null);
});
test('observation requires matching completed native turns; a torn completion waits',async t=>{
 const f=await fixture(t);await appendFile(f.file,start(turn)+msg('user','Remember my tea preference')+msg('assistant','Understood.'));let observed=await observeCodexBinding(f.binding);assert.equal(observed.completed.length,0);f.binding.codex_cursor=observed.cursor;
 const completion=end(turn);await appendFile(f.file,completion.slice(0,-2));observed=await observeCodexBinding(f.binding);assert.equal(observed.completed.length,0);f.binding.codex_cursor=observed.cursor;await appendFile(f.file,completion.slice(-2));observed=await observeCodexBinding(f.binding);assert.equal(observed.completed.length,1);assert.equal(observed.completed[0].ref,'codex-turn:'+turn);
 const rendered=renderCodexTurn(await readFile(f.file,'utf8'),[observed.completed[0].ref]);assert.match(rendered,/tea preference/);assert.equal(JSON.parse(rendered).messages[0].source,'user');
 f.binding.codex_cursor=observed.cursor;assert.equal((await observeCodexBinding(f.binding)).completed.length,0);
});
test('interrupted, compacted, pre-attach and mismatched completed turns are excluded',async t=>{
 const f=await fixture(t);await appendFile(f.file,end(turn)+start(turn)+msg('user','DO-NOT-RETAIN')+line({type:'event_msg',payload:{type:'turn_aborted'}})+end(turn)+start(turn)+line({type:'compacted',payload:{}})+end(turn)+start(turn)+end(randomUUID()));assert.equal((await observeCodexBinding(f.binding)).completed.length,0);
});
test('replacement/truncation invalidates the original source boundary',async t=>{
 const f=await fixture(t);await writeFile(f.file,'changed\n');assert.equal(await observeCodexBinding(f.binding),null);
});
test('writer queues one frozen, scoped job across restart and never queues detached/revoked bindings',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.root,'profiles','p1'),{recursive:true});await writeFile(path.join(f.root,'profiles','p1','device.json'),JSON.stringify({device_id:'d1'}));
 let s=await openStore(f.root,'p1');await s.transact(d=>{d.cloud_device_uid='cloud';d.souls[f.binding.soul_uid]={soul_uid:f.binding.soul_uid,legacy_host_id:277,identity_revision:1,identity:{name:'Test',character:'',description:'',greeting:''},state:'active'};d.consents['cloud:'+f.binding.soul_uid]={cloud_device_uid:'cloud',soul_uid:f.binding.soul_uid,revision:1,categories:['identity','relationship','experience'],enabled:true};d.bindings[bindingKey(f.binding)]=f.binding;});await s.close();
 const writer=await startWriter(f.root);t.after(()=>writer.close());const observe=()=>sendWriter(f.root,{request_uid:randomUUID(),profile_id:'p1',command:'observe_codex',payload:{}});
 await appendFile(f.file,start(turn)+msg('user','ONLY-THIS-SOUL')+msg('assistant','Okay')+end(turn));let result=await observe();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result.scheduled,1);
 result=await observe();assert.equal(result.result.scheduled,0);s=await openStore(f.root,'p1');let snap=await s.read();assert.equal(Object.keys(snap.extraction_watermarks).length,1);const wm=Object.values(snap.extraction_watermarks)[0];assert.equal(wm.request.soul_uid,f.binding.soul_uid);const text=await readSourceRefs(f.root,wm.request.source_event_refs,wm.request.source_turn_refs);assert.match(text,/ONLY-THIS-SOUL/);
 const {createCodexAdapter}=await import('../dist/adapters/codex.js');const {withBatchExtraction}=await import('../dist/extraction/batch-adapter.js');const {drainPendingExtractions}=await import('../dist/extraction/scheduler.js');let modelCalls=0;
 const adapter=withBatchExtraction(createCodexAdapter,{home:f.home,readSource:(refs,turns)=>readSourceRefs(f.root,refs,turns),emit:async()=>{},invoke:async(_runtime,_args,input)=>{modelCalls++;assert.match(input,/ONLY-THIS-SOUL/);return {code:0,stdout:JSON.stringify({proposals:[{kind:'relationship',trait:'preference',content:'Prefers black tea.',applicability:'When choosing tea.',tags:[],evidence:'explicit_user_statement',verification:'unverified',sensitivity:'normal'}]}),stderr:''};}});
 await s.transact(d=>{for(const w of Object.values(d.extraction_watermarks))w.queued_at='2020-01-01T00:00:00Z';});await s.close();const drained=await drainPendingExtractions(f.root,{codex:adapter});assert.equal(drained.completed,1,JSON.stringify(drained));assert.equal(modelCalls,1);const verified=await openStore(f.root,'p1');snap=await verified.read();assert.equal(Object.values(snap.assets)[0].soul_uid,f.binding.soul_uid);assert.equal(Object.values(snap.assets)[0].content,'Prefers black tea.');await verified.close();s=await openStore(f.root,'p1');

 const next=randomUUID();await s.transact(d=>{d.consents['cloud:'+f.binding.soul_uid].enabled=false;});await s.close();await appendFile(f.file,start(next)+msg('user','REVOKED')+end(next));result=await observe();assert.equal(result.result.scheduled,0);assert.ok(!JSON.stringify(snap).includes('ONLY-THIS-SOUL'));
 s=await openStore(f.root,'p1');await s.transact(d=>{d.consents['cloud:'+f.binding.soul_uid].enabled=true;d.consents['cloud:'+f.binding.soul_uid].revision=3;});await s.close();result=await observe();assert.equal(result.result.scheduled,0,'re-authorization must not backfill revoked-period turns');
 const safe=randomUUID();await appendFile(f.file,start(safe)+msg('user','AUTHORIZED-NEW')+end(safe));result=await observe();assert.equal(result.result.scheduled,1);

});

test('hook removal preserves foreign handlers inside mixed groups and custom top-level settings',async t=>{
 const f=await fixture(t);const {removeCodexHookConfig}=await import('../dist/adapters/codex.js');const file=path.join(f.home,'.codex','hooks.json');const foreign={type:'command',command:'node /opt/other-product/cli.js hook --agent codex --event SessionStart',timeout:2};const doc={description:'personal hooks',custom:42,hooks:{UserPromptSubmit:[{matcher:'*',customGroup:true,hooks:[{type:'command',command:"'/runtime/bin/37soul' hook --agent codex --event UserPromptSubmit"},foreign]}],SessionStart:[{hooks:[foreign]}]}};
 await writeFile(file,JSON.stringify(doc));assert.equal(removeCodexHookConfig(f.home),true);const result=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(result.hooks.UserPromptSubmit[0],{matcher:'*',customGroup:true,hooks:[foreign]});assert.equal(result.custom,42);assert.deepEqual(result.hooks.SessionStart,doc.hooks.SessionStart);const saved=await readFile(file,'utf8');assert.equal(removeCodexHookConfig(f.home),false);assert.equal(await readFile(file,'utf8'),saved);
});

test('active native turn prefix mutation cannot be blessed by a later completion',async t=>{
 const f=await fixture(t);await appendFile(f.file,start(turn)+msg('user','ORIGINAL'));let result=await observeCodexBinding(f.binding);f.binding.codex_cursor=result.cursor;
 await writeFile(f.file,(await readFile(f.file,'utf8')).replace('ORIGINAL','MODIFIED'));await appendFile(f.file,end(turn));result=await observeCodexBinding(f.binding);assert.ok(!result || result.completed.length===0);
});

test('legacy rebind establishes a fresh boundary rather than assigning old unread turns to another Soul',async t=>{
 const f=await fixture(t);const s=await openStore(f.root,'p1',{deviceId:'d1'});const second=randomUUID();await s.transact(d=>{d.cloud_device_uid='cloud';for(const uid of [f.binding.soul_uid,second]){d.souls[uid]={soul_uid:uid,legacy_host_id:null,identity_revision:1,identity:{name:'Test',character:'',description:'',greeting:''},state:'active'};d.consents['cloud:'+uid]={cloud_device_uid:'cloud',soul_uid:uid,revision:1,categories:['identity','relationship','experience'],enabled:true};}d.bindings[bindingKey(f.binding)]=f.binding;});await s.close();
 await appendFile(f.file,start(turn)+msg('user','SOUL-A-PRIVATE')+end(turn));const {selectSoul}=await import('../dist/local/bindings.js');await selectSoul(f.key,second,{root:f.root});const r=await openStore(f.root,'p1');const binding=(await r.read()).bindings[bindingKey(f.binding)];await r.close();assert.equal(binding.source_boundary.start_offset,(await stat(f.file)).size);assert.equal((await observeCodexBinding(binding)).completed.length,0);
});
