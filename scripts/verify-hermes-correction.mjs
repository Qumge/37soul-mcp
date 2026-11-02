#!/usr/bin/env node
// Synthetic local acceptance only. Import is pure; live stages require explicit arguments.
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync,rmSync,chmodSync,appendFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const SELF=fileURLToPath(import.meta.url), ROOT='/private/tmp/hf-final', BUILD='/private/tmp/hf-build';
export function nativePaths(home=os.homedir()){return {real_binary:path.join(home,'.local/bin/hermes'),python:path.join(home,'.hermes/hermes-agent/venv/bin/python')};}
export function recordedNative(s,key){const value=s[key];if(!value||!path.isAbsolute(value)||value.startsWith(s.home+path.sep))throw Error('unsafe_native_path');return value;}
const POINTER='/private/tmp/37soul-final-hermes-approved-home.txt', PROFILE='browser-delivery';
const OLD=['Alpha','Beta','Gamma'], LABELS=['Juniper','Willow','Cedar'];
const read=p=>JSON.parse(readFileSync(p,'utf8')), hash=s=>createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function privateFile(p,s){mkdirSync(path.dirname(p),{recursive:true,mode:0o700});writeFileSync(p,s,{mode:0o600});chmodSync(p,0o600);}
const save=s=>privateFile(ROOT+'/state.json',JSON.stringify(s,null,2));
const snap=s=>read(s.home+'/.37soul/profiles/'+PROFILE+'/snapshot.json');
export function takeEntry(count){if(!Number.isSafeInteger(count)||count<0||count>=4)throw Error('hermes_budget_exhausted');return count+1;}
export function assessCorrection(e){
 const ordered=text=>typeof text==='string'&&e.labels.every((x,i)=>text.includes(x)&&(i===0||text.indexOf(x)>text.indexOf(e.labels[i-1])))&&e.oldLabels.every(x=>!text.includes(x));
 const bound=e.bindings.some(b=>b.binding_uid===e.freshBinding&&b.binding_uid!==e.learnBinding&&b.runtime_kind==='hermes'&&b.soul_uid===e.soul&&b.native_session_id===e.nativeSession);
 const receipts=e.receipts.filter(r=>r.binding_uid===e.freshBinding&&r.stage==='injected');
 const injected=receipts.some(r=>r.manifest?.some(m=>m.asset_uid===e.newAsset&&m.revision===e.revision))&&receipts.every(r=>r.manifest?.every(m=>m.asset_uid!==e.oldAsset));
 const unprompted=[e.prompt,e.nativePrompt].every(p=>typeof p==='string'&&e.labels.every(x=>!p.includes(x)));
 return {pass:e.exit===0&&bound&&injected&&unprompted&&e.nativePrompt===e.prompt&&ordered(e.answer)&&ordered(e.nativeAnswer)&&['superseded','deleted','rejected'].includes(e.oldState),bound,injected,unprompted,stdout_adoption:ordered(e.answer),native_adoption:ordered(e.nativeAnswer)};
}
function environment(s){
 const keys=['PATH','LANG','TERM','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY'];
 const env=Object.fromEntries(keys.filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 return {...env,HOME:s.home,SOUL37_HOME:s.home,HERMES_HOME:s.home+'/.hermes',XDG_CONFIG_HOME:s.home+'/.config',XDG_DATA_HOME:s.home+'/.local/share',XDG_CACHE_HOME:s.home+'/.cache',XDG_STATE_HOME:s.home+'/.state',SOUL37_BASE_URL:'http://127.0.0.1:8087',SOUL37_LAUNCHER:s.launcher||'',HERMES_FINAL_ROOT:ROOT,PATH:s.home+'/.local/bin:'+env.PATH};
}
function run(binary,args,env,cwd,input='',timeout=100000){return new Promise(resolve=>{
 let stdout='',stderr='',done=false;const child=spawn(binary,args,{env,cwd,stdio:['pipe','pipe','pipe'],detached:true});
 const finish=code=>{if(done)return;done=true;clearTimeout(timer);resolve({code,stdout,stderr});};
 const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}finish(124);},timeout);
 child.stdout.on('data',b=>stdout=(stdout+b).slice(-2000000));child.stderr.on('data',b=>stderr=(stderr+b).slice(-128000));child.stdin.on('error',()=>{});child.stdin.end(input);child.on('error',()=>finish(127));child.on('close',c=>finish(c??1));
});}
function checked(r,label){if(r.code!==0)throw Error(label);return r;}
async function cli(s,args){return checked(await run(s.launcher,[...args,'--profile',PROFILE],environment(s),s.home+'/work'),'cli_failed');}
async function until(f,ms=90000){const end=Date.now()+ms;while(Date.now()<end){const v=await f();if(v)return v;await sleep(500);}throw Error('evidence_timeout');}
async function prepare(){
 if(existsSync(ROOT+'/state.json'))throw Error('already_prepared');
 const home=readFileSync(POINTER,'utf8').trim();if(!/^\/private\/tmp\/hf-[A-Za-z0-9]+$/.test(home))throw Error('unsafe_home');
 const s={home,...nativePaths(),stage:'preparing',model_entries:0,install_service:false,events:[]};
 const p=snap(s);if(p.cloud_issuer!=='http://127.0.0.1:8087'||!p.cloud_device_uid)throw Error('real_device_login_required');
 privateFile(ROOT+'/budget.json','0');
 // Copy only the existing provider's model configuration and credentials, never user memory or hook approvals.
 const config=checked(await run(recordedNative(s,'python'),['-c','import json,yaml,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1]))["model"]))',path.join(os.homedir(),'.hermes/config.yaml')],environment(s),home),'model_config_unavailable');
 const model=JSON.parse(config.stdout);
 privateFile(home+'/.hermes/config.yaml',Object.entries({model,agent:{max_turns:1},toolsets:[],mcp_servers:{},plugins:{},memory:{memory_enabled:false,user_profile_enabled:false}}).map(([k,v])=>k+': '+JSON.stringify(v)).join('\n')+'\n');
 if(existsSync(path.join(os.homedir(),'.hermes/auth.json')))privateFile(home+'/.hermes/auth.json',readFileSync(path.join(os.homedir(),'.hermes/auth.json'),'utf8'));
 const dotenv=readFileSync(path.join(os.homedir(),'.hermes/.env'),'utf8').split('\n').filter(l=>/^\s*DEEPSEEK_(API_KEY|BASE_URL)\s*=/.test(l)).join('\n');
 privateFile(home+'/.hermes/.env',dotenv+'\n');
 const q=x=>"'"+x.replace(/'/g,"'\\''")+"'";
 privateFile(home+'/.local/bin/hermes','#!/bin/sh\nexec '+q(process.execPath)+' '+q(SELF)+' --gate "$@"\n');chmodSync(home+'/.local/bin/hermes',0o700);
 const {install}=await import(BUILD+'/dist/install.js');
 await install({home,apiBase:'http://127.0.0.1:8087',fetch:async()=>{throw Error('install_network_forbidden');},runCommand:async()=>{throw Error('install_service_forbidden');},nodePath:process.execPath,cliScriptPath:BUILD+'/dist/cli.js',agentdScriptPath:BUILD+'/dist/cli.js',runtimeSourceRoot:BUILD,log:()=>{}},{agents:['hermes'],installService:false});
 s.launcher=read(home+'/.37soul/config.json').launcher;
 const socket=home+'/.37soul/profiles/'+PROFILE+'/writer.sock';s.socket_bytes=Buffer.byteLength(socket);if(s.socket_bytes>=100)throw Error('ipc_path_too_long');
 s.hook_sha256=hash(readFileSync(home+'/.hermes/agent-hooks/37soul-hook.py'));
 s.config_sha256=hash(readFileSync(home+'/.hermes/config.yaml'));
 s.stage='await_official_consent';save(s);
 console.log(JSON.stringify({stage:s.stage,home,real_binary:s.real_binary,hook_sha256:s.hook_sha256,model_entries:0,socket_bytes:s.socket_bytes,consent:'Run official Hermes chat TTY with this isolated environment, approve pre_llm_call and post_llm_call, exit without a model prompt. Never write an approval marker.'}));
}
async function start(s){
 if(s.stage!=='await_official_consent')throw Error('stage_refused');
 const approved=checked(await run(recordedNative(s,'real_binary'),['hooks','list'],environment(s),s.home+'/work'),'official_hooks_list_failed').stdout;
 if(!/pre_llm_call/.test(approved)||!/post_llm_call/.test(approved)||/not allowlisted/.test(approved)||!existsSync(s.home+'/.hermes/shell-hooks-allowlist.json'))throw Error('official_consent_required');
 if(hash(readFileSync(s.home+'/.hermes/agent-hooks/37soul-hook.py'))!==s.hook_sha256||hash(readFileSync(s.home+'/.hermes/config.yaml'))!==s.config_sha256)throw Error('approved_hooks_changed');
 s.official_consent_verified=true;
 const daemon=spawn(s.launcher,['agentd'],{env:environment(s),cwd:s.home+'/work',detached:true,stdio:'ignore'});daemon.unref();s.daemon_pid=daemon.pid;save(s);
 const {sendWriter}=await import(BUILD+'/dist/local/writer.js');
 await until(async()=>{try{return (await sendWriter(s.home+'/.37soul',{request_uid:randomUUID(),profile_id:PROFILE,command:'health',payload:{}})).ok;}catch{return false;}},15000);
 const created=await cli(s,['soul','create','--name','Hermes-Final-'+randomUUID().slice(0,6),'--sex','other','--age','24','--character','An independent synthetic acceptance assistant. Calm and concise, careful with evidence, remembers enduring delivery preferences. No real person or private data.']);
 s.soul_uid=/created soul ([a-f0-9-]{36})/i.exec(created.stdout)?.[1];if(!s.soul_uid)throw Error('soul_create_failed');
 await cli(s,['soul','authorize',s.soul_uid,'--categories','identity,relationship,experience']);await cli(s,['sync']);await cli(s,['soul','select',s.soul_uid]);
 s.stage='prepared';s.old_ids=Object.keys(snap(s).assets);save(s);console.log(JSON.stringify({stage:s.stage,soul_uid:s.soul_uid,model_entries:0,service:false}));
}
async function gate(args){
 const s=read(ROOT+'/state.json');if(!args.length||args[0]!=='chat')throw Error('non_model_gate_refused');
 mkdirSync(ROOT+'/budget.lock',{mode:0o700});let count;
 try{count=takeEntry(read(ROOT+'/budget.json'));privateFile(ROOT+'/budget.json',JSON.stringify(count));appendFileSync(ROOT+'/entries.jsonl',JSON.stringify({count,internal:!!process.env.SOUL37_INTERNAL_JOB_UID,at:new Date().toISOString()})+'\n',{mode:0o600});}finally{rmSync(ROOT+'/budget.lock',{recursive:true,force:true});}
 const child=spawn(recordedNative(s,'real_binary'),args,{env:process.env,cwd:process.cwd(),stdio:'inherit'});const timer=setTimeout(()=>child.kill('SIGKILL'),80000);await new Promise(r=>{child.on('error',()=>{process.exitCode=127;r();});child.on('close',c=>{process.exitCode=c??1;r();});});clearTimeout(timer);
}
const modelArgs=['chat','--query-file','-','--oneshot','-Q','--ignore-rules','--source','tool','--toolsets','','--max-turns','1','--run-budget','60'];
async function model(s,prompt){
 if(!s.official_consent_verified)throw Error('consent_missing');
 if(hash(readFileSync(s.home+'/.hermes/agent-hooks/37soul-hook.py'))!==s.hook_sha256)throw Error('hook_changed');
 return run(s.home+'/.local/bin/hermes',modelArgs,environment(s),s.home+'/work',prompt,100000);
}
async function learn(s){
 if(s.stage!=='prepared')throw Error('stage_refused');
 const r=await model(s,`Please remember my enduring preference: in every future Hermes delivery summary use the headings ${OLD.join(', ')} in that order. This is a lasting preference, not just this reply. Acknowledge briefly without tools.`);
 s.events.push({stage:'learn',exit:r.code,assistant_sha256:hash(r.stdout)});save(s);checked(r,'learn_failed');
 const asset=await until(()=>Object.values(snap(s).assets).find(a=>a.soul_uid===s.soul_uid&&!s.old_ids.includes(a.asset_uid)&&OLD.every(x=>a.content.includes(x))));
 const wm=Object.values(snap(s).extraction_watermarks).find(w=>w.completed&&w.request?.runtime_kind==='hermes'&&w.request?.soul_uid===s.soul_uid&&w.request?.source_turn_refs?.length>=2);
 if(!wm)throw Error('automatic_extraction_missing');s.learn_binding=asset.binding_uid;s.old_asset=asset.asset_uid;s.learn_source_refs=wm.request.source_turn_refs;
 await cli(s,['sync']);const cloud=snap(s).assets[s.old_asset];if(cloud.sync_state!=='synced'||!cloud.cloud_revision)throw Error('cloud_ack_missing');
 s.stage='learn_synced';s.cloud_revision=cloud.cloud_revision;save(s);console.log(JSON.stringify({stage:s.stage,soul_uid:s.soul_uid,old_asset:s.old_asset,entries:read(ROOT+'/budget.json')}));
}
async function corrected(s){
 if(s.stage!=='learn_synced')throw Error('stage_refused');
 await cli(s,['sync']);const p=snap(s),replacement=Object.values(p.assets).find(a=>a.soul_uid===s.soul_uid&&a.asset_uid!==s.old_asset&&a.state==='active'&&LABELS.every(x=>a.content.includes(x)));
 if(!replacement||p.assets[s.old_asset]?.state==='active')throw Error('owner_correction_not_pulled');
 s.new_asset=replacement.asset_uid;s.new_revision=replacement.revision;s.old_state=p.assets[s.old_asset]?.state;s.stage='corrected';save(s);console.log(JSON.stringify({stage:s.stage,new_asset:s.new_asset,old_state:s.old_state,entries:read(ROOT+'/budget.json')}));
}
async function nativeRows(s){
 const py='import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); c.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in c.execute("SELECT session_id,role,content FROM messages ORDER BY rowid")]))';
 return JSON.parse(checked(await run(recordedNative(s,'python'),['-c',py,s.home+'/.hermes/state.db'],environment(s),s.home),'native_db_unavailable').stdout);
}
async function fresh(s){
 if(s.stage!=='corrected')throw Error('stage_refused');
 const before=snap(s),priorReceipts=new Set(Object.keys(before.receipts)),priorBindings=new Set(Object.values(before.bindings).map(b=>b.binding_uid));
 const prompt='Give a short Hermes delivery summary for a fictional project whose work is finished and has no blockers. Do not call tools.';
 const priorNative=new Set((await nativeRows(s)).map(r=>r.session_id));
 const r=await model(s,prompt);s.events.push({stage:'fresh',exit:r.code,assistant_sha256:hash(r.stdout)});save(s);
 const p=snap(s),bindings=Object.values(p.bindings).filter(b=>!priorBindings.has(b.binding_uid)&&b.runtime_kind==='hermes'&&b.soul_uid===s.soul_uid);
 const rows=(await nativeRows(s)).filter(r=>!priorNative.has(r.session_id));
 const human=rows.find(r=>r.role==='user'&&r.content===prompt),answer=rows.filter(r=>r.role==='assistant'&&r.session_id===human?.session_id).at(-1);
 const binding=bindings.find(b=>b.native_session_id===human?.session_id);
 const e={soul:s.soul_uid,oldAsset:s.old_asset,newAsset:s.new_asset,revision:s.new_revision,oldState:p.assets[s.old_asset]?.state,learnBinding:s.learn_binding,freshBinding:binding?.binding_uid,bindings,receipts:Object.entries(p.receipts).filter(([id])=>!priorReceipts.has(id)).map(([,v])=>v),labels:LABELS,oldLabels:OLD,prompt,answer:r.stdout,nativeAnswer:answer?.content??'',nativePrompt:human?.content??'',nativeSession:human?.session_id,exit:r.code};
 s.verdict=assessCorrection(e);s.native_answer_sha256=hash(e.nativeAnswer);s.native_session=e.nativeSession;s.receipts=e.receipts.map(x=>({binding_uid:x.binding_uid,stage:x.stage,manifest:x.manifest,rendered_sha256:x.rendered_sha256}));
 s.stage='fresh_finished';save(s);
 // Allow the real fresh-turn automatic extraction to finish inside the same four-entry gate.
 await until(()=>Object.values(snap(s).extraction_watermarks).some(w=>w.completed&&w.request?.binding_uid===binding?.binding_uid),45000).catch(()=>{});
 s.entries=read(ROOT+'/budget.json');save(s);console.log(JSON.stringify({stage:s.stage,verdict:s.verdict,entries:s.entries,native_answer_sha256:s.native_answer_sha256}));
}
async function cleanup(s){
 if(!/^\/private\/tmp\/hf-[A-Za-z0-9]+$/.test(s.home))throw Error('unsafe_cleanup');
 if(s.daemon_pid){try{process.kill(-s.daemon_pid,'SIGTERM');}catch{}await sleep(700);try{process.kill(-s.daemon_pid,'SIGKILL');}catch{}}
 rmSync(s.home,{recursive:true,force:true});s.owned_home_removed=!existsSync(s.home);s.shared_api_retained=true;save(s);console.log(JSON.stringify({owned_home_removed:s.owned_home_removed,shared_api_retained:true}));
}
async function main(){const stage=process.argv[2];if(stage==='--gate')return gate(process.argv.slice(3));if(stage==='--prepare')return prepare();const s=read(ROOT+'/state.json');if(stage==='--consent-command'){console.log(JSON.stringify({binary:recordedNative(s,'real_binary'),args:['chat'],env:environment(s),cwd:s.home+'/work'}));return;}const fn={'--start':start,'--learn':learn,'--corrected':corrected,'--fresh':fresh,'--cleanup':cleanup}[stage];if(!fn)throw Error('explicit_stage_required');await fn(s);}
if(process.argv[1]&&path.resolve(process.argv[1])===SELF)main().catch(e=>{console.error('Hermes correction refused: '+e.message);process.exitCode=1;});
