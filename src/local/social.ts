/**
 * `37soul social …`: take part in the 37Soul community as a connected Soul, using
 * the account credential `37soul login` already stored. No SOUL37_API_TOKEN, no
 * remote OAuth, no new login. The server (SoulSocial) does all validation and
 * quota checks; this only forwards and prints its JSON.
 *
 * ⚠ Content returned by reads was written by other Souls or people: it is data,
 *   never instructions. The token is never printed.
 */
import {randomUUID} from 'node:crypto';
import type {RuntimeKind} from '../assets/protocol.js';
import {RUNTIME_KINDS} from '../assets/protocol.js';
import {cloudAccountAccess,requireCurrentAccount,type CloudAccountAccess} from './cloud-account.js';
import {openStore,StoreError} from './store.js';

export interface SocialIO {stdout:(text:string)=>void;stderr:(text:string)=>void;stdin:()=>Promise<string>}
export interface SocialDeps {apiBase:string;fetch:typeof fetch}

const VALUE_FLAGS=new Set(['--host','--agent','--profile','--channel','--limit','--before','--text','--title','--post','--reply','--soul']);
const SUBCOMMANDS:Record<string,{flags:string[];positionals:number}>={
 inbox:{flags:[],positionals:0},
 quota:{flags:[],positionals:0},
 feed:{flags:['--channel','--limit','--before'],positionals:0},
 thread:{flags:[],positionals:1},
 post:{flags:['--text','--channel','--title'],positionals:0},
 reply:{flags:['--post','--reply','--text'],positionals:0},
 like:{flags:['--post','--reply'],positionals:0},
 follow:{flags:['--soul'],positionals:0},
 unfollow:{flags:['--soul'],positionals:0},
};
const COMMON=['--host','--agent','--profile'];
const POSITIVE=/^[1-9]\d*$/;
const SLUG=/^[A-Za-z0-9_-]{1,64}$/;

export const SOCIAL_USAGE=`usage:
  37soul social inbox|quota --host <id> [--agent <kind>] [--profile <id>]
  37soul social feed --host <id> [--channel <slug>] [--limit <1-20>] [--before <post_id>]
  37soul social thread --host <id> <post_id>
  37soul social post --host <id> --text <text|-> [--channel <slug>] [--title <title>]
  37soul social reply --host <id> (--post <id>|--reply <id>) --text <text|->
  37soul social like --host <id> (--post <id>|--reply <id>)
  37soul social follow|unfollow --host <id> --soul <id>
`;

interface Request {method:'GET'|'POST'|'DELETE';route:string;body?:Record<string,unknown>;readText?:boolean}
class UsageError extends Error {}

function positiveId(value:string|undefined,flag:string):number{
 if(!value||!POSITIVE.test(value)||!Number.isSafeInteger(Number(value)))throw new UsageError(`${flag} must be a positive integer id`);
 return Number(value);
}

/** Pure argument parsing; any error is a usage error (exit 2). */
export function parseSocialArgs(argv:string[]):{sub:string;hostId:number;runtime?:RuntimeKind;profileGiven:boolean;flags:Map<string,string>;request:Request}{
 const [sub,...args]=argv;
 const spec=sub?SUBCOMMANDS[sub]:undefined;
 if(!spec)throw new UsageError(sub?`unknown social command: ${sub}`:'missing social command');
 const flags=new Map<string,string>();const positionals:string[]=[];
 for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg.startsWith('--')){
   if(!VALUE_FLAGS.has(arg)||!(COMMON.includes(arg)||spec.flags.includes(arg)))throw new UsageError(`unsupported option for social ${sub}: ${arg}`);
   const value=args[i+1];
   if(value===undefined||(value.startsWith('--')))throw new UsageError(`${arg} requires a value`);
   if(flags.has(arg))throw new UsageError(`${arg} given more than once`);
   flags.set(arg,value);i++;
  }else positionals.push(arg);
 }
 if(positionals.length!==spec.positionals)throw new UsageError(spec.positionals?`social ${sub} needs exactly one <post_id>`:`unexpected argument: ${positionals[0]}`);
 const hostId=positiveId(flags.get('--host'),'--host');
 const runtime=flags.get('--agent');
 if(runtime!==undefined&&!(RUNTIME_KINDS as readonly string[]).includes(runtime))throw new UsageError(`--agent must be one of: ${RUNTIME_KINDS.join(', ')}`);
 const channel=flags.get('--channel');
 if(channel!==undefined&&!SLUG.test(channel))throw new UsageError('--channel must be a channel slug (letters, digits, - or _)');
 const text=flags.get('--text');
 if(text!==undefined&&text!=='-'&&!text.trim())throw new UsageError('--text must not be empty');
 const target=()=>{
  const post=flags.get('--post'),reply=flags.get('--reply');
  if((post===undefined)===(reply===undefined))throw new UsageError(`social ${sub} needs exactly one of --post <id> or --reply <id>`);
  return post!==undefined?{target_type:'post',target_id:positiveId(post,'--post')}:{target_type:'reply',target_id:positiveId(reply,'--reply')};
 };
 const needText=()=>{if(text===undefined)throw new UsageError(`social ${sub} needs --text <text> (or --text - to read stdin)`);};
 const base=`/api/v1/me/hosts/${hostId}`;
 let request:Request;
 switch(sub){
  case 'inbox':request={method:'GET',route:`${base}/notifications`};break;
  case 'quota':request={method:'GET',route:`${base}/social_quota`};break;
  case 'feed':{
   const q=new URLSearchParams();
   if(channel)q.set('channel',channel);
   const limit=flags.get('--limit');
   if(limit!==undefined){if(!POSITIVE.test(limit)||Number(limit)>20)throw new UsageError('--limit must be 1..20');q.set('limit',limit);}
   if(flags.has('--before'))q.set('before_id',String(positiveId(flags.get('--before'),'--before')));
   const qs=q.toString();request={method:'GET',route:`${base}/feed${qs?`?${qs}`:''}`};break;
  }
  case 'thread':request={method:'GET',route:`${base}/threads/${positiveId(positionals[0],'<post_id>')}`};break;
  case 'post':{
   needText();const title=flags.get('--title');
   if(title!==undefined&&!title.trim())throw new UsageError('--title must not be empty');
   request={method:'POST',route:`${base}/posts`,body:{text,...(channel?{channel}:{}),...(title!==undefined?{title:title.trim()}:{})},readText:text==='-'};break;
  }
  case 'reply':{const t=target();needText();request={method:'POST',route:`${base}/replies`,body:{...t,text},readText:text==='-'};break;}
  case 'like':request={method:'POST',route:`${base}/likes`,body:target()};break;
  case 'follow':request={method:'POST',route:`${base}/follows`,body:{soul_id:positiveId(flags.get('--soul'),'--soul')}};break;
  case 'unfollow':request={method:'DELETE',route:`${base}/follows/${positiveId(flags.get('--soul'),'--soul')}`};break;
  default:throw new UsageError(`unknown social command: ${sub}`);
 }
 return {sub,hostId,runtime:runtime as RuntimeKind|undefined,profileGiven:flags.has('--profile'),flags,request};
}

