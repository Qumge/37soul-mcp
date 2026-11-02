import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaselinePlan, classifyResult, RequestBudget, validatePlan, buildLoopSessionArgs, renderHermesConfig, installNativeBudgetGate } from '../scripts/verify-native-delivery.mjs';

test('all baseline plans isolate native calls without bypass flags or hook approval', () => {
 for (const host of ['claude-code','codex','opencode','hermes','pi']) {
  const p=buildBaselinePlan(host,'CANARY_TEST');
  assert.equal(validatePlan(p), true);
  assert.doesNotMatch(JSON.stringify(p), /dangerously|accept.hooks|--yolo|--auto|trust.*true/i);
  assert.equal(p.stage,'explicit-context-baseline');
 }
});
test('Pi baseline disables tool/extension/skill/context discovery and persistence', () => {
 const p=buildBaselinePlan('pi','CANARY_TEST');
 for (const f of ['--no-tools','--no-extensions','--no-skills','--no-context-files','--no-session','--no-mcp']) assert.ok(p.args.includes(f));
});
test('updated cumulative budget includes the two spent Pi calls and refuses a seventh', () => {
 const b=new RequestBudget({pi:2});
 for(let i=0;i<4;i++) b.take('pi');
 assert.equal(b.counts.pi,6);
 assert.throws(()=>b.take('pi'));
 assert.throws(()=>b.take('pi',{retry:true,previousFailed:true}));
 assert.throws(()=>b.take('codex',{retry:true,previousFailed:false}));
});
test('only assistant output can prove baseline adoption, raw provider errors never escape', () => {
 const secret='sk-test-secret-NEVER-LOG';
 const failure=classifyResult('codex',{code:1,stdout:'',stderr:secret},'CANARY_TEST');
 assert.equal(failure.adopted,false); assert.ok(!JSON.stringify(failure).includes(secret));
 const fakeEcho=classifyResult('codex',{code:0,stdout:JSON.stringify({type:'prompt',text:'CANARY_TEST'}),stderr:''},'CANARY_TEST');
 assert.equal(fakeEcho.adopted,false);
 const pass=classifyResult('codex',{code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'CANARY_TEST'}}),stderr:''},'CANARY_TEST');
 assert.equal(pass.adopted,true); assert.equal(pass.default_install_closed,false);
});
test('unsafe plans are refused before execution',()=>{
 assert.throws(()=>validatePlan({args:['exec','--dangerously-bypass-hook-trust']}));
});
test('successful native result is not misclassified by nonfatal stderr diagnostics',()=>{
 const r=classifyResult('pi',{code:0,stdout:'CANARY_TEST',stderr:'unknown config field ignored'},'CANARY_TEST');
 assert.equal(r.error_class,null);
});

test('Pi product loop keeps managed extension discovery and real session persistence without answer injection',()=>{
 const args=buildLoopSessionArgs('pi');
 assert.ok(args.includes('--no-tools'));
 for(const flag of ['--no-extensions','--no-session','--system-prompt','--append-system-prompt','--extension','-e'])assert.ok(!args.includes(flag));
 assert.ok(args.includes('--no-skills'));assert.ok(args.includes('--no-context-files'));
});

test('OpenCode does not pin a temporary provider model and can use an explicit discovered config model',()=>{
 const p=buildBaselinePlan('opencode','TEST');
 assert.ok(!p.args.includes('-m'));assert.ok(!JSON.stringify(p).includes('deepseek-v4.1-flash-free'));
 const configured=buildBaselinePlan('opencode','TEST',{model:'approved-provider/current-model'});
 assert.equal(configured.args[configured.args.indexOf('-m')+1],'approved-provider/current-model');
});
test('all product session plans enable real installed host discovery without context-answer injection',()=>{
 for(const host of ['claude-code','codex','opencode','hermes','pi']){
  const args=buildLoopSessionArgs(host);
  assert.ok(args.length>0);
  for(const flag of ['--system-prompt','--append-system-prompt','--no-extensions','--dangerously-bypass-hook-trust','--yolo','--auto'])assert.ok(!args.includes(flag));
  if(host==='opencode')assert.ok(!args.includes('-m'));
 }
});

test('Hermes config has a YAML mapping root so actual installer can append its hooks block',()=>{
 const text=renderHermesConfig({model:{default:'configured-model',provider:'configured-provider'},agent:{max_turns:1}});
 assert.match(text,/^model: /m);
 const modelLine=text.split('\n').find(x=>x.startsWith('model: '));
 assert.equal(JSON.parse(modelLine.slice(7)).default,'configured-model');
 assert.ok(!text.trimStart().startsWith('{'),'JSON document plus appended YAML hooks is invalid');
});

import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HOSTS} from '../dist/hosts/registry.js';
import {buildExecutionPath,resolveNativeExecutable} from '../dist/agentd/native-executable.js';
test('daemon canonical resolution chooses the budget gate despite a colliding nodeDir executable',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'native-gate-test-'));
 try{
  for(const host of ['codex','hermes','pi']){
   const home=path.join(root,host),nodeDir=path.join(root,'nodebin-'+host);mkdirSync(nodeDir,{recursive:true});
   const spec=HOSTS.find(h=>h.kind===host).invoke;
   const collision=path.join(nodeDir,spec.binary);writeFileSync(collision,'#!/bin/sh\nexit 99\n');chmodSync(collision,0o700);
   const gate=await installNativeBudgetGate(home,host,'/not-executed/real-'+host,root);
   assert.equal(gate,path.join(home,spec.userLaunchers[0]));
   const executable=await resolveNativeExecutable(spec,home,buildExecutionPath(home,path.join(nodeDir,'node'),path.dirname(gate)));
   assert.equal(executable,gate,'production resolver must find the gate before nodeDir/global binaries');
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
