import {writeAvatar} from './helpers/avatar.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { install } from '../dist/install.js';
import { loginCommand, main } from '../dist/cli.js';
import { runDoctor } from '../dist/doctor.js';
import { loadConfig, saveConfig } from '../dist/agentd/state.js';
import { resolveLocalAssetsProfileSync, resolveLocalHostIdSync, writeAccountsIndex } from '../dist/local/profiles.js';
import { openStore } from '../dist/local/store.js';
import { configureSyncHttp } from '../dist/sync/client.js';
import { runHookCommand } from '../dist/hook.js';
import { runSyncProfiles } from '../dist/sync/run.js';
import { startWriter } from '../dist/local/writer.js';

const BASE = 'https://fake.test/team';
const soul = { soul_uid: 's1', legacy_host_id: 42, identity_revision: 1, identity: { name: 'Fake Soul', description: '', character: 'FAKE-CONTEXT', greeting: '' }, state: 'active' };
async function read(root, id) { const store = await openStore(root, id); try { return await store.read(); } finally { await store.close(); } }
async function fixture(run) {
  const home = mkdtempSync(path.join(tmpdir(), 'active-profile-'));
  writeAvatar(home);
  const root = path.join(home, '.37soul');
  const source = path.join(home, 'pkg');
  mkdirSync(path.join(source, 'dist/bundle'), { recursive: true });
  for (const file of ['cli.js', 'index.js']) writeFileSync(path.join(source, 'dist/bundle', file), '// fake runtime');
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '0.0.1' }));
  const deps = { home, apiBase: BASE, nodePath: process.execPath, cliScriptPath: path.join(source, 'dist/cli.js'), agentdScriptPath: path.join(source, 'dist/cli.js'), runtimeSourceRoot: source, runtimeVersion: '0.0.1', platform: 'linux', openBrowser: false, now: () => 0, sleep: async () => {}, runCommand: async () => ({ code: 0, stdout: '', stderr: '' }), fetch: async url => ({ status: 201, json: async () => String(url).endsWith('/device_codes') ? { device_code: 'fake', user_code: 'FAKE', verification_url: BASE + '/cli/approve' } : { protocol: 'soul-assets/v1', mode: 'assets_only', owner_id: 'owner', cloud_device_uid: 'device', default_soul_uid: 's1', tokens: [{ agent_kind: 'pi', token: 'FAKE-PI' }] } }) };
  configureSyncHttp(async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ protocol: 'soul-assets/v1', events: [{ event_uid: 'consent', object_type: 'consent', object: { cloud_device_uid: 'device', soul_uid: 's1', revision: 1, categories: ['identity'], enabled: true } }, { event_uid: 'soul', object_type: 'soul', object: soul }], next_cursor: null, has_more: false }) }));
  const io = { stdout: () => {}, stderr: () => {}, stdin: async () => '' };
  try { await run({ home, root, deps, io }); } finally { configureSyncHttp(null); rmSync(home, { recursive: true, force: true }); }
}

test('install -> nondefault login -> reinstall preserves active profile and Pi hook binding despite default directory', async () => {
  await fixture(async ({ home, root, deps, io }) => {
    await install(deps, { agents: ['pi'], installService: false });
    assert.equal(resolveLocalAssetsProfileSync(root)?.profile_id, 'default');
    const anonymous = readFileSync(path.join(root, 'profiles/default/snapshot.json'), 'utf8');
    assert.equal(await loginCommand(root, ['--profile', 'browser-delivery'], io, deps), 0);
    assert.equal((await loadConfig(root)).active_profile_id, 'browser-delivery');
    const selected = resolveLocalAssetsProfileSync(root);
    assert.deepEqual(selected, { profile_id: 'browser-delivery', device_id: (await read(root, 'browser-delivery')).device_id });
    assert.equal(resolveLocalHostIdSync(root), 42);
    await install(deps, { agents: ['pi'], installService: false });
    assert.equal((await loadConfig(root)).active_profile_id, 'browser-delivery');
    assert.equal(resolveLocalAssetsProfileSync(root)?.profile_id, 'browser-delivery');
    assert.equal(readFileSync(path.join(root, 'profiles/default/snapshot.json'), 'utf8'), anonymous, 'reinstall must not rewrite old default data');
    const writer = await startWriter(root);
    try {
      await runHookCommand({ home, agentKind: 'pi', event: 'SessionStart', stdin: JSON.stringify({ session_id: 'pi-active-session' }), stdout: () => {}, stderr: () => {}, fetch: async () => { throw new Error('hook must not network'); }, timeoutMs: 2000 });
      const snap = await read(root, 'browser-delivery');
      assert.ok(Object.values(snap.bindings).some(b => b.runtime_kind === 'pi' && b.native_session_id === 'pi-active-session' && b.soul_uid === 's1'));
      assert.deepEqual((await read(root, 'default')).bindings, {});
    } finally { await writer.close(); }
  });
});

