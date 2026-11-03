import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../dist/local/store.js';
import { resolveBinding } from '../dist/local/bindings.js';
import { startWriter, sendWriter } from '../dist/local/writer.js';
import { runHookCommand } from '../dist/hook.js';
import { readSourceRefs, MAX_SOURCE_BYTES } from '../dist/agentd/source-index.js';
import { createClaudeCodeAdapter } from '../dist/adapters/claude-code.js';
import { drainPendingExtractions } from '../dist/extraction/scheduler.js';

const SOUL = '10000000-0000-4000-8000-000000000320';
const OTHER = '10000000-0000-4000-8000-000000000321';
const RAW = 'SYNTHETIC-PRIVATE-青柠纸鹤';
const FUTURE = 'FUTURE-USER-DO-NOT-INCLUDE';
const line = x => JSON.stringify(x) + '\n';
const user = (uuid = 'root-user', parentUuid = null, text = RAW) => ({ type: 'user', uuid, parentUuid, message: { role: 'user', content: text } });
const assistant = (uuid = 'final-assistant', parentUuid = 'root-user', kind = 'text', stop_reason = 'end_turn') => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', id: 'native-answer', stop_reason, content: [{ type: kind, [kind === 'thinking' ? 'thinking' : 'text']: kind === 'text' ? 'Synthetic confirmation.' : 'Synthetic private thinking.' }] } });
const padding = bytes => {
  const empty = line({ type: 'attachment', attachment: { type: 'synthetic_padding', value: '' } });
  assert.ok(bytes >= Buffer.byteLength(empty));
  return line({ type: 'attachment', attachment: { type: 'synthetic_padding', value: 'x'.repeat(bytes - Buffer.byteLength(empty)) } });
};

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'completed-turn-capture-'));
  const root = path.join(home, '.37soul');
  const key = { profile_id: 'p1', device_id: 'test-device', runtime_kind: 'claude-code', native_session_id: 'synthetic-session' };
  await mkdir(path.join(root, 'profiles', key.profile_id), { recursive: true });
  await writeFile(path.join(root, 'profiles', key.profile_id, 'device.json'), JSON.stringify({ device_id: key.device_id }));
  await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ owner: { profile_id: key.profile_id, cloud_issuer: 'https://synthetic.invalid', default_soul_uid: SOUL, soul_sync_mode: 'assets_only' } }));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ api_base_url: 'https://synthetic.invalid', machine_id: 'synthetic', tokens: {}, active_profile_id: key.profile_id }));
  const store = await openStore(root, key.profile_id);
  await store.transact(d => {
    d.owner_id = 'owner'; d.cloud_device_uid = 'cloud-device'; d.cloud_issuer = 'https://synthetic.invalid';
    for (const uid of [SOUL, OTHER]) {
      d.souls[uid] = { soul_uid: uid, legacy_host_id: uid === SOUL ? 320 : 321, origin: 'cloud', state: 'active', identity_revision: 1, identity: { name: 'Synthetic Persona', description: '', character: '', greeting: '' } };
      d.consents['cloud-device:' + uid] = { cloud_device_uid: 'cloud-device', soul_uid: uid, revision: 1, categories: ['identity', 'relationship', 'experience'], enabled: true };
    }
  });
  await store.close();
  const binding = await resolveBinding(key, SOUL, { root });
  const source = path.join(home, 'native.jsonl');
  const initial = line(user()) + line({ type: 'attachment', uuid: 'hook-attachment', parentUuid: 'root-user', attachment: { type: 'hook_success' } });
  const observed = initial + padding(31187 - Buffer.byteLength(initial));
  await writeFile(source, observed, { mode: 0o600 });
  const writer = await startWriter(root);
  t.after(async () => { await writer.close(); await rm(home, { recursive: true, force: true }); });
  const snap = async () => { const s = await openStore(root, key.profile_id); try { return await s.read(); } finally { await s.close(); } };
  const pointers = async () => {
    const dir = path.join(root, 'sources', key.profile_id);
    return Promise.all((await readdir(dir).catch(() => [])).filter(n => n.endsWith('.json')).map(async n => ({ ref: n.slice(0, -5), ...JSON.parse(await readFile(path.join(dir, n), 'utf8')) })));
  };
  const stop = async () => {
    const stdout = [], stderr = [];
    const before = performance.now();
    assert.equal(await runHookCommand({ home, agentKind: key.runtime_kind, event: 'Stop', stdin: JSON.stringify({ session_id: key.native_session_id, transcript_path: source, hook_event_name: 'Stop' }), fetch: async () => assert.fail('no network'), stdout: x => stdout.push(x), stderr: x => stderr.push(x) }), 0);
    assert.deepEqual(stdout, []); assert.deepEqual(stderr, []);
    assert.ok(performance.now() - before < 1000, 'Stop does bounded local work without waiting for the assistant');
  };
  const connect = async uid => {
    const r = await sendWriter(root, { request_uid: randomUUID(), profile_id: key.profile_id, command: 'connect_session', payload: { ...key, soul_uid: uid } });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result;
  };
  let calls = 0;
  const inputs = [], diagnostics = [];
  let output = { proposals: [] };
  let mutateBeforeRead;
  const adapter = createClaudeCodeAdapter({ home, emit: async () => {}, diagnostic: d => diagnostics.push(d), readSource: async (refs, turns) => { if (mutateBeforeRead) await mutateBeforeRead(); return readSourceRefs(root, refs, turns); }, invoke: async (_kind, _args, input) => { calls++; inputs.push(input); return { code: 0, stdout: JSON.stringify(output), stderr: '' }; } });
  const drain = () => drainPendingExtractions(root, { 'claude-code': adapter }, { diagnostic: d => diagnostics.push(d) });
  return { home, root, key, binding, source, observed, snap, pointers, stop, connect, drain, diagnostics, inputs, calls: () => calls, output: v => { output = v; }, mutate: f => { mutateBeforeRead = f; } };
}
const noAttempts = async f => {
  assert.deepEqual(await f.drain(), { started: 0, completed: 0, failed: 0 });
  assert.equal(f.calls(), 0);
  assert.ok(Object.values((await f.snap()).extraction_watermarks).every(w => !w.completed && w.attempts === 0));
};

