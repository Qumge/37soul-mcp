import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveLoginCredentials, selectCredentials, clearDeviceCredentials, readCredentials } from '../dist/agentd/credentials.js';
import { loadConfig, saveConfig } from '../dist/agentd/state.js';
import { install, status, deviceLogin } from '../dist/install.js';
import { openStore } from '../dist/local/store.js';
import { syncOnce, configureSyncHttp } from '../dist/sync/client.js';
import { startWriter, sendWriter } from '../dist/local/writer.js';

const A = 'https://a.test/team';
const B = 'https://b.test/team';
const input = { apiBaseUrl: A, machineId: 'machine', profileId: 'p1', ownerId: 'owner', cloudDeviceUid: 'device', tokens: { hermes: 'FAKE-A' } };
const credential = { issuer: A, token: 'FAKE-A', profile_id: 'p1', owner_id: 'owner', cloud_device_uid: 'device', runtime_kind: 'hermes', obtained_at: 'fixture' };
const temp = () => mkdtempSync(path.join(tmpdir(), 'issuer-test-'));
const select = (config, base) => selectCredentials(config, 'p1', 'owner', 'device', base);
const config = (entries = [credential]) => ({ api_base_url: A, machine_id: 'machine', tokens: {}, credentials: entries });
const reply = () => ({ status: 200, headers: { get: () => null }, json: async () => ({ protocol: 'soul-assets/v1', events: [], next_cursor: null, has_more: false }) });

// A missing endpoint check would select a token for every one of these distinct targets.
test('issuer selection distinguishes scheme, host, port and basepath; unbound tokens fail closed', () => {
  for (const target of [B, 'http://a.test/team', 'https://a.test:444/team', 'https://a.test/other', 'https://a.test']) {
    assert.deepEqual(select(config(), target), [], target);
  }
  const { issuer, ...unbound } = credential;
  assert.deepEqual(select(config([unbound]), A), []);
  assert.deepEqual(select(config([{ ...credential, issuer: 'not a URL' }]), A), []);
  assert.equal(select(config(), 'https://A.TEST:443/team/')[0]?.token, 'FAKE-A');
});

