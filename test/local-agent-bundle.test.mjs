/** Exercise the shipped single-file CLI, real HTTP and transient writer IPC. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, copyFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../dist/local/store.js';
import {captureSourcePointer} from '../dist/agentd/source-index.js';

const exec=promisify(execFile);
test('bundle: one local login powers identity read and exact-session attachment without remote OAuth',async t=>{
 const home=await mkdtemp(path.join(tmpdir(),'soul-bundle-connect-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const token='SYNTHETIC-BUNDLE-CREDENTIAL';
 const uid='10000000-0000-4000-8000-000000000277';
 let calls=0;
 const server=createServer((request,response)=>{
   calls++;
   assert.equal(request.url,'/api/v1/me/hosts/277/soul');
   assert.equal(request.headers.authorization,`Bearer ${token}`);
   response.writeHead(200,{'Content-Type':'application/json'});
   response.end(JSON.stringify({you_are:'You are Sophia Ramirez',host:{id:277,nickname:'Sophia Ramirez'}}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const base=`http://127.0.0.1:${server.address().port}`;
 const root=path.join(home,'.37soul');
 await mkdir(path.join(root,'profiles','p1'),{recursive:true});
 await writeFile(path.join(root,'profiles','p1','device.json'),JSON.stringify({device_id:'device'}));
 const store=await openStore(root,'p1');
 await store.transact(d=>{
   d.owner_id='owner';d.cloud_issuer=base;d.cloud_device_uid='cloud-device';
   d.souls[uid]={soul_uid:uid,legacy_host_id:277,origin:'cloud',state:'active',identity_revision:1,identity:{name:'Sophia Ramirez',character:'Curious and thoughtful.',description:'',greeting:''}};
   d.consents[`cloud-device:${uid}`]={cloud_device_uid:'cloud-device',soul_uid:uid,revision:1,enabled:true,categories:['identity','relationship','experience']};
 });await store.close();
 await writeFile(path.join(root,'config.json'),JSON.stringify({api_base_url:base,machine_id:'machine',active_profile_id:'p1',tokens:{},credentials:[{issuer:base,profile_id:'p1',owner_id:'owner',cloud_device_uid:'cloud-device',runtime_kind:'claude-code',token}]}));
 await writeFile(path.join(root,'accounts.json'),JSON.stringify({owner:{profile_id:'p1',cloud_issuer:base,default_soul_uid:uid,soul_sync_mode:'assets_only'}}));
 const transcript=path.join(home,'native.jsonl');await writeFile(transcript,'history before attachment\n');
 await captureSourcePointer(root,'p1',randomUUID(),{runtime_kind:'claude-code',native_session_id:'exact-session',path:transcript,captured_at:new Date().toISOString()});
 // The copied bundle has no adjacent dependencies or source tree.
 const stage=path.join(home,'standalone');await mkdir(stage);
 await copyFile(new URL('../dist/bundle/cli.js',import.meta.url),path.join(stage,'cli.js'));
 await writeFile(path.join(stage,'package.json'),JSON.stringify({type:'module'}));
 const options={cwd:stage,env:{...process.env,SOUL37_HOME:home,SOUL37_BASE_URL:base},timeout:10000};
 for(const command of [['whoami','--host','277','--agent','claude-code'],['connect','--host','277','--agent','claude-code','--session','exact-session']]){
   const output=await exec(process.execPath,[path.join(stage,'cli.js'),...command],options);
   assert.equal(output.stderr,'');assert.ok(!output.stdout.includes(token));
   const value=JSON.parse(output.stdout);assert.equal(value.host.id,277);
   if(command[0]==='connect')assert.equal(value.connection.state,'attached');
 }
 assert.equal(calls,2,'no remote MCP or OAuth request occurs');
 const after=JSON.parse(await readFile(path.join(root,'profiles','p1','snapshot.json'),'utf8'));
 const [binding]=Object.values(after.bindings);
 assert.equal(binding.native_session_id,'exact-session');assert.equal(binding.soul_uid,uid);
 assert.ok(binding.source_boundary.start_offset>0);
 assert.ok(!JSON.stringify(after.outbox).includes(transcript));
});
