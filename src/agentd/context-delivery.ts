/** Local delivery metadata only; never store rendered memory or infer another session. */
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {mkdirSync,writeFileSync,renameSync,rmSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';import type {BindingSnapshot} from '../adapters/types.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const contextDigest=(text:string)=>hash(text);
function directory(root:string,profile:string){if(!profile||/[\\/\0]/.test(profile)||profile.includes('..'))throw new Error('invalid delivery profile');return path.join(root,'context-delivery',profile);}
function target(root:string,binding:BindingSnapshot){return path.join(directory(root,binding.profile_id),hash([binding.device_id,binding.runtime_kind,binding.native_session_id])+'.json');}
const scope=(binding:BindingSnapshot,source:string)=>hash([binding.binding_uid,binding.revision,binding.soul_uid,binding.context_epoch??null,binding.source_boundary??null,source]);
export async function contextAlreadyDelivered(root:string,binding:BindingSnapshot,digest:string,source:string):Promise<boolean>{
 try{const row=JSON.parse(await readFile(target(root,binding),'utf8'));return row.scope===scope(binding,source)&&row.digest===digest&&Number.isFinite(row.at)&&Date.now()-row.at<7*86400000;}catch{return false;}
}
/** Commit tiny local metadata without leaving a write continuation past the hook deadline. */
export function recordContextDelivery(root:string,binding:BindingSnapshot,digest:string,source:string):void {
 const file=target(root,binding),dir=path.dirname(file);
 mkdirSync(dir,{recursive:true,mode:0o700});
 const temp=file+'.'+randomUUID()+'.tmp';
 try {
  writeFileSync(temp,JSON.stringify({scope:scope(binding,source),digest,at:Date.now()}),{mode:0o600});
  renameSync(temp,file);
 } finally { rmSync(temp,{force:true}); }
 const rows=[];
 for(const name of readdirSync(dir)) {
  if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
  const full=path.join(dir,name);
  try { rows.push({full,at:statSync(full).mtimeMs}); } catch { /* A concurrent hook may prune it. */ }
 }
 rows.sort((a,b)=>b.at-a.at);
 for(let i=0;i<rows.length;i++)if(i>=128||Date.now()-rows[i].at>7*86400000)rmSync(rows[i].full,{force:true});
}
export function invalidateContextDelivery(root:string,key:{profile_id:string;device_id:string;runtime_kind:string;native_session_id:string}):void {
 const file=path.join(directory(root,key.profile_id),hash([key.device_id,key.runtime_kind,key.native_session_id])+'.json');
 rmSync(file,{force:true});
}
