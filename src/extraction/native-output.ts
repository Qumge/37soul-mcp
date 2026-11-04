/** Decode only the pure-text Claude extraction surface, never general agent failures. */
export function nativeOutputRecords(stdout:string):Record<string,any>[] {
 try{const value=JSON.parse(stdout);return value&&typeof value==='object'&&!Array.isArray(value)?[value]:[];}catch{}
 const result:Record<string,any>[]=[];
 for(const line of stdout.split(/\r?\n/)){try{const value=JSON.parse(line);if(value&&typeof value==='object'&&!Array.isArray(value))result.push(value);}catch{}}
 return result;
}
export function finalNativeRecord(stdout:string):Record<string,any>|undefined {
 const rows=nativeOutputRecords(stdout);for(let i=rows.length-1;i>=0;i--)if(rows[i].type==='result')return rows[i];return rows.at(-1);
}
function shaped(value:any):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const keys=Object.keys(value);return keys.length===1&&((keys[0]==='jobs'&&Array.isArray(value.jobs))||(keys[0]==='proposals'&&Array.isArray(value.proposals)));
}
function parsed(value:unknown):unknown{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return undefined;}}
export function normalizeClaudeExtraction(code:number,stdout:string,args:readonly string[]):{code:number;stdout:string}{
 const original={code,stdout};let config:any;try{config=JSON.parse(args[args.indexOf('--mcp-config')+1]);}catch{return original;}
 if(args[args.indexOf('--output-format')+1]!=='stream-json'||args[args.indexOf('--max-turns')+1]!=='1'||args.indexOf('--tools')<0||args[args.indexOf('--tools')+1]!==''||!args.includes('--strict-mcp-config')||!args.includes('--json-schema')||!config?.mcpServers||Object.keys(config.mcpServers).length!==0)return original;
 const records=nativeOutputRecords(stdout),final=records.filter(r=>r.type==='result').at(-1);
 if(!final)return original;
 if(code===0&&!final.is_error){const value=parsed(final.structured_output??final.result);return shaped(value)?{code:0,stdout:JSON.stringify(value)}:original;}
 if(code!==1||final.is_error!==true||final.subtype!=='error_max_turns')return original;
 // One model turn can already contain complete JSON even when the SDK asks for
 // another turn solely to call its StructuredOutput helper. Do not pay for that retry.
 const candidates:unknown[]=[];
 for(const row of records){if(row.type!=='assistant'||!Array.isArray(row.message?.content))continue;
  for(const block of row.message.content){
   if(block.type==='tool_use'&&block.name!=='StructuredOutput')return original;
   const value=block.type==='tool_use'?block.input:block.type==='text'?parsed(block.text):undefined;
   if(shaped(value))candidates.push(value);
  }
 }
 const unique=new Map(candidates.map(value=>[JSON.stringify(value),value]));
 return unique.size===1?{code:0,stdout:JSON.stringify([...unique.values()][0])}:original;
}
