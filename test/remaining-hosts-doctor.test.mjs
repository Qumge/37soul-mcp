import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {emptySnapshot} from '../dist/local/store.js';
import {host as codex} from '../dist/hosts/codex.js';
import {host as hermes} from '../dist/hosts/hermes.js';
import {host as opencode} from '../dist/hosts/opencode.js';
import {writeCodexHookConfig,codexHookConfigPath} from '../dist/adapters/codex.js';
import {writeHermesPlugin,hermesPluginPath,hermesConfigPath} from '../dist/adapters/hermes.js';
import {writeOpenCodePlugin,openCodePluginPath,openCodeConfigPath,OPENCODE_PLUGIN_FILENAME} from '../dist/adapters/opencode.js';
const hosts=[codex,hermes,opencode];
async function fixture(host,run) {
 const home=await mkdtemp(path.join(os.tmpdir(),'remaining-doctor-'));const root=path.join(home,'.37soul'),dir=path.join(root,'profiles/work');await mkdir(dir,{recursive:true});
 await writeFile(path.join(root,'config.json'),JSON.stringify({api_base_url:'https://issuer.test',machine_id:'m',tokens:{},active_profile_id:'work'}));
 await writeFile(path.join(root,'accounts.json'),JSON.stringify({owner:{profile_id:'work',cloud_issuer:'https://issuer.test',soul_sync_mode:'assets_only'}}));
 await writeFile(path.join(dir,'device.json'),JSON.stringify({device_id:'device'}));
 const snapshot=emptySnapshot('work','device');Object.assign(snapshot,{owner_id:'owner',cloud_device_uid:'cloud',cloud_issuer:'https://issuer.test'});
 const binding={binding_uid:'binding',profile_id:'work',device_id:'device',runtime_kind:host.kind,native_session_id:'session',session_ref:'opaque',soul_uid:'soul',revision:1,state:'bound'};
 const key=['work','device',host.kind,'session'].join('\0');snapshot.bindings[key]=binding;
 const receipt={binding_uid:'binding',binding_revision:1,stage:'injected',manifest:[],rendered_sha256:'a'.repeat(64)};
 const wm={completed:true,state:'completed',last_error:null,attempts:1,request:{job_uid:'job',runtime_kind:host.kind,native_session_id:'session',source_event_refs:['event'],binding_uid:'binding',binding_revision:1,soul_uid:'soul',internal_task:true}};
 const save=()=>writeFile(path.join(dir,'snapshot.json'),JSON.stringify(snapshot));await save();
 if(host.kind==='codex')writeCodexHookConfig(home);else if(host.kind==='hermes')writeHermesPlugin(home);else writeOpenCodePlugin(home);
 const check=()=>host.doctor({home,config:{},assetsMode:true,nodePath:'/node',cliScriptPath:'/cli'});
 const bridgeName=host.kind==='codex'?'codex: SessionStart hook':host.kind+': plugin bridge';
 try{await run({home,snapshot,binding,receipt,wm,save,check,bridgeName});}finally{await rm(home,{recursive:true,force:true});}
}
for(const host of hosts) {
 test(host.kind+' installed file alone waits with actionable host approval and never claims trust',()=>fixture(host,async f=>{
  const checks=await f.check(),bridge=checks.find(c=>c.name===f.bridgeName);assert.equal(bridge.ok,false);assert.equal(bridge.waiting,true);assert.notEqual(bridge.fatal,true);
  assert.match(bridge.detail,host.kind==='codex'?/\/hooks.*approve.*new session/i:host.kind==='hermes'?/official.*consent|consent.*official/i:/restart OpenCode/i);
  assert.doesNotMatch(checks.map(c=>c.detail).join(' '),/no model call authorized|extraction stays off|remain unverified/i);
  assert.equal(checks.find(c=>c.name===host.kind+': extraction')?.waiting,true);
 }));
 test(host.kind+' matching completed extraction and hook output are observed without proving model adoption',()=>fixture(host,async f=>{
  f.snapshot.receipts.r=f.receipt;f.snapshot.extraction_watermarks.w=f.wm;await f.save();const checks=await f.check();
  assert.equal(checks.find(c=>c.name===f.bridgeName).ok,true);assert.equal(checks.find(c=>c.name===host.kind+': hook output')?.ok,true);assert.equal(checks.find(c=>c.name===host.kind+': extraction')?.ok,true);
  assert.match(checks.map(c=>c.detail).join(' '),/not proof of model adoption/);assert.match(checks.find(c=>c.name===f.bridgeName).detail,/trust.*not.*(?:verified|inferred)|not.*(?:verified|inferred).*trust/i);
  assert.doesNotMatch(checks.map(c=>c.detail).join(' '),/no model call authorized|extraction stays off|remain unverified/i);
 }));
 test(host.kind+' foreign device evidence cannot turn diagnostics green',()=>fixture(host,async f=>{
  f.snapshot.receipts.r=f.receipt;f.snapshot.extraction_watermarks.w=f.wm;f.binding.device_id='other';await f.save();const checks=await f.check();assert.equal(checks.find(c=>c.name===f.bridgeName).ok,false);assert.equal(checks.find(c=>c.name===host.kind+': extraction')?.ok,false);
 }));
}
test('missing managed files remain errors even with matching evidence',async()=>{
 for(const host of hosts)await fixture(host,async f=>{
  f.snapshot.receipts.r=f.receipt;f.snapshot.extraction_watermarks.w=f.wm;await f.save();await rm(host.kind==='codex'?codexHookConfigPath(f.home):host.kind==='hermes'?hermesPluginPath(f.home):openCodePluginPath(f.home));const bridge=(await f.check()).find(c=>c.name===f.bridgeName);assert.equal(bridge.ok,false);assert.notEqual(bridge.waiting,true);assert.match(bridge.detail,/not installed/);
 });
});
test('Hermes gateway and OpenCode unknown generation remain errors despite old matching evidence',async()=>{
 await fixture(hermes,async f=>{f.snapshot.receipts.r=f.receipt;await f.save();await writeFile(hermesConfigPath(f.home),'transport: gateway\n');const bridge=(await f.check()).find(c=>c.name===f.bridgeName);assert.equal(bridge.ok,false);assert.notEqual(bridge.waiting,true);assert.match(bridge.detail,/gateway-only.*not a CLI/);});
 await fixture(opencode,async f=>{f.snapshot.receipts.r=f.receipt;await f.save();await writeFile(openCodePluginPath(f.home),'export const api_generation = "v99";');const bridge=(await f.check()).find(c=>c.name===f.bridgeName);assert.equal(bridge.ok,false);assert.notEqual(bridge.waiting,true);assert.match(bridge.detail,/unsupported generation/);});
});
test('OpenCode hook output under model refusal does not invent completed extraction or erase refusal',()=>fixture(opencode,async f=>{
 f.snapshot.receipts.r=f.receipt;await f.save();await writeFile(openCodeConfigPath(f.home),JSON.stringify({plugins:[OPENCODE_PLUGIN_FILENAME],plugin_trust:[OPENCODE_PLUGIN_FILENAME],model_refused:true}));
 const checks=await f.check();assert.equal(checks.find(c=>c.name==='opencode: hook output')?.ok,true);assert.equal(checks.find(c=>c.name==='opencode: extraction')?.ok,false);assert.match(checks.map(c=>c.detail).join(' '),/refused/);
}));

