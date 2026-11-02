#!/usr/bin/env node
// Real managed OpenCode flow, synthetic content only. No model calls on import.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, cpSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const SELF=fileURLToPath(import.meta.url),REPO=path.resolve(path.dirname(SELF),'..');
const BINARY=path.join(os.homedir(),'.opencode/bin/opencode');
// This run's observed provider/model fixture, not a product default.
const MODEL='opencode/deepseek-v4.1-flash-free';
const PROFILE='browser-delivery',ISSUER='http://127.0.0.1:8087';
const LABELS=['North','East','South'];
const sha=text=>createHash('sha256').update(text).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function privateFile(file,text){mkdirSync(path.dirname(file),{recursive:true,mode:0o700});writeFileSync(file,text,{mode:0o600});}
export function managedPlan(prompt,{home=os.homedir(),model=MODEL}={}){if(!/^[a-zA-Z0-9_.:-]+\/[a-zA-Z0-9_.:-]+$/.test(model))throw new Error('invalid_model');return {binary:path.join(home,'.opencode/bin/opencode'),args:['run','--standalone','--format','json','--model',model,'--agent','delivery-acceptance',prompt]};}
export function existingProviderConfig(model) {
 managedPlan('',{model});
 if(!model.startsWith('deepseek/'))throw new Error('unapproved_provider');
 const id=model.slice('deepseek/'.length);
 return {model,provider:{deepseek:{options:{baseURL:'https://api.deepseek.com/v1',apiKey:'{env:DEEPSEEK_API_KEY}'},models:{[id]:{name:id}}}},agent:{'delivery-acceptance':{description:'Bounded synthetic acceptance',mode:'primary',tools:{'*':false},permission:{'*':'deny'},steps:1}},permission:{'*':'deny'}};
}
export async function reserveAttempt(root){
 const lock=path.join(root,'budget.lock');let held=false;
 for(let i=0;i<200;i++){try{mkdirSync(lock,{mode:0o700});held=true;break;}catch(e){if(e.code!=='EEXIST')throw e;await sleep(20);}}
 if(!held)throw new Error('budget_lock_busy');
 try{
  const file=path.join(root,'budget.json'),counts=read(file),n=counts.opencode;
  if(!Number.isSafeInteger(n)||n<1||n>=6)throw new Error('budget_exhausted');
  counts.opencode=n+1;privateFile(file,JSON.stringify(counts));return n+1;
 }finally{rmSync(lock,{recursive:true,force:true});}
}
export function assessEvidence({soul,asset,labels,answer,receipts,bindings,watermarks,synced}){
 const ownedBindings=new Set(bindings.filter(b=>b.runtime_kind==='opencode'&&b.soul_uid===soul).map(b=>b.binding_uid));
 const injected=receipts.some(r=>r.stage==='injected'&&ownedBindings.has(r.binding_uid)&&r.manifest?.some(m=>m.asset_uid===asset));
 const extracted=watermarks.some(w=>w.completed&&w.request?.runtime_kind==='opencode'&&w.request?.soul_uid===soul&&w.request.source_turn_refs?.length>=2);
 const recalled=labels.every(x=>answer.includes(x));
 const uploaded=synced?.sync_state==='synced'&&synced.cloud_revision>0;
 return {pass:injected&&extracted&&recalled&&uploaded,injected,extracted,recalled,uploaded};
}
function environment(home){
 const keys=['PATH','LANG','TERM','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','DEEPSEEK_API_KEY'];
 const env=Object.fromEntries(keys.filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 return {...env,HOME:home,SOUL37_HOME:home,XDG_CONFIG_HOME:home+'/.config',XDG_DATA_HOME:home+'/.local/share',XDG_CACHE_HOME:home+'/.cache',XDG_STATE_HOME:home+'/.state',SOUL37_BASE_URL:ISSUER,DO_NOT_TRACK:'1'};
}
function execute(binary,args,env,cwd,input='',timeout=90000){
 return new Promise(resolve=>{
  let stdout='',stderr='',done=false;const child=spawn(binary,args,{env,cwd,stdio:['pipe','pipe','pipe'],detached:true});
  const finish=(code,timed=false)=>{if(done)return;done=true;clearTimeout(timer);resolve({code,stdout,stderr,timed});};
  const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}finish(124,true);},timeout);
  child.stdout.on('data',b=>{stdout=(stdout+b).slice(-2*1024*1024);});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-128*1024);});
  child.on('error',()=>finish(127));child.on('close',c=>finish(c??1));child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
