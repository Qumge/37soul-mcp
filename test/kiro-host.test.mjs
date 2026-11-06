import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOSTS, hostSpec, SUPPORTED_AGENTS, AGENT_HOMES } from '../dist/hosts/registry.js';
import { RUNTIME_KINDS } from '../dist/assets/protocol.js';
import { detectAgents, planInstall } from '../dist/install.js';

const kind = 'kiro';
const triggers = { SessionStart: 'SessionStart', UserPromptSubmit: 'UserPromptSubmit' };

async function fixture(t, initial) {
  const home = await mkdtemp(path.join(tmpdir(), '37soul-kiro-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.kiro', 'hooks');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, '37soul.json');
  if (initial !== undefined) await writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
  const calls = [];
  const deps = {
    home,
    nodePath: process.execPath,
    cliScriptPath: '/runtime/dist/cli.js',
    launcher: '/runtime/bin/37soul',
    apiBase: 'https://example.invalid',
    runCommand: async args => { calls.push(args); throw new Error('must not invoke a model or register MCP'); },
  };
  return { home, dir, file, calls, deps, host: hostSpec(kind) };
}

const managed = doc => doc.hooks.filter(hook =>
  typeof hook?.action?.command === 'string' && hook.action.command.includes('37soul-managed:'));

test('kiro: registry, home, executable and detection are canonical', async t => {
  assert.equal(HOSTS.length, 8);
  assert.deepEqual(HOSTS.map(host => host.kind), RUNTIME_KINDS);
  assert.deepEqual(SUPPORTED_AGENTS, RUNTIME_KINDS);
  assert.equal(AGENT_HOMES.kiro, '.kiro');
  assert.equal(hostSpec('kiro').invoke.binary, 'kiro-cli');
  assert.ok(hostSpec('kiro').invoke.userLaunchers.includes('.local/bin/kiro-cli'));

  const f = await fixture(t);
  assert.deepEqual(await detectAgents(f.home), ['kiro']);
  const plan = await planInstall({ ...f.deps, runtimeVersion: '0.19.0', platform: 'darwin' });
  assert.deepEqual(plan.agents, ['kiro']);
  assert.deepEqual(plan.unsupported, []);
  assert.ok(plan.files.includes(f.file));
  assert.deepEqual(await readdir(f.dir), []);
});

test('kiro: configure preserves user hooks and installs both context events', async t => {
  const user = { name: 'mine', trigger: 'SessionStart', action: { type: 'command', command: 'echo user' }, enabled: true };
  const promptUser = { name: 'prompt', trigger: 'UserPromptSubmit', action: { type: 'command', command: 'echo prompt' } };
  const f = await fixture(t, { version: 'v1', custom: { keep: true }, hooks: [user, promptUser] });

  const result = await f.host.install.configure(f.deps, 'must-not-be-used');
  assert.equal(result.hook, true);
  assert.equal(result.mcp, false);
  assert.deepEqual(result.report, { installed: true, trusted: false, events_seen: false, extraction_capable: false, injection_capable: false });
  assert.deepEqual(result.manifestEntries.map(entry => entry.file), [f.file]);

  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(doc.custom, { keep: true });
  assert.equal(doc.version, 'v1');
  assert.ok(doc.hooks.some(hook => JSON.stringify(hook) === JSON.stringify(user)));
  assert.ok(doc.hooks.some(hook => JSON.stringify(hook) === JSON.stringify(promptUser)));
  const own = managed(doc);
  assert.equal(own.length, 2);
  for (const [trigger, canonical] of Object.entries(triggers)) {
    const hook = own.find(entry => entry.trigger === trigger);
    assert.ok(hook, `missing ${trigger}`);
    assert.equal(hook.action.type, 'command');
    assert.match(hook.action.command, new RegExp(`hook --agent kiro --event ${canonical}`));
    assert.ok(hook.action.command.endsWith(`# 37soul-managed:kiro:${trigger}:v1`));
    assert.equal(hook.timeout, 30);
    assert.equal(hook.enabled, true);
  }

  const before = await readFile(f.file, 'utf8');
  const names = await readdir(f.dir);
  await f.host.install.configure(f.deps, '');
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.deepEqual(await readdir(f.dir), names, 'no extra backup on identical reinstall');
  assert.deepEqual(f.calls, []);
});

