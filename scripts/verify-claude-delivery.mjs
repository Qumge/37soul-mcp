#!/usr/bin/env node
// Dedicated Claude product acceptance; imports and --plan make no native/API calls.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, cpSync, chmodSync, renameSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const BASE='http://127.0.0.1:8087', PROFILE='browser-delivery';
const DEFAULT_LEDGER='/private/tmp/37soul-native-delivery-20261102-bounded';
const BEFORE=['Copper','Silver','Tin'], AFTER=['Flint','River','Star'];
const sha=x=>createHash('sha256').update(x??'').digest('hex');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
function privateFile(p,text){mkdirSync(path.dirname(p),{recursive:true,mode:0o700});writeFileSync(p,text,{mode:0o600});}
function count(root){return json(path.join(root,'budget.json'))['claude-code'];}
export function buildClaudeSessionPlan(stage){
 if(!['learn','recall','corrected'].includes(stage))throw new Error('unknown_stage');
 const sessionId=randomUUID();
 return {sessionId,args:['-p','--output-format','json','--tools','','--max-turns','1','--disable-slash-commands','--strict-mcp-config','--setting-sources','user','--session-id',sessionId],input:stage==='learn'
  ?`Please remember my enduring preference: in every future Claude delivery summary, use the headings ${BEFORE.join(', ')} in that order. This is a lasting preference, not just a format for this reply. Acknowledge briefly; do not call tools.`
  :'Give a short Claude delivery summary for a fictional project whose work is finished and has no blockers. Do not call tools.'};
}
export function installClaudeBudgetGate(home,real){
 const allowedRoots=[os.tmpdir(),'/tmp'].flatMap(root=>{try{return [realpathSync(root)];}catch{return [];}});
 let resolved;try{resolved=realpathSync(home);}catch{throw new Error('gate_home_not_isolated');}
 if(!path.isAbsolute(home)||!allowedRoots.includes(path.dirname(resolved))||!path.basename(resolved).startsWith('37soul-claude-')||resolved===realpathSync(os.homedir()))throw new Error('gate_home_not_isolated');
 // Canonical HOME launcher must be the gate: the runtime resolves it before PATH.
 const gatePath=path.join(home,'.local/bin/claude'),script=fileURLToPath(import.meta.url);
 const q=s=>"'"+s.replace(/'/g,"'\\''")+"'";
 privateFile(gatePath,'#!/bin/sh\nexec '+q(process.execPath)+' '+q(script)+' --native-gate '+q(real)+' "$@"\n');
 chmodSync(gatePath,0o700);
 return gatePath;
}
export function reserveClaudeAttempt(root,phase){
 const lock=path.join(root,'budget.lock');mkdirSync(lock,{mode:0o700});
 try{
  const ledger=path.join(root,'budget.json'),c=json(ledger),n=c['claude-code'];
  if(!Number.isInteger(n)||n<1||n>=6)throw new Error('native_budget_refused');
  c['claude-code']=n+1;
  const temp=path.join(root,`claude-budget-${process.pid}.tmp`);privateFile(temp,JSON.stringify(c));renameSync(temp,ledger);
  appendFileSync(path.join(root,'claude-native-gate.jsonl'),JSON.stringify({phase,count:n+1,at:new Date().toISOString()})+'\n',{mode:0o600});
  return n+1;
 }finally{rmSync(lock,{recursive:true,force:true});}
}
function assistantText(stdout){
 let text='';for(const line of (stdout??'').split('\n')){try{const r=JSON.parse(line);if(r.type==='result'&&typeof r.result==='string')text=r.result;}catch{}}
 return text;
}
export function summarizeNative(result){
 const text=assistantText(result.stdout);
 return {code:result.code,timeout:!!result.timeout,assistant_chars:text.length,assistant_sha256:sha(text)};
}
function run(command,args,env,cwd,input='',ms=90000){
 return new Promise(resolve=>{
  let stdout='',stderr='',done=false,timed=false;
  const child=spawn(command,args,{env,cwd,stdio:['pipe','pipe','pipe'],detached:true});
  const finish=code=>{if(done)return;done=true;clearTimeout(timer);resolve({code,stdout,stderr,timeout:timed});};
  const timer=setTimeout(()=>{timed=true;try{process.kill(-child.pid,'SIGKILL');}catch{}finish(124);},ms);
  child.stdout.on('data',b=>{stdout=(stdout+b).slice(-4*1024*1024);});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-128*1024);});
  child.on('error',()=>finish(127));child.on('close',c=>finish(c??1));child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
async function gate(){
 const [real,...args]=process.argv.slice(3),root=process.env.CLAUDE_DELIVERY_LEDGER_ROOT;
 if(root!==DEFAULT_LEDGER||!real||/dangerously|bypass|--yolo/i.test(args.join(' ')))throw new Error('gate_refused');
 try{reserveClaudeAttempt(root,process.env.SOUL37_INTERNAL_JOB_UID?'extraction':'session');}catch{
  appendFileSync(path.join(root,'claude-native-refused.jsonl'),JSON.stringify({at:new Date().toISOString(),phase:process.env.SOUL37_INTERNAL_JOB_UID?'extraction':'session'})+'\n',{mode:0o600});throw new Error('native_budget_refused');
 }
 const child=spawn(real,args,{env:process.env,cwd:process.cwd(),stdio:'inherit'});
 const timer=setTimeout(()=>child.kill('SIGKILL'),85000);
 await new Promise(resolve=>{child.on('error',()=>{process.exitCode=127;resolve();});child.on('close',code=>{process.exitCode=code??1;resolve();});});clearTimeout(timer);
}
function environment(home){
 const names=['PATH','LANG','TERM','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'];
 const env=Object.fromEntries(names.filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 return {...env,HOME:home,XDG_CONFIG_HOME:home+'/.config',XDG_CACHE_HOME:home+'/.cache',XDG_DATA_HOME:home+'/.local/share',CLAUDE_CONFIG_DIR:home+'/.claude',SOUL37_HOME:home,SOUL37_BASE_URL:BASE,CLAUDE_DELIVERY_LEDGER_ROOT:DEFAULT_LEDGER,DO_NOT_TRACK:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ANTHROPIC_MAX_RETRIES:'0'};
}
async function until(check,ms=130000){const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,1000));}throw new Error('evidence_timeout');}
const CORRECT_RUBY=String.raw`require '/private/tmp/37soul-delivery-api-boot'
f=delivery_fixture
user=delivery_owner(f)
abort 'dedicated synthetic owner required' unless user.id==2
uid, asset_uid, text=ARGV
host=user.created_hosts.find_by!(soul_uid:uid)
abort 'dedicated Claude Soul required' unless host.nickname.start_with?('Claude Delivery ')
asset=HostUserFact.find_by(asset_uid:asset_uid,user_id:user.id,host_id:host.id) || SoulExperience.find_by(asset_uid:asset_uid,user_id:user.id,host_id:host.id)
abort 'owned asset required' unless asset
result=user.with_lock do
 abort 'owner suspended' unless user.api_access_allowed?
 SoulSync::AssetWriter.call(user:user,host:host,device:nil,source_context:{runtime_kind:'web'},change:{change_id:SecureRandom.uuid,operation:'review',soul_uid:host.soul_uid,asset_uid:asset.asset_uid,base_revision:asset.revision,actor:'owner',payload:{action:'edit',replacement_uid:SecureRandom.uuid,content:text}})
end
abort 'correction rejected' unless result[:status]=='accepted'
puts JSON.generate(status:'accepted')
`;
async function acceptance(){
 const runtimeArg=process.argv.indexOf('--runtime-root'),runtimeRoot=runtimeArg>=0?path.resolve(process.argv[runtimeArg+1]):process.cwd();
 const reportPath=path.resolve('docs/reviews/2026-11-02-claude-delivery.md');
 const report={host:'claude-code',runtime_version:'0.14.0',native_version:'2.1.316',core_pass:false,correction_pass:false,service_installation:'not_run',cloud_environment:'isolated Rails 8087 / test delivery auth DB',prior_native_calls:count(DEFAULT_LEDGER)};
 let home=null,daemon=null,phase='prepare';const progress=name=>{phase=name;console.log(JSON.stringify({host:'claude-code',phase:name,cumulative_native_calls:count(DEFAULT_LEDGER)}));};
 try{
  if(report.prior_native_calls!==1)throw new Error('baseline_count_changed');
  if(json(path.join(runtimeRoot,'package.json')).version!=='0.14.0')throw new Error('candidate_version_mismatch');
  const approved=readFileSync('/private/tmp/37soul-delivery-browser-home.txt','utf8').trim();
  if(!approved.startsWith('/private/tmp/')&&!approved.startsWith('/var/folders/'))throw new Error('approved_home_not_private');
  const approvedSnap=json(path.join(approved,'.37soul/profiles',PROFILE,'snapshot.json'));
  if(approvedSnap.owner_id!=='2'||approvedSnap.cloud_issuer!==BASE)throw new Error('approved_owner_or_issuer_mismatch');
  home=mkdtempSync('/private/tmp/37soul-claude-delivery-');chmodSync(home,0o700);
  for(const file of ['config.json','accounts.json','state.json'])if(existsSync(path.join(approved,'.37soul',file)))privateFile(path.join(home,'.37soul',file),readFileSync(path.join(approved,'.37soul',file)));
  cpSync(path.join(approved,'.37soul/profiles'),path.join(home,'.37soul/profiles'),{recursive:true});
  mkdirSync(path.join(home,'.claude'),{recursive:true,mode:0o700});mkdirSync(path.join(home,'work'),{mode:0o700});
  const env=environment(home),settingsPath=path.join(os.homedir(),'.claude/settings.json');
  if(existsSync(settingsPath))for(const [k,v] of Object.entries(json(settingsPath).env??{}))if(k.startsWith('ANTHROPIC_'))env[k]=String(v);
  if(!env.ANTHROPIC_API_KEY&&!env.ANTHROPIC_AUTH_TOKEN){const auth=path.join(os.homedir(),'.claude/.credentials.json');if(existsSync(auth))privateFile(path.join(home,'.claude/.credentials.json'),readFileSync(auth));}
  privateFile(path.join(home,'.claude/settings.json'),'{}');
  const real=path.join(os.homedir(),'.local/bin/claude');
  const gatePath=installClaudeBudgetGate(home,real);env.PATH=path.dirname(gatePath)+path.delimiter+env.PATH;
  const mod=rel=>import(pathToFileURL(path.join(runtimeRoot,'dist',rel)).href);
  const {install}=await mod('install.js');
  await install({home,apiBase:BASE,fetch:async()=>{throw new Error('installer_HTTP_forbidden');},runCommand:async()=>{throw new Error('installer_native_command_forbidden');},nodePath:process.execPath,cliScriptPath:path.join(runtimeRoot,'dist/cli.js'),agentdScriptPath:path.join(runtimeRoot,'dist/cli.js'),runtimeSourceRoot:runtimeRoot,log:()=>{}},{agents:['claude-code'],installService:false});
  const root=path.join(home,'.37soul'),snapshot=()=>json(path.join(root,'profiles',PROFILE,'snapshot.json'));
  const {resolveLocalAssetsProfileSync}=await mod('local/profiles.js');if(resolveLocalAssetsProfileSync(root)?.profile_id!==PROFILE)throw new Error('installed_profile_unresolvable');
  const managed=json(path.join(home,'.claude/settings.json'));if(!managed.hooks?.SessionStart?.length||!managed.hooks?.Stop?.length)throw new Error('managed_hooks_missing');
  const launcher=json(path.join(root,'config.json')).launcher;env.SOUL37_LAUNCHER=launcher;
  const cli=async args=>{const r=await run(launcher,args,env,path.join(home,'work'),'',60000);if(r.code!==0)throw new Error('cli_'+args.slice(0,2).join('_')+'_failed');return r;};
  progress('create-select-authorize-independent-soul');
  const oldSouls=new Set(Object.keys(snapshot().souls));
  const name='Claude Delivery '+randomUUID().slice(0,8);
  await cli(['soul','create','--name',name,'--sex','female','--age','24','--character','A synthetic acceptance character dedicated to Claude delivery summaries, who records explicit format preferences, explains outcomes clearly, and respects private conversations.']);
  const soul=Object.values(snapshot().souls).find(s=>!oldSouls.has(s.soul_uid));if(!soul)throw new Error('synthetic_soul_missing');report.soul_uid=soul.soul_uid;
  await cli(['soul','select',soul.soul_uid,'--agent','claude-code']);
  await cli(['soul','authorize',soul.soul_uid,'--categories','identity,relationship,experience']);await cli(['sync']);
  if(!snapshot().souls[soul.soul_uid]?.legacy_host_id)throw new Error('synthetic_soul_not_registered');
  report.owned_soul_registered=true;report.managed_hooks_installed=true;
  daemon=spawn(launcher,['agentd'],{env,cwd:home,detached:true,stdio:['ignore','ignore','ignore']});
  const {sendWriter}=await mod('local/writer.js');await until(async()=>{const r=await sendWriter(root,{request_uid:randomUUID(),profile_id:PROFILE,command:'health',payload:{}});return r.ok;},15000);
  const session=async stage=>{const plan=buildClaudeSessionPlan(stage);progress(stage+'-native-session');const r=await run(gatePath,plan.args,env,path.join(home,'work'),plan.input,110000);report[stage]=summarizeNative(r);if(r.code!==0)throw new Error('native_'+stage+'_failed');return {r,plan,text:assistantText(r.stdout)};};
  const oldAssets=new Set(Object.keys(snapshot().assets));
  const first=await session('learn');report.learn.session_id=first.plan.sessionId;
  progress('automatic-daemon-extraction');
  const asset=await until(()=>Object.values(snapshot().assets).find(a=>a.soul_uid===soul.soul_uid&&!oldAssets.has(a.asset_uid)&&BEFORE.every(w=>a.content.includes(w))));
  const wm=Object.values(snapshot().extraction_watermarks).find(w=>w.completed&&w.request.runtime_kind==='claude-code'&&w.request.key?.native_session_id===first.plan.sessionId)??Object.values(snapshot().extraction_watermarks).find(w=>w.completed&&w.request.runtime_kind==='claude-code'&&w.request.soul_uid===soul.soul_uid);
  if(!wm)throw new Error('completed_native_watermark_missing');report.automatic_extraction_completed=true;report.source_ref_count=wm.request.source_turn_refs.length;report.asset_uid=asset.asset_uid;
  progress('real-http-push-pull');await cli(['sync']);
  const synced=snapshot().assets[asset.asset_uid];if(synced.sync_state!=='synced'||!synced.cloud_revision)throw new Error('asset_not_cloud_synced');report.cloud_asset_revision=synced.cloud_revision;
  const beforeReceipts=new Set(Object.keys(snapshot().receipts));
  const recall=await session('recall');report.recall.session_id=recall.plan.sessionId;report.recall.answer_uses_preference=BEFORE.every(w=>recall.text.includes(w));
  const receipts=Object.entries(snapshot().receipts).filter(([id,r])=>!beforeReceipts.has(id)&&r.stage==='injected');report.recall.injected_receipt_has_asset=receipts.some(([,r])=>r.manifest.some(a=>a.asset_uid===asset.asset_uid));report.recall.answer_not_in_prompt=BEFORE.every(w=>!recall.plan.input.includes(w));
  report.core_pass=report.recall.answer_uses_preference&&report.recall.injected_receipt_has_asset&&report.recall.answer_not_in_prompt;
  if(!report.core_pass)throw new Error('fresh_recall_not_adopted');
  if(count(DEFAULT_LEDGER)>=6){report.correction_status='not_run_budget_exhausted';return;}
  progress('owned-soul-cloud-correction');
  const ruby=path.join(home,'correct-owned-soul.rb');privateFile(ruby,CORRECT_RUBY);
  const railsEnv={PATH:path.join(os.homedir(),'.rbenv/shims')+':/opt/homebrew/bin:/usr/bin:/bin',HOME:os.homedir(),RAILS_ENV:'test',DATABASE_URL:'postgresql://localhost/37soul_test_delivery_auth',REDIS_URL:'redis://localhost:6379/15'};
  const correction=await run('bundle',['exec','ruby',ruby,soul.soul_uid,asset.asset_uid,`My enduring preference is that all future Claude delivery summaries must use headings ${AFTER.join(', ')}, in that order.`],railsEnv,'/Users/jiangxin/projects/37soul/.worktrees/delivery-account-auth','',60000);
  report.cloud_correction_method='local-test-Rails-AssetWriter-owned-Soul';report.cloud_correction_exit=correction.code;if(correction.code!==0)throw new Error('cloud_correction_failed');
  await cli(['sync']);const replacement=Object.values(snapshot().assets).find(a=>a.soul_uid===soul.soul_uid&&AFTER.every(w=>a.content.includes(w)));if(!replacement)throw new Error('corrected_asset_not_pulled');
  const previous=new Set(Object.keys(snapshot().receipts));const fresh=await session('corrected');report.corrected.session_id=fresh.plan.sessionId;
  const newReceipts=Object.entries(snapshot().receipts).filter(([id,r])=>!previous.has(id)&&r.stage==='injected');
  report.corrected.answer_uses_correction=AFTER.every(w=>fresh.text.includes(w));report.corrected.answer_not_in_prompt=AFTER.every(w=>!fresh.plan.input.includes(w));report.corrected.receipt_has_replacement=newReceipts.some(([,r])=>r.manifest.some(a=>a.asset_uid===replacement.asset_uid));report.corrected.receipts_exclude_old=newReceipts.every(([,r])=>r.manifest.every(a=>a.asset_uid!==asset.asset_uid));report.corrected_asset_uid=replacement.asset_uid;
  report.correction_pass=report.corrected.answer_uses_correction&&report.corrected.answer_not_in_prompt&&report.corrected.receipt_has_replacement&&report.corrected.receipts_exclude_old;
 }catch(error){report.failed_phase=phase;const allowed=/^(baseline_count_changed|candidate_version_mismatch|approved_home_not_private|approved_owner_or_issuer_mismatch|installed_profile_unresolvable|managed_hooks_missing|cli_[a-z_]+_failed|synthetic_soul_missing|synthetic_soul_not_registered|native_[a-z]+_failed|evidence_timeout|completed_native_watermark_missing|asset_not_cloud_synced|fresh_recall_not_adopted|cloud_correction_failed|corrected_asset_not_pulled)$/;report.error_class=allowed.test(error?.message)?error.message:'setup_or_runtime_error';
 }finally{
  if(daemon){try{process.kill(-daemon.pid,'SIGTERM');}catch{}await new Promise(r=>setTimeout(r,700));try{process.kill(-daemon.pid,'SIGKILL');}catch{}}
  if(home)rmSync(home,{recursive:true,force:true});
  report.private_auth_removed=true;report.cumulative_native_calls=count(DEFAULT_LEDGER);report.new_native_calls=report.cumulative_native_calls-report.prior_native_calls;report.timestamp=new Date().toISOString();
  const body='# Claude Code delivery acceptance — 2026-11-02\n\nSynthetic data only; dedicated owned Soul under local test user 2. No production/deployment/global service changes. Native invocation counts include automatic daemon extraction; they are not a provider billing audit. Existing browser approval was reused, no device-code polling.\n\n```json\n'+JSON.stringify(report,null,2)+'\n```\n\nCloud correction, if completed, used the website AssetWriter service through a private local Rails runner scoped by owner and Soul UID; it was not browser UI acceptance. Session persistence was enabled for product sessions; extraction uses the runtime adapter\'s own invocation contract. Native raw output/authentication material was never included in this report.\n';
  mkdirSync(path.dirname(reportPath),{recursive:true});writeFileSync(reportPath,body);console.log(JSON.stringify(report));
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const task=process.argv[2]==='--native-gate'?gate():process.argv.includes('--run')?acceptance():Promise.resolve(console.log(JSON.stringify({host:'claude-code',plan:buildClaudeSessionPlan('recall'),budget:{prior:1,max:6},execute:'--run --runtime-root <isolated-build-root>'})));
 task.catch(()=>{console.error('Claude delivery execution refused; details suppressed');process.exitCode=1;});
}