// Replay the actual observed 31187-byte Stop before the final 44462-byte flush.
test('completed capture: user-only Stop defers with no watermark, attempt or raw persistence', async t => {
  const f = await fixture(t);
  assert.equal((await stat(f.source)).size, 31187);
  await f.stop();
  assert.deepEqual((await f.snap()).extraction_watermarks, {}, 'incomplete turns are not model jobs');
  await noAttempts(f);
  const pointers = await f.pointers();
  assert.equal(pointers.length, 1);
  assert.ok(!JSON.stringify(pointers).includes(RAW));
  assert.ok(!JSON.stringify(await f.snap()).includes(f.source));
  assert.equal(await readSourceRefs(f.root, [pointers[0].ref], ['root-user']), '', 'unresolved witnesses are never readable extraction sources');
});

test('completed capture: thinking end_turn is incomplete; exact later text freezes before future turns', async t => {
  const f = await fixture(t);
  await f.stop();
  const thinking = line(assistant('thinking', 'hook-attachment', 'thinking'));
  await appendFile(f.source, thinking);
  await noAttempts(f);
  const final = line(assistant('final-assistant', 'thinking'));
  await appendFile(f.source, final);
  const end = (await stat(f.source)).size;
  await appendFile(f.source, padding(44462 - end));
  assert.equal((await stat(f.source)).size, 44462);
  await appendFile(f.source, line(user('future-user', 'final-assistant', FUTURE)) + line(assistant('future-answer', 'future-user')));
  assert.deepEqual(await f.drain(), { started: 1, completed: 1, failed: 0 });
  assert.equal(f.calls(), 1);
  const wm = Object.values((await f.snap()).extraction_watermarks);
  assert.equal(wm.length, 1);
  assert.deepEqual(wm[0].request.source_turn_refs, ['root-user', 'thinking', 'final-assistant']);
  assert.equal(wm[0].request.binding_uid, f.binding.binding_uid);
  assert.equal(wm[0].request.soul_uid, SOUL);
  assert.equal(wm[0].attempts, 1);
  const ptr = (await f.pointers())[0];
  assert.equal(ptr.end_offset, end, 'only the matched terminal assistant endpoint is frozen');
  const body = JSON.parse(f.inputs[0].split('--- completed turn ---\n')[1]);
  assert.deepEqual(body.messages.map(x => x.source), ['user', 'assistant']);
  assert.equal(body.messages[0].text, RAW);
  assert.ok(!f.inputs[0].includes(FUTURE));
  assert.ok(!f.inputs[0].includes('Synthetic private thinking.'));
  assert.deepEqual(await f.drain(), { started: 0, completed: 0, failed: 0 });
});

