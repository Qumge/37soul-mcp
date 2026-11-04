import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {main} from '../dist/cli.js';
import {openStore} from '../dist/local/store.js';
import {hostSpec} from '../dist/hosts/registry.js';
import {writeCodexHookConfig} from '../dist/adapters/codex.js';

async function fixture(t){
 const home=await mkdtemp(path.join(tmpdir(),'soul-context-recovery-')),root=path.join(home,'.37soul');
 const store=await openStore(root,'p1',{deviceId:'test-device'});await store.transact(()=>{});await store.close();
 await writeFile(path.join(root,'profiles/p1/device.json'),JSON.stringify({device_id:'test-device'}));
 const config={active_profile_id:'p1',machine_id:'test-machine',api_base_url:'https://network-forbidden.invalid',tokens:{},launcher:'/synthetic/runtime/bin/37soul'};
 await writeFile(path.join(root,'config.json'),JSON.stringify(config));
 await writeFile(path.join(root,'accounts.json'),JSON.stringify({anonymous:{profile_id:'p1',cloud_issuer:null,default_soul_uid:null,soul_sync_mode:'assets_only'}}));
 await mkdir(path.join(home,'.codex'),{recursive:true});
 const trustFile=path.join(home,'.codex/config.toml');await writeFile(trustFile,'[features]\nhooks = true\n');
 const before={snapshot:await readFile(path.join(root,'profiles/p1/snapshot.json'),'utf8'),config:await readFile(path.join(root,'config.json'),'utf8'),accounts:await readFile(path.join(root,'accounts.json'),'utf8'),trust:await readFile(trustFile,'utf8')};
 const previous={home:process.env.SOUL37_HOME,base:process.env.SOUL37_BASE_URL,fetch:globalThis.fetch};let calls=0;
 process.env.SOUL37_HOME=home;delete process.env.SOUL37_BASE_URL;
 globalThis.fetch=async()=>{calls++;throw Error('network forbidden');};
 t.after(async()=>{if(previous.home===undefined)delete process.env.SOUL37_HOME;else process.env.SOUL37_HOME=previous.home;if(previous.base===undefined)delete process.env.SOUL37_BASE_URL;else process.env.SOUL37_BASE_URL=previous.base;globalThis.fetch=previous.fetch;await rm(home,{recursive:true,force:true});});
 const unchanged=async()=>{assert.equal(calls,0);assert.equal(await readFile(path.join(root,'profiles/p1/snapshot.json'),'utf8'),before.snapshot);assert.equal(await readFile(path.join(root,'config.json'),'utf8'),before.config);assert.equal(await readFile(path.join(root,'accounts.json'),'utf8'),before.accounts);assert.equal(await readFile(trustFile,'utf8'),before.trust);};
 const run=async args=>{let stdout='',stderr='';const code=await main(args,{stdout:s=>stdout+=s,stderr:s=>stderr+=s,stdin:async()=>''});return {code,stdout,stderr};};
 return {home,root,config,run,unchanged};
}
function recovery(text){assert.match(text,/37soul doctor/);assert.match(text,/hook.*(?:approval|trust|load)/i);assert.match(text,/without.*repeat.*(?:choice|selection)|do not.*repeat.*(?:choice|selection)/i);assert.doesNotMatch(text,/send another message|start a new session/i);}
test('recovery: missing flags keeps the requested Host ID and diagnoses before another prompt',async t=>{const f=await fixture(t);const r=await f.run(['connect','--host','276']);assert.equal(r.code,2);assert.equal(r.stdout,'');assert.match(r.stderr,/host 276/);recovery(r.stderr);await f.unchanged();});
test('recovery: missing flags keeps an exact named Soul without directory/authentication work',async t=>{const f=await fixture(t);const r=await f.run(['connect','--name','Lila Kensington']);assert.equal(r.code,2);assert.match(r.stderr,/Lila Kensington/);recovery(r.stderr);await f.unchanged();});
test('recovery: flags without a valid source leave all local state intact and retain the target',async t=>{const f=await fixture(t);const r=await f.run(['connect','--host','276','--agent','codex','--session','synthetic-session']);assert.equal(r.code,1);assert.equal(r.stdout,'');assert.match(r.stderr,/host 276/);recovery(r.stderr);await f.unchanged();});
test('recovery: installed Codex hooks need native review/loading, not a blanket restart or repeated choice',async t=>{const f=await fixture(t);writeCodexHookConfig(f.home,{command:f.config.launcher});const checks=await hostSpec('codex').doctor({home:f.home,config:f.config,assetsMode:true});const row=checks.find(c=>c.name==='codex: SessionStart hook');assert.equal(row.ok,false);assert.equal(row.waiting,true);assert.match(row.detail,/\/hooks/);assert.match(row.detail,/load/i);assert.doesNotMatch(row.detail,/start a new session|send another message/i);assert.match(row.detail,/choice|selection|requested Soul/i);assert.match(row.detail,/trust.*not.*(?:verified|inferred)|not.*proof.*trust/i);await f.unchanged();});
test('recovery control: absent Codex hooks retain the install diagnosis and do not alter native trust',async t=>{const f=await fixture(t);const row=(await hostSpec('codex').doctor({home:f.home,config:f.config,assetsMode:true})).find(c=>c.name==='codex: SessionStart hook');assert.equal(row.ok,false);assert.match(row.detail,/install/i);await f.unchanged();});
