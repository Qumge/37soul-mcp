import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { install, runtimeLauncher, runtimeDir } from '../dist/install.js';
import { runDoctor } from '../dist/doctor.js';
import { saveConfig } from '../dist/agentd/state.js';
import { openStore } from '../dist/local/store.js';
import { registerWriterCommand, startWriter } from '../dist/local/writer.js';
import { messages } from '../dist/i18n.js';

async function fixture(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'install-recovery-'));
  const root = path.join(home, '.37soul');
  const source = path.join(home, 'pkg');
  await mkdir(path.join(source, 'dist/bundle'), { recursive: true });
  for (const file of ['cli.js', 'index.js']) await writeFile(path.join(source, 'dist/bundle', file), '// test runtime');
  const logs = [], commands = [];
  const deps = { home, apiBase: 'https://example.test', nodePath: process.execPath, cliScriptPath: path.join(source, 'dist/cli.js'), agentdScriptPath: '', runtimeSourceRoot: source, runtimeVersion: '0.0.1', platform: 'linux', log: line => logs.push(line), runCommand: async argv => { commands.push(argv); return { code: 0, stdout: '', stderr: '' }; }, fetch: async () => { throw Error('no network'); } };
  try { await run({ home, root, deps, logs, commands }); } finally { await rm(home, { recursive: true, force: true }); }
}
async function legacy(root) {
  const store = await openStore(root, 'default');
  try { await store.transact(draft => { draft.owner_id = 'old-owner'; }); } finally { await store.close(); }
  const entry = { profile_id: 'default', soul_sync_mode: 'assets_only', default_soul_uid: null };
  await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ 'old-owner': entry, duplicate: entry }));
  await saveConfig(root, { machine_id: 'test', api_base_url: 'https://example.test', tokens: {}, installed_at: '' });
}
for (const running of [false, true]) test(`recovery install preserves legacy data and installs hooks/service; old writer=${running}`, async () => fixture(async ({ home, root, deps, logs, commands }) => {
  await legacy(root);
  const files = ['accounts.json', 'profiles/default/snapshot.json'];
  const before = await Promise.all(files.map(file => readFile(path.join(root, file), 'utf8')));
  let initCalls = 0;
  // Emulate a previous runtime accepting init without validating local selection.
  if (running) registerWriterCommand('init_assets_profile', async () => { initCalls++; return {}; });
  const writer = running ? await startWriter(root) : null;
  try {
    const result = await install(deps, { agents: ['pi'] });
    assert.equal(result.installed[0].agentKind, 'pi');
    assert.equal(initCalls, 0, 'must not dispatch init to an old daemon');
    assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(root, file), 'utf8'))), before);
    assert.deepEqual(await readdir(path.join(root, 'profiles')), ['default']);
    assert.ok((await readFile(runtimeLauncher(home, '0.0.1'), 'utf8')).length);
    assert.ok(commands.some(argv => argv[0] === 'systemctl'));
    assert.match(logs.join('\n'), /37soul login/);
  } finally { await writer?.close(); }
}));
test('doctor rejects unavailable local selection even with healthy daemon', async () => fixture(async ({ home, root, deps }) => {
  await legacy(root);
  const launcher = runtimeLauncher(home, '0.0.1');
  await mkdir(path.dirname(launcher), { recursive: true }); await writeFile(launcher, 'test');
  await saveConfig(root, { machine_id: 'test', api_base_url: deps.apiBase, tokens: {}, launcher, runtime_dir: runtimeDir(home, '0.0.1'), node_path: process.execPath });
  const result = await runDoctor({ ...deps, inspectRuntime: async () => ({ ok: true, agentd: true, pid: 123, entrypoint: path.join(runtimeDir(home, '0.0.1'), 'dist/cli.js') }) });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some(check => check.name === 'local profile' && !check.ok && check.fatal && check.detail.includes('37soul login')));
}));
test('attention summaries identify local profile as well as daemon in all languages', () => {
  for (const [lang, word] of [['en', 'profile'], ['zh', 'profile'], ['ja', 'プロファイル']]) assert.ok(messages(lang).localNeedsAttention.includes(word), lang);
});

const minimalConfig = { api_base_url: 'https://example.test', machine_id: 'test' };
for (const [name, value] of [
  ['missing required fields', { retained: 'data' }],
  ['invalid API type', { ...minimalConfig, api_base_url: 42 }],
  ['invalid machine type', { ...minimalConfig, machine_id: null }],
  ['array tokens', { ...minimalConfig, tokens: [] }],
  ['null tokens', { ...minimalConfig, tokens: null }],
  ['string tokens', { ...minimalConfig, tokens: 'retained' }],
  ['object credentials', { ...minimalConfig, credentials: {} }],
  ['null credentials', { ...minimalConfig, credentials: null }],
  ['object transcript fallback', { ...minimalConfig, transcript_fallback: {} }],
  ['null transcript fallback', { ...minimalConfig, transcript_fallback: null }],
  ['array config', []],
  ['null config', null],
  ['broken JSON', undefined],
]) test(`install refuses damaged config before any writes: ${name}`, async () => fixture(async ({ root, deps, commands }) => {
  await mkdir(root, { recursive: true });
  const bytes = value === undefined ? '{broken retained' : ` ${JSON.stringify(value)}\n`;
  await writeFile(path.join(root, 'config.json'), bytes);
  await assert.rejects(install(deps, { agents: ['pi'] }), /config\.json.*repair/i);
  assert.equal(await readFile(path.join(root, 'config.json'), 'utf8'), bytes);
  assert.deepEqual(await readdir(root), ['config.json'], 'no profile, index, IPC or runtime created');
  assert.deepEqual(commands, [], 'no host/service commands');
}));

test('install accepts minimum legacy config with optional collections omitted', async () => fixture(async ({ root, deps }) => {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'config.json'), JSON.stringify(minimalConfig));
  await install(deps, { agents: ['pi'], installService: false });
  assert.equal(JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')).machine_id, 'test');
}));