test('completed capture: torn assistant JSON cannot complete until its remaining bytes arrive', async t => {
  const f = await fixture(t); await f.stop();
  const answer = line(assistant('final-assistant', 'hook-attachment'));
  await appendFile(f.source, answer.slice(0, -3));
  await noAttempts(f);
  await appendFile(f.source, answer.slice(-3));
  assert.equal((await f.drain()).completed, 1);
  assert.equal(f.calls(), 1);
});

test('completed capture: a future human before the matching final answer permanently closes the old witness', async t => {
  const f = await fixture(t); await f.stop();
  await appendFile(f.source, line(user('future-user', 'hook-attachment', FUTURE)) + line(assistant('future-answer', 'future-user')) + line(assistant('late-old-answer', 'hook-attachment')));
  await noAttempts(f);
  await writeFile(f.source, f.observed + line(assistant('final-assistant', 'hook-attachment')));
  await noAttempts(f);
});

for (const mutation of ['replacement', 'rewrite', 'truncate', 'overflow']) {
  test(`completed capture: ${mutation} fails closed and a restored source cannot revive it`, async t => {
    const f = await fixture(t); await f.stop();
    const complete = f.observed + line(assistant('final-assistant', 'hook-attachment'));
    if (mutation === 'replacement') {
      await writeFile(f.source + '.new', complete); await rename(f.source + '.new', f.source);
    } else if (mutation === 'rewrite') {
      await writeFile(f.source, complete.replace(RAW, 'x'.repeat(Buffer.byteLength(RAW))));
    } else if (mutation === 'truncate') {
      await writeFile(f.source, line(user('root-user', null, 'compacted')));
    } else {
      await appendFile(f.source, padding(MAX_SOURCE_BYTES + 1024) + line(assistant('final-assistant', 'hook-attachment')));
    }
    await noAttempts(f);
    await writeFile(f.source, complete);
    await noAttempts(f);
    assert.deepEqual((await f.snap()).assets, {});
  });
}

test('completed capture: deferred old binding stays retired across switching away and back', async t => {
  const f = await fixture(t); await f.stop();
  await f.connect(OTHER);
  await appendFile(f.source, line(assistant('final-assistant', 'hook-attachment')));
  await noAttempts(f);
  await f.connect(SOUL);
  await noAttempts(f);
  assert.deepEqual((await f.snap()).assets, {});
});

test('completed capture: repeated Stops and a drain restart share one completed native turn budget', async t => {
  const f = await fixture(t); await f.stop(); await f.stop();
  await appendFile(f.source, line(assistant('final-assistant', 'hook-attachment')));
  assert.deepEqual(await f.drain(), { started: 1, completed: 1, failed: 0 });
  assert.equal(f.calls(), 1);
  assert.equal(Object.keys((await f.snap()).extraction_watermarks).length, 1);
  await f.stop();
  assert.deepEqual(await f.drain(), { started: 0, completed: 0, failed: 0 });
});

test('completed capture: resolved source rewritten before the adapter read cannot invoke the model', async t => {
  const f = await fixture(t);
  await appendFile(f.source, line(assistant('final-assistant', 'hook-attachment')));
  await f.stop();
  f.mutate(async () => { await writeFile(f.source, f.observed.replace(RAW, 'x'.repeat(Buffer.byteLength(RAW))) + line(assistant('final-assistant', 'hook-attachment'))); });
  assert.deepEqual(await f.drain(), { started: 1, completed: 0, failed: 1 });
  assert.equal(f.calls(), 0);
  assert.ok(Object.values((await f.snap()).extraction_watermarks).every(w => !w.completed));
});

for (const shape of ['branch', 'duplicate', 'nonterminal']) {
  test(`completed capture: ambiguous or incomplete native ${shape} is not claimable`, async t => {
    const f = await fixture(t); await f.stop();
    if (shape === 'branch') await appendFile(f.source, line(assistant('a1', 'hook-attachment')) + line(assistant('a2', 'hook-attachment')));
    if (shape === 'duplicate') await appendFile(f.source, line(assistant('a1', 'hook-attachment')) + line(assistant('a1', 'hook-attachment')));
    if (shape === 'nonterminal') await appendFile(f.source, line(assistant('a1', 'hook-attachment', 'text', null)));
    await noAttempts(f);
  });
}