test('kiro: reconfigure preserves a user-disabled or renamed managed hook', async t => {
  const f = await fixture(t);
  await f.host.install.configure(f.deps, '');
  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  const own = managed(doc).find(hook => hook.trigger === 'SessionStart');
  own.name = 'my-37soul-hook';
  own.enabled = false;
  await writeFile(f.file, JSON.stringify(doc));

  await f.host.install.configure(f.deps, '');
  const after = JSON.parse(await readFile(f.file, 'utf8'));
  const hook = managed(after).find(entry => entry.trigger === 'SessionStart');
  assert.equal(hook.name, 'my-37soul-hook');
  assert.equal(hook.enabled, false);

  const checks = await f.host.doctor({ ...f.deps, config: { launcher: f.deps.launcher }, assetsMode: true });
  const config = checks.find(check => check.name === 'kiro: native hook configuration');
  assert.equal(config.ok, false);
  assert.match(config.detail, /disabled/);
});

test('kiro: malformed or incompatible config is rejected without changing bytes', async t => {
  const f = await fixture(t, '{ broken JSON');
  await assert.rejects(() => f.host.install.configure(f.deps, ''), /JSON/);
  assert.equal(await readFile(f.file, 'utf8'), '{ broken JSON');

  for (const text of ['[]', 'null', '{"version":"v2","hooks":[]}', '{"version":"v1","hooks":{}}']) {
    await writeFile(f.file, text);
    await assert.rejects(() => f.host.install.configure(f.deps, ''));
    assert.equal(await readFile(f.file, 'utf8'), text);
  }
  assert.equal((await readdir(f.dir)).length, 1);
});

test('kiro: an existing hook file without a version is upgraded in place', async t => {
  const user = { name: 'mine', trigger: 'SessionStart', action: { type: 'command', command: 'echo user' } };
  const f = await fixture(t, { hooks: [user] });
  await f.host.install.configure(f.deps, '');
  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(doc.version, 'v1');
  assert.ok(doc.hooks.some(hook => JSON.stringify(hook) === JSON.stringify(user)));
  assert.equal(managed(doc).length, 2);
});

test('kiro: uninstall removes only managed hooks and deletes an otherwise empty file', async t => {
  const user = { name: 'mine', trigger: 'SessionStart', action: { type: 'command', command: 'echo mine' } };
  const f = await fixture(t, { version: 'v1', user: { keep: true }, hooks: [user] });
  await f.host.install.configure(f.deps, '');
  const removed = [];
  await f.host.install.uninstall(f.deps, removed);
  const after = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(after.user, { keep: true });
  assert.deepEqual(after.hooks, [user]);
  assert.ok(removed.length > 0);

  const text = await readFile(f.file, 'utf8');
  await f.host.install.uninstall(f.deps, []);
  assert.equal(await readFile(f.file, 'utf8'), text);

  const only = await fixture(t);
  await only.host.install.configure(only.deps, '');
  const deleted = [];
  await only.host.install.uninstall(only.deps, deleted);
  await assert.rejects(() => stat(only.file), error => error.code === 'ENOENT');
  assert.ok(deleted.includes(path.relative(only.home, only.file)));
});

test('kiro: uninstall preserves an unreadable file and reports nothing removed', async t => {
  const f = await fixture(t, '{not JSON');
  const removed = [];
  await f.host.install.uninstall(f.deps, removed);
  assert.equal(await readFile(f.file, 'utf8'), '{not JSON');
  assert.deepEqual(removed, []);
});

test('kiro: doctor separates config from trust, output and extraction without writes', async t => {
  const f = await fixture(t);
  await f.host.install.configure(f.deps, '');
  const deps = { ...f.deps, config: { launcher: f.deps.launcher }, assetsMode: true };
  const before = await readdir(f.home);
  const checks = await f.host.doctor(deps);
  assert.equal(checks.find(check => check.name === 'kiro: native hook configuration').ok, true);
  for (const suffix of ['trust/load', 'hook output', 'extraction']) {
    const check = checks.find(entry => entry.name === `kiro: ${suffix}`);
    assert.equal(check.ok, false);
    assert.match(check.detail, /not verified|no matching|unavailable|unverified/i);
  }
  assert.match(checks.find(check => check.name === 'kiro: extraction').detail, /Kiro extraction unavailable/);
  assert.deepEqual(await readdir(f.home), before);

  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  doc.hooks = doc.hooks.filter(hook => hook.trigger !== 'UserPromptSubmit' || !managed({ hooks: [hook] }).length);
  await writeFile(f.file, JSON.stringify(doc));
  assert.equal((await f.host.doctor(deps)).find(check => check.name === 'kiro: native hook configuration').ok, false);
});

