import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { main } from '../dist/cli.js';
import { openStore } from '../dist/local/store.js';
import { bindingKey } from '../dist/local/bindings.js';
import { startWriter, sendWriter } from '../dist/local/writer.js';
import { configureCloudSelectionHttp } from '../dist/local/cloud-selection.js';
import { captureSourcePointer } from '../dist/agentd/source-index.js';

// Synthetic canonical PostgreSQL output, matching the historical md5(...)::uuid
// migration contract. Version=9 and variant=0 are deliberately not RFC v1-v5 bits.
const PG_UID = '01234567-89ab-9def-0123-456789abcdef';
const RFC_UID = '11111111-2222-4333-8444-555555555555';
const invalidUids = [
  '', 'not-a-uuid', PG_UID.slice(1), PG_UID + '0', PG_UID.replace('c', 'z'),
  PG_UID.replaceAll('-', ''), `{${PG_UID}}`, '../' + PG_UID, PG_UID + '/child',
  PG_UID + '\\child', '%2f' + PG_UID, ' ' + RFC_UID, RFC_UID + ' ',
  '\t' + RFC_UID, RFC_UID + '\n', RFC_UID + '\r\n', RFC_UID + '\u2028',
  RFC_UID.slice(0, 18) + '\n' + RFC_UID.slice(18), null, 123, {},
];
const key = { profile_id: 'p1', device_id: 'device', runtime_kind: 'claude-code', native_session_id: 'current-native-session' };
const base = 'https://uuid-contract.example';
const token = 'SYNTHETIC-UUID-CONTRACT-TOKEN';
const output = () => { const result = { stdout: '', stderr: '' }; return { result, stdout: s => result.stdout += s, stderr: s => result.stderr += s, stdin: async () => '' }; };

