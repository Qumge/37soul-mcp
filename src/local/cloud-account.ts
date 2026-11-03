/** Account-scoped directory access. Credentials stay inside the runtime. */
import type {RuntimeKind} from '../assets/protocol.js';
import {loadConfig} from '../agentd/state.js';
import {credentialForRuntime,selectCredentials} from '../agentd/credentials.js';
import {readAccountsIndex,resolveLocalAssetsProfileSync} from './profiles.js';
import {assertProfileCloudIssuer,requireCloudIssuer} from './profile-issuer.js';
import {openStore,StoreError} from './store.js';

export interface CloudAccountAccess {base:string;profile:string;owner:string;device:string;localDevice:string;token:string}
export async function cloudAccountAccess(root:string,profile:string,runtime:RuntimeKind|undefined,apiBase:string):Promise<CloudAccountAccess>{
 const base=requireCloudIssuer(apiBase);const config=await loadConfig(root);const store=await openStore(root,profile);
 try{const snap=await store.read();assertProfileCloudIssuer(snap,base,await readAccountsIndex(root));
  const credential=credentialForRuntime(selectCredentials(config,profile,snap.owner_id,snap.cloud_device_uid,base),runtime);
  if(!credential||!snap.owner_id||!snap.cloud_device_uid)throw new StoreError('login_required','Account login required. Run 37soul login, then choose a Soul in your Agent.');
  return {base,profile,owner:snap.owner_id,device:snap.cloud_device_uid,localDevice:snap.device_id,token:credential.token};
 }finally{await store.close();}
}
export async function requireCurrentAccount(root:string,access:CloudAccountAccess):Promise<void>{
 const config=await loadConfig(root);const active=resolveLocalAssetsProfileSync(root);
 if((config?.active_profile_id!==undefined&&config.active_profile_id!==access.profile)||active?.profile_id!==access.profile||active.device_id!==access.localDevice)throw new StoreError('active_profile_changed','The active account/profile changed. Retry using the current native hook context.');
}
export function sameCloudAccount(a:CloudAccountAccess,b:CloudAccountAccess):boolean{return a.base===b.base&&a.profile===b.profile&&a.owner===b.owner&&a.device===b.device&&a.localDevice===b.localDevice;}
export async function accountJson(access:CloudAccountAccess,fetcher:typeof fetch,route:string,method='GET',key?:string):Promise<any>{
 try{
  const response=await fetcher(`${access.base}${route}`,{method,redirect:'error',signal:AbortSignal.timeout(8000),headers:{Authorization:`Bearer ${access.token}`,Accept:'application/json',...(method==='POST'?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(method==='POST'?{body:'{}'}:{})});
  if(!response.ok){await response.body?.cancel().catch(()=>{});if(response.status===401)throw new StoreError('login_required','Account credential expired or revoked. Run 37soul login.');if(response.status===403)throw new StoreError('soul_consent_revoked','This Soul or device is disabled or not authorized. Re-enable its consent explicitly; another account login is not a role-selection step.');if(response.status===404)throw new StoreError('unknown_soul','No owned Soul was found. Do not create a replacement.');throw new StoreError('cloud_unavailable',`The account request failed (HTTP ${response.status}).`);}
  return await response.json();
 }catch(error){if(error instanceof StoreError)throw error;throw new StoreError('cloud_unavailable','Account request failed: network or timeout error. Retry locally; do not start remote OAuth.');}
}
export interface OwnedHost {id:number;nickname:string;soul_uid:string;sex?:string;age?:number;karma_score?:number}
// PostgreSQL emits canonical hex UUIDs even when legacy md5-generated values
// have arbitrary version/variant bits. Validate the wire shape, not their origin.
export const SOUL_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function ownedHosts(root:string,profile:string,runtime:RuntimeKind|undefined,options:{name?:string;hostId?:number;limit?:number;offset?:number},deps:{apiBase:string;fetch:typeof fetch}):Promise<{hosts:OwnedHost[];pagination:{total:number;limit:number;offset:number;has_more:boolean}}>{
 const access=await cloudAccountAccess(root,profile,runtime,deps.apiBase);await requireCurrentAccount(root,access);
 const params=new URLSearchParams({limit:String(options.limit??50),offset:String(options.offset??0)});
 if(options.name!==undefined)params.set('name',options.name.trim());if(options.hostId!==undefined)params.set('host_id',String(options.hostId));
 const body=await accountJson(access,deps.fetch,`/api/v1/me/hosts?${params}`);
 const current=await cloudAccountAccess(root,profile,runtime,deps.apiBase);await requireCurrentAccount(root,current);
 if(!sameCloudAccount(access,current))throw new StoreError('active_profile_changed','The account/device changed while listing Souls. Retry with the current account.');
 if(!body||!Array.isArray(body.hosts)||!body.pagination||!Number.isSafeInteger(body.pagination.total)||body.pagination.total<0||typeof body.pagination.has_more!=='boolean')throw new StoreError('invalid_directory','The server did not return a valid owned Soul directory.');
 const hosts=body.hosts.map((host:any)=>{if(!Number.isSafeInteger(host?.id)||host.id<=0||typeof host.nickname!=='string'||typeof host.soul_uid!=='string'||!SOUL_UUID.test(host.soul_uid))throw new StoreError('invalid_directory','The owned Soul directory contains an invalid role identity.');return {id:host.id,nickname:host.nickname,soul_uid:host.soul_uid,...(typeof host.sex==='string'?{sex:host.sex}:{}),...(typeof host.age==='number'?{age:host.age}:{}),...(typeof host.karma_score==='number'?{karma_score:host.karma_score}:{})};});
 return {hosts,pagination:{total:body.pagination.total,limit:options.limit??50,offset:options.offset??0,has_more:body.pagination.has_more}};
}
