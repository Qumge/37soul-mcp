/** Conservative local reservations, not provider billing. Counts contain no source text. */
import {createHash} from 'node:crypto';
import type {BindingSnapshot} from '../adapters/types.js';
export interface ResourceCounter {calls:number;reserved_units:number;}
export interface DailyResourceUsage extends ResourceCounter {sessions:Record<string,ResourceCounter>;}
export type ResourceUsage=Record<string,DailyResourceUsage>;
export const resourceSession=(b:BindingSnapshot)=>createHash('sha256').update(JSON.stringify([b.device_id,b.runtime_kind,b.native_session_id])).digest('hex');
const valid=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
function counter(c:ResourceCounter|undefined):ResourceCounter{
 if(c===undefined)return {calls:0,reserved_units:0};
 if(!c||!valid(c.calls)||!valid(c.reserved_units))throw new Error('resource_budget_corrupt');return c;
}
export function canReserve(usage:ResourceUsage|undefined,binding:BindingSnapshot,units:number,now=Date.now()):boolean{
 if(usage!==undefined&&(!usage||typeof usage!=="object"||Array.isArray(usage)))throw new Error("resource_budget_corrupt");
 if(!valid(units)||units<1||units>25600)return false;
 const d=usage?.[new Date(now).toISOString().slice(0,10)];
 if(d&&(!d.sessions||typeof d.sessions!=='object'||Array.isArray(d.sessions)))throw new Error('resource_budget_corrupt');
 const profile=counter(d),session=counter(d?.sessions[resourceSession(binding)]);
 return profile.calls<40&&session.calls<20&&profile.reserved_units+units<=200000&&session.reserved_units+units<=50000;
}
export function reserve(usage:ResourceUsage|undefined,binding:BindingSnapshot,units:number,now=Date.now()):ResourceUsage{
 if(!canReserve(usage,binding,units,now))throw new Error('resource_budget_exhausted');
 const result:ResourceUsage={};const day=new Date(now).toISOString().slice(0,10);
 for(const [date,row]of Object.entries(usage??{})){const t=Date.parse(date+'T00:00:00Z');if(Number.isFinite(t)&&t<=now&&now-t<8*86400000)result[date]=structuredClone(row);}
 const today=result[day]??{calls:0,reserved_units:0,sessions:{}};const id=resourceSession(binding);const session=today.sessions[id]??{calls:0,reserved_units:0};
 today.calls++;today.reserved_units+=units;today.sessions[id]={calls:session.calls+1,reserved_units:session.reserved_units+units};result[day]=today;return result;
}
