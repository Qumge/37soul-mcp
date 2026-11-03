import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../dist/local/store.js';
import { bindingKey, resolveBinding, assertBindingCurrent } from '../dist/local/bindings.js';
import { startWriter, sendWriter } from '../dist/local/writer.js';
import { captureSourcePointer } from '../dist/agentd/source-index.js';
import { scheduleExtraction, drainPendingExtractions, rangeForEvent, watermarkKey } from '../dist/extraction/scheduler.js';
import { syncOnce } from '../dist/sync/client.js';
import { runHookCommand } from '../dist/hook.js';
import { createFakeAdapter } from './helpers/fake-runtime.mjs';

const OLD_SOUL = '10000000-0000-4000-8000-000000000277';
const NEW_SOUL = '10000000-0000-4000-8000-000000000278';
const issuer = 'https://retired-binding.example';
const key = { profile_id: 'p1', device_id: 'local-device', runtime_kind: 'claude-code', native_session_id: 'one-native-session' };
const completedRange = { event_refs: [randomUUID()], start: 1, end: 1 };
const oldBinding = snapshot => Object.values(snapshot.bindings).find(b => b.soul_uid === OLD_SOUL);
const currentBinding = snapshot => snapshot.bindings[bindingKey(key)];
const proposal = content => ({ kind: 'relationship', trait: 'preference', content, applicability: 'future work', tags: [], evidence: 'explicit_user_statement', verification: 'unverified', sensitivity: 'normal', source: { runtime_kind: key.runtime_kind, session_ref: '', event_ref: 'native-completed-turn', occurred_at: '2026-11-03T00:00:00Z' } });

async function fixture(t, { completed = true, pending = true } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'retired-bindings-'));
  const root = path.join(home, '.37soul');
  const dir = path.join(root, 'profiles', key.profile_id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'device.json'), JSON.stringify({ device_id: key.device_id }));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ api_base_url: issuer, machine_id: 'synthetic-machine', tokens: {}, active_profile_id: key.profile_id }));
  await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ owner: { profile_id: key.profile_id, cloud_issuer: issuer, default_soul_uid: OLD_SOUL, soul_sync_mode: 'assets_only' } }));
  const store = await openStore(root, key.profile_id);
  await store.transact(draft => {
    draft.owner_id = 'owner'; draft.cloud_device_uid = 'cloud-device'; draft.cloud_issuer = issuer;
    for (const [uid, name, id] of [[OLD_SOUL, 'Old Cached Persona', 277], [NEW_SOUL, 'New Cached Persona', 278]]) {
      draft.souls[uid] = { soul_uid: uid, legacy_host_id: id, identity_revision: 1, state: 'active', origin: 'cloud', identity: { name, description: '', character: 'A fixture identity.', greeting: '' } };
      draft.consents[`cloud-device:${uid}`] = { cloud_device_uid: 'cloud-device', soul_uid: uid, revision: 1, categories: ['identity', 'relationship', 'experience'], enabled: true };
    }
  });
  await store.close();
  const old = await resolveBinding(key, OLD_SOUL, { root });
  const source = path.join(home, 'native-session.jsonl');
  await writeFile(source, 'old transcript must not be reassigned\n');
  await captureSourcePointer(root, key.profile_id, randomUUID(), { runtime_kind: key.runtime_kind, native_session_id: key.native_session_id, path: source, captured_at: new Date().toISOString() });
  const writer = await startWriter(root);
  t.after(async () => { await writer.close(); await rm(home, { recursive: true, force: true }); });
  const snap = async () => { const s = await openStore(root, key.profile_id); try { return await s.read(); } finally { await s.close(); } };
  if (completed) await scheduleExtraction(old, completedRange, { root, adapter: createFakeAdapter(key.runtime_kind, { extract: async () => ({ proposals: [proposal('Keep completed old-Soul work sendable.')] }) }) });
  const event = { key, event_ref: randomUUID(), kind: 'turn_completed', internal_job_uid: null };
  if (pending) {
    const result = await sendWriter(root, { request_uid: randomUUID(), profile_id: key.profile_id, command: 'runtime_event', payload: { event, source_path: source } });
    assert.equal(result.ok, true);
  }
  const before = await snap();
  const connect = async soulUid => {
    const result = await sendWriter(root, { request_uid: randomUUID(), profile_id: key.profile_id, command: 'connect_session', payload: { ...key, soul_uid: soulUid } });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result;
  };
  const switchSoul = async () => { await connect(NEW_SOUL); return currentBinding(await snap()); };
  // Seed a valid retired shape independently of retention, isolating boundary
  // probes so a missing archive cannot make stale-task tests pass accidentally.
  const ensureOldMetadata = async () => {
    if (!oldBinding(await snap())) {
      const s = await openStore(root, key.profile_id);
      await s.transact(draft => { draft.bindings[`fixture-retired:${old.binding_uid}`] = { ...old, retired: true }; });
      await s.close();
    }
  };
  return { home, root, old, before, source, event, snap, connect, switchSoul, ensureOldMetadata };
}

