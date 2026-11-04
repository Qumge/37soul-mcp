/** Local source compaction. Never turns tool/assistant material into human evidence. */
import {serializeSourceTurn, type TurnMessage} from '../adapters/source-turn.js';
export const TURN_INPUT_BYTES = 6144;
export const EXTRACTION_INPUT_BYTES = 24576;
export const EXTRACTION_OUTPUT_TOKENS = 1024;
export class ExtractionInputTooLarge extends Error {
  readonly code='source_input_too_large';
  constructor(){super('Memory source exceeds the local input budget; it remains pending and was not remembered.');}
}
const bytes=(s:string)=>Buffer.byteLength(s,'utf8');
export function clipMaterial(text:string,limit:number):string{
 if(bytes(text)<=limit)return text;
 const marker='\n[material omitted to fit memory budget]\n';const buffer=Buffer.from(text);
 const half=Math.max(0,Math.floor((limit-bytes(marker))/2));
 const head=buffer.subarray(0,half).toString('utf8').replace(/\uFFFD+$/,'');
 const tail=buffer.subarray(-half).toString('utf8').replace(/^\uFFFD+/,'');
 return head+marker+tail;
}
export function explicitMemoryRequest(turnText:string):boolean{
 try {const turn=JSON.parse(turnText);return Array.isArray(turn.messages)&&turn.messages.some((m:TurnMessage)=>m.source==='user'&&/(?:请?记住|记一下|以后.{0,12}(?:默认|都要|请)|\bremember\b|\bdon['’]?t forget\b|覚えて)/iu.test(m.text));}
 catch{return false;}
}
export function compactTurnText(turnText:string):string{
 let parsed:any;try{parsed=JSON.parse(turnText);}catch{if(bytes(turnText)>TURN_INPUT_BYTES)throw new ExtractionInputTooLarge();return turnText;}
 if(parsed?.format!=='37soul-source-turn/v1'||!Array.isArray(parsed.messages)){
  if(bytes(turnText)>TURN_INPUT_BYTES)throw new ExtractionInputTooLarge();return turnText;
 }
 const seen=new Set<string>();const messages:TurnMessage[]=[];
 for(const item of parsed.messages){
  if(!item||!['user','assistant','tool'].includes(item.source)||typeof item.text!=='string')continue;
  const text=item.text.replace(/data:[^;\s]+;base64,[A-Za-z0-9+/_=-]+/g,'[binary data omitted]');
  if(item.source==='tool'){
   const key=JSON.stringify([item.kind,item.name,text]);if(seen.has(key))continue;seen.add(key);
  }
  messages.push({source:item.source,kind:item.kind,...(typeof item.name==='string'?{name:item.name}:{}),text:item.source==='user'?text:clipMaterial(text,item.source==='tool'?1024:1536)});
 }
 let result=serializeSourceTurn(messages);
 if(bytes(result)<=TURN_INPUT_BYTES)return result;
 for(const m of messages)if(m.source!=='user')m.text=clipMaterial(m.text,384);
 result=serializeSourceTurn(messages);
 // Select optional material once, with exact encoded sizes; never reserialize N shrinking arrays.
 const mandatory=messages.filter(m=>m.source!=='tool');
 const base=serializeSourceTurn(mandatory);
 if(bytes(base)>TURN_INPUT_BYTES)throw new ExtractionInputTooLarge();
 let remaining=TURN_INPUT_BYTES-bytes(base);let count=mandatory.length;
 const keep=new Set(mandatory);
 const shell=bytes(JSON.stringify({format:'37soul-source-turn/v1',messages:[]}));
 for(let i=messages.length-1;i>=0;i--){const m=messages[i];if(m.source!=='tool')continue;
  const cost=bytes(serializeSourceTurn([m]))-shell+(count>0?1:0);
  if(cost<=remaining){keep.add(m);remaining-=cost;count++;}
 }
 return serializeSourceTurn(messages.filter(m=>keep.has(m)));
}