test('completed capture: diagnostic counts distinguish model empty, parser drops and commit rejects without bodies', async t => {
  const f = await fixture(t);
  await appendFile(f.source, line(assistant('final-assistant', 'hook-attachment')));
  await f.stop();
  // One dropped item, one parsed but invalid asset, and one accepted preference.
  const valid = { kind: 'relationship', trait: 'preference', content: 'Persist a synthetic preference.', applicability: 'future work', tags: [], evidence: 'explicit_user_statement', verification: 'unverified', sensitivity: 'normal' };
  f.output({ type: 'result', subtype: 'success', is_error: false, structured_output: { proposals: [null, { ...valid, content: 'x'.repeat(5000) }, valid] } });
  assert.equal((await f.drain()).completed, 1);
  assert.deepEqual(f.diagnostics.find(x => x.stage === 'source'), { stage: 'source', user_messages: 1, assistant_messages: 1, tool_messages: 0 });
  assert.deepEqual(f.diagnostics.find(x => x.stage === 'parse'), { stage: 'parse', proposals_received: 3, proposals_parsed: 2, proposals_dropped: 1 });
  assert.deepEqual(f.diagnostics.find(x => x.stage === 'commit'), { stage: 'commit', proposals_received: 2, proposals_accepted: 1, proposals_rejected: 1, proposals_queued: 1 });
  const serialized = JSON.stringify(f.diagnostics);
  for (const forbidden of [RAW, FUTURE, f.source, f.key.native_session_id, SOUL, 'Persist a synthetic preference.', 'Synthetic confirmation.']) assert.ok(!serialized.includes(forbidden));
});

test('completed capture: long existing history leaves bounded room after the pinned root', async t => {
  const f = await fixture(t);
  const history = line({ type: 'system', value: 'x'.repeat(1000) }).repeat(Math.ceil((MAX_SOURCE_BYTES + 20000) / 1000));
  await writeFile(f.source, history + f.observed);
  await f.stop();
  await noAttempts(f);
  await appendFile(f.source, line(assistant('final-assistant', 'hook-attachment')));
  assert.deepEqual(await f.drain(), { started: 1, completed: 1, failed: 0 });
  assert.equal(f.calls(), 1);
  assert.ok(!f.inputs[0].includes('synthetic_padding'));
});

test('completed capture: an explicit compact event permanently retires an awaiting witness', async t => {
  const f = await fixture(t); await f.stop();
  const result = await sendWriter(f.root, { request_uid: randomUUID(), profile_id: f.key.profile_id, command: 'runtime_event', payload: { event: { key: f.key, event_ref: randomUUID(), kind: 'compact', internal_job_uid: null }, source_path: f.source } });
  assert.equal(result.ok, true);
  await appendFile(f.source, line(assistant('final-assistant', 'hook-attachment')));
  await noAttempts(f);
});

test('completed capture: ordinary cloud binding ACK preserves eligibility of the same local lifecycle revision', async t => {
  const f = await fixture(t); await f.stop();
  const { syncOnce } = await import('../dist/sync/client.js');
  const report = await syncOnce('p1', async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (pathname.includes('/bindings/')) return new Response(JSON.stringify({ binding: { binding_uid: f.binding.binding_uid, session_ref: body.session_ref, runtime_kind: body.runtime_kind, soul_uid: body.soul_uid, state: body.state, revision: body.base_revision + 1 } }), { status: 200 });
    if (pathname.endsWith('/pull')) return new Response(JSON.stringify({ protocol: 'soul-assets/v1', events: [], next_cursor: null, has_more: false }), { status: 200 });
    assert.fail('Unexpected synthetic ACK route');
  }, { root: f.root, token: 'synthetic-token', tokenIssuer: 'https://synthetic.invalid', baseUrl: 'https://synthetic.invalid', backoff: { sleep: async () => {}, maxRetries: 0 } });
  assert.equal(report.conflicts, 0);
  const current = Object.values((await f.snap()).bindings).find(b => b.binding_uid === f.binding.binding_uid);
  assert.equal(current.cloud_revision, 1);
  assert.equal(current.unconfirmed, false);
  assert.equal(current.revision, f.binding.revision, 'ordinary ACK confirms, but does not advance the local lifecycle epoch');
  assert.equal(current.session_ref, f.binding.session_ref);
  await appendFile(f.source, line(assistant('final-assistant', 'hook-attachment')));
  assert.deepEqual(await f.drain(), { started: 1, completed: 1, failed: 0 });
  assert.equal(f.calls(), 1);
});

