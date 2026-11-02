import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../dist/cli.js';
for (const [label, metadata] of [['missing',null],['damaged','{bad'],['empty','{}'],['unsupported',JSON.stringify({owner:{profile_id:'p',soul_sync_mode:'legacy'}})]]) {
 test(`explicit all-profiles sync reports actionable failure instead of success when profile metadata is ${label}`, async()=>{
  const home=mkdtempSync(path.join(tmpdir(),'sync-delivery-')); const previous=process.env.SOUL37_HOME;const oldFetch=globalThis.fetch;
  process.env.SOUL37_HOME=home;let output='';let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('network forbidden')};
  try{
   const root=path.join(home,'.37soul');mkdirSync(root);
   if(metadata!==null)writeFileSync(path.join(root,'accounts.json'),metadata);
   const code=await main(['sync','--all-profiles'],{stdout:t=>output+=t,stderr:t=>output+=t,stdin:async()=>''});
   assert.equal(code,1);assert.match(output,/profile.*(unavailable|found)|login|install/i);assert.equal(calls,0);
  }finally{globalThis.fetch=oldFetch;if(previous===undefined)delete process.env.SOUL37_HOME;else process.env.SOUL37_HOME=previous;rmSync(home,{recursive:true,force:true})}
 });
}
