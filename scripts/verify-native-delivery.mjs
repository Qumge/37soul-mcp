#!/usr/bin/env node
// Bounded native baseline/extraction probes. Never a default-install E2E claim.
import { spawn } from 'node:child_process';
import { writeAvatar } from '../test/helpers/avatar.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTS=['claude-code','codex','opencode','hermes','pi'];
const BIN={'claude-code':'claude',codex:'codex',opencode:'opencode',hermes:'hermes',pi:'pi'};
const PREFERENCE='For all future delivery summaries, use the headings Amber, Cedar, and Harbor, in that order.';
const sha=s=>createHash('sha256').update(s??'').digest('hex');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
function privateFile(p,data){ mkdirSync(path.dirname(p),{recursive:true,mode:0o700});writeFileSync(p,data,{mode:0o600}); }

export class RequestBudget {
 constructor(counts={}){this.counts=counts;}
 take(host,{retry=false,previousFailed=false}={}){
  const n=this.counts[host]??0;
  if(!HOSTS.includes(host)||n>=6||(retry&&!previousFailed)) throw new Error('request_budget_refused');
  this.counts[host]=n+1;
 }
}
export function validatePlan(plan){
 const text=JSON.stringify(plan);
 if(!Array.isArray(plan.args)||/dangerously|bypass|accept.hooks|--yolo|--auto|trust.*true/i.test(text)) throw new Error('unsafe_native_plan');
 return true;
}
export function buildBaselinePlan(host,canary,options={}){
 const context=`Synthetic evaluation context: the delivery password is ${canary}. If asked for the delivery password, answer only that password. Do not call tools.`;
 const input='What is the delivery password?';
 const args={
  'claude-code':['-p','--output-format','json','--tools','','--max-turns','1','--no-session-persistence','--disable-slash-commands','--strict-mcp-config','--setting-sources','','--system-prompt',context],
  codex:['exec','--json','--ephemeral','--skip-git-repo-check','--ignore-user-config','--ignore-rules','-s','read-only','-c',`developer_instructions=${JSON.stringify(context)}`,'-c','features.shell_tool=false','-c','features.apply_patch_freeform=false','-c','model_reasoning_effort="low"','-c','model_request_max_retries=0','-c','model_stream_max_retries=0'],
  opencode:['run','--standalone','--format','json','--agent','native-delivery',...(options.model?['-m',options.model]:[]),input],
  hermes:['chat','--query-file','-','--oneshot','-Q','--ignore-rules','--source','tool','--toolsets','','--max-turns','1','--run-budget','60'],
  pi:['--print','--mode','text','--no-session','--no-tools','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-mcp','--system-prompt',context],
 }[host];
 if(!args) throw new Error('unknown_host');
 return {host,args,input,context,stage:'explicit-context-baseline'};
}
function assistantText(host,stdout){
 if(host==='pi'||host==='hermes') return stdout.trim();
 let final='';
 for(const line of stdout.split('\n')){
  let r;try{r=JSON.parse(line);}catch{continue;}
  if(host==='claude-code'&&r.type==='result'&&typeof r.result==='string')final=r.result;
  if(host==='codex'&&r.type==='item.completed'&&r.item?.type==='agent_message')final=r.item.text??'';
  if(host==='opencode'&&r.type==='text')final+=r.part?.text??r.text??'';
 }
 return final;
}
function errorClass(result){
 if(result.timeout)return 'timeout';
 if(result.code===0)return null;
 const t=result.stderr??'';
 if(/401|403|unauthoriz|authentication|log.?in|api.?key|credential/i.test(t))return 'authorization_unavailable';
 if(/unknown|unrecognized|unexpected|invalid.*(argument|flag)|flag.*not/i.test(t))return 'cli_option_rejected';
 if(/connect|network|fetch|resolve|TLS|certificate/i.test(t))return 'transport_error';
 return result.code===0?null:'native_nonzero';
}
export function classifyResult(host,result,canary){
 const text=assistantText(host,result.stdout??'');
 return {host,code:result.code,timeout:!!result.timeout,adopted:result.code===0&&text.includes(canary),assistant_sha256:sha(text),assistant_chars:text.length,error_class:errorClass(result),default_install_closed:false};
}
function run(command,args,env,cwd,input='',timeout=90000){
 return new Promise(resolve=>{
  let stdout='',stderr='',timed=false,done=false;
  const child=spawn(command,args,{env,cwd,stdio:['pipe','pipe','pipe'],detached:true});
  const finish=code=>{if(done)return;done=true;clearTimeout(timer);resolve({code,stdout,stderr,timeout:timed});};
  const timer=setTimeout(()=>{timed=true;try{process.kill(-child.pid,'SIGKILL');}catch{}finish(124);},timeout);
  child.stdout.on('data',b=>{stdout=(stdout+b).slice(-2*1024*1024);});
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(-128*1024);});
  child.on('error',()=>finish(127));child.on('close',c=>finish(c??1));child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
function cleanEnv(home){
 const allowed=['PATH','LANG','TERM','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'];
 const e=Object.fromEntries(allowed.filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 return {...e,HOME:home,XDG_CONFIG_HOME:home+'/.config',XDG_CACHE_HOME:home+'/.cache',XDG_DATA_HOME:home+'/.local/share',XDG_STATE_HOME:home+'/.state',CODEX_HOME:home+'/.codex',CLAUDE_CONFIG_DIR:home+'/.claude',HERMES_HOME:home+'/.hermes',PI_CODING_AGENT_DIR:home+'/.pi/agent',SOUL37_HOME:home,SOUL37_INTERNAL_JOB_UID:'native-delivery-'+randomUUID(),DO_NOT_TRACK:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ANTHROPIC_MAX_RETRIES:'0'};
}
async function prepare(host,home,plan,product=false){
 const real=os.homedir(),env=cleanEnv(home);
 mkdirSync(home+'/work',{recursive:true});
 if(host==='claude-code'){
  const settings=json(real+'/.claude/settings.json');
  for(const [k,v] of Object.entries(settings.env??{}))if(k.startsWith('ANTHROPIC_'))env[k]=String(v);
  privateFile(home+'/.claude/settings.json',JSON.stringify(product?{}:{disableAllHooks:true}));
 }
 if(host==='codex'){
  privateFile(home+'/.codex/auth.json',JSON.stringify(json(real+'/.codex/auth.json')));
  const text=readFileSync(real+'/.codex/config.toml','utf8');const model=/^model\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  if(model){plan.args.push('-m',model);if(product)privateFile(home+'/.codex/config.toml','model = '+JSON.stringify(model)+'\n');}
 }
 if(host==='pi'){
  for(const file of ['auth.json','models.json'])privateFile(home+'/.pi/agent/'+file,JSON.stringify(json(real+'/.pi/agent/'+file)));
  const settings=json(real+'/.pi/agent/settings.json');
  privateFile(home+'/.pi/agent/settings.json',JSON.stringify({defaultModel:settings.defaultModel,defaultProvider:settings.defaultProvider,retry:{enabled:false},packages:[]}));
 }
 if(host==='opencode'){
  let current={};
  for(const file of ['opencode.json','opencode.jsonc'])if(existsSync(real+'/.config/opencode/'+file)){
   const text=readFileSync(real+'/.config/opencode/'+file,'utf8').replace(/^\s*\/\/.*$/gm,'');current=JSON.parse(text);break;
  }
  const configured={...(current.model?{model:current.model}:{}),...(current.provider?{provider:current.provider}:{}),agent:{'native-delivery':{description:'Synthetic bounded delivery probe',mode:'primary',...(!product?{prompt:plan.context}:{}),tools:{'*':false},permission:{'*':'deny'},steps:1}},permission:{'*':'deny'}};
  privateFile(home+'/.config/opencode/opencode.json',JSON.stringify(configured));
  if(existsSync(real+'/.local/share/opencode/auth.json'))privateFile(home+'/.local/share/opencode/auth.json',JSON.stringify(json(real+'/.local/share/opencode/auth.json')));
 }
 if(host==='hermes'){
  // Parse only model settings; never print YAML, auth or dotenv content.
  const py=real+'/.hermes/hermes-agent/venv/bin/python';
  const c=await run(py,['-c','import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1]))["model"]))',real+'/.hermes/config.yaml'],env,home);
  if(c.code!==0)throw new Error('hermes_model_configuration_unavailable');
  const model=JSON.parse(c.stdout);
  privateFile(home+'/.hermes/config.yaml',renderHermesConfig({model,agent:{...(!product?{system_prompt:plan.context}:{}),max_turns:1},toolsets:[],mcp_servers:{},plugins:{},memory:{memory_enabled:false,user_profile_enabled:false}}));
  if(existsSync(real+'/.hermes/auth.json'))privateFile(home+'/.hermes/auth.json',JSON.stringify(json(real+'/.hermes/auth.json')));
  if(existsSync(real+'/.hermes/.env'))for(const line of readFileSync(real+'/.hermes/.env','utf8').split('\n')){
   const m=/^\s*([A-Z][A-Z0-9_]*(?:API_KEY|BASE_URL|TOKEN))\s*=\s*(.*)\s*$/.exec(line);
   if(m)env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
  }
  if(product)privateFile(home+'/.hermes/.env',Object.entries(env).filter(([key])=>/API_KEY$|BASE_URL$|TOKEN$/.test(key)).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n');
 }
 return env;
}
function syntheticSource(host){
 const user=PREFERENCE,answer='Understood. I will use that order for future delivery summaries.';
 const rows={
  'claude-code':[{type:'user',uuid:'u1',parentUuid:null,message:{role:'user',content:user}},{type:'assistant',uuid:'a1',parentUuid:'u1',message:{role:'assistant',content:[{type:'text',text:answer}]}}],
  codex:[{type:'session_meta',payload:{id:'native-synthetic'}},{type:'turn_context',payload:{turn_id:'t1'}},{type:'response_item',payload:{type:'message',id:'u1',role:'user',content:[{type:'input_text',text:user}]}},{type:'response_item',payload:{type:'message',id:'a1',role:'assistant',content:[{type:'output_text',text:answer}]}}],
  opencode:[{type:'request',id:'u1',session_id:'native-synthetic',prompt:user},{type:'message',id:'a1',session_id:'native-synthetic',role:'assistant',content:answer}],
  hermes:[{type:'user_message',id:'u1',session_id:'native-synthetic',text:user},{type:'assistant_message',id:'a1',session_id:'native-synthetic',text:answer}],
  pi:[{type:'session',id:'native-synthetic',version:3},{type:'message',id:'u1',parentId:null,message:{role:'user',content:user}},{type:'message',id:'a1',parentId:'u1',message:{role:'assistant',content:[{type:'text',text:answer}],stopReason:'stop'}}],
 }[host];
 return rows.map(r=>JSON.stringify(r)).join('\n');
}
async function extract(host,home,env,plan){
 const module=await import('../dist/adapters/'+host+'.js');
 const create=module[{'claude-code':'createClaudeCodeAdapter',codex:'createCodexAdapter',opencode:'createOpenCodeAdapter',hermes:'createHermesAdapter',pi:'createPiAdapter'}[host]];
 let calls=0;
 const adapter=create({home,readSource:async()=>syntheticSource(host),emit:async()=>{},invoke:async(_kind,args,input)=>{
  if(++calls>1)throw new Error('native_call_budget_refused');
  if(host==='claude-code')args=[...args,'--disable-slash-commands','--strict-mcp-config','--setting-sources',''];
  if(host==='codex')args=[...args,'--ephemeral','--ignore-user-config','--ignore-rules','-c','features.shell_tool=false'];
  if(host==='opencode')args=[...args,'--agent','native-delivery'];
  if(host==='pi')args=[...args,'--no-mcp'];
  return run(BIN[host],args,env,home+'/work',input);
 }});
 const result=await adapter.extract({job_uid:env.SOUL37_INTERNAL_JOB_UID,runtime_kind:host,native_session_id:'native-synthetic',source_event_refs:['synthetic-event'],binding_uid:'synthetic-binding',binding_revision:1,soul_uid:'synthetic-soul',internal_task:true});
 const proposals=result.proposals??[];
 return {host,stage:'native-extraction-synthetic-source',native_calls:calls,proposal_count:proposals.length,preference_extracted:proposals.some(p=>/Amber/i.test(p.content)&&/Cedar/i.test(p.content)&&/Harbor/i.test(p.content)),error_class:result.error?.code??null,default_install_closed:false};
}
async function main(){
 if(!process.argv.includes('--live'))throw new Error('explicit_live_flag_required');
 const value=k=>process.argv[process.argv.indexOf(k)+1];
 const host=value('--host'),stage=value('--stage');
 if(!HOSTS.includes(host)||!['baseline','extract','loop','authorize'].includes(stage))throw new Error('host_and_stage_required');
 const root=process.env.NATIVE_DELIVERY_ROOT;
 if(!root||!path.resolve(root).startsWith('/private/tmp/37soul-native-delivery-'))throw new Error('private_run_root_required');
 mkdirSync(root,{recursive:true,mode:0o700});
 if(stage==='authorize')return authorizeHost(host,root);
 if(stage==='loop')return productLoop(host,root);
 const ledger=path.join(root,'budget.json');const counts=existsSync(ledger)?json(ledger):{};
 const retry=process.argv.includes('--retry');
 const priorFile=path.join(root,host+'-'+stage+'.json');
 const prior=existsSync(priorFile)?json(priorFile):null;
 new RequestBudget(counts).take(host,{retry,previousFailed:prior!==null&&!prior.pass});
 privateFile(ledger,JSON.stringify(counts));
 const home=mkdtempSync(path.join(root,host+'-'));const canary='NATIVE_'+randomUUID().slice(0,8).toUpperCase();
 const plan=buildBaselinePlan(host,canary);validatePlan(plan);
 let result;
 try{
  const env=await prepare(host,home,plan);
  const version=await run(BIN[host],['--version'],env,home+'/work','',15000);
  let versionNumber=version.stdout.match(/\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9]+)?\b/)?.[0]??'unknown';
  if(host==='hermes')versionNumber=/^version\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(os.homedir(),'.hermes/hermes-agent/pyproject.toml'),'utf8'))?.[1]??versionNumber;
  if(stage==='baseline')result={...classifyResult(host,await run(BIN[host],plan.args,env,home+'/work',plan.input),canary),stage:plan.stage};
  else result=await extract(host,home,env,plan);
  result.version=versionNumber;result.runtime_version=json(path.resolve('package.json')).version;result.pass=stage==='baseline'?result.adopted:result.preference_extracted;
 }catch{result={host,stage,pass:false,error_class:'probe_setup_or_adapter_error',default_install_closed:false};}
 finally{rmSync(home,{recursive:true,force:true});}
 result.attempt=counts[host];result.timestamp=new Date().toISOString();result.private_auth_removed=true;
 privateFile(priorFile,JSON.stringify(result,null,2));
 const report=path.resolve('docs/reviews/2026-11-02-native-delivery.md');
 if(!existsSync(report))privateFile(report,'# Native delivery evidence — 2026-11-02\n\nSynthetic only. Explicit-context baseline and native extraction are separate from default-install closure. No trust bypass or production account. Private credential copies are removed after each host invocation.\n');
 appendFileSync(report,'\n```json\n'+JSON.stringify(result,null,2)+'\n```\n');
 console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))(process.argv[2]==='--native-gate'?nativeGate():main()).catch(()=>{console.error('native probe refused; details suppressed');process.exitCode=1;});

