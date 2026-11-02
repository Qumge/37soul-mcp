import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDoctor } from '../dist/doctor.js';
import { saveConfig, saveState, emptyState } from '../dist/agentd/state.js';
import { openStore } from '../dist/local/store.js';

const A = 'https://a.test/team';
const B = 'https://b.test/team';
const credential = { issuer: A, token: 'FAKE-A', profile_id: 'p1', owner_id: 'owner', cloud_device_uid: 'device', runtime_kind: 'claude-code', obtained_at: 'fixture' };
async function fixture(run) {
  const home = mkdtempSync(path.join(tmpdir(), 'doctor-issuer-'));
  const root = path.join(home, '.37soul');
  await saveConfig(root, { api_base_url: B, machine_id: 'machine', tokens: { 'claude-code': 'LEGACY-FAKE-A' }, credentials: [credential] });
  let calls = 0;
  const deps = { home, apiBase: B, fetch: async () => { calls++; return { status: 200 }; }, runCommand: async () => ({ code: 0, stdout: '', stderr: '' }), nodePath: process.execPath, cliScriptPath: '/fake/cli.js', lang: 'en', inspectRuntime: async () => ({ ok: false, detail: 'fake offline runtime' }) };
  try { await run({ root, deps, calls: () => calls }); } finally { rmSync(home, { recursive: true, force: true }); }
}
async function profile(root, { owner = 'owner', device = 'device', mode = 'assets_only' } = {}) {
  writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({ owner: { profile_id: 'p1', cloud_issuer: B, default_soul_uid: null, soul_sync_mode: mode } }));
  const store = await openStore(root, 'p1');
  await store.transact(d => { d.owner_id = owner; d.cloud_device_uid = device; d.cloud_issuer = B; });
  await store.close();
}
const syncCredential = report => report.checks.find(c => c.name === 'claude-code: sync credential');

test('doctor missing or corrupt mode metadata never sends legacy A token to B or accepts old upload success', async () => {
  await fixture(async ({ root, deps, calls }) => {
    const state = emptyState('machine');
    state.sessions['claude-code:old-session'] = { last_upload_at: '2026-11-02T00:00:00Z' };
    await saveState(root, state);
    const before = readFileSync(path.join(root, 'config.json'), 'utf8');
    for (const metadata of [null, '{broken', JSON.stringify({ owner: { profile_id: 'p1', cloud_issuer: B, soul_sync_mode: 'unknown' } })]) {
      if (metadata !== null) writeFileSync(path.join(root, 'accounts.json'), metadata);
      const report = await runDoctor(deps);
      assert.equal(calls(), 0, 'doctor has no authorized network probe, regardless of metadata');
      assert.equal(syncCredential(report)?.ok, false);
      assert.ok(report.notes.some(n => n.includes('37soul login')));
      assert.ok(!report.checks.some(c => c.ok && /last upload|: token$/.test(c.name)), 'historical transcript upload is not current delivery success');
    }
    assert.equal(readFileSync(path.join(root, 'config.json'), 'utf8'), before);
  });
});

test('doctor rejects wrong issuer, profile, owner or device even with assets_only metadata', async () => {
  await fixture(async ({ root, deps, calls }) => {
    await profile(root);
    for (const entry of [credential, { ...credential, issuer: B, profile_id: 'other' }, { ...credential, issuer: B, owner_id: 'other' }, { ...credential, issuer: B, cloud_device_uid: 'other' }, { ...credential, issuer: undefined }]) {
      await saveConfig(root, { api_base_url: B, machine_id: 'machine', tokens: { 'claude-code': 'LEGACY-FAKE-A' }, credentials: [entry] });
      const report = await runDoctor(deps);
      assert.equal(syncCredential(report)?.ok, false, JSON.stringify(entry));
      assert.ok(report.notes.some(n => n.includes('37soul login')));
      assert.match(report.checks.find(c => c.name === 'soul sync')?.detail ?? '', /login required/);
    }
    assert.equal(calls(), 0);
  });
});

test('doctor only accepts credentials whose account owner agrees with the actual profile snapshot', async () => {
  await fixture(async ({ root, deps, calls }) => {
    await profile(root, { owner: 'other' });
    await saveConfig(root, { api_base_url: B, machine_id: 'machine', tokens: {}, credentials: [{ ...credential, issuer: B, owner_id: 'other' }] });
    const report = await runDoctor(deps);
    assert.equal(syncCredential(report)?.ok, false);
    assert.ok(report.notes.some(n => n.includes('37soul login')));
    assert.equal(calls(), 0);
  });
});

test('doctor recognizes fully matched normalized issuer scope offline without legacy token keys', async () => {
  await fixture(async ({ root, deps, calls }) => {
    await profile(root);
    await saveConfig(root, { api_base_url: 'https://B.TEST:443/team/', machine_id: 'machine', tokens: {}, credentials: [{ ...credential, issuer: B }] });
    const report = await runDoctor(deps);
    assert.equal(syncCredential(report)?.ok, true);
    assert.deepEqual(report.notes, []);
    assert.equal(calls(), 0);
  });
});