test('login before install does not cause install to manufacture a new default profile', async () => {
  await fixture(async ({ root, deps, io }) => {
    assert.equal(await loginCommand(root, ['--profile', 'browser-delivery'], io, deps), 0);
    await install(deps, { agents: ['pi'], installService: false });
    assert.deepEqual(readdirSync(path.join(root, 'profiles')), ['browser-delivery']);
    assert.equal(resolveLocalAssetsProfileSync(root)?.profile_id, 'browser-delivery');
  });
});

test('invalid or stale explicit active selection never falls back to the anonymous profile', async () => {
  await fixture(async ({ root, deps }) => {
    await install(deps, { agents: ['pi'], installService: false });
    const config = await loadConfig(root);
    for (const active_profile_id of ['gone', '', '../escape', null, 42]) {
      await saveConfig(root, { ...config, active_profile_id });
      assert.equal(resolveLocalAssetsProfileSync(root), null, String(active_profile_id));
      assert.equal(resolveLocalHostIdSync(root), null);
    }
  });
});

test('unselected multiple profiles are ambiguous rather than newest/first-owner selected', async () => {
  await fixture(async ({ root, deps }) => {
    await install(deps, { agents: ['pi'], installService: false });
    const store = await openStore(root, 'second'); await store.transact(() => {}); await store.close();
    const config = await loadConfig(root); delete config.active_profile_id; await saveConfig(root, config);
    assert.equal(resolveLocalAssetsProfileSync(root), null);
    const before = readFileSync(path.join(root, 'profiles/default/snapshot.json'), 'utf8');
    await install(deps, { agents: ['pi'], installService: false });
    assert.equal(resolveLocalAssetsProfileSync(root), null, 'upgrading does not choose a profile');
    assert.equal(readFileSync(path.join(root, 'profiles/default/snapshot.json'), 'utf8'), before);
  });
});

test('active profile validates account mode, owner, issuer, uniqueness and pinned device', async () => {
  await fixture(async ({ root, deps, io }) => {
    assert.equal(await loginCommand(root, ['--profile', 'browser-delivery'], io, deps), 0);
    const config = await loadConfig(root);
    const good = JSON.parse(readFileSync(path.join(root, 'accounts.json'), 'utf8'));
    for (const bad of [
      { owner: { ...good.owner, soul_sync_mode: 'unknown' } },
      { other: good.owner },
      { owner: { ...good.owner, cloud_issuer: 'https://other.test' } },
      { ...good, duplicate: good.owner },
    ]) {
      await writeAccountsIndex(root, bad);
      assert.equal(resolveLocalAssetsProfileSync(root), null);
    }
    await writeAccountsIndex(root, good);
    assert.equal(resolveLocalAssetsProfileSync(root)?.profile_id, 'browser-delivery');
    await saveConfig(root, { ...config, api_base_url: 'https://other.test' });
    assert.equal(resolveLocalAssetsProfileSync(root), null);
    await saveConfig(root, config);
    writeFileSync(path.join(root, 'profiles/browser-delivery/device.json'), JSON.stringify({ device_id: 'wrong' }));
    assert.equal(resolveLocalAssetsProfileSync(root), null);
  });
});

test('default profile login replaces the anonymous index alias with an unambiguous active owner', async () => {
  await fixture(async ({ root, deps, io }) => {
    await install(deps, { agents: ['pi'], installService: false });
    assert.equal(await loginCommand(root, ['--profile', 'default'], io, deps), 0);
    assert.equal((await loadConfig(root)).active_profile_id, 'default');
    assert.equal(resolveLocalAssetsProfileSync(root)?.profile_id, 'default');
  });
});