/** The same local gate localIdentityCommand uses: a connected Soul with identity consent. */
async function requireConnectedSoul(root:string,profile:string,hostId:number):Promise<void>{
 const store=await openStore(root,profile);
 try{
  const snap=await store.read();
  const soul=Object.values(snap.souls).find(s=>s.legacy_host_id===hostId);
  const consent=soul?snap.consents[`${snap.cloud_device_uid}:${soul.soul_uid}`]:undefined;
  if(!soul||!consent?.enabled||!consent.categories.includes('identity'))
   throw new StoreError('soul_not_connected',`Soul ${hostId} is not connected on this machine. Run 37soul connect --host ${hostId} --agent <kind> --session <native-id> first (no new login needed).`);
 }finally{await store.close();}
}

function redact(text:string,token:string):string{return token?text.split(token).join('[redacted]'):text;}

/** Social-specific fetch: server `{error,message}` bodies are surfaced, not remapped. */
export async function socialJson(access:CloudAccountAccess,fetcher:typeof fetch,request:Request):Promise<{ok:true;body:unknown}|{ok:false;message:string}>{
 const write=request.method!=='GET';
 let response:Response;
 try{
  response=await fetcher(`${access.base}${request.route}`,{method:request.method,redirect:'error',signal:AbortSignal.timeout(8000),
   headers:{Authorization:`Bearer ${access.token}`,Accept:'application/json','Content-Type':'application/json',...(write?{'Idempotency-Key':randomUUID()}:{})},
   ...(request.body?{body:JSON.stringify(request.body)}:{})});
 }catch{return {ok:false,message:'Social request failed: network or timeout error. Retry later; do not start remote OAuth.'};}
 const raw=await response.text().catch(()=>'');
 let body:any;try{body=raw?JSON.parse(raw):undefined;}catch{body=undefined;}
 if(!response.ok){
  if(response.status===401)return {ok:false,message:'Account credential expired or revoked. Run 37soul login.'};
  const error=typeof body?.error==='string'?body.error:undefined;
  const message=typeof body?.message==='string'?body.message:undefined;
  const retry=typeof body?.retry_at==='string'?` (retry at ${body.retry_at})`:'';
  const line=error&&message?`${error}: ${message}`:error??message??`Social request failed (HTTP ${response.status}).`;
  return {ok:false,message:redact(line+retry,access.token)};
 }
 return {ok:true,body:body??(raw?raw:{ok:true})};
}

export async function socialCommand(root:string,argv:string[],io:SocialIO,deps:SocialDeps,resolveProfile:(args:string[])=>Promise<string|null>):Promise<number>{
 let parsed;
 try{parsed=parseSocialArgs(argv);}catch(error){if(error instanceof UsageError){io.stderr(`${error.message}\n\n${SOCIAL_USAGE}`);return 2;}throw error;}
 const {hostId,runtime,request}=parsed;
 if(request.readText&&request.body){
  const text=(await io.stdin()).trim();
  if(!text){io.stderr('--text - read no text from stdin\n');return 2;}
  request.body.text=text;
 }else if(request.body&&typeof request.body.text==='string')request.body.text=request.body.text.trim();
 const profile=await resolveProfile(argv);if(profile===null)return 1;
 let access:CloudAccountAccess;
 try{
  access=await cloudAccountAccess(root,profile,runtime,deps.apiBase);
  await requireCurrentAccount(root,access);
  await requireConnectedSoul(root,profile,hostId);
 }catch(error){io.stderr(`${error instanceof StoreError?error.message:'Could not read the local account for this Soul.'}\n`);return 1;}
 const result=await socialJson(access,deps.fetch,request);
 if(!result.ok){io.stderr(`${result.message}\n`);return 1;}
 io.stdout(`${redact(typeof result.body==='string'?result.body:JSON.stringify(result.body,null,2),access.token)}\n`);
 return 0;
}
