import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {emptySnapshot} from '../dist/local/store.js';
import {host as pi} from '../dist/hosts/pi.js';
import {host as claude} from '../dist/hosts/claude-code.js';
import {writePiExtension} from '../dist/adapters/pi.js';

async function fixture(run) {
 const home=await mkdtemp(path.join(os.tmpdir(),'runtime-evidence-'));
 const root=path.join(home,'.37soul'), dir=path.join(root,'profiles/work');
 await mkdir(dir,{recursive:true});
 const config={api_base_url:'https://issuer.test',machine_id:'machine',tokens:{},active_profile_id:'work'};
 const accounts={owner:{profile_id:'work',cloud_issuer:'https://issuer.test',soul_sync_mode:'assets_only'}};
 const snapshot=emptySnapshot('work','device');Object.assign(snapshot,{owner_id:'owner',cloud_device_uid:'cloud',cloud_issuer:'https://issuer.test'});
 const binding={binding_uid:'binding',profile_id:'work',device_id:'device',runtime_kind:'pi',native_session_id:'session',session_ref:'opaque',soul_uid:'soul',revision:1,state:'bound'};
 snapshot.bindings[['work','device','pi','session'].join('\0')]=binding;
 const receipt={binding_uid:'binding',binding_revision:1,stage:'injected',manifest:[],rendered_sha256:'a'.repeat(64)};
 const watermark={completed:true,state:'completed',last_error:null,attempts:1,request:{job_uid:'job',runtime_kind:'pi',native_session_id:'session',source_event_refs:['event'],binding_uid:'binding',binding_revision:1,soul_uid:'soul',internal_task:true}};
 const save=async()=>{await writeFile(path.join(root,'config.json'),JSON.stringify(config));await writeFile(path.join(root,'accounts.json'),JSON.stringify(accounts));await writeFile(path.join(dir,'device.json'),JSON.stringify({device_id:'device'}));await writeFile(path.join(dir,'snapshot.json'),JSON.stringify(snapshot));};
 await save();writePiExtension(home);
 try {await run({home,root,dir,config,accounts,snapshot,binding,receipt,watermark,save});} finally {await rm(home,{recursive:true,force:true});}
}
const deps=home=>({home,config:{},assetsMode:true,nodePath:'/node',cliScriptPath:'/runtime/cli.js'});

test('Claude Stop-only configuration must not make SessionStart green',async()=>{
 await fixture(async({home})=>{
  await mkdir(path.join(home,'.claude'),{recursive:true});
  await writeFile(path.join(home,'.claude/settings.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'"/node" "/runtime/cli.js" hook --agent claude-code --event Stop'}]}]}}));
  assert.equal((await claude.doctor(deps(home))).find(c=>c.name==='claude-code: SessionStart hook').ok,false);
 });
});
test('Claude verifies command within SessionStart only, including fixed launcher and malformed settings',async()=>{
 await fixture(async({home})=>{
  await mkdir(path.join(home,'.claude'),{recursive:true});
  const file=path.join(home,'.claude/settings.json');const command='"/fixed/37soul" hook --agent claude-code --event SessionStart';
  for(const [document,want] of [[{hooks:{Stop:[{hooks:[{type:'command',command}]}]}},false],[{hooks:{SessionStart:[{hooks:[{type:'command',command}]}]}},true],[{hooks:{SessionStart:[{hooks:[{type:'command',command:command.replace('/fixed/','/old/')}]}]}},false]]) {
   await writeFile(file,JSON.stringify(document));assert.equal((await claude.doctor({...deps(home),config:{launcher:'/fixed/37soul'}})).find(c=>c.name==='claude-code: SessionStart hook').ok,want);
  }
  await writeFile(file,'{broken');assert.equal((await claude.doctor(deps(home))).find(c=>c.name==='claude-code: SessionStart hook').ok,false);
 });
});
test('Pi evidence becomes observable without claiming model adoption or verified trust',async()=>{
 await fixture(async f=>{
  f.snapshot.receipts.r=f.receipt;f.snapshot.extraction_watermarks.w=f.watermark;await f.save();
  const checks=await pi.doctor(deps(f.home));
  assert.equal(checks.find(c=>c.name==='pi: hook output')?.ok,true);
  assert.equal(checks.find(c=>c.name==='pi: extraction')?.ok,true);
  assert.doesNotMatch(checks.map(c=>c.detail).join(' '),/restart Pi|open a new session/);
  assert.match(checks.map(c=>c.detail).join(' '),/not.*model adoption|model adoption.*not/i);
  assert.match(checks.map(c=>c.detail).join(' '),/trust.*not verified/i);
 });
});
test('receipt alone does not prove extraction, and downloaded receipt does not prove hook output',async()=>{
 await fixture(async f=>{
  f.snapshot.receipts.r=f.receipt;await f.save();let checks=await pi.doctor(deps(f.home));
  assert.equal(checks.find(c=>c.name==='pi: hook output')?.ok,true);assert.equal(checks.find(c=>c.name==='pi: extraction')?.waiting,true);
  f.receipt.stage='downloaded';await f.save();checks=await pi.doctor(deps(f.home));assert.equal(checks.find(c=>c.name==='pi: hook output')?.ok,false);
 });
});
test('shared helper is scoped, fail-closed and strictly read-only',async()=>{
 const {readRuntimeEvidence}=await import('../dist/hosts/runtime-evidence.js');
 await fixture(async f=>{
  f.snapshot.receipts.r=f.receipt;f.snapshot.extraction_watermarks.w=f.watermark;await f.save();
  const expected={profile_id:'work',hook_output_observed:true,extraction_completed:true};
  assert.deepEqual(await readRuntimeEvidence(f.home,'pi'),expected);
  assert.deepEqual(await readRuntimeEvidence(f.home,'claude-code'),{profile_id:'work',hook_output_observed:false,extraction_completed:false});
  for(const [object,key,bad] of [[f.binding,'device_id','foreign'],[f.binding,'profile_id','foreign'],[f.binding,'runtime_kind','codex'],[f.binding,'revision',2],[f.binding,'state','detached']]) {
   const original=object[key];object[key]=bad;await f.save();assert.deepEqual(await readRuntimeEvidence(f.home,'pi'),{profile_id:'work',hook_output_observed:false,extraction_completed:false},key);object[key]=original;
  }
  for(const state of ['pending','running','error']) {f.watermark.state=state;await f.save();assert.equal((await readRuntimeEvidence(f.home,'pi')).extraction_completed,false);}f.watermark.state='completed';
  f.config.active_profile_id='missing';await f.save();assert.equal((await readRuntimeEvidence(f.home,'pi')).profile_id,null);
  f.config.active_profile_id='work';f.accounts.owner.cloud_issuer='https://foreign.test';await f.save();assert.equal((await readRuntimeEvidence(f.home,'pi')).profile_id,null);
  f.accounts.owner.cloud_issuer='https://issuer.test';f.snapshot.receipts={bad:null};f.snapshot.extraction_watermarks={bad:null};await f.save();
  const before=await readFile(path.join(f.dir,'snapshot.json'),'utf8');const files=await readdir(f.dir);assert.deepEqual(await readRuntimeEvidence(f.home,'pi'),{profile_id:'work',hook_output_observed:false,extraction_completed:false});
  assert.equal(await readFile(path.join(f.dir,'snapshot.json'),'utf8'),before);assert.deepEqual(await readdir(f.dir),files);
 });
});
