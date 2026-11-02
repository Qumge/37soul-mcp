import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {deviceLogin} from '../dist/install.js';
test('device login never forwards its device-code body to a redirected issuer',async()=>{
 let targetCalls=0;
 const target=createServer((req,res)=>{targetCalls++;req.resume();res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify({protocol:'soul-assets/v1',mode:'assets_only',owner_id:'other-server',cloud_device_uid:'foreign-device',tokens:[{agent_kind:'claude-code',token:'SYNTHETIC-FOREIGN-TOKEN'}]}));});
 target.listen(0,'127.0.0.1');await once(target,'listening');
 let base;
 const issuer=createServer((req,res)=>{req.resume();if(req.url.endsWith('/device_codes')){res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify({device_code:'SYNTHETIC-SECRET-CODE',user_code:'TEST-CODE',verification_url:base+'/cli/approve?code=TEST-CODE',expires_in:60}));}else{res.writeHead(307,{Location:`http://127.0.0.1:${target.address().port}/collect`});res.end();}});
 issuer.listen(0,'127.0.0.1');await once(issuer,'listening');base=`http://127.0.0.1:${issuer.address().port}`;
 try{
  await assert.rejects(deviceLogin({apiBase:base,fetch:globalThis.fetch,runCommand:async()=>({code:0,stdout:'',stderr:''}),openBrowser:false},['claude-code'],{assetsMode:true,machineId:'synthetic-machine'}));
  assert.equal(targetCalls,0,'device code and credentials must never cross issuer on 307');
 }finally{
  issuer.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise(r=>issuer.close(r)),new Promise(r=>target.close(r))]);
 }
});