test('retired bindings: warm cached switch preserves pending binding and completed proposal for sync and ACK', async t => {
  const f = await fixture(t);
  const current = await f.switchSoul();
  const after = await f.snap();
  for (const [id, op] of Object.entries(f.before.outbox)) assert.deepEqual(after.outbox[id], op, 'frozen old outbox operations must not be rewritten');
  const serverBindings = new Map();
  const wire = [];
  const http = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    wire.push({ pathname, body });
    if (pathname.includes('/bindings/')) {
      const uid = pathname.split('/').at(-1);
      const binding = { binding_uid: uid, session_ref: body.session_ref, runtime_kind: body.runtime_kind, soul_uid: body.soul_uid, state: body.state, revision: body.base_revision + 1 };
      serverBindings.set(uid, binding);
      return new Response(JSON.stringify({ binding }), { status: 200 });
    }
    if (pathname.endsWith('/push')) {
      const results = body.changes.map(change => {
        const binding = serverBindings.get(change.binding_uid);
        const valid = binding && binding.soul_uid === change.soul_uid && binding.revision === change.binding_revision && binding.state === 'bound';
        return { change_id: change.change_id, status: valid ? 'accepted' : 'rejected', applied_revisions: valid ? [{ object_uid: change.asset_uid, revision: 1 }] : [], objects: [], error: valid ? null : { code: 'sync_not_authorized', retryable: false } };
      });
      return new Response(JSON.stringify({ protocol: 'soul-assets/v1', results }), { status: 200 });
    }
    if (pathname.endsWith('/pull')) return new Response(JSON.stringify({ protocol: 'soul-assets/v1', events: [], next_cursor: null, has_more: false }), { status: 200 });
    assert.fail(`unexpected synthetic sync route: ${pathname}`);
  };
  const report = await syncOnce(key.profile_id, http, { root: f.root, token: 'synthetic-only', tokenIssuer: issuer, baseUrl: issuer, backoff: { sleep: async () => {}, maxRetries: 0 } });
  assert.equal(report.conflicts, 0, 'old completed proposal must not become sync_not_authorized');
  const synced = await f.snap();
  assert.deepEqual(synced.quarantine, {}, 'old binding must not become binding_not_found');
  const retired = oldBinding(synced);
  assert.ok(retired, 'old session_ref metadata must remain locally resolvable');
  assert.equal(retired.binding_uid, f.old.binding_uid);
  assert.equal(retired.session_ref, f.old.session_ref);
  assert.equal(retired.soul_uid, OLD_SOUL);
  assert.equal(retired.state, f.old.state);
  assert.equal(retired.revision, f.old.revision);
  assert.equal(retired.cloud_revision, 1, 'old binding ACK must find its retired metadata');
  assert.equal(retired.unconfirmed, false);
  assert.equal(currentBinding(synced).binding_uid, current.binding_uid);
  assert.equal(currentBinding(synced).soul_uid, NEW_SOUL);
  const asset = Object.values(synced.assets)[0];
  assert.equal(asset.sync_state, 'synced');
  assert.equal(asset.soul_uid, OLD_SOUL);
  assert.equal(asset.binding_uid, f.old.binding_uid);
  assert.equal(asset.source.session_ref, f.old.session_ref);
  const oldPut = wire.find(call => call.pathname.endsWith('/bindings/' + f.old.binding_uid));
  assert.deepEqual(oldPut.body, Object.values(f.before.outbox).find(op => op.operation_kind === 'binding').request);
  const pushed = wire.find(call => call.pathname.endsWith('/push')).body.changes[0];
  assert.deepEqual(pushed, Object.values(f.before.outbox).find(op => op.operation_kind === 'asset').request);
  assert.ok(!JSON.stringify(wire).includes('retired'));
  assert.ok(!JSON.stringify(wire).includes(key.native_session_id));
  assert.ok(!JSON.stringify(wire).includes(f.source));
  const count = Object.keys(synced.bindings).length;
  await f.connect(NEW_SOUL);
  assert.equal(Object.keys((await f.snap()).bindings).length, count, 'idempotent reconnect must not create extra retired metadata');
});

test('retired bindings: current assertions require the canonical native key plus UID and revision', async t => {
  const f = await fixture(t, { completed: false });
  const current = await f.switchSoul();
  await f.ensureOldMetadata();
  await assert.rejects(() => assertBindingCurrent(key, f.old.binding_uid, f.old.revision, { root: f.root }), error => ['unknown_binding', 'stale_binding'].includes(error.code));
  await assert.rejects(() => assertBindingCurrent({ ...key, native_session_id: 'another-session' }, current.binding_uid, current.revision, { root: f.root }));
  await assert.rejects(() => assertBindingCurrent({ ...key, device_id: 'another-device' }, current.binding_uid, current.revision, { root: f.root }));
  await assertBindingCurrent(key, current.binding_uid, current.revision, { root: f.root });
});

