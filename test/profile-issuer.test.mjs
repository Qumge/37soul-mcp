import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loginCommand } from '../dist/cli.js';
import { openStore, snapshotPath } from '../dist/local/store.js';
import { accountsIndexPath, writeAccountsIndex, readAccountsIndex, mergeLoginProfile } from '../dist/local/profiles.js';
import { saveConfig, loadConfig } from '../dist/agentd/state.js';
import { configureSyncHttp } from '../dist/sync/client.js';
import { startWriter, sendWriter } from '../dist/local/writer.js';

const A = 'https://a.test/team';
const B = 'https://b.test/team';
const soul = uid => ({ soul_uid: uid, legacy_host_id: 1, identity_revision: 1, identity: { name: uid, description: '', character: '', greeting: '' }, state: 'active' });
async function seed(root, id, issuer, owned = true) {
  const store = await openStore(root, id);
  await store.transact(d => {
    d.owner_id = owned ? '123' : null;
    d.cloud_device_uid = owned ? 'device' : null;
    if (issuer !== undefined) d.cloud_issuer = issuer;
    d.souls[id] = soul(id);
  });
  await store.close();
}
async function snap(root, id) {
  const store = await openStore(root, id);
  try { return await store.read(); } finally { await store.close(); }
}
async function fixture(run) {
  const home = mkdtempSync(path.join(tmpdir(), 'profile-issuer-'));
  const root = path.join(home, '.37soul');
  await saveConfig(root, { api_base_url: B, machine_id: 'm', tokens: {}, credentials: [{ issuer: A, token: 'FAKE-A', owner_id: '123', cloud_device_uid: 'device', runtime_kind: 'hermes', profile_id: 'old', obtained_at: 'fixture' }] });
  let text = '';
  const wire = [];
  configureSyncHttp(async (url, init) => {
    wire.push({ url: String(url), init });
    return { status: 200, headers: { get: () => null }, json: async () => ({ protocol: 'soul-assets/v1', events: [], next_cursor: null, has_more: false }) };
  });
  const io = { stdout: s => { text += s; }, stderr: s => { text += s; }, stdin: async () => '' };
  const deps = { home, apiBase: B, nodePath: process.execPath, cliScriptPath: '/fake/cli.js', agentdScriptPath: '/fake/cli.js', openBrowser: false, now: () => 0, sleep: async () => {}, runCommand: async () => ({ code: 0, stdout: '', stderr: '' }), fetch: async url => ({ status: 201, json: async () => String(url).endsWith('/device_codes') ? { device_code: 'fake-code', user_code: 'FAKE', verification_url: B + '/cli/approve', interval: 1, expires_in: 60 } : { protocol: 'soul-assets/v1', mode: 'assets_only', owner_id: '123', cloud_device_uid: 'device', default_soul_uid: null, tokens: [{ agent_kind: 'hermes', token: 'FAKE-B' }] } }) };
  try { await run({ root, io, deps, wire, text: () => text }); } finally { rmSync(home, { recursive: true, force: true }); }
}
async function account(root, profile, issuer = A) {
  await writeAccountsIndex(root, { '123': { profile_id: profile, default_soul_uid: profile, soul_sync_mode: 'assets_only', cloud_issuer: issuer } });
}
function bytes(root, profiles) {
  return [path.join(root, 'config.json'), accountsIndexPath(root), ...profiles.map(id => snapshotPath(root, id))].map(file => readFileSync(file, 'utf8'));
}

test('fresh B login refuses an A-owned or unknown-issuer current profile even after config switched to B', async () => {
  for (const issuer of [A, undefined]) await fixture(async ({ root, deps, io, wire, text }) => {
    await seed(root, 'old', issuer);
    await account(root, 'old');
    const before = bytes(root, ['old']);
    assert.equal(await loginCommand(root, ['--profile', 'old'], io, deps), 1);
    assert.match(text(), /issuer|server/i);
    assert.match(text(), /--profile/);
    assert.deepEqual(bytes(root, ['old']), before);
    assert.equal(wire.length, 0);
  });
});