// Only anonymous first install may use the singleton fallback; cloud login must
// have persisted an explicit adoption, even if only one cloud profile exists.
test('missing active id on a cloud-owned singleton does not infer a login choice', async () => {
  await fixture(async ({ root, deps, io }) => {
    assert.equal(await loginCommand(root, ['--profile', 'browser-delivery'], io, deps), 0);
    const config = await loadConfig(root); delete config.active_profile_id;
    await saveConfig(root, config);
    assert.equal(resolveLocalAssetsProfileSync(root), null);
  });
});

test('anonymous install -> actual CLI soul create -> Pi hook keeps one anonymous account and usable binding', async () => {
  await fixture(async ({ home, root, deps, io }) => {
    await install(deps, { agents: ['pi'], installService: false });
    const oldHome = process.env.SOUL37_HOME;
    const oldFetch = globalThis.fetch;
    process.env.SOUL37_HOME = home;
    globalThis.fetch = async () => { throw new Error('anonymous create must not network'); };
    try {
      assert.equal(await main(['soul', 'create', '--avatar', path.join(home, 'synthetic-avatar.png'), '--name', 'Anonymous Fake', '--sex', 'female', '--age', '24', '--character', 'A synthetic local character who speaks clearly, respects boundaries, remembers explicit preferences and never invents evidence.'], io), 0);
    } finally {
      if (oldHome === undefined) delete process.env.SOUL37_HOME; else process.env.SOUL37_HOME = oldHome;
      globalThis.fetch = oldFetch;
    }
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(root, 'accounts.json'), 'utf8'))), ['anonymous']);
    assert.equal(resolveLocalAssetsProfileSync(root)?.profile_id, 'default');
    await install(deps, { agents: ['pi'], installService: false });
    const writer = await startWriter(root);
    try {
      await runHookCommand({ home, agentKind: 'pi', event: 'SessionStart', stdin: JSON.stringify({ session_id: 'anonymous-pi-session' }), stdout: () => {}, stderr: () => {}, fetch: async () => { throw new Error('anonymous hook must not network'); }, timeoutMs: 2000 });
      const snapshot = await read(root, 'default');
      assert.ok(Object.values(snapshot.bindings).some(b => b.runtime_kind === 'pi' && b.native_session_id === 'anonymous-pi-session'));
      assert.equal(snapshot.owner_id, null);
    } finally { await writer.close(); }
  });
});

