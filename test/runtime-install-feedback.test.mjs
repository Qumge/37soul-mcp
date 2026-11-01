import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installService, plistPath, SERVICE_LABEL } from '../dist/service.js';
import { installRuntime, planInstall, saveConfig, writeJsonFile } from '../dist/install.js';
import { runDoctor } from '../dist/doctor.js';
import { startWriter } from '../dist/local/writer.js';

async function homeFor(t) { const home=await mkdtemp(path.join(os.tmpdir(),'s37-feedback-'));t.after(()=>rm(home,{recursive:true,force:true}));return home; }
const good=()=>({code:0,stdout:'',stderr:''});

test('upgrade reloads the cached launchd job with bootout then bootstrap',async t=>{
 const home=await homeFor(t),commands=[];const launcher=path.join(home,'.37soul/runtime/0.13.2/bin/37soul');
 await mkdir(path.dirname(plistPath(home)),{recursive:true});await writeFile(plistPath(home),'<plist>old configuration</plist>');
 await installService({home,nodePath:process.execPath,scriptPath:launcher,launcherPath:launcher,logPath:path.join(home,'agentd.log'),platform:'darwin',uid:501},async argv=>{commands.push(argv);return argv[1]==='print'?{code:0,stdout:`program = ${home}/.37soul/runtime/0.13.0/bin/37soul\npid = 123`,stderr:''}:good();});
 assert.deepEqual(commands,[['launchctl','print',`gui/501/${SERVICE_LABEL}`],['launchctl','bootout',`gui/501/${SERVICE_LABEL}`],['launchctl','bootstrap','gui/501',plistPath(home)]]);
 assert.ok((await readFile(plistPath(home),'utf8')).includes(launcher));
});

test('isolated HOME must not evict another HOME launchd job with the same label',async t=>{
 const home=await homeFor(t),commands=[];
 await assert.rejects(installService({home,nodePath:process.execPath,scriptPath:'/different/cli.js',logPath:'x',platform:'darwin',uid:501},async argv=>{commands.push(argv);return {code:0,stdout:'program = /other-user-home/.37soul/runtime/0.13.2/bin/37soul\npid = 123',stderr:''};}),/different HOME/);
 assert.equal(commands.length,1);await assert.rejects(readFile(plistPath(home),'utf8'),{code:'ENOENT'});
});

test('installed runtime plans use its marker version instead of 0.0.0',async t=>{
 const home=await homeFor(t);await mkdir(path.join(home,'.pi'));
 const source=path.join(home,'.37soul/runtime/0.13.2');await mkdir(path.join(source,'dist'),{recursive:true});await writeFile(path.join(source,'package.json'),'\n{"type":"module"}');await writeFile(path.join(source,'.installed'),JSON.stringify({version:'0.13.2',mode:'bundle'}));
 const plan=await planInstall({home,cliScriptPath:path.join(source,'dist/cli.js'),nodePath:process.execPath,platform:'darwin'});
 assert.ok(plan.files.includes(source));assert.ok(!plan.files.some(f=>f.includes('/runtime/0.0.0')));
});

test('a flattened installed bundle can reinstall itself into another isolated HOME',async t=>{
 const home=await homeFor(t),source=path.join(home,'published');await mkdir(path.join(source,'dist'),{recursive:true});await writeFile(path.join(source,'dist/cli.js'),'// bundled cli\n');await writeFile(path.join(source,'dist/index.js'),'// bundled server\n');await writeFile(path.join(source,'package.json'),'{"type":"module"}');await writeFile(path.join(source,'.installed'),JSON.stringify({version:'0.13.2',mode:'bundle'}));
 const runtime=await installRuntime({home,sourceRoot:source,version:'0.13.2',nodePath:process.execPath});
 assert.equal(await readFile(path.join(runtime.dir,'dist/cli.js'),'utf8'),'// bundled cli\n');
 assert.equal(JSON.parse(await readFile(path.join(runtime.dir,'package.json'),'utf8')).version,'0.13.2');
});

