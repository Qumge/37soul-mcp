/** Production-only batching at the existing native-adapter seam. Raw text is ephemeral. */
import type {AdapterDeps,ExtractionRequest,ExtractionResult,PreparedExtraction,RuntimeAdapter} from '../adapters/types.js';
import {EXTRACTION_OUTPUT_SCHEMA} from '../adapters/claude-code.js';
import {EXTRACTION_INPUT_BYTES,explicitMemoryRequest} from './compact-input.js';
const DELIMITER='--- completed turn ---\n';
type Invocation={args:readonly string[];input:string};
const failure=(code:string):ExtractionResult=>({error:{code,retryable:false}});
function nativeValue(stdout:string):any{
 let value:any;try{value=JSON.parse(stdout.trim());}catch{return undefined;}
 for(let i=0;i<4;i++){
  if(value?.is_error===true)return undefined;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{return undefined;}continue;}
  if(value&&typeof value==='object'&&'structured_output'in value){value=value.structured_output;continue;}
  if(value&&typeof value==='object'&&'result'in value){value=value.result;continue;}
  return value;
 }
 return value;
}
function nativeSchema(value:any):any{
 if(Array.isArray(value))return value.map(nativeSchema);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([k])=>!['maxLength','maxItems'].includes(k)).map(([k,v])=>[k,nativeSchema(v)]));
}
export function withBatchExtraction(factory:(deps:AdapterDeps)=>RuntimeAdapter,deps:AdapterDeps):RuntimeAdapter{
 const base=factory(deps);
 // A blocked native host has no model surface to batch. Preserve its existing diagnostic path.
 if(typeof base.extract!=="function"||["cursor","gemini-cli"].includes(base.runtime_kind))return base;
 const baseExtract=base.extract.bind(base);const cached=new Map<string,Invocation|ExtractionResult>();
 // Only these native surfaces currently have an explicit tools-denial path.
 const batchSupported=base.runtime_kind==='claude-code'||base.runtime_kind==='pi';
 const prepare=async(request:ExtractionRequest):Promise<PreparedExtraction>=>{
  let entry=cached.get(request.job_uid);
  if(!entry){
   let captured:Invocation|undefined;
   try{
    const result=await factory({...deps,diagnostic:undefined,invoke:async(_runtime,args,input)=>{
     captured={args,input};return {code:1,stdout:'',stderr:''};
    }}).extract(request);
    entry=captured??result;
   }catch(error){entry=failure((error as {code?:string}).code??'source_preparation_failed');}
   // At most a small worker batch is retained; not a cross-tick transcript cache.
   if(cached.size>=16)cached.clear();cached.set(request.job_uid,entry);
  }
  if('input'in entry){const turn=entry.input.split(DELIMITER).at(-1)??'';return {available:true,urgent:explicitMemoryRequest(turn),input_bytes:Buffer.byteLength(entry.input,'utf8')};}
  return {available:false,urgent:false,input_bytes:0,error_code:'error'in entry?entry.error.code:'source_unavailable'};
 };
 const extract=async(request:ExtractionRequest):Promise<ExtractionResult>=>{
  try{return await baseExtract(request);}catch(error){return failure((error as {code?:string}).code??'source_preparation_failed');}
  finally{cached.delete(request.job_uid);}
 };
 const extractBatch=async(requests:readonly ExtractionRequest[]):Promise<ExtractionResult[]>=>{
  if(requests.length===0)return [];
  if(requests.length===1)return [await extract(requests[0])];
  const first=requests[0];const same=(r:ExtractionRequest)=>r.runtime_kind===first.runtime_kind&&r.native_session_id===first.native_session_id&&r.binding_uid===first.binding_uid&&r.binding_revision===first.binding_revision&&r.soul_uid===first.soul_uid;
  if(!batchSupported||requests.length>3||requests.some(r=>!same(r))||new Set(requests.map(r=>r.job_uid)).size!==requests.length)return requests.map(()=>failure('batch_scope_mismatch'));
  try{
   const ready=await Promise.all(requests.map(prepare));
   if(ready.some(r=>!r.available))return ready.map(r=>failure(r.error_code??'batch_source_unavailable'));
   const invocations=requests.map(r=>cached.get(r.job_uid) as Invocation);
   const rules=invocations[0].input.split(DELIMITER)[0];
   const input=rules+'\nBatch mode: process each job independently. Return {"jobs":[{"job_uid":"exact supplied id","proposals":[...]}]}. Include every job exactly once, even with no proposals. Never transfer facts between jobs. At most 1024 output tokens.\n--- batch data ---\n'+JSON.stringify({jobs:requests.map((r,i)=>({job_uid:r.job_uid,turn:JSON.parse(invocations[i].input.split(DELIMITER).at(-1)!)}))});
   if(Buffer.byteLength(input,'utf8')>EXTRACTION_INPUT_BYTES)return requests.map(()=>failure('source_input_too_large'));
   const args=[...invocations[0].args];const schemaIndex=args.indexOf('--json-schema');
   if(schemaIndex>=0)args[schemaIndex+1]=JSON.stringify(nativeSchema({type:'object',properties:{jobs:{type:'array',items:{type:'object',properties:{job_uid:{type:'string'},proposals:EXTRACTION_OUTPUT_SCHEMA.properties.proposals},required:['job_uid','proposals'],additionalProperties:false}}},required:['jobs'],additionalProperties:false}));
   const response=await deps.invoke(base.runtime_kind,args,input,first.job_uid);
   if(response.code!==0)return requests.map(()=>failure('model_error'));
   const value=nativeValue(response.stdout);const jobs=value?.jobs;
   const wanted=new Set(requests.map(r=>r.job_uid));
   if(!Array.isArray(jobs)||jobs.some(j=>!j||!wanted.has(j.job_uid)||!Array.isArray(j.proposals))||new Set(jobs.map(j=>j.job_uid)).size!==jobs.length)return requests.map(()=>failure('invalid_batch_output'));
   // Existing adapters recheck their frozen source and parse with the ORIGINAL request/turn refs.
   return await Promise.all(requests.map(async request=>{
    const row=jobs.find(j=>j.job_uid===request.job_uid);if(!row)return failure('batch_result_missing');
    try{return await factory({...deps,invoke:async()=>({code:0,stdout:JSON.stringify({proposals:row.proposals}),stderr:''})}).extract(request);}
    catch(error){return failure((error as {code?:string}).code??'source_preparation_failed');}
   }));
  }finally{for(const r of requests)cached.delete(r.job_uid);}
 };
 return Object.assign(base,{prepare,extract,extractBatch,batchSupported});
}