test('kiro: parser retains only verified identity fields and never reads a transcript path', () => {
  const parser = hostSpec('kiro').hook.parsePayload;
  assert.deepEqual(parser({
    hook_event_name: 'SessionStart',
    session_id: 'k-session',
    cwd: '/work',
    prompt: 'question',
    transcript_path: '/native/transcript.jsonl',
    assistant_response: 'private reply',
  }), { sessionId: 'k-session', cwd: '/work', prompt: 'question', transcriptPath: null });
  assert.equal(JSON.stringify(parser({ session_id: 'k-session', assistant_response: 'private reply' })).includes('private'), false);
  for (const payload of [{}, { session_id: {} }, { session_id: '' }, { session_id: 7 }]) {
    assert.equal(parser(payload).sessionId, 'unknown');
    assert.equal(parser(payload).transcriptPath, null);
  }
});

test('kiro: SessionStart injects plain text and UserPromptSubmit stays silent', () => {
  const hook = hostSpec('kiro').hook;
  assert.equal(hook.injectionChannel, 'SessionStart');
  assert.deepEqual(hook.events.map(event => event.event), ['SessionStart', 'UserPromptSubmit']);
  assert.deepEqual(hook.events.map(event => event.canonical), ['SessionStart', 'UserPromptSubmit']);
  assert.equal(hook.formatContext('hello\n世界', 'SessionStart'), 'hello\n世界');
  assert.equal(hook.formatContext('must not inject', 'UserPromptSubmit'), 'must not inject');
});

test('kiro: installed command quotes shell metacharacters in runtime paths', async t => {
  const f = await fixture(t);
  const script = path.join(f.home, "runtime ' ` dollar$;.mjs");
  await writeFile(script, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2)}))');
  const deps = { ...f.deps, launcher: undefined, cliScriptPath: script };
  await f.host.install.configure(deps, '');
  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  const command = managed(doc).find(hook => hook.trigger === 'SessionStart').action.command;
  const run = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 2500 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).args, ['hook', '--agent', kind, '--event', 'SessionStart']);
});

test('kiro: nonempty-source extraction reports a blocker without invoking any CLI', async () => {
  const spec = hostSpec(kind);
  let calls = 0;
  let reads = 0;
  const adapter = spec.invoke.createAdapter({
    home: '/unused',
    invoke: async () => { calls++; throw new Error('unsafe native call'); },
    readSource: async (refs, turnRefs) => {
      reads++;
      assert.deepEqual(refs, ['ref']);
      assert.equal(turnRefs, undefined);
      return 'synthetic native source';
    },
    emit: async () => { calls++; },
  });
  const probe = await adapter.probe();
  assert.equal(probe.version, '0.0.0-unverified');
  for (const capability of ['before_request', 'structured_extraction', 'internal_marker', 'resume', 'compact', 'interrupt']) {
    assert.equal(probe[capability], false);
  }
  const result = await adapter.extract({
    job_uid: 'j1', runtime_kind: kind, native_session_id: 's',
    source_event_refs: ['ref'], binding_uid: 'b', binding_revision: 1, soul_uid: 'soul', internal_task: true,
  });
  assert.deepEqual(result, { error: { code: 'kiro_tool_free_extraction_unavailable', retryable: false } });
  assert.equal(calls, 0);
  assert.equal(reads, 1);
  const injection = await adapter.inject({ rendered_text: 'identity' });
  assert.equal(injection.delivered, false);
});

test('kiro: empty source retains the shared source-unavailable contract', async () => {
  let calls = 0;
  let reads = 0;
  const adapter = hostSpec(kind).invoke.createAdapter({
    home: '/unused',
    invoke: async () => { calls++; throw new Error('must not invoke'); },
    readSource: async (refs, turnRefs) => {
      reads++;
      assert.deepEqual(refs, ['ref']);
      assert.deepEqual(turnRefs, ['native-turn']);
      return '';
    },
    emit: async () => {},
  });
  const result = await adapter.extract({
    job_uid: 'j-empty', runtime_kind: kind, native_session_id: 's',
    source_event_refs: ['ref'], source_turn_refs: ['native-turn'],
    binding_uid: 'b', binding_revision: 1, soul_uid: 'soul', internal_task: true,
  });
  assert.deepEqual(result, { error: { code: 'source_unavailable', retryable: true } });
  assert.equal(reads, 1);
  assert.equal(calls, 0);
});