async function doctorFixture(t,inspectRuntime){
 const home=await homeFor(t),root=path.join(home,'.37soul'),runtime=path.join(root,'runtime/0.13.2'),launcher=path.join(runtime,'bin/37soul');await mkdir(path.dirname(launcher),{recursive:true});await writeFile(launcher,'#!/bin/sh\n');await mkdir(path.dirname(plistPath(home)),{recursive:true});await writeFile(plistPath(home),`<string>${launcher}</string>`);
 await saveConfig(root,{api_base_url:'https://app.test',machine_id:'m1',tokens:{},runtime_dir:runtime,launcher,node_path:process.execPath});await writeJsonFile(path.join(root,'install-manifest.json'),{entries:[{kind:'service'}]});
 const report=await runDoctor({home,apiBase:'https://app.test',nodePath:process.execPath,cliScriptPath:'/pkg/dist/cli.js',platform:'darwin',fetch:async()=>{throw Error('no network');},runCommand:async()=>good(),inspectRuntime});
 return {report,runtime};
}

test('doctor does not claim a service is running just because its plist exists',async t=>{
 const {report}=await doctorFixture(t,async()=>({ok:false,detail:'writer is not running'}));
 assert.equal(report.checks.find(c=>c.name==='runtime: service').ok,false);assert.equal(report.ok,false);
});

test('doctor reports a live writer from an old runtime as version mismatch',async t=>{
 const {report}=await doctorFixture(t,async root=>({ok:true,pid:123,agentd:true,entrypoint:path.join(root,'runtime/0.13.0/dist/cli.js')}));
 const version=report.checks.find(c=>c.name==='runtime: running version');assert.ok(version);assert.equal(version.ok,false);assert.match(version.detail,/0\.13\.0/);assert.equal(report.ok,false);
});

test('doctor reports the matching live runtime version',async t=>{
 const {report}=await doctorFixture(t,async root=>({ok:true,pid:123,agentd:true,entrypoint:path.join(root,'runtime/0.13.2/dist/cli.js')}));
 assert.equal(report.checks.find(c=>c.name==='runtime: running version')?.ok,true);assert.equal(report.checks.find(c=>c.name==='runtime: service').ok,true);
});

test('writer health is a bounded real IPC probe, not a socket-file existence check',async t=>{
 const {inspectRuntime}=await import('../dist/runtime-health.js');const home=await homeFor(t),root=path.join(home,'.37soul');
 assert.equal((await inspectRuntime(root)).ok,false);
 const writer=await startWriter(root);t.after(()=>writer.close());
 const health=await inspectRuntime(root);assert.equal(health.ok,true);assert.equal(health.pid,process.pid);assert.equal(health.entrypoint,process.argv[1]);
});

test('a live transient writer must not count as the background agentd service',async t=>{
 const {report}=await doctorFixture(t,async root=>({ok:true,pid:123,agentd:false,entrypoint:path.join(root,'runtime/0.13.2/dist/cli.js')}));
 assert.equal(report.checks.find(c=>c.name==='runtime: service').ok,false);
});

test('login approval display and browser keep the configured HTTP origin and path',async t=>{
 const {deviceLogin}=await import('../dist/install.js');const home=await homeFor(t),logs=[],commands=[],requests=[];
 await deviceLogin({home,apiBase:'http://127.0.0.1:3000/site/',platform:'darwin',log:s=>logs.push(s),runCommand:async a=>{commands.push(a);return good();},fetch:async(url,opts)=>{requests.push([url,JSON.parse(opts.body)]);return requests.length===1?{status:201,json:async()=>({device_code:'secret-device',user_code:'TEST',verification_url:'https://localhost:3000/cli/approve?code=TEST',interval:1})}:{status:201,json:async()=>({tokens:[{agent_kind:'pi',token:'scoped-token'}]})};}},['pi']);
 assert.ok(logs.includes('  Open:  http://127.0.0.1:3000/site/cli/approve?code=TEST'));
 assert.deepEqual(commands,[['open','http://127.0.0.1:3000/site/cli/approve?code=TEST']]);
 assert.equal(requests[1][1].device_code,'secret-device');
 assert.ok(requests.every(([u])=>u.startsWith('http://127.0.0.1:3000/site/api/')));
});