async function invokeCli(home, args) {
  const oldHome = process.env.SOUL37_HOME;
  const oldFetch = globalThis.fetch;
  let stdout = '', stderr = '';
  process.env.SOUL37_HOME = home;
  globalThis.fetch = async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ protocol: 'soul-assets/v1', events: [], next_cursor: null, has_more: false }) });
  try {
    const code = await main(args, { stdout: s => { stdout += s; }, stderr: s => { stderr += s; }, stdin: async () => '' });
    return { code, stdout, stderr };
  } finally {
    if (oldHome === undefined) delete process.env.SOUL37_HOME; else process.env.SOUL37_HOME = oldHome;
    globalThis.fetch = oldFetch;
  }
}
const createArgs = home => ['soul', 'create', '--name', 'Active Local', '--sex', 'female', '--age', '24', '--character', 'A synthetic local character who speaks clearly, respects boundaries, remembers explicit preferences and never invents evidence.', '--avatar', path.join(home, 'synthetic-avatar.png')];
function recallAsset(uid, content) {
  return { asset_uid: uid, soul_uid: 's1', kind: 'relationship', trait: 'preference', content, applicability: '', tags: [], evidence: 'explicit_user_statement', verification: 'unverified', sensitivity: 'normal', state: 'active', revision: 1, supersedes_uid: null, pinned: false, source: { runtime_kind: 'pi', session_ref: 'fake', event_ref: 'fake', occurred_at: '2026-11-02T00:00:00Z' }, sync_state: 'local_only', cloud_revision: null };
}
test('install -> login work -> no-profile-flag create/scoped-recall/select/sync and Pi hook use the adopted profile', async () => {
  await fixture(async ({ home, root, deps, io }) => {
    await install(deps, { agents: ['pi'], installService: false });
    assert.equal(await loginCommand(root, ['--profile', 'work'], io, deps), 0);
    for (const [id, marker] of [['default', 'OTHER_ACCOUNT_CANARY'], ['work', 'ACTIVE_PROFILE_FACT']]) {
      const store = await openStore(root, id);
      await store.transact(d => { d.assets[id] = recallAsset(id, marker); });
      await store.close();
    }
    const defaultBefore = readFileSync(path.join(root, 'profiles/default/snapshot.json'), 'utf8');
    const created = await invokeCli(home, createArgs(home));
    assert.equal(created.code, 0, created.stderr);
    assert.equal(Object.keys((await read(root, 'work')).souls).length, 2);
    assert.deepEqual((await read(root, 'default')).souls, {});
    const ambiguousRecall = await invokeCli(home, ['recall']);
    assert.notEqual(ambiguousRecall.code, 0, 'multiple Souls require a role choice, even in the active profile');
    assert.equal(ambiguousRecall.stdout, '');
    assert.doesNotMatch(ambiguousRecall.stderr, /ACTIVE_PROFILE_FACT|OTHER_ACCOUNT_CANARY/);
    const recall = await invokeCli(home, ['recall', '--soul', 's1']);
    assert.equal(recall.code, 0, recall.stderr);
    assert.match(recall.stdout, /ACTIVE_PROFILE_FACT/);
    assert.doesNotMatch(recall.stdout, /OTHER_ACCOUNT_CANARY/);
    const uid = Object.keys((await read(root, 'work')).souls).find(uid => uid !== 's1');
    const selected = await invokeCli(home, ['soul', 'select', uid, '--agent', 'pi']);
    assert.equal(selected.code, 0, selected.stderr);
    const synced = await invokeCli(home, ['sync']);
    assert.equal(synced.code, 0, synced.stderr);
    assert.match(synced.stdout, /profile work:/);
    assert.doesNotMatch(synced.stdout, /profile default:/);
    const writer = await startWriter(root);
    try {
      await runHookCommand({ home, agentKind: 'pi', event: 'SessionStart', stdin: JSON.stringify({ session_id: 'cli-aligned-pi' }), stdout: () => {}, stderr: () => {}, fetch: async () => { throw new Error('hook must not network'); }, timeoutMs: 2000 });
      assert.ok(Object.values((await read(root, 'work')).bindings).some(b => b.native_session_id === 'cli-aligned-pi' && b.soul_uid === uid));
    } finally { await writer.close(); }
    assert.equal(readFileSync(path.join(root, 'profiles/default/snapshot.json'), 'utf8'), defaultBefore);
    const daemonReports = await runSyncProfiles(root);
    assert.deepEqual(daemonReports.map(r => r.profile_id), ['work'], 'anonymous install index is not a daemon sync target');
    const all = await invokeCli(home, ['sync', '--all-profiles']);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /profile work:/);
  });
});

test('stale active CLI selection refuses implicit default, but explicit --profile remains available', async () => {
  await fixture(async ({ home, root, deps }) => {
    await install(deps, { agents: ['pi'], installService: false });
    await saveConfig(root, { ...(await loadConfig(root)), active_profile_id: 'missing' });
    const before = readFileSync(path.join(root, 'profiles/default/snapshot.json'), 'utf8');
    for (const args of [createArgs(home), ['recall'], ['soul', 'select', 's1'], ['sync'], ['login']]) {
      const result = await invokeCli(home, args);
      assert.equal(result.code, 1, JSON.stringify(args));
      assert.match(result.stderr, /--profile/);
    }
    assert.equal(readFileSync(path.join(root, 'profiles/default/snapshot.json'), 'utf8'), before);
    assert.equal((await invokeCli(home, [...createArgs(home), '--profile', 'default'])).code, 0);
  });
});

test('CLI refuses ambiguous profiles without active selection instead of reading the first directory', async () => {
  await fixture(async ({ home, root, deps }) => {
    await install(deps, { agents: ['pi'], installService: false });
    const extra = await openStore(root, 'other'); await extra.transact(() => {}); await extra.close();
    const result = await invokeCli(home, ['recall']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--profile/);
  });
});

