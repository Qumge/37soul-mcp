import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../scripts/verify-hermes-correction.mjs').catch(()=>({}));
const valid=()=>({soul:'s',oldAsset:'old',newAsset:'new',revision:2,oldState:'superseded',learnBinding:'learn',freshBinding:'fresh',bindings:[{binding_uid:'fresh',runtime_kind:'hermes',soul_uid:'s',native_session_id:'native-fresh'}],receipts:[{binding_uid:'fresh',stage:'injected',manifest:[{asset_uid:'new',revision:2}]}],labels:['Juniper','Willow','Cedar'],oldLabels:['Alpha','Beta','Gamma'],prompt:'Summarize the finished fictional delivery.',answer:'Juniper\nDone\nWillow\nReady\nCedar\nNone',nativeAnswer:'Juniper\nDone\nWillow\nReady\nCedar\nNone',nativePrompt:'Summarize the finished fictional delivery.',nativeSession:'native-fresh',exit:0});
test('requires real native answer and corrected receipt for a distinct session',()=>{assert.equal(typeof mod.assessCorrection,'function');assert.equal(mod.assessCorrection(valid()).pass,true);});
for(const [name,patch] of Object.entries({oldReceipt:{receipts:[{binding_uid:'fresh',stage:'injected',manifest:[{asset_uid:'old',revision:1}]}]},sameSession:{freshBinding:'learn'},wrongSoul:{soul:'another'},staleRevision:{revision:3},answerInPrompt:{prompt:'Juniper Willow Cedar'},stdoutOnly:{nativeAnswer:''},nativePromptSpoof:{nativePrompt:'Juniper Willow Cedar'},oldActive:{oldState:'active'},candidateOld:{oldState:'candidate'},invalidOld:{oldState:'unknown'},differentNativePrompt:{nativePrompt:'A different query'},oldLabelsRemain:{answer:'Juniper Willow Cedar Alpha'},wrongOrder:{answer:'Cedar Willow Juniper'},nativeWrongSession:{nativeSession:'another'}}))test('rejects '+name,()=>{assert.equal(typeof mod.assessCorrection,'function');assert.equal(mod.assessCorrection({...valid(),...patch}).pass,false);});
test('four-entry budget counts automatic extraction and rejects fifth',()=>{assert.equal(typeof mod.takeEntry,'function');let count=0;for(let i=0;i<4;i++)count=mod.takeEntry(count);assert.equal(count,4);assert.throws(()=>mod.takeEntry(count),/budget/);assert.throws(()=>mod.takeEntry(-1),/budget/);});
test('native paths follow caller home and gate keeps recorded real binary under isolated HOME',()=>{
 assert.equal(typeof mod.nativePaths,'function');
 assert.deepEqual(mod.nativePaths('/portable/user'),{real_binary:'/portable/user/.local/bin/hermes',python:'/portable/user/.hermes/hermes-agent/venv/bin/python'});
 assert.equal(typeof mod.recordedNative,'function');
 const state={home:'/private/tmp/hf-test',real_binary:'/portable/user/.local/bin/hermes',python:'/portable/user/.hermes/hermes-agent/venv/bin/python'};
 assert.equal(mod.recordedNative(state,'real_binary'),state.real_binary);
 assert.throws(()=>mod.recordedNative({...state,real_binary:'/private/tmp/hf-test/.local/bin/hermes'},'real_binary'),/native/);
 assert.throws(()=>mod.recordedNative({...state,real_binary:'hermes'},'real_binary'),/native/);
});