test('install never announces local readiness when the service failed and agentd is absent',async t=>{
 const {main}=await import('../dist/cli.js');const {chmod}=await import('node:fs/promises');const home=await homeFor(t),bin=path.join(home,'fake-system');await mkdir(bin);await mkdir(path.join(home,'.pi'));
 for(const name of ['launchctl','systemctl']){const file=path.join(bin,name);await writeFile(file,'#!/bin/sh\nexit 1\n');await chmod(file,0o755);}
 const oldHome=process.env.SOUL37_HOME,oldPath=process.env.PATH,oldFetch=globalThis.fetch;process.env.SOUL37_HOME=home;process.env.PATH=`${bin}${path.delimiter}${oldPath}`;globalThis.fetch=async()=>{throw Error('no network');};
 try{let out='';const code=await main(['install'],{stdout:s=>out+=s,stderr:()=>{},stdin:async()=>''});assert.notEqual(code,0);assert.ok(!out.includes('Local use is ready'));assert.ok(!out.includes('本地已经可用'));assert.match(out,/agentd|background service/);}
 finally{if(oldHome===undefined)delete process.env.SOUL37_HOME;else process.env.SOUL37_HOME=oldHome;process.env.PATH=oldPath;globalThis.fetch=oldFetch;}
});

test('launchd environment paths are not proof that the registered program belongs to HOME',async t=>{
 const home=await homeFor(t),commands=[];
 await assert.rejects(installService({home,nodePath:process.execPath,scriptPath:'/different/cli.js',logPath:'x',platform:'darwin',uid:501},async argv=>{commands.push(argv);return {code:0,stdout:`program = /other/.37soul/runtime/0.13.0/bin/37soul\nenvironment = {\n CACHE = ${home}/.37soul/runtime\n}`,stderr:''};}),/different HOME/);
 assert.equal(commands.length,1);
});

for(const failure of ['exit','throw'])test(`failed upgrade restores and reboots the previous service (${failure})`,async t=>{
 const home=await homeFor(t),file=plistPath(home),old=`<plist>old runtime ${home}/.37soul/runtime/0.13.0/bin/37soul</plist>`;await mkdir(path.dirname(file),{recursive:true});await writeFile(file,old);const boots=[];
 await assert.rejects(installService({home,nodePath:process.execPath,scriptPath:'new',launcherPath:path.join(home,'.37soul/runtime/0.13.2/bin/37soul'),logPath:'log',platform:'darwin',uid:501},async argv=>{
  if(argv[1]==='print')return {code:0,stdout:`program = ${home}/.37soul/runtime/0.13.0/bin/37soul`,stderr:''};
  if(argv[1]==='bootstrap'){boots.push(await readFile(file,'utf8'));if(boots.length===1){if(failure==='throw')throw Error('bootstrap transport failed');return {code:1,stdout:'',stderr:'bootstrap failed'};}}
  return good();
 }),/bootstrap/);
 assert.equal(boots.length,2);assert.equal(boots[1],old);assert.equal(await readFile(file,'utf8'),old);
});

test('writer health has a total deadline even when a peer keeps sending partial bytes',async t=>{
 const net=await import('node:net');const {inspectRuntime}=await import('../dist/runtime-health.js');const home=await homeFor(t),root=path.join(home,'.37soul'),socketPath=path.join(root,'ipc/writer.sock');await mkdir(path.dirname(socketPath),{recursive:true});
 const server=net.createServer(socket=>{socket.write('{');const drip=setInterval(()=>socket.write(' '),10);const end=setTimeout(()=>socket.destroy(),900);socket.on('error',()=>{});socket.on('close',()=>{clearInterval(drip);clearTimeout(end);});});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const health=await inspectRuntime(root);assert.equal(health.ok,false);assert.match(health.detail,/timed out/);
});

test('an already loaded job with no previous plist is left running rather than stopped without rollback',async t=>{
 const home=await homeFor(t),commands=[];
 await assert.rejects(installService({home,nodePath:process.execPath,scriptPath:'new',launcherPath:path.join(home,'.37soul/runtime/0.13.2/bin/37soul'),logPath:'log',platform:'darwin',uid:501},async argv=>{commands.push(argv);return {code:0,stdout:`program = ${home}/.37soul/runtime/0.13.0/bin/37soul`,stderr:''};}),/previous.*plist|safely/);
 assert.equal(commands.length,1);
});

