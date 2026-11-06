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
 if(typeof base.extract!=="function"||["cursor","gemini-cli","kiro"].includes(base.runtime_kind))return base;
 const batchSupported=base.runtime_kind==='claude-code'||base.runtime_kind==='pi';
 // Preparation is invocation-local: never cache raw material or failures across drains.
 const prepareInvocation=async(request:ExtractionRequest):Promise<Invocation|ExtractionResult>=>{
  let captured:Invocation|undefined;
  try{const result=await factory({...deps,diagnostic:undefined,invoke:async(_runtime,args,input)=>{captured={args,input};return {code:1,stdout:'',stderr:''};}}).extract(request);return captured??result;}
  catch(error){return failure((error as {code?:string}).code??'source_preparation_failed');}
 };
 const prepare=async(request:ExtractionRequest):Promise<PreparedExtraction>=>{
  const entry=await prepareInvocation(request);
  if('input'in entry)return {available:true,urgent:explicitMemoryRequest(entry.input.split(DELIMITER).at(-1)??''),input_bytes:Buffer.byteLength(entry.input,'utf8')};
  return {available:false,urgent:false,input_bytes:0,error_code:'error'in entry?entry.error.code:'source_unavailable'};
 };
 const checkedResult=async(request:ExtractionRequest,stdout:string,expectedInput:string):Promise<ExtractionResult>=>{
  try{return await factory({...deps,invoke:async(_kind,_args,input)=>{
   if(input!==expectedInput)throw Object.assign(new Error('Source changed during extraction'),{code:'source_changed'});
   return {code:0,stdout,stderr:''};
  }}).extract(request);}catch(error){return failure((error as {code?:string}).code??'source_preparation_failed');}
 };
 const extract=async(request:ExtractionRequest):Promise<ExtractionResult>=>{
  const entry=await prepareInvocation(request);if(!('input'in entry))return entry;
  const response=await deps.invoke(base.runtime_kind,entry.args,entry.input,request.job_uid);
  if(response.code!==0)return failure('model_error');
  return checkedResult(request,response.stdout,entry.input);
 };
 const extractBatch=async(requests:readonly ExtractionRequest[]):Promise<ExtractionResult[]>=>{
  if(requests.length===0)return [];
  if(requests.length===1)return [await extract(requests[0])];
  const first=requests[0];const same=(r:ExtractionRequest)=>r.runtime_kind===first.runtime_kind&&r.native_session_id===first.native_session_id&&r.binding_uid===first.binding_uid&&r.binding_revision===first.binding_revision&&r.soul_uid===first.soul_uid;
  if(!batchSupported||requests.length>3||requests.some(r=>!same(r))||new Set(requests.map(r=>r.job_uid)).size!==requests.length)return requests.map(()=>failure('batch_scope_mismatch'));
  const entries=await Promise.all(requests.map(prepareInvocation));
  if(entries.some(e=>!('input'in e)))return entries.map(e=>failure('error'in e?e.error.code:'batch_source_unavailable'));
  const invocations=entries as Invocation[];
  const rules=invocations[0].input.split(DELIMITER)[0];
  const input=rules+'\nBatch mode: process each job independently. Return {"jobs":[{"job_uid":"exact supplied id","proposals":[...]}]}. Include every job exactly once, even with no proposals. Never transfer facts between jobs. At most 1024 output tokens.\n--- batch data ---\n'+JSON.stringify({jobs:requests.map((r,i)=>({job_uid:r.job_uid,turn:JSON.parse(invocations[i].input.split(DELIMITER).at(-1)!)}))});
  if(Buffer.byteLength(input,'utf8')>EXTRACTION_INPUT_BYTES)return requests.map(()=>failure('source_input_too_large'));
  const args=[...invocations[0].args];const schemaIndex=args.indexOf('--json-schema');
  if(schemaIndex>=0)args[schemaIndex+1]=JSON.stringify(nativeSchema({type:'object',properties:{jobs:{type:'array',items:{type:'object',properties:{job_uid:{type:'string'},proposals:EXTRACTION_OUTPUT_SCHEMA.properties.proposals},required:['job_uid','proposals'],additionalProperties:false}}},required:['jobs'],additionalProperties:false}));
  const response=await deps.invoke(base.runtime_kind,args,input,first.job_uid);
  if(response.code!==0)return requests.map(()=>failure('model_error'));
  const value=nativeValue(response.stdout),jobs=value?.jobs,wanted=new Set(requests.map(r=>r.job_uid));
  if(!Array.isArray(jobs)||jobs.some(j=>!j||!wanted.has(j.job_uid)||!Array.isArray(j.proposals))||new Set(jobs.map(j=>j.job_uid)).size!==jobs.length)return requests.map(()=>failure('invalid_batch_output'));
  return Promise.all(requests.map((request,i)=>{const row=jobs.find(j=>j.job_uid===request.job_uid);return row?checkedResult(request,JSON.stringify({proposals:row.proposals}),invocations[i].input):failure('batch_result_missing');}));
 };
 return Object.assign(base,{prepare,extract,extractBatch,batchSupported});
}