export function buildLoopSessionArgs(host) {
 const plans={
  'claude-code':['-p','--output-format','json','--tools','','--max-turns','1','--disable-slash-commands','--strict-mcp-config','--setting-sources','user'],
  codex:['exec','--json','--skip-git-repo-check','--ignore-rules','-s','read-only','-c','features.shell_tool=false','-c','features.apply_patch_freeform=false','-c','model_reasoning_effort="low"'],
  opencode:['run','--standalone','--format','json','--agent','native-delivery'],
  hermes:['chat','--query-file','-','--oneshot','-Q','--ignore-rules','--source','tool','--toolsets','','--max-turns','1','--run-budget','60'],
  pi:['--print','--mode','json','--no-tools','--no-skills','--no-prompt-templates','--no-context-files','--no-mcp'],
 };
 if(!plans[host])throw new Error('unknown_loop_host');return plans[host];
}

// Child native gate also covers automatic extraction spawned by the real daemon.
async function nativeGate(){
 const [host,binary,...args]=process.argv.slice(3),root=process.env.NATIVE_DELIVERY_ROOT;
 if(!root?.startsWith('/private/tmp/37soul-native-delivery-')||!HOSTS.includes(host))throw new Error('gate_root_refused');
 if(args.length===1&&['--version','--help'].includes(args[0])){const child=spawn(binary,args,{env:process.env,cwd:process.cwd(),stdio:'inherit'});await new Promise(resolve=>{child.on('close',c=>{process.exitCode=c??1;resolve();});child.on('error',()=>{process.exitCode=127;resolve();});});return;}
 const lock=path.join(root,'budget.lock');let locked=false;
 for(let i=0;i<100&&!locked;i++){try{mkdirSync(lock,{mode:0o700});locked=true;}catch{await new Promise(r=>setTimeout(r,20));}}
 if(!locked)throw new Error('budget_lock_busy');
 try{
  const ledger=path.join(root,'budget.json'),counts=json(ledger);new RequestBudget(counts).take(host);privateFile(ledger,JSON.stringify(counts));
  appendFileSync(path.join(root,'native-gate.jsonl'),JSON.stringify({host,count:counts[host],internal:!!process.env.SOUL37_INTERNAL_JOB_UID,at:new Date().toISOString()})+'\n',{mode:0o600});
 }finally{rmSync(lock,{recursive:true,force:true});}
 // Inherit the caller's process group: controller can terminate its entire owned tree.
 const child=spawn(binary,args,{env:process.env,cwd:process.cwd(),stdio:'inherit'});
 const timer=setTimeout(()=>child.kill('SIGKILL'),85000);
 await new Promise(resolve=>{child.on('error',()=>{process.exitCode=127;resolve();});child.on('close',c=>{process.exitCode=c??1;resolve();});});
 clearTimeout(timer);
}
function snapshot(home,profile){return json(path.join(home,'.37soul/profiles',profile,'snapshot.json'));}
async function until(check,ms=150000){
 const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,1000));}throw new Error('evidence_timeout');
}
function finalPiText(stdout){
 let text='';for(const line of stdout.split('\n')){try{const r=JSON.parse(line);if(r.type==='message_end'&&r.message?.role==='assistant')text=(r.message.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');}catch{}}
 return text;
}
async function productLoop(host,root){
 if(!HOSTS.includes(host))throw new Error('unknown_loop_host');
 const approvedHome=readFileSync(process.env.NATIVE_DELIVERY_APPROVED_HOME_FILE||'/private/tmp/37soul-delivery-browser-home.txt','utf8').trim();
 if(!approvedHome.startsWith('/private/tmp/')&&!approvedHome.startsWith('/var/folders/'))throw new Error('approved_home_not_private');
 const ownedApprovedHome=approvedHome.startsWith(root+'/approved-');
 const home=ownedApprovedHome?approvedHome:mkdtempSync(path.join(root,host+'-loop-')),profile='browser-delivery';
 const startedCounts={...json(path.join(root,'budget.json'))};let daemon=null,phase='prepare',result={host,stage:'managed-product-loop',pass:false,product_bridge_closed:false,default_install_closed:false};
 const progress=name=>{phase=name;console.log(JSON.stringify({host,phase:name,model_counts:json(path.join(root,'budget.json'))}));};
 try{
  if(!ownedApprovedHome)cpSync(path.join(approvedHome,'.37soul'),path.join(home,'.37soul'),{recursive:true});
  const before=snapshot(home,profile);
  if(before.cloud_issuer!=='http://127.0.0.1:8087'||!before.cloud_device_uid)throw new Error('profile_issuer_not_bound');
  const approvedMarker=path.join(root,'codex-hooks-reviewed.json');
  const reuseInstalled=host==='codex'&&process.argv.includes('--reuse-installed')&&existsSync(approvedMarker)&&json(approvedMarker).home===home;
  const hooksFile=path.join(home,'.codex/hooks.json');const hooksHashBefore=reuseInstalled?sha(readFileSync(hooksFile)):null;
  if(process.argv.includes('--reuse-installed')&&!reuseInstalled)throw new Error('trusted_home_reuse_refused');
  const plan=buildBaselinePlan(host,'unused');const env=reuseInstalled?cleanEnv(home):await prepare(host,home,plan,true);delete env.SOUL37_INTERNAL_JOB_UID;
  result.preserved_official_trust_setup=reuseInstalled;

  env.SOUL37_BASE_URL='http://127.0.0.1:8087';env.NATIVE_DELIVERY_ROOT=root;
  const {HOSTS}=await import('../dist/hosts/registry.js');
  const {buildExecutionPath,resolveNativeExecutable}=await import('../dist/agentd/native-executable.js');
  const invoke=HOSTS.find(h=>h.kind===host)?.invoke;
  const real=await resolveNativeExecutable(invoke,os.homedir(),buildExecutionPath(os.homedir(),process.execPath,process.env.PATH));
  if(!real)throw new Error('native_real_launcher_missing');
  const script=fileURLToPath(import.meta.url),gate=reuseInstalled?path.join(home,invoke.userLaunchers[0]):await installNativeBudgetGate(home,host,real,root);
  env.PATH=path.dirname(gate)+path.delimiter+env.PATH;
  const resolvedGate=await resolveNativeExecutable(invoke,home,buildExecutionPath(home,process.execPath,env.PATH));
  if(resolvedGate!==gate)throw new Error('native_budget_gate_resolution_failed');
  result.budget_gate_canonical=invoke.userLaunchers[0];result.daemon_resolves_gate=true;
  const {install}=await import('../dist/install.js');
  const repo=path.resolve(path.dirname(script),'..');result.runtime_version=json(path.join(repo,'package.json')).version;
  if(!reuseInstalled)await install({home,apiBase:env.SOUL37_BASE_URL,fetch:async()=>{throw new Error('installer_HTTP_forbidden');},runCommand:async()=>{throw new Error('installer_native_command_forbidden');},nodePath:process.execPath,cliScriptPath:path.join(repo,'dist/cli.js'),agentdScriptPath:path.join(repo,'dist/cli.js'),runtimeSourceRoot:repo,log:()=>{}},{agents:[host],installService:false});
  const {resolveLocalAssetsProfileSync}=await import('../dist/local/profiles.js');
  if(resolveLocalAssetsProfileSync(path.join(home,'.37soul'))?.profile_id!==profile)throw new Error('installed_profile_unresolvable');
  if(reuseInstalled&&sha(readFileSync(hooksFile))!==hooksHashBefore)throw new Error('official_hook_hash_changed');
  result.official_hooks_sha256=hooksHashBefore;
  const config=json(path.join(home,'.37soul/config.json')),launcher=config.launcher;
  env.SOUL37_LAUNCHER=launcher;
  result.installer_managed_extension=true;result.service_installation='not_run_global_service_constraint';result.browser_login_profile_reused=true;
  if(host==='codex'&&process.argv.includes('--wait-for-hook-review')){
   phase='wait-for-official-hooks-tui';
   const marker=path.join(root,'codex-hooks-reviewed.json');
   console.log(JSON.stringify({host,phase:'wait-for-official-hooks-tui',isolated_home:home,codex_home:path.join(home,'.codex'),installed_hooks:path.join(home,'.codex/hooks.json'),cwd:path.join(home,'work'),binary:real,confirmation_file:marker,confirmation_shape:{method:'official-hooks-tui',home}}));
   if(!reuseInstalled)await until(()=>{if(!existsSync(marker))return false;const m=json(marker);return m.method==='official-hooks-tui'&&m.home===home;},900000);
   result.codex_trust_method='parent-official-hooks-tui-confirmed';
  }
  if(host==='hermes'&&process.argv.includes('--wait-for-hook-review')){
   phase='wait-for-official-hook-consent';
   const marker=path.join(root,'hermes-hooks-reviewed.json');
   console.log(JSON.stringify({host,phase:'wait-for-official-hook-consent',isolated_home:home,hermes_home:path.join(home,'.hermes'),installed_hooks:path.join(home,'.hermes/config.yaml'),cwd:path.join(home,'work'),binary:real,confirmation_file:marker,confirmation_shape:{method:'official-hook-consent',home}}));
   await until(()=>{if(!existsSync(marker))return false;const m=json(marker);return m.method==='official-hook-consent'&&m.home===home;},900000);
   result.hermes_trust_method='parent-official-hook-consent-confirmed';
  }
  const daemonArgs=['agentd'];daemon=spawn(launcher,daemonArgs,{env,cwd:home,detached:true,stdio:['ignore','ignore','ignore']});
  const {sendWriter}=await import('../dist/local/writer.js');
  await until(async()=>{const r=await sendWriter(path.join(home,'.37soul'),{request_uid:randomUUID(),profile_id:profile,command:'health',payload:{}});return r.ok;},15000);
  let soul=Object.values(before.souls)[0];
  if(process.argv.includes('--new-soul')){
   const character=`This is a synthetic ${host} delivery acceptance character. They are concise, honest, careful with provenance, and remember explicit durable delivery-format preferences while keeping test content local except for authorized asset sync.`;
   const created=await run(launcher,['soul','create','--avatar',writeAvatar(home),'--name','Native-'+host+'-'+randomUUID().slice(0,6),'--sex','other','--age','24','--character',character,'--profile',profile],env,home+'/work');
   const uid=/created soul ([a-f0-9-]{36})/i.exec(created.stdout)?.[1];if(created.code!==0||!uid)throw new Error('new_soul_create_failed');
   const authorized=await run(launcher,['soul','authorize',uid,'--categories','identity,relationship,experience','--profile',profile],env,home+'/work');if(authorized.code!==0)throw new Error('new_soul_authorize_failed');
   const registered=await run(launcher,['sync','--profile',profile],env,home+'/work','',60000);if(registered.code!==0)throw new Error('new_soul_registration_failed');
   soul=snapshot(home,profile).souls[uid];result.independent_synthetic_soul=true;
  }
  if(!soul)throw new Error('approved_soul_missing');result.soul_uid=soul.soul_uid;result.host_id=soul.legacy_host_id;result.cloud_device_uid=snapshot(home,profile).cloud_device_uid;
  const select=await run(launcher,['soul','select',soul.soul_uid,'--profile',profile],env,home+'/work');if(select.code!==0)throw new Error('select_failed');
  const labels={
   'claude-code':[['Copper','Silver','Tin'],['Flint','River','Star']],
   codex:[['Lime','Teal','Navy'],['Coral','Indigo','Pearl']],
   opencode:[['North','East','South'],['Dawn','Noon','Dusk']],
   hermes:[['Alpha','Beta','Gamma'],['Juniper','Willow','Cedar']],
   pi:[['Amber','Cedar','Harbor'],['Maple','Quartz','Willow']],
  }[host];
  const oldIds=new Set(Object.keys(snapshot(home,profile).assets));
  progress('first-native-session');
  const firstPrompt=`Please remember my enduring preference: in every future ${host} delivery summary, use the headings ${labels[0].join(', ')} in that order. This is a lasting preference, not just a format for this reply. Acknowledge briefly; do not call tools.`;
  const first=await run(gate,buildLoopSessionArgs(host),env,home+'/work',firstPrompt,110000);
  result.first_session_exit=first.code;result.first_session_assistant_sha256=sha(host==='pi'?finalPiText(first.stdout):assistantText(host,first.stdout));if(first.code!==0)throw new Error('first_native_session_failed');
  progress('wait-daemon-extraction');
  const asset=await until(()=>{
   const s=snapshot(home,profile);return Object.values(s.assets).find(a=>a.soul_uid===soul.soul_uid&&!oldIds.has(a.asset_uid)&&labels[0].every(x=>a.content.includes(x)));
  });
  let current=snapshot(home,profile);
  const wm=Object.values(current.extraction_watermarks).find(w=>w.completed&&w.request.runtime_kind===host);
  if(!wm)throw new Error('daemon_watermark_missing');
  result.native_source_refs=wm.request.source_turn_refs;result.watermark_completed=true;result.asset_uid=asset.asset_uid;result.asset_state=asset.state;result.asset_binding_uid=asset.binding_uid;
  result.first_injected_receipts=Object.values(current.receipts).filter(r=>r.stage==='injected').length;
  progress('actual-http-sync');
  const synced=await run(launcher,['sync','--profile',profile],env,home+'/work','',60000);if(synced.code!==0)throw new Error('native_asset_sync_failed');
  current=snapshot(home,profile);result.asset_cloud_revision=current.assets[asset.asset_uid]?.cloud_revision;result.asset_sync_state=current.assets[asset.asset_uid]?.sync_state;
  if(result.asset_sync_state!=='synced'||!result.asset_cloud_revision)throw new Error('cloud_asset_not_synced');
  progress('cloud-correction');
  const fixture=json('/private/tmp/37soul-delivery-api-fixture.json');if(fixture.soul_uid!==soul.soul_uid&&!process.argv.includes('--wait-for-web-edit'))throw new Error('new_soul_requires_owner_checked_web_edit');
  const corrected=`My enduring preference is that all future ${host} delivery summaries must use headings ${labels[1].join(', ')}, in that order.`;
  if(process.argv.includes('--wait-for-web-edit')){
   const marker=path.join(root,host+'-web-edit.json');
   console.log(JSON.stringify({host,phase:'wait-for-parent-web-edit',asset_uid:asset.asset_uid,host_id:soul.legacy_host_id,memory_path:'/hosts/'+soul.legacy_host_id+'/memories',expected_synthetic_text:corrected,confirmation_file:marker,confirmation_shape:{asset_uid:asset.asset_uid,method:'browser-ui'}}));
   await until(()=>{if(!existsSync(marker))return false;const m=json(marker);return m.asset_uid===asset.asset_uid&&m.method==='browser-ui';},900000);
   result.cloud_correction_method='parent-browser-ui-confirmed';
  }else{
   const railsEnv={PATH:path.join(os.homedir(),'.rbenv/shims')+':/opt/homebrew/bin:/usr/bin:/bin',HOME:os.homedir(),RAILS_ENV:'test',DATABASE_URL:'postgresql://localhost/37soul_test_delivery_auth',REDIS_URL:'redis://localhost:6379/15'};
   const correction=await run('bundle',['exec','ruby','/private/tmp/37soul-delivery-api-correct.rb',asset.asset_uid,corrected],railsEnv,fixture.worktree,'',60000);
   result.cloud_correction_exit=correction.code;result.cloud_correction_method='rails-AssetWriter';if(correction.code!==0)throw new Error('cloud_correction_failed');
  }
  const pulled=await run(launcher,['sync','--profile',profile],env,home+'/work','',60000);if(pulled.code!==0)throw new Error('correction_pull_failed');
  current=snapshot(home,profile);const replacement=Object.values(current.assets).find(a=>a.soul_uid===soul.soul_uid&&labels[1].every(x=>a.content.includes(x)));
  if(!replacement)throw new Error('corrected_asset_missing');
  result.corrected_asset_uid=replacement.asset_uid;result.corrected_asset_revision=replacement.revision;result.old_asset_state=current.assets[asset.asset_uid]?.state;
  const previousReceipts=new Set(Object.keys(current.receipts));
  progress('fresh-native-session');
  const freshPrompt=`Give a short ${host} delivery summary for a fictional project whose work is finished and has no blockers. Do not call tools.`;
  const fresh=await run(gate,buildLoopSessionArgs(host),env,home+'/work',freshPrompt,110000);
  const text=host==='pi'?finalPiText(fresh.stdout):assistantText(host,fresh.stdout);current=snapshot(home,profile);
  result.fresh_session_exit=fresh.code;result.fresh_assistant_sha256=sha(text);result.fresh_answer_uses_correction=labels[1].every(x=>text.includes(x));result.answer_not_in_human_prompt=labels[1].every(x=>!freshPrompt.includes(x));
  const receipts=Object.entries(current.receipts).filter(([id,r])=>!previousReceipts.has(id)&&r.stage==='injected');
  result.fresh_receipt_has_corrected_asset=receipts.some(([,r])=>r.manifest.some(x=>x.asset_uid===replacement.asset_uid));
  result.fresh_receipt_excludes_old_asset=receipts.every(([,r])=>r.manifest.every(x=>x.asset_uid!==asset.asset_uid));
  result.product_bridge_closed=fresh.code===0&&result.fresh_answer_uses_correction&&result.answer_not_in_human_prompt&&result.fresh_receipt_has_corrected_asset&&result.fresh_receipt_excludes_old_asset;
  if(reuseInstalled)result.official_hooks_unchanged=sha(readFileSync(hooksFile))===hooksHashBefore;
  result.pass=result.product_bridge_closed;result.version=host==='pi'?'1.4.0':'see-observed-host-version';
 }catch(error){result.error_class=['installed_profile_unresolvable','profile_issuer_not_bound','first_native_session_failed','evidence_timeout','select_failed','daemon_watermark_missing','native_asset_sync_failed','cloud_asset_not_synced','cloud_correction_failed','correction_pull_failed','corrected_asset_missing','fixture_soul_mismatch'].includes(error?.message)?error.message:'loop_setup_or_runtime_error';result.failed_phase=phase;}
 finally{
  if(daemon){try{process.kill(-daemon.pid,'SIGTERM');}catch{}await new Promise(r=>setTimeout(r,800));try{process.kill(-daemon.pid,'SIGKILL');}catch{}}
  result.final_counts=json(path.join(root,'budget.json'));result.new_native_attempts=(result.final_counts[host]??0)-(startedCounts[host]??0);
  result.timestamp=new Date().toISOString();rmSync(home,{recursive:true,force:true});result.private_auth_removed=true;
 }
 privateFile(path.join(root,host+'-product-loop.json'),JSON.stringify(result,null,2));
 appendFileSync(path.resolve('docs/reviews/2026-11-02-native-delivery.md'),'\n## Managed product-loop attempt\n\n```json\n'+JSON.stringify(result,null,2)+'\n```\n');
 console.log(JSON.stringify(result));
}


async function authorizeHost(host,root){
 const home=mkdtempSync(path.join(root,'approved-'+host+'-')),profile='browser-delivery',dataRoot=path.join(home,'.37soul');
 const {startWriter,sendWriter}=await import('../dist/local/writer.js');
 const {loginCommand}=await import('../dist/cli.js');
 const {configureSyncHttp}=await import('../dist/sync/client.js');configureSyncHttp(globalThis.fetch);
 let writer=null,completed=false;
 try{
  writer=await startWriter(dataRoot);
  const init=await sendWriter(dataRoot,{request_uid:randomUUID(),profile_id:profile,command:'init_assets_profile',payload:{profile_id:profile}});
  if(!init.ok)throw new Error('profile_init_failed');
  await writer.close();writer=null;
  const deps={home,apiBase:'http://127.0.0.1:8087',fetch:globalThis.fetch,runCommand:async()=>{throw new Error('browser_auto_open_forbidden');},openBrowser:false,nodePath:process.execPath,cliScriptPath:path.resolve('dist/cli.js'),agentdScriptPath:path.resolve('dist/cli.js'),log:line=>{
   const open=/^\s*Open:\s+(http:\/\/127\.0\.0\.1:8087\/cli\/approve[^\s]*)/.exec(line);
   if(open)console.log(JSON.stringify({host,phase:'parent-browser-device-approval',approval_url:open[1]}));
  }};
  const code=await loginCommand(dataRoot,['--profile',profile],{stdout:()=>{},stderr:()=>{},stdin:async()=>''},deps);
  if(code!==0)throw new Error('native_login_failed');
  const c=json(path.join(dataRoot,'config.json')),snap=snapshot(home,profile);
  if(c.active_profile_id!==profile||snap.cloud_issuer!==deps.apiBase)throw new Error('approved_active_profile_missing');
  const pointer=path.join(root,host+'-approved-home.txt');privateFile(pointer,home+'\n');completed=true;
  console.log(JSON.stringify({host,phase:'real-device-login-completed',approved_home_pointer:pointer,profile_id:profile,active_profile_id:c.active_profile_id,credential_count:c.credentials?.length??0,cloud_device_uid:snap.cloud_device_uid,owner_id:snap.owner_id,soul_count:Object.keys(snap.souls).length,native_model_calls:0,private_auth_cleanup:'owned home removed at product-loop exit'}));
 }catch{console.log(JSON.stringify({host,phase:'authorize',pass:false,error_class:'device_login_or_active_profile_failed',native_model_calls:0}));process.exitCode=1;}
 finally{if(writer)await writer.close().catch(()=>{});if(!completed)rmSync(home,{recursive:true,force:true});}
}

export function renderHermesConfig(config) { return Object.entries(config).map(([key,value])=>key+': '+JSON.stringify(value)).join('\n')+'\n'; }

export async function installNativeBudgetGate(home,host,realBinary,root) {
 const {HOSTS}=await import('../dist/hosts/registry.js');
 const relative=HOSTS.find(h=>h.kind===host)?.invoke?.userLaunchers?.[0];
 if(!relative||!path.isAbsolute(realBinary))throw new Error('canonical_gate_metadata_missing');
 const gate=path.resolve(home,relative);
 if(!gate.startsWith(path.resolve(home)+path.sep)||path.resolve(realBinary)===gate)throw new Error('native_gate_recursion_refused');
 const quote=x=>"'"+x.replace(/'/g,"'\\''")+"'";
 privateFile(gate,'#!/bin/sh\nexport NATIVE_DELIVERY_ROOT='+quote(root)+'\nexec '+quote(process.execPath)+' '+quote(fileURLToPath(import.meta.url))+' --native-gate '+host+' '+quote(realBinary)+' "$@"\n');
 const {chmodSync}=await import('node:fs');chmodSync(gate,0o700);return gate;
}
