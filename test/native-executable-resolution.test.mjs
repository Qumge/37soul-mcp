import test from 'node:test';
import {execFile} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, chmod, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createNativeInvoker} from '../dist/agentd/native-invoker.js';
import {renderPlist, renderSystemdUnit} from '../dist/service.js';

async function fixture(run) {
 const home=await mkdtemp(path.join(os.tmpdir(),'native-resolution-'));
 const launcher=async relative=>{const file=path.join(home,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({path:process.env.PATH,uid:process.env.SOUL37_INTERNAL_JOB_UID}));');await chmod(file,0o700);return file;};
 try {await run({home,launcher});} finally {await rm(home,{recursive:true,force:true});}
}
function recorder(version='2.0.32', fail=false) {
 const calls=[];
 const spawn=(command,args,options,cb)=>{calls.push({command,args,options});cb(fail?new Error('broken launcher'):null,args[0]==='--version'?version:'[]','');return {stdin:{write(){},end(){}},kill(){}};};
 return {calls,spawn};
}
test('all five native hosts prefer canonical user launchers over PATH duplicates',async()=>{
 await fixture(async({home,launcher})=>{
  for(const [kind,relative,binary] of [['claude-code','.local/bin/claude','claude'],['codex','.local/bin/codex','codex'],['opencode','.opencode/bin/opencode','opencode'],['hermes','.local/bin/hermes','hermes'],['pi','.local/bin/pi','pi']]) {
   const canonical=await launcher(relative);await launcher('old/bin/'+binary);
   const {calls,spawn}=recorder();const invoke=createNativeInvoker(undefined,spawn,{home,nodePath:process.execPath,env:{PATH:path.join(home,'old/bin')}});
   assert.equal((await invoke(kind,['run'],'input','job')).code,0);
   assert.ok(calls.length>0);assert.ok(calls.every(call=>call.command===canonical),kind);
  }
 });
});
test('missing canonical launcher falls back to an executable absolute PATH entry',async()=>{
 await fixture(async({home,launcher})=>{
  const fallback=await launcher('custom/bin/codex');const {calls,spawn}=recorder();
  await createNativeInvoker(undefined,spawn,{home,nodePath:process.execPath,env:{PATH:path.dirname(fallback)}})('codex',[],'','job');
  assert.equal(calls[0].command,fallback);
 });
});
test('OpenCode v1 PATH fallback is rejected before extraction and canonical failure never retries old PATH',async()=>{
 await fixture(async({home,launcher})=>{
  await launcher('old/bin/opencode');const old=recorder('1.1.36');
  const result=await createNativeInvoker(undefined,old.spawn,{home,env:{PATH:path.join(home,'old/bin')}})('opencode',['run'],'private-input','job');
  assert.notEqual(result.code,0);assert.match(result.stderr,/version|generation/i);assert.deepEqual(old.calls.map(c=>c.args),[['--version']]);
  const canonical=await launcher('.opencode/bin/opencode');const broken=recorder('2.0.32',true);
  assert.notEqual((await createNativeInvoker(undefined,broken.spawn,{home,env:{PATH:path.join(home,'old/bin')}})('opencode',['run'],'','job')).code,0);
  assert.ok(broken.calls.every(c=>c.command===canonical));
 });
});
test('foreground invoker executes env-node shebang with recorded node directory and known home bins',async()=>{
 await fixture(async({home,launcher})=>{
  await launcher('.local/bin/codex');
  const guardedSpawn=(command,args,options,cb)=>{assert.ok(command.startsWith(home+path.sep),'only execute temporary fake launchers');return execFile(command,args,options,cb);};
  const result=await createNativeInvoker(undefined,guardedSpawn,{home,nodePath:process.execPath,env:{PATH:'/usr/bin:/bin'}})('codex',[],'','job-shebang');
  assert.equal(result.code,0,result.stderr);const env=JSON.parse(result.stdout);
  assert.equal(env.uid,'job-shebang');assert.equal(env.path.split(':')[0],path.dirname(process.execPath));
  assert.ok(env.path.split(':').includes(path.join(home,'.opencode/bin')));
 });
});
test('missing executables fail without spawning and injected legacy fake commands stay usable',async()=>{
 await fixture(async({home})=>{
  const {calls,spawn}=recorder();
  assert.notEqual((await createNativeInvoker(undefined,spawn,{home,nodePath:'/nonexistent/node',env:{PATH:''}})('codex',[],'','job')).code,0);
  assert.equal(calls.length,0);
  await createNativeInvoker(undefined,spawn)('codex',[],'','job');assert.equal(calls[0].command,'codex');
 });
});
test('service renderers serialize only explicit PATH with XML and systemd escaping',()=>{
 const executionPath='/node & bin:/home/u/100%/bin:/quote"/back\\slash:/line\nnext:/usr/bin';
 const spec={home:'/home/u',nodePath:'/node/bin/node',scriptPath:'/runtime/cli.js',logPath:'/log',executionPath};
 const plist=renderPlist(spec);assert.match(plist,/<key>EnvironmentVariables<\/key>/);assert.ok(plist.includes('<key>PATH</key>'));assert.ok(plist.includes('/node &amp; bin:'));assert.ok(plist.includes('/quote&quot;'));
 const unit=renderSystemdUnit(spec);assert.ok(unit.includes('Environment="PATH=/node & bin:/home/u/100%%/bin:/quote\\"/back\\\\slash:/line\\nnext:/usr/bin"'));
 assert.doesNotMatch(plist+unit,/OPENAI_API_KEY|ANTHROPIC_API_KEY|HOME<\/key>/);
});
