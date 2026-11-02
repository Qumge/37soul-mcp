import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDaemon, defaultDiscover } from '../dist/agentd/daemon.js';
import { UploadQueue } from '../dist/agentd/queue.js';

const retired = ['log_turn', 'remember', 'resume', 'checkpoint'];
const metadata = [undefined, '{broken', '{}', '{"owner":{"soul_sync_mode":"unknown"}}'];
const item = { id:'raw:1-1', sessionKey:'raw', agentKind:'claude-code', machineId:'m1', externalId:'s1', session:{external_id:'s1'}, seqFrom:1, seqTo:1, events:[{seq:1,at:new Date().toISOString(),role:'user',text:'PRIVATE-RAW'}], createdAt:0, attempts:0, nextAttemptAt:0 };
for (const [i, accounts] of metadata.entries()) {
  test(`retired tools reject calls without network; metadata case ${i}`, async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'retire-mcp-'));
    const root = path.join(home, '.37soul'); await mkdir(root);
    if (accounts !== undefined) await writeFile(path.join(root,'accounts.json'), accounts);
    const calls=[];
    const api=createServer((req,res)=>{ calls.push(req.url); req.resume(); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{}'); });
    api.listen(0,'127.0.0.1'); await once(api,'listening');
    const client=new Client({name:'retirement',version:'1'});
    try {
      await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...process.env,HOME:home,SOUL37_HOME:home,SOUL37_API_TOKEN:'legacy-secret',SOUL37_HOST_ID:'262',SOUL37_BASE_URL:`http://127.0.0.1:${api.address().port}`,SOUL37_OPERATION_STATE_PATH:path.join(home,'operations.json')},stderr:'ignore'}));
      const {tools}=await client.listTools();
      for (const name of retired) {
        const r=await client.callTool({name,arguments:{host_id:262,content:'PRIVATE-RAW',user_message:'PRIVATE-RAW',host_message:'PRIVATE-RAW',repo:'private',branch:'main',body:{notes:'PRIVATE-RAW'}}});
        assert.equal(r.isError,true, `${name} must reject`);
      }
      assert.deepEqual(calls,[], 'retired calls must cause zero HTTP requests');
      assert.deepEqual(tools.filter(t=>retired.includes(t.name)),[]);
      for (const name of ['list_hosts','get_host','chat_with_host','instruct_post','whoami','shoot']) assert.ok(tools.some(t=>t.name===name));
    } finally { await client.close(); await new Promise(r=>api.close(r)); await rm(home,{recursive:true,force:true}); }
  });
  test(`agentd with stored tokens and raw queue is inert; metadata case ${i}`, async () => {
    const home=await mkdtemp(path.join(tmpdir(),'retire-cli-')); const root=path.join(home,'.37soul'); await mkdir(root);
    if(accounts!==undefined) await writeFile(path.join(root,'accounts.json'),accounts);
    const calls=[]; const api=createServer((req,res)=>{calls.push(req.url);req.resume();res.writeHead(202,{'Content-Type':'application/json'});res.end('{}');});
    api.listen(0,'127.0.0.1'); await once(api,'listening');
    const config={machine_id:'m1',api_base_url:`http://127.0.0.1:${api.address().port}`,tokens:{'claude-code':'legacy-secret'},transcript_fallback:['claude-code']};
    await writeFile(path.join(root,'config.json'),JSON.stringify(config));
    const queue=new UploadQueue({root}); await queue.enqueue(item); const before=await queue.list();
    const child=spawn(process.execPath,['dist/cli.js','agentd'],{env:{...process.env,HOME:home,SOUL37_HOME:home,SOUL37_BASE_URL:config.api_base_url},stdio:'ignore'});
    try {
      let ready=false;
      for(let n=0;n<100;n++){ try { ready=(await readFile(path.join(root,'agentd.log'),'utf8')).includes('agentd started'); }catch{} if(ready)break; await new Promise(r=>setTimeout(r,50)); }
      assert.ok(ready,'agentd must reach startup tick');
      assert.deepEqual(calls,[], 'stored legacy token must never authorize upload');
      assert.deepEqual(await queue.list(),before,'old queue must remain untouched');
      assert.deepEqual(JSON.parse(await readFile(path.join(root,'config.json'),'utf8')),config);
    } finally { child.kill('SIGTERM'); await once(child,'exit'); await new Promise(r=>api.close(r)); await rm(home,{recursive:true,force:true}); }
  });
}
test('direct daemon ignores legacy credentials, discovery and queued raw events',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'retire-direct-')); const queue=new UploadQueue({root});await queue.enqueue(item);const before=await queue.list();const requests=[];
 const config={root,home:root,machineId:'m1',apiBaseUrl:'https://invalid.test',tokens:{'claude-code':'secret'},transcriptFallback:['claude-code']};
 const daemon=createDaemon(config,{queue,fetch:async(url)=>{requests.push(url);return new Response('{}',{status:202});},acquireLock:async()=>async()=>{}});
 try{await daemon.processQueue();await daemon.tick();assert.deepEqual(requests,[]);assert.deepEqual(await queue.list(),before);assert.deepEqual(await defaultDiscover(config)(),[]);}finally{await daemon.stop();await rm(root,{recursive:true,force:true});}
});
test('whoami never instructs the model to use retired raw writeback',async()=>{
 const {renderWhoami}=await import('../dist/soul.js');
 assert.doesNotMatch(renderWhoami({host:{id:262,nickname:'Test'}}),/`log_turn`|send the exchange back/);
});
test('standalone raw uploader is retired even with valid legacy credentials', async()=>{
 const {uploadBatch}=await import('../dist/agentd/uploader.js');let calls=0;
 const result=await uploadBatch({baseUrl:'https://invalid.test',tokenFor:()=> 'valid-secret',fetch:async()=>{calls++;return new Response('{}',{status:202});}},item);
 assert.equal(calls,0);assert.equal(result.status,'retired');
});
for(const mode of ['old-entry','SessionStart','UserPromptSubmit','Stop','PreCompact','PostToolUse']) {
 test(`hook retires raw spool and remote/cache brief: ${mode}`,async()=>{
  const {runHook,runHookCommand}=await import('../dist/hook.js');
  const {cachePath}=await import('../dist/agentd/brief-cache.js');
  const home=await mkdtemp(path.join(tmpdir(),'retire-hook-'));const root=path.join(home,'.37soul');await mkdir(root);
  await writeFile(path.join(root,'config.json'),JSON.stringify({machine_id:'m1',api_base_url:'https://invalid.test',tokens:{'claude-code':'secret'}}));
  const cache=cachePath(root,'path:m1:/tmp/private',null);await mkdir(path.dirname(cache),{recursive:true});await writeFile(cache,'PRIVATE-OLD-BRIEF');
  const calls=[],out=[];
  const deps={home,agentKind:'claude-code',stdin:JSON.stringify({session_id:'s1',cwd:'/tmp/private',prompt:'PRIVATE-RAW',last_assistant_message:'PRIVATE-RAW',tool_name:'Bash',tool_input:{command:'PRIVATE-RAW'}}),fetch:async url=>{calls.push(url);return new Response(JSON.stringify({text:'PRIVATE-REMOTE-BRIEF'}));},stdout:t=>out.push(t),stderr:()=>{},getGitState:async()=>({repo:{remote:null,branch:null},git_state:null})};
  try{
   if(mode==='old-entry') await runHook(deps);else await runHookCommand({...deps,event:mode});
   assert.deepEqual(calls,[]);assert.deepEqual(out,[]);
   const {readdir}=await import('node:fs/promises');
   assert.deepEqual(await readdir(path.join(root,'spool')).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e)),[]);
   assert.equal(await readFile(cache,'utf8'),'PRIVATE-OLD-BRIEF');
  }finally{await rm(home,{recursive:true,force:true});}
 });
}
