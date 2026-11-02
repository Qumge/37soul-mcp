import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildExecutionPath, resolveNativeExecutable } from '../dist/agentd/native-executable.js';
import { buildClaudeSessionPlan, reserveClaudeAttempt, summarizeNative, installClaudeBudgetGate } from '../scripts/verify-claude-delivery.mjs';

test('Claude product plans retain managed hooks and persistent fresh sessions without injecting the answer', () => {
 const first=buildClaudeSessionPlan('learn');const fresh=buildClaudeSessionPlan('recall');const corrected=buildClaudeSessionPlan('corrected');
 assert.ok(first.args.includes('--session-id'));
 assert.ok(first.args.includes('--setting-sources'));assert.equal(first.args[first.args.indexOf('--setting-sources')+1],'user');
 for(const plan of [first,fresh,corrected]){
  for(const flag of ['--no-session-persistence','--system-prompt','--append-system-prompt','--bare','--dangerously-skip-permissions'])assert.ok(!plan.args.includes(flag));
  assert.ok(plan.args.includes('-p'));assert.ok(plan.args.includes('--output-format'));
 }
 assert.notEqual(first.sessionId,fresh.sessionId);assert.notEqual(fresh.sessionId,corrected.sessionId);
 assert.match(first.input,/Copper, Silver, Tin/);
 assert.doesNotMatch(fresh.input+corrected.input,/Copper|Silver|Tin|Flint|River|Star/);
});
test('process-persistent gate counts the spent baseline and refuses a seventh native including daemon extraction',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'claude-gate-test-'));
 try{
  writeFileSync(path.join(root,'budget.json'),JSON.stringify({'claude-code':1,pi:5}));
  for(let i=0;i<5;i++)reserveClaudeAttempt(root,i===1?'extraction':'session');
  assert.throws(()=>reserveClaudeAttempt(root,'extraction'),/budget/);
  const c=JSON.parse(readFileSync(path.join(root,'budget.json'),'utf8'));assert.equal(c['claude-code'],6);assert.equal(c.pi,5);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('missing or damaged ledger fails closed instead of resetting the spent native budget',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'claude-gate-test-'));
 try{
  assert.throws(()=>reserveClaudeAttempt(root,'session'));
  writeFileSync(path.join(root,'budget.json'),'{broken');assert.throws(()=>reserveClaudeAttempt(root,'session'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('sanitized report hashes only the assistant result and never includes raw provider output',()=>{
 const secret='sk-SECRET-NEVER-REPORT';
 const got=summarizeNative({code:1,stdout:secret,stderr:secret});
 assert.equal(got.code,1);assert.ok(!JSON.stringify(got).includes(secret));
 const ok=summarizeNative({code:0,stdout:JSON.stringify({type:'result',result:'synthetic result'}),stderr:secret});
 assert.equal(ok.assistant_chars,16);assert.match(ok.assistant_sha256,/^[a-f0-9]{64}$/);
});

for(const canonicalPresent of [false,true])test(`budget gate wins against node-bin and existing canonical executable (canonical=${canonicalPresent})`,async()=>{
 const home=mkdtempSync(path.join(tmpdir(),'37soul-claude-gate-test-'));
 try{
  const fake=relative=>{const file=path.join(home,relative);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,'#!/bin/sh\nexit 99\n');chmodSync(file,0o700);return file;};
  const node=fake('node-bin/node');fake('node-bin/claude');
  if(canonicalPresent)fake('.local/bin/claude');
  const real=fake('approved-real/claude');
  const gate=installClaudeBudgetGate(home,real);
  const childPath=buildExecutionPath(home,node,path.dirname(gate));
  const selected=await resolveNativeExecutable({binary:'claude',userLaunchers:['.local/bin/claude']},home,childPath);
  assert.equal(selected,gate,'daemon must resolve the counting gate, never an ungated executable');
  assert.equal(gate,path.join(home,'.local/bin/claude'));
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('gate installation refuses real user HOME before writing a launcher',()=>{
 assert.throws(()=>installClaudeBudgetGate(process.env.HOME,'/unused/fake-cli'),/isolated/);
});