test('self reinstall from the installed flattened runtime retains its version and configuration',async t=>{
 const {install}=await import('../dist/install.js');const home=await homeFor(t),source=path.join(home,'package');await mkdir(path.join(home,'.pi'));await mkdir(path.join(source,'dist/bundle'),{recursive:true});await writeFile(path.join(source,'dist/bundle/cli.js'),'// fixture cli\n');await writeFile(path.join(source,'dist/bundle/index.js'),'// fixture server\n');await writeFile(path.join(source,'package.json'),'{"version":"0.13.2"}');
 const deps={home,runtimeSourceRoot:source,cliScriptPath:path.join(source,'dist/cli.js'),agentdScriptPath:path.join(source,'dist/cli.js'),nodePath:process.execPath,apiBase:'https://app.test',platform:'darwin',fetch:async()=>{throw Error('no network');},runCommand:async()=>good()};
 await install(deps,{installService:false});const runtime=path.join(home,'.37soul/runtime/0.13.2');await writeFile(path.join(runtime,'package.json'),'{"type":"module"}');
 const rerun={...deps,runtimeSourceRoot:undefined,cliScriptPath:path.join(runtime,'dist/cli.js')};
 assert.ok((await planInstall(rerun)).files.includes(runtime));await install(rerun,{installService:false});assert.equal(JSON.parse(await readFile(path.join(home,'.37soul/config.json'),'utf8')).runtime_dir,runtime);
});

test('doctor reads pid and version through an actual isolated agentd-shaped child process',async t=>{
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');const {pathToFileURL}=await import('node:url');const {inspectRuntime}=await import('../dist/runtime-health.js');
 const {report}=await doctorFixture(t,async root=>{
  const entry=path.join(root,'runtime/0.13.2/dist/cli.mjs');await mkdir(path.dirname(entry),{recursive:true});const moduleUrl=pathToFileURL(path.resolve('dist/local/writer.js')).href;
  await writeFile(entry,`import {startWriter} from ${JSON.stringify(moduleUrl)};const writer=await startWriter(${JSON.stringify(root)});console.log('ready');process.on('SIGTERM',async()=>{await writer.close();process.exit(0);});`);
  const child=spawn(process.execPath,[entry,'agentd'],{stdio:['ignore','pipe','pipe']});t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}});
  await once(child.stdout,'data');const health=await inspectRuntime(root);assert.equal(health.pid,child.pid);assert.equal(health.agentd,true);return health;
 });
 assert.equal(report.checks.find(c=>c.name==='runtime: service').ok,true);assert.equal(report.checks.find(c=>c.name==='runtime: running version').ok,true);
});

test('transient launchd bootstrap EIO after bootout is retried before rolling back',async t=>{
 const home=await homeFor(t),file=plistPath(home),commands=[],waits=[];await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'<plist>previous</plist>');let starts=0;
 const launcher=path.join(home,'.37soul/runtime/0.13.3/bin/37soul');
 await installService({home,nodePath:process.execPath,scriptPath:launcher,launcherPath:launcher,logPath:'log',platform:'darwin',uid:501,sleep:async ms=>waits.push(ms)},async argv=>{commands.push(argv);if(argv[1]==='print')return {code:0,stdout:`program = ${home}/.37soul/runtime/0.13.2/bin/37soul`,stderr:''};if(argv[1]==='bootstrap'&&++starts===1)return {code:5,stdout:'',stderr:'Bootstrap failed: 5: Input/output error'};return good();});
 assert.equal(starts,2);assert.equal(commands.filter(a=>a[1]==='bootout').length,1);assert.ok(waits.length>0);assert.ok((await readFile(file,'utf8')).includes(launcher));
});

test('bootstrap EIO retries are bounded and an exhausted upgrade restores the previous job',async t=>{
 const home=await homeFor(t),file=plistPath(home),old='<plist>previous</plist>';await mkdir(path.dirname(file),{recursive:true});await writeFile(file,old);let starts=0;const waits=[];
 await assert.rejects(installService({home,nodePath:process.execPath,scriptPath:'new',launcherPath:path.join(home,'.37soul/runtime/0.13.3/bin/37soul'),logPath:'log',platform:'darwin',uid:501,sleep:async ms=>waits.push(ms)},async argv=>{if(argv[1]==='print')return {code:0,stdout:`program = ${home}/.37soul/runtime/0.13.2/bin/37soul`,stderr:''};if(argv[1]==='bootstrap'&&++starts<=6)return {code:5,stdout:'',stderr:'EIO'};return good();}),/bootstrap/);
 assert.equal(starts,7);assert.equal(waits.length,5);assert.equal(await readFile(file,'utf8'),old);
});