test('login normalizes issuer, retains other issuer slots and selects only the current target', async () => {
  const root = temp();
  try {
    await saveLoginCredentials(root, { ...input, apiBaseUrl: 'https://A.TEST:443/team///' });
    let saved = await loadConfig(root);
    assert.equal(saved.credentials[0].issuer, A);
    await saveLoginCredentials(root, { ...input, apiBaseUrl: B, tokens: { hermes: 'FAKE-B' } });
    saved = await loadConfig(root);
    assert.equal(saved.api_base_url, B);
    assert.equal(saved.credentials.length, 2);
    assert.equal(select(saved, A)[0].token, 'FAKE-A');
    assert.equal(select(saved, B)[0].token, 'FAKE-B');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const badBases = ['broken', 'ftp://a.test', 'https://user:pass@a.test', 'https://a.test?x=1', 'https://a.test#frag', 'https://a.test?', 'https://a.test#', 'https://a.test/team/../other', 'https:\\a.test', ' https://a.test'];
test('invalid issuer login fails before persistence or device HTTP', async () => {
  const root = temp();
  try {
    for (const apiBaseUrl of badBases) {
      await assert.rejects(saveLoginCredentials(root, { ...input, apiBaseUrl }), /server|issuer|URL/i, apiBaseUrl);
      let calls = 0;
      await assert.rejects(deviceLogin({ apiBase: apiBaseUrl, fetch: async () => { calls++; throw new Error('unexpected fake HTTP'); } }, ['hermes']), /server|issuer|URL/i);
      assert.equal(calls, 0);
    }
    assert.equal(await loadConfig(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function seed(root) {
  await saveConfig(root, config());
  const store = await openStore(root, 'p1');
  await store.transact(d => { d.owner_id = 'owner'; d.cloud_device_uid = 'device'; });
  await store.close();
}

test('sync override and unbound explicit tokens never transmit a credential to another issuer', async () => {
  const root = temp();
  try {
    await seed(root);
    const calls = [];
    const http = async (url, init) => { calls.push({ url, init }); return reply(); };
    for (const baseUrl of [B, 'https://a.test/other', 'https://a.test:444/team']) {
      const report = await syncOnce('p1', http, { root, baseUrl });
      assert.match(report.error ?? '', /token|login|issuer/);
    }
    await syncOnce('p1', http, { root, baseUrl: B, token: 'UNBOUND' });
    await syncOnce('p1', http, { root, baseUrl: B, token: 'EXPLICIT-A', tokenIssuer: A });
    assert.equal(calls.length, 0, 'no HTTP may carry an issuer-mismatched or issuer-less token');
    const report = await syncOnce('p1', http, { root, baseUrl: 'https://A.TEST:443/team/' });
    assert.equal(report.error, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://a.test/team/api/v1/me/soul_sync/pull?cursor=0&limit=50');
    assert.equal(calls[0].init.headers.authorization, 'Bearer FAKE-A');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('localhost HTTP explicit issuer is usable; malformed sync target makes zero HTTP calls', async () => {
  const root = temp();
  try {
    await seed(root);
    let calls = 0;
    const http = async () => { calls++; return reply(); };
    await syncOnce('p1', http, { root, baseUrl: 'http://localhost:4312/base/', token: 'LOCAL-FAKE', tokenIssuer: 'http://LOCALHOST:4312/base' });
    assert.equal(calls, 1);
    for (const baseUrl of badBases) {
      try { await syncOnce('p1', http, { root, baseUrl, token: 'LOCAL-FAKE', tokenIssuer: baseUrl }); } catch {}
    }
    assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('manual avatar writer entry rejects a target mismatch before HTTP', async () => {
  const root = temp();
  let writer;
  try {
    await seed(root);
    const file = path.join(root, 'avatar.png');
    writeFileSync(file, 'FAKE-IMAGE');
    const store = await openStore(root, 'p1');
    await store.transact(d => {
      d.souls.s1 = { soul_uid: 's1', legacy_host_id: 1, identity_revision: 1, identity: { name: 'Fake', description: '', character: '', greeting: '' }, state: 'active', local_avatar_path: file, avatar_uploaded: false };
      d.consents['device:s1'] = { cloud_device_uid: 'device', soul_uid: 's1', revision: 1, categories: ['identity'], enabled: true };
    });
    await store.close();
    await saveConfig(root, { ...config(), api_base_url: B });
    let calls = 0;
    configureSyncHttp(async () => { calls++; return reply(); });
    writer = await startWriter(root);
    const result = await sendWriter(root, { request_uid: 'avatar-issuer-test', command: 'upload_avatar', profile_id: 'p1', payload: { soul_uid: 's1' } });
    assert.equal(result.ok, true);
    assert.equal(result.result.status, 'not_logged_in');
    assert.equal(calls, 0);
  } finally { await writer?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('cross-server reinstall preserves assets/credentials but requires login without network', async () => {
  const home = temp();
  const root = path.join(home, '.37soul');
  try {
    await seed(root);
    mkdirSync(path.join(home, '.claude'));
    await saveConfig(root, { ...config(), active_profile_id: "p1", tokens: { hermes: 'LEGACY-UNBOUND' } });
    const existingStore = await openStore(root, 'p1');
    await existingStore.transact(d => { d.cloud_issuer = A; });
    await existingStore.close();
    writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({ owner: { profile_id: 'p1', cloud_issuer: A, soul_sync_mode: 'assets_only', default_soul_uid: null } }));
    const source = path.join(home, 'fake-package');
    mkdirSync(path.join(source, 'dist/bundle'), { recursive: true });
    for (const f of ['cli.js', 'index.js']) writeFileSync(path.join(source, 'dist/bundle', f), '// fake bundle');
    writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    const deps = { home, apiBase: B, fetch: async () => { throw new Error('install must not network'); }, runCommand: async () => ({ code: 0, stdout: '', stderr: '' }), nodePath: process.execPath, cliScriptPath: path.join(source, 'dist/cli.js'), agentdScriptPath: path.join(source, 'dist/cli.js'), runtimeSourceRoot: source, platform: 'linux' };
    await install(deps, { agents: ['claude-code'], installService: false });
    const saved = await loadConfig(root);
    assert.deepEqual(saved.credentials, [credential]);
    assert.equal(saved.api_base_url, B);
    assert.deepEqual(saved.tokens, { hermes: 'LEGACY-UNBOUND' }, 'legacy token data survives but is never selectable');
    assert.deepEqual(select(saved, B), []);
    assert.ok((await status(deps)).some(line => line.includes('login required')));
    const store = await openStore(root, 'p1');
    assert.equal((await store.read()).owner_id, 'owner');
    await store.close();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const damagedCredentialRecords = [null, 42, 'unbound legacy value', [], {}, { ...credential, token: '' }, { ...credential, issuer: 'not a URL' }];
test('login preserves malformed credential records without crashing or authorizing them', async () => {
  const root = temp();
  try {
    const other = { ...credential, issuer: B, token: 'FAKE-B' };
    await saveConfig(root, config([...damagedCredentialRecords, credential, other]));
    await saveLoginCredentials(root, { ...input, tokens: { hermes: 'NEW-A' } });
    const saved = await loadConfig(root);
    assert.deepEqual(saved.credentials.slice(0, damagedCredentialRecords.length), damagedCredentialRecords);
    assert.deepEqual(readCredentials(saved).map(c => c.token).sort(), ['FAKE-B', 'NEW-A']);
    assert.equal(select(saved, A)[0].token, 'NEW-A');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('revocation preserves malformed records and other issuers while removing the valid revoked device', async () => {
  const root = temp();
  try {
    const other = { ...credential, issuer: B, token: 'FAKE-B' };
    await saveConfig(root, config([...damagedCredentialRecords, credential, other]));
    await clearDeviceCredentials(root, 'owner', 'device', A);
    const saved = await loadConfig(root);
    assert.deepEqual(saved.credentials, [...damagedCredentialRecords, other]);
    assert.deepEqual(select(saved, A), []);
    assert.equal(select(saved, B)[0].token, 'FAKE-B');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