test('uninstalled fresh CLI may create in default without inventing a cloud owner', async () => {
  await fixture(async ({ home, root }) => {
    assert.equal((await invokeCli(home, createArgs(home))).code, 0);
    assert.equal(Object.keys((await read(root, 'default')).souls).length, 1);
    assert.equal((await read(root, 'default')).owner_id, null);
  });
});

test('default sync and daemon sync ignore the retained anonymous install profile after login work', async () => {
  await fixture(async ({ home, root, deps, io }) => {
    await install(deps, { agents: ['pi'], installService: false });
    assert.equal(await loginCommand(root, ['--profile', 'work'], io, deps), 0);
    const sync = await invokeCli(home, ['sync']);
    assert.equal(sync.code, 0, sync.stdout + sync.stderr);
    assert.match(sync.stdout, /profile work:/);
    assert.doesNotMatch(sync.stdout, /profile default:/);
    const reports = await runSyncProfiles(root);
    assert.deepEqual(reports.map(r => r.profile_id), ['work']);
  });
});

test('explicit all-profiles sync retains two-account coverage while no-flag sync stays active-only', async () => {
  await fixture(async ({ home, root, deps, io }) => {
    await install(deps, { agents: ['pi'], installService: false });
    assert.equal(await loginCommand(root, ['--profile', 'work'], io, deps), 0);
    const other = await openStore(root, 'second');
    await other.transact(d => { d.owner_id = 'other-owner'; d.cloud_device_uid = 'other-device'; d.cloud_issuer = BASE; });
    await other.close();
    const index = JSON.parse(readFileSync(path.join(root, 'accounts.json'), 'utf8'));
    await writeAccountsIndex(root, { ...index, 'other-owner': { profile_id: 'second', cloud_issuer: BASE, default_soul_uid: null, soul_sync_mode: 'assets_only' } });
    const config = await loadConfig(root);
    await saveConfig(root, { ...config, credentials: [...config.credentials, { issuer: BASE, token: 'SECOND-FAKE', owner_id: 'other-owner', cloud_device_uid: 'other-device', profile_id: 'second', runtime_kind: 'pi', obtained_at: 'fixture' }] });
    const one = await invokeCli(home, ['sync']);
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /profile work:/);
    assert.doesNotMatch(one.stdout, /profile second:/);
    const all = await invokeCli(home, ['sync', '--all-profiles']);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /profile work:/);
    assert.match(all.stdout, /profile second:/);
    assert.doesNotMatch(all.stdout, /profile default:/);
    assert.equal((await invokeCli(home, ['sync', '--all-profiles', '--profile', 'work'])).code, 2);
  });
});

async function legacyProfile(root, deps) {
  await install(deps, { agents: ['pi'], installService: false });
  const store = await openStore(root, 'default');
  await store.transact(d => {
    d.owner_id = 'owner'; d.cloud_device_uid = 'old-device'; d.cloud_issuer = null;
    d.souls.s1 = soul;
    d.assets.canary = recallAsset('canary', 'RETAINED_LOCAL_MEMORY');
  });
  await store.close();
  await writeAccountsIndex(root, {
    anonymous: { profile_id: 'default', default_soul_uid: null, soul_sync_mode: 'assets_only' },
    owner: { profile_id: 'default', default_soul_uid: 's1', soul_sync_mode: 'assets_only' },
  });
  const config = await loadConfig(root); delete config.active_profile_id; await saveConfig(root, config);
}

test('plain login offers confirmed website reconnection while retaining an unverified old profile byte-for-byte', async () => {
  await fixture(async ({root, deps, io}) => {
    await legacyProfile(root, deps);
    const before = readFileSync(path.join(root, 'profiles/default/snapshot.json'), 'utf8');
    let prompt = '', output = '';
    const code = await loginCommand(root, [], {...io, stderr: s => {output += s;}, confirm: async text => {prompt = text; return true;}}, deps);
    assert.equal(code, 0, output);
    assert.match(prompt, /keep|preserv/i);
    assert.match(prompt, /not.*(?:merge|copy)|separate/i);
    const active = resolveLocalAssetsProfileSync(root);
    assert.match(active.profile_id, /^reconnect-/);
    assert.equal(readFileSync(path.join(root, 'profiles/default/snapshot.json'), 'utf8'), before);
    assert.equal((await read(root, active.profile_id)).assets.canary, undefined);
    assert.ok((await read(root, active.profile_id)).souls.s1, 'website Soul is pulled into the new profile');
    const config = await loadConfig(root);
    const report = await runDoctor({...deps, inspectRuntime: async () => ({ok:true,agentd:true,pid:123,entrypoint:path.join(config.runtime_dir,'dist/cli.js')})});
    assert.equal(report.checks.find(check => check.name === 'local profile').ok,true);
    assert.doesNotMatch(report.checks.find(check => check.name === 'soul sync').detail, /login required/, 'retained inactive anonymous index must not make the restored connection appear unauthenticated');
  });
});