test('completed capture: malformed interior records cannot hide a future source boundary', async t => {
  const f = await fixture(t); await f.stop();
  await appendFile(f.source, '{"type":"user","uuid":"lost-boundary"\n' + line(assistant('final-assistant', 'hook-attachment')));
  await noAttempts(f);
});

test('completed capture: durable resolved pointer recovers an interrupted enqueue without a latest-source window', async t => {
  const f = await fixture(t);
  await appendFile(f.source, line(assistant('final-assistant', 'hook-attachment')));
  await f.stop();
  const pointer = (await f.pointers())[0];
  pointer.turn_capture.state = 'resolved';
  const { ref, ...record } = pointer;
  await writeFile(path.join(f.root, 'sources', f.key.profile_id, ref + '.json'), JSON.stringify(record));
  const store = await openStore(f.root, f.key.profile_id);
  await store.transact(d => { d.extraction_watermarks = {}; });
  await store.close();
  await appendFile(f.source, line(user('future-user', 'final-assistant', FUTURE)) + padding(MAX_SOURCE_BYTES + 1024));
  assert.deepEqual(await f.drain(), { started: 1, completed: 1, failed: 0 });
  assert.equal(f.calls(), 1);
  assert.ok(!f.inputs[0].includes(FUTURE));
  assert.deepEqual(f.diagnostics.find(d => d.stage === 'parse'), { stage: 'parse', proposals_received: 0, proposals_parsed: 0, proposals_dropped: 0 });
});

test('completed capture: production diagnostic formatting only emits allowlisted numeric counts', async () => {
  const { formatExtractionDiagnostic } = await import('../dist/extraction/diagnostics.js');
  assert.equal(formatExtractionDiagnostic({ stage: 'parse', proposals_received: 3, proposals_parsed: 2, proposals_dropped: 1, raw: RAW }), 'extraction parse: received 3, parsed 2, dropped 1');
  assert.equal(formatExtractionDiagnostic({ stage: 'source', user_messages: RAW, assistant_messages: -1, tool_messages: NaN }), 'extraction source: user 0, assistant 0, tool 0');
});


test('completed capture: a complete final JSON object without newline preserves the native Stop contract', async t => {
  const f = await fixture(t);
  await appendFile(f.source, line(assistant('final-assistant', 'hook-attachment')).trimEnd());
  await f.stop();
  assert.equal(Object.keys((await f.snap()).extraction_watermarks).length, 1);
  assert.deepEqual(await f.drain(), { started: 1, completed: 1, failed: 0 });
});

for (const kind of ['image', 'audio', 'attachment']) {
  test(`completed capture: a nontext ${kind} future human closes the pinned text turn`, async t => {
    const f = await fixture(t); await f.stop();
    const future = { type: 'user', uuid: 'future-nontext', parentUuid: 'hook-attachment', message: { role: 'user', content: [{ type: kind, source: { type: 'synthetic', data: 'SYNTHETIC-ONLY' } }] } };
    await appendFile(f.source, line(future) + line(assistant('future-answer', 'future-nontext')));
    await noAttempts(f);
    assert.deepEqual((await f.snap()).assets, {});
    await writeFile(f.source, f.observed + line(assistant('final-assistant', 'hook-attachment')));
    await noAttempts(f);
  });
}

test('completed capture: tool_result-only native user messages continue the same human turn', async t => {
  const f = await fixture(t); await f.stop();
  const call = { type: 'assistant', uuid: 'tool-call', parentUuid: 'hook-attachment', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'synthetic-tool', name: 'synthetic', input: {} }] } };
  const result = { type: 'user', uuid: 'tool-result', parentUuid: 'tool-call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-tool', content: 'Synthetic tool result.' }] } };
  await appendFile(f.source, line(call) + line(result) + line(assistant('final-assistant', 'tool-result')));
  assert.deepEqual(await f.drain(), { started: 1, completed: 1, failed: 0 });
  assert.deepEqual(Object.values((await f.snap()).extraction_watermarks)[0].request.source_turn_refs, ['root-user', 'tool-call', 'tool-result', 'final-assistant']);
});