function assistant(stdout){let text='';for(const line of stdout.split('\n')){try{const r=JSON.parse(line);if(r.type==='text')text+=r.part?.text??r.text??'';}catch{}}return text;}
export function gateBinary(state){
 if(!state.binary || !path.isAbsolute(state.binary) || state.binary.startsWith(state.home+path.sep))throw new Error('gate_binary_refused');
 return state.binary;
}
export function classifyFailure(result){
 if(result.code===0)return null;
 const text=(result.stderr??'')+'\n'+(result.stdout??'');
 if(/QuotaExceeded|Free usage limit reached/i.test(text))return 'provider_quota_exceeded';
 if(/401|403|unauthorized|authentication/i.test(text))return 'authorization_unavailable';
 if(/unknown.*flag|unexpected.*argument/i.test(text))return 'cli_option_rejected';
 if(/readiness|standalone server exited/i.test(text))return 'standalone_readiness_failed';
 return 'native_nonzero';
}
function diagnostics(result){
 const t=result.stderr+'\n'+result.stdout;
 return {exit:result.code,timeout:result.timed,stdout_bytes:Buffer.byteLength(result.stdout),assistant_chars:assistant(result.stdout).length,
  error_class:classifyFailure(result),auth_error:/401|403|unauthorized|credential|authentication/i.test(t),model_error:/model.*not found|modelnotfound/i.test(t),
  plugin_error:/plugin.*(?:error|failed)|failed.*plugin/i.test(t),permission_error:/permission.*(?:denied|rejected)/i.test(t),
  readiness_error:/readiness|standalone server exited/i.test(t),cli_error:/unknown.*flag|unexpected.*argument/i.test(t)};
}
function snapshot(home){return read(path.join(home,'.37soul/profiles',PROFILE,'snapshot.json'));}
async function until(check,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){const x=await check();if(x)return x;await sleep(500);}throw new Error('evidence_timeout');}
const statePath=root=>path.join(root,'opencode-managed-state.json');
function save(root,s){privateFile(statePath(root),JSON.stringify(s,null,2));}
function report(root,s){
 const out={timestamp:new Date().toISOString(),runtime_version:s.runtime_version,opencode_version:s.version,stage:s.stage,
  pass:!!s.pass,managed_install:s.managed_install,foreground_agentd:!!s.daemon_pid,soul_uid:s.soul_uid,
  service_installation:false,default_install_closed:false,model:s.model??MODEL,
  attempts:read(path.join(root,'budget.json')).opencode,events:s.events??[],error_class:s.error_class??null,
  evidence:s.evidence??null,cleanup:s.cleanup??false};
 const file=path.join(REPO,'docs/reviews/2026-11-02-opencode-delivery.md');
 if(!existsSync(file))privateFile(file,'# OpenCode managed delivery — 2026-11-02\n\nSynthetic Soul; local Rails 8087; browser-approved profile reused. Actual installer with installService:false and foreground agentd. No host trust bypass. OAuth transfer uses private stdin; no secrets or raw session bodies in this report. Model invocation budget is shared and includes automatic extraction; provider-internal retries are not inferred from CLI invocation counts.\n');
 appendFileSync(file,'\n```json\n'+JSON.stringify(out,null,2)+'\n```\n');console.log(JSON.stringify(out));
}
async function cli(s,args){const env={...environment(s.home),OPENCODE_DELIVERY_ROOT:s.root,PATH:s.home+'/.local/bin:'+s.home+'/.opencode/bin:'+process.env.PATH,SOUL37_LAUNCHER:s.launcher};return execute(s.launcher,args,env,s.home+'/work','',60000);}
function checked(result,label){if(result.code!==0)throw new Error(label);return result;}
async function prepare(root){
 if(existsSync(statePath(root)))throw new Error('existing_run_refused');
 const spent=read(path.join(root,'budget.json')).opencode;
 if(!Number.isSafeInteger(spent)||spent<1||spent>=6)throw new Error('budget_not_ready');
 const approved=readFileSync('/private/tmp/37soul-delivery-browser-home.txt','utf8').trim();
 const prior=read(path.join(approved,'.37soul/profiles',PROFILE,'snapshot.json'));
 if(prior.cloud_issuer!==ISSUER||!prior.cloud_device_uid)throw new Error('approved_profile_mismatch');
 const home=mkdtempSync(path.join(root,'managed-opencode-'));
 const model=process.env.OPENCODE_DELIVERY_MODEL??MODEL;managedPlan('',{model});
 const s={root,home,binary:BINARY,model,stage:'prepare',events:[],pass:false};save(root,s);
 try{
  cpSync(path.join(approved,'.37soul'),home+'/.37soul',{recursive:true});
  // Do not reuse an IPC socket, lock, service or PID from the approved profile.
  for(const name of ['agentd.lock','writer.sock','writer.lock'])rmSync(home+'/.37soul/'+name,{force:true});
  mkdirSync(home+'/work',{recursive:true});
  const env=environment(home);
  const version=checked(await execute(BINARY,['--version'],env,home),'version_failed');
  if(!version.stdout.includes('2.0.32'))throw new Error('unexpected_opencode_version');s.version='2.0.32';
  if(model.startsWith('deepseek/')) {
   if(!env.DEEPSEEK_API_KEY)throw new Error('existing_provider_authorization_missing');
   privateFile(home+'/.config/opencode/opencode.json',JSON.stringify(existingProviderConfig(model)));
  } else {
   const exported=checked(await execute(BINARY,['auth','export','opencode','--standalone'],environment(os.homedir()),home,'',30000),'auth_export_failed');
   if(!exported.stdout.trim())throw new Error('empty_provider_export');
   checked(await execute(BINARY,['auth','import','--standalone'],env,home,exported.stdout,30000),'auth_import_failed');
   exported.stdout='';
   privateFile(home+'/.config/opencode/opencode.json',JSON.stringify({model,agent:{'delivery-acceptance':{description:'Bounded synthetic acceptance',mode:'primary',tools:{'*':false},permission:{'*':'deny'},steps:1}},permission:{'*':'deny'}}));
  }
  const quote=x=>"'"+x.replace(/'/g,"'\\''")+"'";
  privateFile(home+'/.opencode/bin/opencode','#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(SELF)+' --gate "$@"\n');chmodSync(home+'/.opencode/bin/opencode',0o700);
  const {install}=await import('../dist/install.js');
  await install({home,apiBase:ISSUER,fetch:async()=>{throw new Error('install_network_forbidden');},runCommand:async()=>{throw new Error('install_service_forbidden');},nodePath:process.execPath,cliScriptPath:REPO+'/dist/cli.js',agentdScriptPath:REPO+'/dist/cli.js',runtimeSourceRoot:REPO,log:()=>{}},{agents:['opencode'],installService:false});
  const c=read(home+'/.37soul/config.json');s.launcher=c.launcher;s.runtime_version=read(REPO+'/package.json').version;s.managed_install=true;
  save(root,s);
  const daemonEnv={...env,OPENCODE_DELIVERY_ROOT:root,SOUL37_LAUNCHER:s.launcher,PATH:home+'/.local/bin:'+home+'/.opencode/bin:'+env.PATH};
  const daemon=spawn(s.launcher,['agentd'],{env:daemonEnv,cwd:home+'/work',detached:true,stdio:'ignore'});daemon.unref();s.daemon_pid=daemon.pid;save(root,s);
  const {sendWriter}=await import('../dist/local/writer.js');
  await until(async()=>{try{return (await sendWriter(home+'/.37soul',{request_uid:randomUUID(),profile_id:PROFILE,command:'health',payload:{}})).ok;}catch{return false;}},15000);
  const created=checked(await cli(s,['soul','create','--name','Native-OpenCode-'+randomUUID().slice(0,6),'--sex','other','--age','24','--character','This synthetic acceptance character is concise, honest and careful with provenance. They remember durable preferences about delivery summaries and keep all unrelated data private. This is an independent test Soul.','--profile',PROFILE]),'soul_create_failed');
  const uid=/created soul ([a-f0-9-]{36})/i.exec(created.stdout)?.[1];if(!uid)throw new Error('soul_uid_missing');s.soul_uid=uid;save(root,s);
  checked(await cli(s,['soul','authorize',uid,'--categories','identity,relationship,experience','--profile',PROFILE]),'soul_authorize_failed');
  checked(await cli(s,['sync','--profile',PROFILE]),'registration_sync_failed');
  checked(await cli(s,['soul','select',uid,'--profile',PROFILE]),'soul_select_failed');
  s.old_assets=Object.keys(snapshot(home).assets);s.stage='prepared';save(root,s);report(root,s);
 }catch(e){s.error_class=e.message;s.stage='prepare_failed';save(root,s);report(root,s);throw e;}
}
async function model(root,s,kind){
 if(kind==='learn'&&s.stage!=='prepared')throw new Error('learn_stage_refused');
 if(kind==='recall'&&s.stage!=='synced')throw new Error('recall_stage_refused');
 const prompt=kind==='learn'?`Please remember my enduring preference: in every future OpenCode delivery summary, use the headings ${LABELS.join(', ')} in that order. This is a lasting preference, not a one-off instruction. Acknowledge briefly without tools.`:'Give a short OpenCode delivery summary for a fictional project whose work is finished and has no blockers. Do not call tools.';
 const plan=managedPlan(prompt,{model:s.model??MODEL}),env={...environment(s.home),OPENCODE_DELIVERY_ROOT:root,SOUL37_LAUNCHER:s.launcher,PATH:s.home+'/.local/bin:'+s.home+'/.opencode/bin:'+process.env.PATH};
 const before=Object.keys(snapshot(s.home).receipts);
 const result=await execute(s.home+'/.opencode/bin/opencode',plan.args,env,s.home+'/work','',110000);
 const answer=assistant(result.stdout);
 s.events.push({stage:kind,...diagnostics(result),answer_sha256:sha(answer)});
 s.stage=kind+'_finished';
 if(kind==='recall'){
  const snap=snapshot(s.home);
  s.evidence=assessEvidence({soul:s.soul_uid,asset:s.asset_uid,labels:s.expected_labels??LABELS,answer,receipts:Object.entries(snap.receipts).filter(([id])=>!before.includes(id)).map(([,r])=>r),bindings:Object.values(snap.bindings),watermarks:Object.values(snap.extraction_watermarks),synced:snap.assets[s.asset_uid]});
  s.evidence.answer_not_in_prompt=(s.expected_labels??LABELS).every(label=>!prompt.includes(label));
  s.evidence.old_asset_excluded=!s.original_asset_uid||Object.entries(snap.receipts).filter(([id])=>!before.includes(id)).every(([,r])=>!r.manifest?.some(m=>m.asset_uid===s.original_asset_uid));s.pass=result.code===0&&s.evidence.pass&&s.evidence.answer_not_in_prompt&&s.evidence.old_asset_excluded;
 }
 if(result.code!==0)s.error_class=classifyFailure(result);save(root,s);report(root,s);
}
async function observe(root,s){
 if(s.stage!=='learn_finished')throw new Error('observe_stage_refused');
 try{
  const asset=await until(()=>Object.values(snapshot(s.home).assets).find(a=>a.soul_uid===s.soul_uid&&!s.old_assets.includes(a.asset_uid)&&LABELS.every(x=>a.content.includes(x))),100000);
  s.asset_uid=asset.asset_uid;s.stage='extracted';
 }catch(e){s.error_class=e.message;s.stage='extraction_wait_failed';}
 const snap=snapshot(s.home);
 s.events.push({stage:'observe',bindings:Object.values(snap.bindings).filter(b=>b.runtime_kind==='opencode'&&b.soul_uid===s.soul_uid).length,receipts:Object.values(snap.receipts).filter(r=>r.stage==='injected').length,watermarks:Object.values(snap.extraction_watermarks).filter(w=>w.request?.runtime_kind==='opencode').map(w=>({completed:w.completed,attempts:w.attempts,error:w.last_error,refs:w.request.source_turn_refs?.length}))});
 save(root,s);report(root,s);
}
async function sync(root,s){
 if(s.stage!=='extracted')throw new Error('sync_stage_refused');
 checked(await cli(s,['sync','--profile',PROFILE]),'asset_sync_failed');
 const a=snapshot(s.home).assets[s.asset_uid];if(a.sync_state!=='synced'||!a.cloud_revision)throw new Error('asset_not_cloud_synced');
 s.stage='synced';s.events.push({stage:'sync',asset_uid:s.asset_uid,cloud_revision:a.cloud_revision,sync_state:a.sync_state});save(root,s);report(root,s);
}
async function pullCorrection(root,s){
 if(s.stage!=='synced')throw new Error('correction_stage_refused');
 checked(await cli(s,['sync','--profile',PROFILE]),'correction_sync_failed');
 const labels=['Dawn','Noon','Dusk'];const snap=snapshot(s.home);
 const replacement=Object.values(snap.assets).find(a=>a.soul_uid===s.soul_uid&&a.state==='active'&&labels.every(x=>a.content.includes(x)));
 if(!replacement||snap.assets[s.asset_uid]?.state==='active')throw new Error('correction_not_observed');
 s.original_asset_uid=s.asset_uid;s.asset_uid=replacement.asset_uid;s.expected_labels=labels;
 s.events.push({stage:'correction_pulled',asset_uid:s.asset_uid,old_asset_active:false});save(root,s);report(root,s);
}
async function gate(root,args){
 const binary=gateBinary(read(statePath(root)));
 if(args.length===1&&args[0]==='--version'){const r=await execute(binary,args,process.env,process.cwd(),'',15000);process.stdout.write(r.stdout);process.exitCode=r.code;return;}
 if(args[0]!=='run')throw new Error('gate_non_run_refused');
 const count=await reserveAttempt(root);
 appendFileSync(root+'/opencode-managed-gate.jsonl',JSON.stringify({count,internal:!!process.env.SOUL37_INTERNAL_JOB_UID,at:new Date().toISOString()})+'\n',{mode:0o600});
 // A single real CLI call; do not retry errors or bypass host permissions.
 const child=spawn(binary,args,{env:process.env,cwd:process.cwd(),stdio:'inherit'});
 const timer=setTimeout(()=>child.kill('SIGKILL'),85000);
 await new Promise(resolve=>{child.on('error',()=>{process.exitCode=127;resolve();});child.on('close',c=>{process.exitCode=c??1;resolve();});});clearTimeout(timer);
}
async function cleanup(root,s){
 if(s.daemon_pid){try{process.kill(-s.daemon_pid,'SIGTERM');}catch{}await sleep(1000);try{process.kill(-s.daemon_pid,'SIGKILL');}catch{}}
 if(!s.home.startsWith(root+'/managed-opencode-'))throw new Error('cleanup_path_refused');
 rmSync(s.home,{recursive:true,force:true});s.cleanup=true;save(root,s);report(root,s);
}
async function main(){
 const root=process.env.OPENCODE_DELIVERY_ROOT;
 if(!root?.startsWith('/private/tmp/37soul-native-delivery-'))throw new Error('private_shared_budget_root_required');
 if(process.argv[2]==='--gate')return gate(root,process.argv.slice(3));
 if(!process.argv.includes('--live'))throw new Error('explicit_live_required');
 const stage=process.argv[process.argv.indexOf('--stage')+1];
 if(stage==='prepare')return prepare(root);
 const s=read(statePath(root));
 if(stage==='learn'||stage==='recall')return model(root,s,stage);
 if(stage==='observe')return observe(root,s);
 if(stage==='sync')return sync(root,s);
 if(stage==='pull-correction')return pullCorrection(root,s);
 if(stage==='cleanup')return cleanup(root,s);
 throw new Error('unknown_stage');
}
if(process.argv[1]&&path.resolve(process.argv[1])===SELF)main().catch(e=>{console.error(JSON.stringify({error_class:/^[a-z_]+$/.test(e.message)?e.message:'runner_error_details_suppressed'}));process.exitCode=1;});
