import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {installService,removeService,plistPath} from '../dist/service.js';
async function fixture(run){const home=await mkdtemp(path.join(os.tmpdir(),'mac-service-reenable-'));try{await run({home,nodePath:'/usr/bin/node',scriptPath:path.join(home,'.37soul/runtime/0.14.0/dist/cli.js'),logPath:path.join(home,'.37soul/agentd.log'),platform:'darwin',uid:501,sleep:async()=>{}});}finally{await rm(home,{recursive:true,force:true});}}
test('macOS uninstall then reinstall enables the owned label before bootstrap',()=>fixture(async spec=>{
 let loaded=false,disabled=false;const commands=[];
 const run=async argv=>{commands.push(argv);if(argv[1]==='print')return loaded?{code:0,stdout:`program = ${spec.nodePath}\narguments = {\n${spec.scriptPath}\n}`,stderr:''}:{code:1,stdout:'',stderr:'not loaded'};if(argv[1]==='unload'){loaded=false;disabled=true;}if(argv[1]==='enable')disabled=false;if(argv[1]==='bootstrap'){if(disabled)return {code:5,stdout:'',stderr:'disabled override'};loaded=true;}return {code:0,stdout:'',stderr:''};};
 await installService(spec,run);await removeService(spec,run);assert.equal(disabled,true);const before=commands.length;
 await installService(spec,run);assert.equal(loaded,true);assert.equal(disabled,false);
 const after=commands.slice(before).map(c=>c[1]);assert.ok(after.indexOf('enable')<after.indexOf('bootstrap'));assert.equal(commands.slice(before).find(c=>c[1]==='enable')[2],'gui/501/com.37soul.agentd');
}));
test('macOS enable failure is surfaced before bootstrap and restores staged plist',()=>fixture(async spec=>{
 const file=plistPath(spec.home);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'previous-owned-plist');const commands=[];
 const run=async argv=>{commands.push(argv);return argv[1]==='print'?{code:1,stdout:'',stderr:'not loaded'}:argv[1]==='enable'?{code:1,stdout:'',stderr:'permission denied'}:{code:0,stdout:'',stderr:''};};
 await assert.rejects(installService(spec,run),/enable/);assert.equal(commands.some(c=>c[1]==='bootstrap'),false);assert.equal(await readFile(file,'utf8'),'previous-owned-plist');
}));