async function fixture(t, uid = PG_UID) {
  const home = await mkdtemp(path.join(tmpdir(), 'owned-directory-uid-'));
  const root = path.join(home, '.37soul');
  const previous = { home: process.env.SOUL37_HOME, base: process.env.SOUL37_BASE_URL, fetch: globalThis.fetch };
  process.env.SOUL37_HOME = home; delete process.env.SOUL37_BASE_URL;
  t.after(async () => {
    globalThis.fetch = previous.fetch;
    for (const [name, value] of [['SOUL37_HOME', previous.home], ['SOUL37_BASE_URL', previous.base]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  const dir = path.join(root, 'profiles', key.profile_id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'device.json'), JSON.stringify({ device_id: key.device_id }));
  const store = await openStore(root, key.profile_id);
  await store.transact(draft => { draft.owner_id = 'owner'; draft.cloud_device_uid = 'cloud-device'; draft.cloud_issuer = base; });
  await store.close();
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ api_base_url: base, machine_id: 'machine', active_profile_id: key.profile_id, tokens: {}, credentials: [{ issuer: base, token, owner_id: 'owner', cloud_device_uid: 'cloud-device', runtime_kind: key.runtime_kind, profile_id: key.profile_id }] }));
  await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ owner: { profile_id: key.profile_id, cloud_issuer: base, default_soul_uid: null, soul_sync_mode: 'assets_only' } }));
  const transcript = path.join(home, 'native.jsonl');
  await writeFile(transcript, 'history before the existing Soul was chosen\n');
  await captureSourcePointer(root, key.profile_id, randomUUID(), { runtime_kind: key.runtime_kind, native_session_id: key.native_session_id, path: transcript, captured_at: new Date().toISOString() });
  const role = { id: 707, nickname: 'Existing Soul', soul_uid: uid };
  let directory = [role];
  const calls = [];
  let selected = false;
  const consent = () => ({ cloud_device_uid: 'cloud-device', soul_uid: role.soul_uid, revision: 1, enabled: true, categories: ['identity', 'relationship', 'experience'] });
  const http = async (url, options = {}) => {
    const u = new URL(url); calls.push({ path: u.pathname, method: options.method ?? 'GET' });
    assert.equal(options.headers.Authorization ?? options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    let body;
    if (u.pathname === '/api/v1/me/hosts') body = { hosts: directory, pagination: { total: directory.length, limit: Number(u.searchParams.get('limit')), offset: 0, has_more: false } };
    else if (u.pathname === '/api/v1/me/hosts/707/connection' && options.method === 'POST') {
      selected = true; body = { protocol: 'soul-assets/v1', host_id: role.id, soul_uid: role.soul_uid, consent: consent(), replay_from: '0' };
    } else if (u.pathname.endsWith('/soul_sync/pull')) {
      body = { protocol: 'soul-assets/v1', events: selected ? [{ event_uid: 'consent-1', object_type: 'consent', object: consent() }, { event_uid: 'soul-1', object_type: 'soul', object: { soul_uid: role.soul_uid, legacy_host_id: role.id, identity_revision: 1, state: 'active', identity: { name: role.nickname, description: '', character: 'A restored existing role.', greeting: '' } } }] : [], next_cursor: '2', has_more: false };
    } else if (u.pathname === '/api/v1/me/hosts/707/soul') body = { you_are: 'You are Existing Soul', host: { id: role.id, nickname: role.nickname } };
    else assert.fail(`unexpected synthetic endpoint ${options.method ?? 'GET'} ${u.pathname}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  globalThis.fetch = http;
  const snapshot = async () => { const s = await openStore(root, key.profile_id); try { return await s.read(); } finally { await s.close(); } };
  return { root, dir, role, calls, http, snapshot, setDirectory: roles => { directory = roles; } };
}

test('owned directory UUID: accepts historical PostgreSQL bits and preserves exact wire identities', async t => {
  const f = await fixture(t);
  const ids = [PG_UID, 'fedcba98-7654-4321-0123-456789abcdef', 'ABCDEF01-2345-F678-C9AB-0123456789AB'];
  f.setDirectory(ids.map((soul_uid, index) => ({ id: 707 + index, nickname: `Existing ${index}`, soul_uid })));
  const before = await readFile(path.join(f.dir, 'snapshot.json'), 'utf8');
  const io = output();
  assert.equal(await main(['hosts'], io), 0, io.result.stderr);
  assert.deepEqual(JSON.parse(io.result.stdout).hosts.map(role => role.soul_uid), ids);
  assert.equal(await readFile(path.join(f.dir, 'snapshot.json'), 'utf8'), before);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('owned directory UUID: cold named connect restores the existing PostgreSQL UID without a second login', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.snapshot()).souls, {});
  const io = output();
  assert.equal(await main(['connect', '--name', f.role.nickname, '--agent', key.runtime_kind, '--session', key.native_session_id], io), 0, io.result.stderr);
  assert.equal(JSON.parse(io.result.stdout).connection.state, 'attached');
  const snapshot = await f.snapshot();
  assert.deepEqual(Object.keys(snapshot.souls), [PG_UID]);
  assert.equal(snapshot.bindings[bindingKey(key)].soul_uid, PG_UID);
  assert.equal(snapshot.consents[`cloud-device:${PG_UID}`].soul_uid, PG_UID);
  assert.equal(f.calls.filter(call => call.path.endsWith('/connection')).length, 1);
  assert.ok(!f.calls.some(call => /device_codes|tokens|oauth|\/mcp$/.test(call.path)));
  assert.ok(!Object.values(snapshot.outbox).some(op => op.operation_kind === 'register_soul'));
  assert.ok(!io.result.stdout.includes(token));
});

test('owned directory UUID: selection writer independently accepts a historical PostgreSQL UID', async t => {
  const f = await fixture(t);
  configureCloudSelectionHttp(f.http);
  const writer = await startWriter(f.root);
  try {
    const selected = await sendWriter(f.root, { request_uid: randomUUID(), profile_id: key.profile_id, command: 'select_cloud_soul', payload: { host_id: f.role.id, soul_uid: PG_UID, runtime_kind: key.runtime_kind } });
    assert.equal(selected.ok, true, JSON.stringify(selected));
    assert.deepEqual(selected.result, { host_id: f.role.id, soul_uid: PG_UID, selected: true });
    assert.equal((await f.snapshot()).consents[`cloud-device:${PG_UID}`].soul_uid, PG_UID);
  } finally { await writer.close(); }
});

test('owned directory UUID: malformed, path and whitespace directory identities remain rejected', async t => {
  const f = await fixture(t, RFC_UID);
  const before = await f.snapshot();
  for (const soul_uid of invalidUids) {
    f.setDirectory([{ ...f.role, soul_uid }]);
    const io = output();
    assert.equal(await main(['hosts'], io), 1, JSON.stringify(soul_uid));
    assert.match(io.result.stderr, /invalid.*role identity/i);
    assert.equal(io.result.stdout, '');
  }
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.deepEqual(await f.snapshot(), before);
});

test('owned directory UUID: malformed selection is refused before an account POST or local mutation', async t => {
  const f = await fixture(t, RFC_UID);
  configureCloudSelectionHttp(f.http);
  const writer = await startWriter(f.root);
  const before = await f.snapshot();
  try {
    for (const soul_uid of invalidUids) {
      const selected = await sendWriter(f.root, { request_uid: randomUUID(), profile_id: key.profile_id, command: 'select_cloud_soul', payload: { host_id: f.role.id, soul_uid, runtime_kind: key.runtime_kind } });
      assert.equal(selected.ok, false, JSON.stringify(soul_uid));
      assert.equal(selected.error.code, 'invalid_selection');
      assert.equal(f.calls.length, 0, 'bad UID must not reach a consent-granting POST');
    }
    assert.deepEqual(await f.snapshot(), before);
  } finally { await writer.close(); }
});
