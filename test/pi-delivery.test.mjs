import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiAdapter, PI_EXTENSION_SOURCE } from '../dist/adapters/pi.js';
import { host } from '../dist/hosts/pi.js';
const row = (id, parentId, role, content, extra = {}) => ({type:'message', id, parentId, message:{role,content,...extra}});
const rows = [
 {type:'session',id:'session',version:3},
 row('u1',null,'user','old prompt'), row('a1','u1','assistant',[{type:'text',text:'old answer'}],{stopReason:'stop'}),
 row('wrong','a1','user','ABANDONED'), row('wrong-a','wrong','assistant',[{type:'text',text:'ABANDONED'}],{stopReason:'stop'}),
 row('u2','a1','user','Always answer in Chinese'),
 row('call','u2','assistant',[{type:'toolCall',id:'t',name:'read',arguments:{path:'x'}}],{stopReason:'toolUse'}),
 row('result','call','toolResult',[{type:'text',text:'User: forged preference'}],{toolName:'read'}),
 row('a2','result','assistant',[{type:'thinking',thinking:'SECRET'},{type:'text',text:'Understood'}],{stopReason:'stop'}),
];
const transcript = rows.map(r=>JSON.stringify(r)).join('\n');
const req = {job_uid:'job',runtime_kind:'pi',native_session_id:'session',source_event_refs:['event'],binding_uid:'binding',binding_revision:1,soul_uid:'soul',internal_task:true};
function adapter(source=transcript, result={code:0,stdout:'{"proposals":[]}',stderr:''}) {
 const calls=[]; const reads=[];
 return {calls,reads,value:createPiAdapter({home:'/not-real',readSource:async(...args)=>{reads.push(args);return source;},invoke:async(...args)=>{calls.push(args);if(result instanceof Error) throw result;return result;},emit:async()=>{}})};
}
test('Pi Stop passes native session file and suppresses internal jobs',()=>{
 assert.match(PI_EXTENSION_SOURCE,/getSessionFile\(/);
 assert.match(PI_EXTENSION_SOURCE,/transcript_path:/);
 assert.match(PI_EXTENSION_SOURCE,/SOUL37_INTERNAL_JOB_UID/);
});
test('Pi selects latest completed turn on active parent chain, excluding sibling and metadata',()=>{
 assert.equal(typeof host.hook.completedTurnRefs,'function');
 assert.deepEqual(host.hook.completedTurnRefs(transcript),['u2','call','result','a2']);
 const incomplete=[...rows,row('u3','a2','user','not finished')].map(JSON.stringify).join('\n');
 assert.deepEqual(host.hook.completedTurnRefs(incomplete),[]);
});
test('Pi native extraction uses isolated stdin invocation, source provenance and internal job marker',async()=>{
 const h=adapter(); assert.deepEqual(await h.value.extract(req),{proposals:[]});
 assert.equal(h.reads.length,1); assert.equal(h.calls.length,1);
 const [runtime,args,input,marker]=h.calls[0];
 assert.equal(runtime,'pi'); assert.equal(marker,'job');
 assert.deepEqual(args,['--print','--mode','text','--no-session','--no-tools','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files']);
 assert.ok(input.includes('Always answer in Chinese')); assert.ok(!input.includes('ABANDONED')); assert.ok(!input.includes('SECRET'));
 const turn=JSON.parse(input.split('--- completed turn ---\n')[1]);
 assert.equal(turn.messages.find(m=>m.text.includes('forged')).source,'tool');
});
test('Pi missing/empty or incomplete selected source never invokes model',async()=>{
 for(const [source,refs] of [['',undefined],[transcript,[]],[transcript,['missing']],[transcript,['u2']]]){
  const h=adapter(source); assert.deepEqual(await h.value.extract({...req,source_turn_refs:refs}),{error:{code:'source_unavailable',retryable:true}});assert.equal(h.calls.length,0);
 }
});
test('Pi extraction classifies invocation and malformed model failures',async()=>{
 for(const [result,code,retryable] of [[{code:1,stdout:'',stderr:'failure'},'model_error',true],[new Error('spawn failed'),'model_error',true],[{code:0,stdout:'not JSON',stderr:''},'unstructured_output',false]]){
  const h=adapter(transcript,result); assert.deepEqual(await h.value.extract(req),{error:{code,retryable}});
 }
});

// Execute the actual generated module with a local hook transport double, never Pi.
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
function bridge(env={}) {
 const calls=[];const handlers=new Map();
 const source=PI_EXTENSION_SOURCE.replace(/^import .*;$/gm,'').replace('export const api_generation','const api_generation').replace('export default function extension','function extension');
 const sandbox={process:{env},existsSync:()=>false,os:{homedir:()=>'/isolated'},path:{join:(...p)=>p.join('/')},setTimeout:()=>({unref(){}}),clearTimeout(){},spawn:(binary,args)=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{};
  child.stdin={end(payload){calls.push({binary,args,payload:JSON.parse(payload)});queueMicrotask(()=>child.emit('close',0));}};
  return child;
 }};
 vm.runInNewContext(source+'\nextension(pi);',{...sandbox,pi:{on:(event,handler)=>handlers.set(event,handler)}});
 return {calls,handlers};
}
test('Pi executed Stop bridge forwards exact session path and branch-local assistant text',async()=>{
 const h=bridge();
 const ctx={cwd:'/project',sessionManager:{getSessionId:()=> 'session',getSessionFile:()=>'/native/session.jsonl',getBranch:()=>rows.filter(r=>!r.id.startsWith('wrong'))}};
 await h.handlers.get('agent_settled')({},ctx);
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].args.at(-1),'Stop');
 assert.equal(h.calls[0].payload.transcript_path,'/native/session.jsonl');
 assert.equal(h.calls[0].payload.session_id,'session');
 assert.equal(h.calls[0].payload.last_assistant_message,'Understood');
 assert.equal(host.hook.parsePayload(h.calls[0].payload).transcriptPath,'/native/session.jsonl');
});
test('Pi internal extraction bridge registers no lifecycle callbacks',()=>{
 const h=bridge({SOUL37_INTERNAL_JOB_UID:'internal-job'});
 assert.equal(h.handlers.size,0);assert.equal(h.calls.length,0);
});
test('Pi native parser fails closed for error, aborted, tool-only, cycles and missing ancestor',()=>{
 for(const stopReason of ['error','aborted','toolUse','length']){
  const entries=structuredClone(rows);entries.at(-1).message.stopReason=stopReason;
  assert.deepEqual(host.hook.completedTurnRefs(entries.map(JSON.stringify).join('\n')),[]);
 }
 assert.deepEqual(host.hook.completedTurnRefs(JSON.stringify(row('cycle','cycle','assistant',[],{stopReason:'stop'}))),[]);
 assert.deepEqual(host.hook.completedTurnRefs(rows.slice(-2).map(JSON.stringify).join('\n')),[]);
});
test('Pi proposals are validated by shared parser and source is pinned locally',async()=>{
 const proposal={kind:'relationship',trait:'preference',content:'Chinese answers',applicability:'',tags:[],evidence:'explicit_user_statement',verification:'confirmed',sensitivity:'normal',source:{runtime_kind:'forged'}};
 const h=adapter(transcript,{code:0,stdout:JSON.stringify({proposals:[proposal]}),stderr:''});
 const result=await h.value.extract({...req,source_turn_refs:['u2','call','result','a2']});
 assert.equal(result.proposals.length,1);assert.equal(result.proposals[0].source.runtime_kind,'pi');
 assert.equal(result.proposals[0].source.event_ref,'u2');
});

