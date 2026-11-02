import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const runner=await import('../scripts/verify-opencode-delivery.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('OpenCode managed plan uses current binary, real plugin discovery and explicit model without trust bypass',()=>{
 assert.equal(typeof runner.managedPlan,'function');
 const p=runner.managedPlan('synthetic prompt',{home:'/isolated-test-user'});
 assert.equal(p.binary,path.join('/isolated-test-user','.opencode/bin/opencode'));
 assert.deepEqual(p.args,['run','--standalone','--format','json','--model','opencode/deepseek-v4.1-flash-free','--agent','delivery-acceptance','synthetic prompt']);
 assert.doesNotMatch(JSON.stringify(p),/--auto|bypass|--continue|--session|system-prompt|no-plugins/);
});
test('OpenCode shared budget starts at already spent one, gates automatic extraction and refuses seventh',async()=>{
 assert.equal(typeof runner.reserveAttempt,'function');
 const root=mkdtempSync(path.join(tmpdir(),'opencode-budget-test-'));
 try{
  writeFileSync(path.join(root,'budget.json'),JSON.stringify({opencode:1,pi:5}));
  const counts=await Promise.all(Array.from({length:5},()=>runner.reserveAttempt(root)));
  assert.deepEqual(counts.sort(),[2,3,4,5,6]);
  await assert.rejects(()=>runner.reserveAttempt(root),/budget_exhausted/);
  assert.equal(JSON.parse(readFileSync(path.join(root,'budget.json'))).pi,5);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('OpenCode evidence rejects prompt echo and requires actual managed receipt plus real completed watermark',()=>{
 assert.equal(typeof runner.assessEvidence,'function');
 const input={soul:'s',asset:'a',labels:['North','East','South'],answer:'North East South',bindings:[{binding_uid:'b',runtime_kind:'opencode',soul_uid:'s'}],receipts:[{stage:'injected',binding_uid:'b',manifest:[{asset_uid:'a'}]}],watermarks:[{completed:true,request:{runtime_kind:'opencode',soul_uid:'s',source_turn_refs:['u','a']}}],synced:{sync_state:'synced',cloud_revision:1}};
 assert.equal(runner.assessEvidence(input).pass,true);
 assert.equal(runner.assessEvidence({...input,answer:'',stdout:'North East South'}).pass,false);
 assert.equal(runner.assessEvidence({...input,receipts:[]}).pass,false);
 assert.equal(runner.assessEvidence({...input,watermarks:[]}).pass,false);
 assert.equal(runner.assessEvidence({...input,bindings:[{...input.bindings[0],soul_uid:'other'}]}).pass,false);
});

test('OpenCode provider quota failure is classified without exposing response or credentials',()=>{
 assert.equal(typeof runner.classifyFailure,'function');
 const secret='never-log-private-provider-response';
 assert.equal(runner.classifyFailure({code:1,stdout:JSON.stringify({error:{type:'AI.Error.QuotaExceeded',message:'Free usage limit reached. '+secret}}),stderr:''}),'provider_quota_exceeded');
 assert.equal(runner.classifyFailure({code:1,stdout:'',stderr:'HTTP 401 '+secret}),'authorization_unavailable');
 assert.equal(runner.classifyFailure({code:0,stdout:'',stderr:secret}),null);
});
test('OpenCode gate uses saved real binary under isolated HOME and rejects recursive self-resolution',()=>{
 assert.equal(typeof runner.gateBinary,'function');
 assert.equal(runner.gateBinary({binary:'/real-user/.opencode/bin/opencode',home:'/isolated-home'}),'/real-user/.opencode/bin/opencode');
 assert.throws(()=>runner.gateBinary({binary:'/isolated-home/.opencode/bin/opencode',home:'/isolated-home'}),/gate_binary_refused/);
 assert.throws(()=>runner.gateBinary({binary:'opencode',home:'/isolated-home'}),/gate_binary_refused/);
});
