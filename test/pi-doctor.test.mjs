import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { host } from '../dist/hosts/pi.js';
import { piExtensionPath, writePiExtension } from '../dist/adapters/pi.js';

async function checkHome(setup, verify) {
 const home=mkdtempSync(path.join(tmpdir(),'pi-doctor-'));
 try {
  setup(home);
  const checks=await host.doctor({home,config:{},assetsMode:true});
  assert.ok(checks.length>0,'Pi must expose a doctor diagnostic');
  await verify(checks,home);
 } finally {rmSync(home,{recursive:true,force:true});}
}
test('Pi doctor missing bridge fails with exact path and install recovery',()=>checkHome(()=>{},(checks,home)=>{
 const check=checks.find(c=>c.name==='pi: extension bridge');
 assert.ok(check);assert.equal(check.ok,false);assert.notEqual(check.waiting,true);
 assert.ok(check.detail.includes(piExtensionPath(home)));assert.match(check.detail,/37soul install/);
 assert.match(check.detail,/missing|not installed/i);
}));
test('Pi doctor unsupported generation fails and requests reinstall',()=>checkHome(home=>{
 const file=piExtensionPath(home);mkdirSync(path.dirname(file),{recursive:true});
 writeFileSync(file,'export const api_generation = "unsupported-generation";\n');
},(checks)=>{
 const check=checks.find(c=>c.name==='pi: extension bridge');assert.ok(check);
 assert.equal(check.ok,false);assert.notEqual(check.waiting,true);
 assert.match(check.detail,/generation.*unsupported|unsupported.*generation/i);
 assert.match(check.detail,/37soul install/);assert.match(check.detail,/reinstall/i);
}));
test('Pi doctor managed file alone remains waiting, never claims runtime verification',()=>checkHome(home=>writePiExtension(home),(checks,home)=>{
 const check=checks.find(c=>c.name==='pi: extension bridge');assert.ok(check);
 assert.equal(check.ok,false);assert.equal(check.waiting,true);
 assert.ok(check.detail.includes(piExtensionPath(home)));assert.match(check.detail,/restart|new session/i);
 assert.match(check.detail,/load.*(?:unverified|not verified)|(?:unverified|not verified).*load/i);
 assert.match(check.detail,/trust.*(?:unverified|not verified)|(?:unverified|not verified).*trust/i);
 assert.match(check.detail,/extract.*(?:unverified|not verified)|(?:unverified|not verified).*extract/i);
 assert.match(check.detail,/event|runtime evidence/i);
 assert.ok(checks.every(c=>!c.ok),'a managed file write is not runtime evidence');
 assert.equal(readFileSync(piExtensionPath(home),'utf8').includes('pi-extension-v1'),true);
}));
test('Pi doctor unreadable bridge path fails as configuration error, not runtime waiting',()=>checkHome(home=>mkdirSync(piExtensionPath(home),{recursive:true}),(checks)=>{
 const check=checks.find(c=>c.name==='pi: extension bridge');assert.ok(check);
 assert.equal(check.ok,false);assert.notEqual(check.waiting,true);
 assert.match(check.detail,/read|unreadable/i);assert.match(check.detail,/37soul install/);
}));