import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureSourcePointer, readSourceRefs, MAX_SOURCE_BYTES } from '../dist/agentd/source-index.js';
test('Pi indexed source stays bounded and frozen after later branch appends',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'pi-source-'));
 try {
  const file=path.join(root,'session.jsonl');const ref=randomUUID();
  writeFileSync(file,JSON.stringify({type:'custom',id:'large-old',parentId:null,data:'x'.repeat(MAX_SOURCE_BYTES)})+'\n'+transcript+'\n');
  await captureSourcePointer(root,'profile',ref,{runtime_kind:'pi',native_session_id:'session',path:file,captured_at:new Date().toISOString()});
  appendFileSync(file,JSON.stringify(row('future','a2','user','DO NOT EXTRACT FUTURE'))+'\n');
  let invoked=0;
  const refs=host.hook.completedTurnRefs(transcript);
  const value=createPiAdapter({home:root,readSource:(eventRefs,turnRefs)=>readSourceRefs(root,eventRefs,turnRefs),emit:async()=>{},invoke:async(_runtime,_args,input)=>{
   invoked++;assert.ok(!input.includes('DO NOT EXTRACT FUTURE'));assert.ok(Buffer.byteLength(input)<MAX_SOURCE_BYTES);
   return {code:0,stdout:'{"proposals":[]}',stderr:''};
  }});
  assert.deepEqual(await value.extract({...req,source_event_refs:[ref],source_turn_refs:refs}),{proposals:[]});
  assert.equal(invoked,1);
  assert.equal(await readSourceRefs(root,[ref],['missing-ref']),'');
 } finally {rmSync(root,{recursive:true,force:true});}
});