test('declining recovery performs no network request and changes no local metadata', async () => {
  await fixture(async ({root, deps, io}) => {
    await legacyProfile(root, deps);
    const files = ['config.json', 'accounts.json', 'profiles/default/snapshot.json'];
    const before = files.map(f => readFileSync(path.join(root,f),'utf8'));
    let prompts = 0, requests = 0;
    const code = await loginCommand(root, [], {...io, confirm: async () => {prompts++; return false;}}, {...deps, fetch: async () => {requests++; throw Error('must not network');}});
    assert.equal(code, 1); assert.equal(prompts, 1); assert.equal(requests, 0);
    assert.deepEqual(files.map(f => readFileSync(path.join(root,f),'utf8')), before);
    assert.deepEqual(readdirSync(path.join(root,'profiles')), ['default']);
  });
});

test('noninteractive recovery prints a concrete safe command without creating a profile', async () => {
  await fixture(async ({root, deps, io}) => {
    await legacyProfile(root, deps);
    let output = '';
    const code = await loginCommand(root, [], {...io, stderr: s => {output += s;}}, deps);
    assert.equal(code,1);
    assert.match(output, /37soul login --profile reconnect-[a-z0-9-]+/);
    assert.match(output, /not.*(?:merge|copy)|separate/i);
    assert.deepEqual(readdirSync(path.join(root,'profiles')), ['default']);
  });
});

test('plain fresh-install login uses its anonymous profile without a recovery prompt', async () => {
  await fixture(async ({root, deps, io}) => {
    await install(deps, { agents: ['pi'], installService: false });
    assert.equal(await loginCommand(root, [], {...io, confirm: async () => {throw Error('unnecessary recovery prompt');}}, deps), 0);
    assert.equal(resolveLocalAssetsProfileSync(root).profile_id, 'default');
  });
});

test('explicit unverified profile and corrupt shared metadata never start confirmed recovery', async () => {
  await fixture(async ({root, deps, io}) => {
    await legacyProfile(root, deps);
    const confirm = async () => {throw Error('must not bypass explicit selection or corrupt metadata');};
    assert.equal(await loginCommand(root, ['--profile','default'], {...io,confirm}, deps),1);
    writeFileSync(path.join(root,'accounts.json'), '{broken');
    assert.equal(await loginCommand(root, [], {...io,confirm}, deps),1);
    assert.equal(readFileSync(path.join(root,'accounts.json'),'utf8'), '{broken');
    assert.deepEqual(readdirSync(path.join(root,'profiles')), ['default']);
  });
});

for (const [file, replacement] of [
  ['config.json', {retained:'data'}],
  ['accounts.json', {owner:null}],
  ['accounts.json', JSON.parse('{"__proto__":{"profile_id":"default"}}')],
  ['accounts.json', {owner:{profile_id:'default',retained:'data'}}],
]) test(`recovery refuses structurally damaged shared metadata: ${file} ${JSON.stringify(replacement)}`, async () => {
  await fixture(async ({root,deps,io}) => {
    await legacyProfile(root,deps);
    writeFileSync(path.join(root,file),JSON.stringify(replacement));
    const before=readFileSync(path.join(root,file),'utf8');
    let prompts=0,requests=0;
    const code=await loginCommand(root,[],{...io,confirm:async()=>{prompts++;return false;}},{...deps,fetch:async()=>{requests++;throw Error('must not network');}});
    assert.equal(code,1);assert.equal(prompts,0);assert.equal(requests,0);
    assert.equal(readFileSync(path.join(root,file),'utf8'),before);
    assert.deepEqual(readdirSync(path.join(root,'profiles')),['default']);
  });
});
