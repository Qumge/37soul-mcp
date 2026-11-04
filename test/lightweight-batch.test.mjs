import test from 'node:test';
import assert from 'node:assert/strict';
import * as native from '../dist/agentd/native-invoker.js';
import {createClaudeCodeAdapter} from '../dist/adapters/claude-code.js';
const req=n=>({job_uid:'job-'+n,runtime_kind:'claude-code',native_session_id:'session',source_event_refs:['event-'+n],source_turn_refs:['u'+n,'a'+n],binding_uid:'binding',binding_revision:1,soul_uid:'soul',internal_task:true});
const p=n=>({kind:'relationship',trait:'preference',content:'Preference '+n,applicability:'future replies',tags:[],evidence:'explicit_user_statement',verification:'unverified',sensitivity:'normal'});
function fixture(responder){
 assert.equal(typeof native.withBatchExtraction,'function','production adapter batching is missing');const calls=[];
 const deps={home:'/synthetic',emit:async()=>{},readSource:async refs=>{const n=refs[0].split('-').at(-1);return [
 {type:'user',uuid:'u'+n,timestamp:'2026-11-04T00:00:00Z',message:{content:'Please remember preference '+n}},
 {type:'assistant',uuid:'a'+n,timestamp:'2026-11-04T00:00:01Z',message:{content:[{type:'text',text:'Understood.'}]}}
 ].map(x=>JSON.stringify(x)).join('\n');},invoke:async(kind,args,input,uid)=>{calls.push({kind,args,input,uid});return {code:0,stdout:JSON.stringify(responder?.()??{type:'result',is_error:false,structured_output:{jobs:[3,1,2].map(n=>({job_uid:'job-'+n,proposals:[p(n)]}))}}),stderr:''};}};
 return {adapter:native.withBatchExtraction(createClaudeCodeAdapter,deps),calls};
}
test('lightweight batch: three prepared native turns use one model call and preserve each source attribution despite reordered results',async()=>{
 const {adapter,calls}=fixture();for(const n of [1,2,3]){const metadata=await adapter.prepare(req(n));assert.equal(metadata.urgent,true);}assert.equal(calls.length,0,'preparation is local');
 const results=await adapter.extractBatch([req(1),req(2),req(3)]);assert.equal(calls.length,1);assert.ok(Buffer.byteLength(calls[0].input)<=24576);
 for(let i=0;i<3;i++){assert.equal(results[i].proposals[0].content,'Preference '+(i+1));assert.equal(results[i].proposals[0].source.event_ref,'u'+(i+1));}
 const schema=JSON.parse(calls[0].args[calls[0].args.indexOf('--json-schema')+1]);assert.ok(schema.properties.jobs);assert.deepEqual(calls[0].args.slice(0,5),['-p','--output-format','json','--tools','']);
});
test('lightweight batch: missing result stays an explicit failure, never completed empty memory',async()=>{
 const {adapter}=fixture(()=>({jobs:[{job_uid:'job-1',proposals:[]}]}));const results=await adapter.extractBatch([req(1),req(2)]);assert.deepEqual(results[0],{proposals:[]});assert.equal(results[1].error.code,'batch_result_missing');
});
test('lightweight batch: duplicate or foreign result identifiers cannot be applied',async()=>{
 for(const jobs of [[{job_uid:'job-1',proposals:[]},{job_uid:'job-1',proposals:[]}],[{job_uid:'foreign',proposals:[]} ]]){
  const {adapter}=fixture(()=>({jobs}));const result=await adapter.extractBatch([req(1),req(2)]);assert.ok(result.every(r=>r.error?.code==='invalid_batch_output'));
 }
});
test('lightweight batch: different Soul or session is rejected before a model call',async()=>{
 const {adapter,calls}=fixture();for(const field of ['soul_uid','native_session_id','binding_revision']){
  const other={...req(2),[field]:field==='binding_revision'?2:'other'};const result=await adapter.extractBatch([req(1),other]);assert.ok(result.every(r=>r.error));
 }assert.equal(calls.length,0);
});
test('lightweight native: extraction alone disables thinking and caps Claude output without changing parent environment',async()=>{
 let seen;const before=process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
 const invoke=native.createNativeInvoker(undefined,(_command,_args,options,callback)=>{seen=options.env;callback(null,'{"proposals":[]}','');return {stdin:{write(){},end(){}},kill(){}};});
 await invoke('claude-code',['-p'],'synthetic','internal-job');assert.equal(seen.CLAUDE_CODE_MAX_OUTPUT_TOKENS,'1024');assert.equal(seen.CLAUDE_CODE_DISABLE_THINKING,'1');assert.equal(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,before);
});
test('lightweight native: report observed token usage separately without trusting CLI dollar estimates or leaking provider fields',async()=>{
 const logs=[];const invoke=native.createNativeInvoker({info:s=>logs.push(s),error:()=>{}},(_command,_args,_options,cb)=>{cb(null,JSON.stringify({usage:{input_tokens:120,output_tokens:20,cache_read_input_tokens:40},total_cost_usd:9,secret:'PRIVATE-CANARY'}),'');return {stdin:{write(){},end(){}},kill(){}};});await invoke('claude-code',['-p'],'synthetic','j');assert.ok(logs.some(s=>/input 120.*output 20.*cache_read 40/.test(s)));assert.ok(!logs.join('').includes('PRIVATE-CANARY'));assert.ok(!logs.join('').includes('$9'));
});