test('retired bindings: writer claim refuses the old UID before spending a model attempt', async t => {
  const f = await fixture(t, { completed: false });
  await f.switchSoul(); await f.ensureOldMetadata();
  const range = rangeForEvent(f.event);
  const before = (await f.snap()).extraction_watermarks[watermarkKey(f.old, range)];
  const result = await sendWriter(f.root, { request_uid: randomUUID(), profile_id: key.profile_id, command: 'begin_extraction', payload: { binding: f.old, range, job_uid: before.request.job_uid } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { scheduled: false, reason: 'stale_binding' });
  assert.deepEqual((await f.snap()).extraction_watermarks[watermarkKey(f.old, range)], before, 'stale claim cannot rewrite the frozen job or increment attempts');
});

test('retired bindings: direct scheduling and drain cannot run archived pending model tasks', async t => {
  const f = await fixture(t);
  await f.switchSoul(); await f.ensureOldMetadata();
  const before = await f.snap();
  let modelCalls = 0;
  const adapter = createFakeAdapter(key.runtime_kind, { extract: async () => { modelCalls++; return { proposals: [proposal('A stale task must never run.')] }; } });
  await scheduleExtraction(f.old, { event_refs: [randomUUID()], start: 91, end: 91 }, { root: f.root, adapter });
  assert.equal(modelCalls, 0, 'old snapshot cannot start a model via the direct scheduling path');
  assert.deepEqual(await drainPendingExtractions(f.root, { [key.runtime_kind]: adapter }), { started: 0, completed: 0, failed: 0 });
  assert.equal(modelCalls, 0, 'drain must exclude archived bindings before model invocation');
  const after = await f.snap();
  assert.deepEqual(after.assets, before.assets);
  assert.deepEqual(after.extraction_watermarks, before.extraction_watermarks);
});

test('retired bindings: an in-flight old extraction cannot commit after the session switches', async t => {
  const f = await fixture(t, { completed: false, pending: false });
  const range = { event_refs: [randomUUID()], start: 101, end: 101 };
  let calls = 0;
  const adapter = createFakeAdapter(key.runtime_kind, { extract: async () => {
    calls++;
    await f.switchSoul(); await f.ensureOldMetadata();
    return { proposals: [proposal('Late old-revision output must not commit.')] };
  } });
  await scheduleExtraction(f.old, range, { root: f.root, adapter });
  assert.equal(calls, 1, 'only the already-started synthetic task ran');
  const after = await f.snap();
  assert.deepEqual(after.assets, {});
  const wm = after.extraction_watermarks[watermarkKey(f.old, range)];
  assert.equal(wm.completed, false);
  assert.equal(wm.last_error, 'stale_binding');
  assert.equal(wm.request.binding_uid, f.old.binding_uid);
  assert.equal(wm.request.soul_uid, OLD_SOUL);
});

test('retired bindings: native resolution and injection use only the new canonical binding', async t => {
  const f = await fixture(t);
  const current = await f.switchSoul(); await f.ensureOldMetadata();
  await appendFile(f.source, 'new Soul source only\n');
  assert.equal((await resolveBinding(key, undefined, { root: f.root })).binding_uid, current.binding_uid);
  const out = [], errors = [];
  assert.equal(await runHookCommand({ home: f.home, agentKind: key.runtime_kind, event: 'SessionStart', stdin: JSON.stringify({ session_id: key.native_session_id, transcript_path: f.source }), fetch: async () => assert.fail('no real network'), stdout: text => out.push(text), stderr: text => errors.push(text), timeoutMs: 3000 }), 0);
  assert.deepEqual(errors, []);
  const text = JSON.parse(out.join('')).hookSpecificOutput.additionalContext;
  assert.match(text, /New Cached Persona/);
  assert.ok(!text.includes('Old Cached Persona'));
  assert.ok(!text.includes('Keep completed old-Soul work sendable.'));
  const after = await f.snap();
  assert.ok(Object.values(after.receipts).every(receipt => receipt.binding_uid === current.binding_uid));
  assert.equal(Object.values(after.assets)[0].soul_uid, OLD_SOUL);
  const pointer = JSON.parse(await readFile(path.join(f.root, 'sources', key.profile_id, f.event.event_ref + '.json'), 'utf8'));
  assert.equal(pointer.path, f.source);
  assert.equal(pointer.native_session_id, key.native_session_id);
});

test('retired bindings: disabled target consent requires explicit re-enable and preserves the current binding', async t => {
  const f = await fixture(t);
  const store = await openStore(f.root, key.profile_id);
  await store.transact(draft => { draft.consents[`cloud-device:${NEW_SOUL}`].enabled = false; });
  await store.close();
  const before = await f.snap();
  const result = await sendWriter(f.root, { request_uid: randomUUID(), profile_id: key.profile_id, command: 'connect_session', payload: { ...key, soul_uid: NEW_SOUL } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'identity_not_authorized');
  assert.match(result.error.message, /identity consent/i);
  assert.match(result.error.message, /explicitly.*re-enable/i);
  assert.ok(!result.error.message.includes('login'));
  const after = await f.snap();
  assert.deepEqual(after.bindings, before.bindings);
  assert.deepEqual(after.outbox, before.outbox);
  assert.deepEqual(after.assets, before.assets);
});