for (const flag of ['--merge-profile', '--use-profile']) {
  test(`B login ${flag} cannot adopt A same-owner data or consent`, async () => {
    await fixture(async ({ root, deps, io, wire, text }) => {
      await seed(root, 'old', A);
      await seed(root, 'new', undefined, false);
      await account(root, 'old');
      const before = bytes(root, ['old', 'new']);
      assert.equal(await loginCommand(root, ['--profile', 'new', flag, 'old'], io, deps), 1);
      assert.match(text(), /issuer|server/i);
      assert.deepEqual(bytes(root, ['old', 'new']), before);
      assert.equal(wire.length, 0);
    });
  });
  test(`same issuer explicit ${flag} remains usable and records normalized profile issuer`, async () => {
    await fixture(async ({ root, deps, io, wire }) => {
      await seed(root, 'old', B);
      await seed(root, 'new', undefined, false);
      await account(root, 'old', B);
      const sourceBefore = readFileSync(snapshotPath(root, 'old'), 'utf8');
      assert.equal(await loginCommand(root, ['--profile', 'new', flag, 'old'], io, { ...deps, apiBase: 'https://B.TEST:443/team/' }), 0);
      const adopted = flag === '--use-profile' ? 'old' : 'new';
      assert.equal((await snap(root, adopted)).cloud_issuer, B);
      assert.equal((await loadConfig(root)).active_profile_id, adopted);
      assert.equal((await readAccountsIndex(root))['123'].cloud_issuer, B);
      assert.ok((await snap(root, adopted)).souls.old);
      if (flag === '--merge-profile') assert.equal(readFileSync(snapshotPath(root, 'old'), 'utf8'), sourceBefore);
      assert.ok(wire.length > 0);
      assert.ok(wire.every(c => c.url.startsWith(B + '/') && c.init.headers.authorization === 'Bearer FAKE-B'));
    });
  });
}

test('independent anonymous B profile can log in despite an A profile with the same owner id', async () => {
  await fixture(async ({ root, deps, io }) => {
    await seed(root, 'old', A);
    await seed(root, 'new', undefined, false);
    await account(root, 'old');
    const old = readFileSync(snapshotPath(root, 'old'), 'utf8');
    assert.equal(await loginCommand(root, ['--profile', 'new'], io, deps), 0);
    assert.equal((await snap(root, 'new')).cloud_issuer, B);
    assert.equal(readFileSync(snapshotPath(root, 'old'), 'utf8'), old);
    assert.equal((await readAccountsIndex(root))['123'].default_soul_uid, null, 'A account default must not become B default');
  });
});

test('same issuer repeat login preserves profile data and has a durable issuer independent of config', async () => {
  await fixture(async ({ root, deps, io }) => {
    await seed(root, 'new', B);
    await account(root, 'new', B);
    assert.equal(await loginCommand(root, ['--profile', 'new'], io, deps), 0);
    assert.equal((await snap(root, 'new')).cloud_issuer, B);
    assert.ok((await snap(root, 'new')).souls.new);
    assert.equal((await readAccountsIndex(root))['123'].cloud_issuer, B);
  });
});

for (const choice of ['current', 'merge_profile_id', 'use_profile_id']) {
  test(`writer cannot bypass issuer guard via ${choice}`, async () => {
    await fixture(async ({ root }) => {
      await seed(root, 'old', A);
      await seed(root, 'new', undefined, false);
      await account(root, 'old');
      const before = bytes(root, ['old', 'new']);
      const writer = await startWriter(root);
      try {
        const result = await sendWriter(root, { request_uid: 'issuer-test', command: 'login_associate', profile_id: choice === 'current' ? 'old' : 'new', payload: { owner_id: '123', cloud_device_uid: 'device', cloud_issuer: B, ...(choice === 'current' ? {} : { [choice]: 'old' }) } });
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'profile_issuer_mismatch');
        assert.deepEqual(bytes(root, ['old', 'new']), before);
      } finally { await writer.close(); }
    });
  });
}

test('direct profile association refuses missing issuer rather than inferring config target', async () => {
  await fixture(async ({ root }) => {
    await seed(root, 'old', A);
    await assert.rejects(mergeLoginProfile('old', '123', undefined, { root }), /issuer|server/i);
    assert.equal((await snap(root, 'old')).cloud_issuer, A);
  });
});
