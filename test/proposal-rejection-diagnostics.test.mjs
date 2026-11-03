import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateProposedAsset } from '../dist/assets/validation.js';
import { formatExtractionDiagnostic } from '../dist/extraction/diagnostics.js';
import { openStore } from '../dist/local/store.js';
import { resolveBinding } from '../dist/local/bindings.js';
import { startWriter, sendWriter } from '../dist/local/writer.js';
import { drainPendingExtractions } from '../dist/extraction/scheduler.js';
import { createClaudeCodeAdapter } from '../dist/adapters/claude-code.js';

const PRIVATE = 'SYNTHETIC-PRIVATE-REJECT-MARKER';
const proposal = () => ({ kind: 'relationship', trait: 'preference', content: 'A durable synthetic preference.', applicability: 'future summaries', tags: ['synthetic'], evidence: 'explicit_user_statement', verification: 'unverified', sensitivity: 'normal', source: { runtime_kind: 'claude-code', session_ref: 'synthetic-session-ref', event_ref: 'u', occurred_at: '2026-11-04T00:00:00Z' } });
const cases = [
  ['content_limit', p => { p.content = '🪁'.repeat(201); }],
  ['content_limit', p => { p.kind = 'experience'; p.trait = 'fact'; p.content = 'x'.repeat(4001); }],
  ['applicability_limit', p => { p.applicability = 'x'.repeat(501); }],
  ['tags_limit', p => { p.tags = Array(9).fill('tag'); }],
  ['tag_invalid', p => { p.tags = ['x'.repeat(33)]; }],
  ['invalid_enum', p => { p.evidence = PRIVATE; }],
  ['invalid_type', p => { p.applicability = {}; }],
  ['experience_trait', p => { p.kind = 'experience'; p.trait = 'preference'; }],
  ['source_invalid', p => { p.source = null; }],
  ['event_ref_limit', p => { p.source.event_ref = 'x'.repeat(129); }],
  ['timestamp_invalid', p => { p.source.occurred_at = PRIVATE; }],
  ['unexpected_field', p => { p[PRIVATE] = 'untrusted field'; }],
];
for (const [index, [reason, mutate]] of cases.entries()) {
  test(`rejection diagnostic: fixed reason ${reason} (${index + 1}) retains strict rejection without strings`, () => {
    const p = proposal(); mutate(p);
    assert.throws(() => validateProposedAsset(p), error => {
      assert.equal(error.reason, reason);
      assert.ok(!JSON.stringify({ reason: error.reason }).includes(PRIVATE));
      return true;
    });
  });
}

test('rejection diagnostic: formatter only emits fixed labels and positive safe integer counts', () => {
  assert.equal(formatExtractionDiagnostic({ stage: 'reject', reasons: { content_limit: 1, applicability_limit: 2, [PRIVATE]: 99, invalid_enum: PRIVATE, invalid_type: -1 } }), 'extraction reject: content_limit 1, applicability_limit 2');
});

test('rejection diagnostic: parser-to-writer preserves rejection policy and reports field limits without raw proposals', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'proposal-rejection-'));
  const root = path.join(home, '.37soul');
  const key = { profile_id: 'p1', device_id: 'test-device', runtime_kind: 'claude-code', native_session_id: 'synthetic-native-session' };
  await mkdir(path.join(root, 'profiles/p1'), { recursive: true });
  await writeFile(path.join(root, 'profiles/p1/device.json'), JSON.stringify({ device_id: key.device_id }));
  const store = await openStore(root, 'p1');
  await store.transact(d => {
    d.souls.s1 = { soul_uid: 's1', state: 'active', legacy_host_id: null, identity_revision: 1, identity: { name: 'Synthetic', description: '', character: '', greeting: '' } };
    d.consents['device:s1'] = { cloud_device_uid: 'device', soul_uid: 's1', enabled: true, categories: ['identity', 'relationship', 'experience'], revision: 1 };
  });
  await store.close();
  const binding = await resolveBinding(key, 's1', { root });
  const writer = await startWriter(root);
  t.after(async () => { await writer.close(); await rm(home, { recursive: true, force: true }); });
  const event = { key, event_ref: randomUUID(), kind: 'turn_completed', source_turn_refs: ['u', 'a'], internal_job_uid: null };
  const queued = await sendWriter(root, { request_uid: randomUUID(), profile_id: 'p1', command: 'runtime_event', payload: { event } });
  assert.equal(queued.ok, true);
  const raw = [proposal(), proposal(), proposal()];
  raw[0].content = PRIVATE.repeat(20); raw[1].applicability = PRIVATE.repeat(25);
  for (const item of raw) delete item.source;
  const source = [
    { type: 'user', uuid: 'u', parentUuid: null, message: { role: 'user', content: PRIVATE } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Synthetic confirmation.' }] } },
  ].map(x => JSON.stringify(x)).join('\n');
  const diagnostics = [];
  const adapter = createClaudeCodeAdapter({ home, emit: async () => {}, diagnostic: d => diagnostics.push(d), readSource: async () => source, invoke: async () => ({ code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', structured_output: { proposals: raw } }), stderr: '' }) });
  assert.deepEqual(await drainPendingExtractions(root, { 'claude-code': adapter }, { diagnostic: d => diagnostics.push(d) }), { started: 1, completed: 1, failed: 0 });
  assert.deepEqual(diagnostics.find(d => d.stage === 'parse'), { stage: 'parse', proposals_received: 3, proposals_parsed: 3, proposals_dropped: 0 });
  assert.deepEqual(diagnostics.find(d => d.stage === 'commit'), { stage: 'commit', proposals_received: 3, proposals_accepted: 1, proposals_rejected: 2, proposals_queued: 1 });
  assert.deepEqual(diagnostics.find(d => d.stage === 'reject'), { stage: 'reject', reasons: { content_limit: 1, applicability_limit: 1 } });
  const s = await openStore(root, 'p1'); const snap = await s.read(); await s.close();
  assert.equal(Object.keys(snap.assets).length, 1);
  assert.equal(Object.values(snap.assets)[0].binding_uid, binding.binding_uid);
  assert.equal(Object.values(snap.assets)[0].content, proposal().content);
  assert.ok(!JSON.stringify(diagnostics).includes(PRIVATE));
  assert.ok(!JSON.stringify(snap).includes(PRIVATE), 'rejected proposal content is never persisted');
});