for(const scenario of ['malformed','Stop-only','old-launcher','wrong-event','wrong-type']) {
 test('Codex '+scenario+' cannot borrow valid runtime evidence for SessionStart',()=>fixture(codex,async f=>{
  f.snapshot.receipts.r=f.receipt;f.snapshot.extraction_watermarks.w=f.wm;await f.save();
  const launcher='/current/runtime launcher';writeCodexHookConfig(f.home,{command:launcher});
  const {readFile}=await import('node:fs/promises');const file=codexHookConfigPath(f.home);const doc=JSON.parse(await readFile(file,'utf8'));
  if(scenario==='Stop-only')delete doc.hooks.SessionStart;
  if(scenario==='old-launcher')doc.hooks.SessionStart[0].hooks[0].command="'/old/runtime' hook --agent codex --event SessionStart";
  if(scenario==='wrong-event')doc.hooks.SessionStart[0].hooks[0].command="'/current/runtime launcher' hook --agent codex --event Stop";
  if(scenario==='wrong-type')doc.hooks.SessionStart[0].hooks[0].type='prompt';
  await writeFile(file,scenario==='malformed'?'{broken':JSON.stringify(doc));
  const checks=await codex.doctor({home:f.home,config:{launcher},assetsMode:true,nodePath:'/node',cliScriptPath:'/cli'});
  const row=checks.find(c=>c.name===f.bridgeName);assert.equal(row.ok,false);assert.notEqual(row.waiting,true);assert.match(row.detail,/37soul install/);
  assert.ok(!checks.some(c=>c.name==='codex: hook output'&&c.ok));
 }));
}
test('Codex current installer-quoted launcher waits without evidence and observes matching evidence',()=>fixture(codex,async f=>{
 const launcher="/current/owner's runtime";writeCodexHookConfig(f.home,{command:launcher});
 const check=()=>codex.doctor({home:f.home,config:{launcher},assetsMode:true,nodePath:'/node',cliScriptPath:'/cli'});
 let row=(await check()).find(c=>c.name===f.bridgeName);assert.equal(row.ok,false);assert.equal(row.waiting,true);
 f.snapshot.receipts.r=f.receipt;await f.save();row=(await check()).find(c=>c.name===f.bridgeName);assert.equal(row.ok,true);
}));
