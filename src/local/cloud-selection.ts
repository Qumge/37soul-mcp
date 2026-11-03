/** Explicit role selection uses the existing account login, never a new OAuth. */
import {RUNTIME_KINDS,type RuntimeKind,type Consent} from '../assets/protocol.js';
import {loadConfig} from '../agentd/state.js';
import {registerWriterCommand} from './writer.js';
import {openStore,StoreError,type StoreSnapshot} from './store.js';
import {accountJson,cloudAccountAccess,requireCurrentAccount,sameCloudAccount,SOUL_UUID} from './cloud-account.js';
let transport:typeof fetch|undefined;
export function configureCloudSelectionHttp(fetcher:typeof fetch):void{transport=fetcher;}
function rejectDisabled(snap:StoreSnapshot,soulUid:string):void{
 const consent=snap.consents[`${snap.cloud_device_uid}:${soulUid}`];
 const pendingRevoke=Object.values(snap.outbox).some(op=>op.operation_kind==='consent'&&op.request.soul_uid===soulUid&&(op.request.enabled===false||!Array.isArray(op.request.categories)||!op.request.categories.includes('identity')));
 if((consent&&(!consent.enabled||!consent.categories.includes('identity')))||pendingRevoke)throw new StoreError('soul_consent_revoked','This Soul has disabled or revoked consent. Re-enable it explicitly before reconnecting; account login is already separate.');
}
registerWriterCommand('select_cloud_soul',async({root,request})=>{
 if(!transport)throw new StoreError('http_not_configured','The account selection transport is unavailable.');
 const hostId=request.payload.host_id;const soulUid=request.payload.soul_uid;const runtime=request.payload.runtime_kind as RuntimeKind;
 if(!Number.isSafeInteger(hostId)||Number(hostId)<=0||typeof soulUid!=='string'||!SOUL_UUID.test(soulUid)||!(RUNTIME_KINDS as readonly string[]).includes(runtime))throw new StoreError('invalid_selection','Choose an owned Soul using its directory identity and native runtime.');
 const config=await loadConfig(root);const access=await cloudAccountAccess(root,request.profile_id,runtime,config?.api_base_url??'https://37soul.com');await requireCurrentAccount(root,access);
 const store=await openStore(root,request.profile_id);
 try{
  rejectDisabled(await store.read(),soulUid);
  const body=await accountJson(access,transport,`/api/v1/me/hosts/${hostId}/connection`,'POST',request.request_uid);
  const current=await cloudAccountAccess(root,request.profile_id,runtime,access.base);await requireCurrentAccount(root,current);
  if(!sameCloudAccount(access,current))throw new StoreError('active_profile_changed','The account/device changed during Soul selection. Retry with current hook context.');
  const consent=body?.consent as Consent|undefined;
  if(body?.protocol!=='soul-assets/v1'||body.host_id!==hostId||body.soul_uid!==soulUid||!consent||consent.soul_uid!==soulUid||consent.cloud_device_uid!==access.device||consent.enabled!==true||!Number.isSafeInteger(consent.revision)||consent.revision<1||!Array.isArray(consent.categories)||!consent.categories.includes('identity')||consent.categories.some(c=>!['identity','relationship','experience'].includes(c)))throw new StoreError('invalid_selection','The server did not confirm this owned Soul and device consent.');
  const snap=await store.read();rejectDisabled(snap,soulUid);
  await store.transact(draft=>{
   const key=`${access.device}:${soulUid}`;const previous=draft.consents[key];
   if(!previous||previous.revision<consent.revision)draft.consents[key]=consent;
   // Reset only for a new authorization; retrying an incomplete restore must keep its checkpoint.
   if(!previous||previous.revision<consent.revision)draft.pull_cursor='0';
  });
  return {host_id:hostId,soul_uid:soulUid,selected:true};
 }finally{await store.close();}
});
