import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runDoctor} from '../dist/doctor.js';
import {saveConfig} from '../dist/agentd/state.js';
test('doctor never presents retired raw spool as current host activity',async()=>{
 const home=mkdtempSync(path.join(tmpdir(),'doctor-current-'));const root=path.join(home,'.37soul');
 try{
  await saveConfig(root,{api_base_url:'https://37soul.com',machine_id:'fake',tokens:{pi:'FAKE_OLD_TOKEN'}});
  const spool=path.join(root,'spool','pi');mkdirSync(spool,{recursive:true});writeFileSync(path.join(spool,'old.jsonl'),'{}\n');
  const report=await runDoctor({home,apiBase:'https://37soul.com',fetch:async()=>{throw new Error('network forbidden')},runCommand:async()=>({code:0,stdout:'',stderr:''}),nodePath:process.execPath,cliScriptPath:'/unused',inspectRuntime:async()=>({ok:false,detail:'fixture'}),lang:'en'});
  assert.ok(!report.checks.some(c=>/spool backlog|hook activity/.test(c.name)),'retired spool must not appear as current activity, either green or waiting');
 }finally{rmSync(home,{recursive:true,force:true})}
});
