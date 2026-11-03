import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOSTS, hostSpec, SUPPORTED_AGENTS, AGENT_HOMES } from '../dist/hosts/registry.js';
import { RUNTIME_KINDS } from '../dist/assets/protocol.js';
import { detectAgents, planInstall } from '../dist/install.js';
import { createExtractAdapters } from '../dist/agentd/native-invoker.js';

const kinds = ['gemini-cli', 'cursor'];
async function fixture(t, kind, initial) {
  const home = await mkdtemp(path.join(tmpdir(), '37soul-new-hosts-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, kind === 'cursor' ? '.cursor' : '.gemini');
  await mkdir(dir);
  const file = path.join(dir, kind === 'cursor' ? 'hooks.json' : 'settings.json');
  if (initial !== undefined) await writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
  const calls = [];
  const deps = { home, nodePath: process.execPath, cliScriptPath: '/runtime/dist/cli.js', launcher: '/runtime/bin/37soul', apiBase: 'https://example.invalid', runCommand: async args => { calls.push(args); throw new Error('must not invoke a model or register MCP'); } };
  return { home, dir, file, calls, deps, host: hostSpec(kind) };
}
const entries = (kind, doc, event) => kind === 'cursor' ? doc.hooks[event] : doc.hooks[event].flatMap(group => group.hooks);
const mappings = {
  'gemini-cli': { SessionStart: 'SessionStart', BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', PreCompress: 'PreCompact' },
  cursor: { sessionStart: 'SessionStart', beforeSubmitPrompt: 'UserPromptSubmit', stop: 'Stop', preCompact: 'PreCompact' },
};

test('new hosts: canonical registry and native executables cover seven runtimes', () => {
  assert.equal(HOSTS.length, 7);
  assert.deepEqual(SUPPORTED_AGENTS, RUNTIME_KINDS);
  assert.deepEqual(HOSTS.map(h => h.kind), RUNTIME_KINDS);
  assert.equal(hostSpec('cursor').invoke.binary, 'cursor-agent');
  assert.ok(hostSpec('cursor').invoke.userLaunchers.every(p => p.endsWith('/cursor-agent')));
  assert.equal(hostSpec('gemini-cli').invoke.binary, 'gemini');
  assert.equal(AGENT_HOMES.cursor, '.cursor');
  assert.equal(AGENT_HOMES['gemini-cli'], '.gemini');
  const adapters = createExtractAdapters('/unused-new-hosts-home');
  for (const kind of kinds) assert.equal(adapters[kind].runtime_kind, kind);
});

for (const kind of kinds) {
  test(`new hosts: ${kind} detection and plan are canonical without writes`, async t => {
    const f = await fixture(t, kind);
    assert.deepEqual(await detectAgents(f.home), [kind]);
    const plan = await planInstall({ ...f.deps, runtimeVersion: '0.14.2', platform: 'darwin' });
    assert.deepEqual(plan.agents, [kind]);
    assert.deepEqual(plan.unsupported, []);
    assert.ok(plan.files.includes(f.file));
    assert.deepEqual(await readdir(f.dir), []);
  });

  test(`new hosts: ${kind} preserves config, installs protocol events and is byte-idempotent`, async t => {
    const user = { command: 'user-hook --keep', timeout: 17 };
    const initial = { theme: 'user-theme', ...(kind === 'cursor' ? { version: 1 } : { hooksConfig: { enabled: false, disabled: ['mine'] } }), hooks: { [Object.keys(mappings[kind])[0]]: kind === 'cursor' ? [user] : [{ matcher: 'custom', sequential: true, hooks: [user] }], unrelated: [{ command: 'keep-me' }] } };
    const f = await fixture(t, kind, initial);
    const result = await f.host.install.configure(f.deps, 'must-not-be-used');
    assert.equal(result.hook, true);
    assert.equal(result.mcp, false);
    assert.deepEqual(result.report, { installed: true, trusted: false, events_seen: false, extraction_capable: false, injection_capable: false });
    assert.deepEqual(result.manifestEntries.map(e => e.file), [f.file]);
    const installed = JSON.parse(await readFile(f.file, 'utf8'));
    assert.equal(installed.theme, 'user-theme');
    assert.deepEqual(installed.hooks.unrelated, initial.hooks.unrelated);
    for (const [native, canonical] of Object.entries(mappings[kind])) {
      const own = entries(kind, installed, native).filter(e => e.command?.includes('37soul-managed:'));
      assert.equal(own.length, 1);
      assert.match(own[0].command, new RegExp(`hook --agent ${kind} --event ${canonical}`));
      assert.equal(own[0].type, 'command');
      assert.equal(own[0].timeout, kind === 'cursor' ? 5 : 5000);
    }
    if (kind === 'gemini-cli') assert.deepEqual(installed.hooksConfig, initial.hooksConfig);
    const before = await readFile(f.file, 'utf8');
    const names = await readdir(f.dir);
    await f.host.install.configure(f.deps, '');
    assert.equal(await readFile(f.file, 'utf8'), before);
    assert.deepEqual(await readdir(f.dir), names, 'no extra backup on identical reinstall');
    assert.deepEqual(f.calls, []);
  });

  test(`new hosts: ${kind} uninstall removes only marked commands and preserves siblings`, async t => {
    const f = await fixture(t, kind, { ...(kind === 'cursor' ? { version: 1 } : {}), user: { keep: true }, hooks: {} });
    await f.host.install.configure(f.deps, '');
    const doc = JSON.parse(await readFile(f.file, 'utf8'));
    const event = Object.keys(mappings[kind])[0];
    const user = { command: `echo 'hook --agent ${kind}'`, timeout: 73 };
    if (kind === 'cursor') doc.hooks[event].push(user);
    else { doc.hooks[event][0].hooks.push(user); doc.hooks[event][0].sequential = true; }
    doc.hooks.customUserEvent = [{ command: 'do-not-remove' }];
    await writeFile(f.file, JSON.stringify(doc));
    const removed = [];
    await f.host.install.uninstall(f.deps, removed);
    const after = JSON.parse(await readFile(f.file, 'utf8'));
    assert.deepEqual(after.user, { keep: true });
    assert.deepEqual(entries(kind, after, event), [user]);
    assert.deepEqual(after.hooks.customUserEvent, doc.hooks.customUserEvent);
    if (kind === 'gemini-cli') assert.equal(after.hooks[event][0].sequential, true);
    assert.ok(removed.length > 0);
    const text = await readFile(f.file, 'utf8');
    await f.host.install.uninstall(f.deps, []);
    assert.equal(await readFile(f.file, 'utf8'), text);
  });

  test(`new hosts: ${kind} rejects malformed or incompatible config without changing bytes`, async t => {
    const f = await fixture(t, kind, '{ broken JSON');
    await assert.rejects(() => f.host.install.configure(f.deps, ''), /JSON/);
    assert.equal(await readFile(f.file, 'utf8'), '{ broken JSON');
    for (const text of ['[]', 'null', '{"hooks":[]}', '{"hooks":{"' + Object.keys(mappings[kind])[0] + '":{}}}']) {
      await writeFile(f.file, text);
      await assert.rejects(() => f.host.install.configure(f.deps, ''));
      assert.equal(await readFile(f.file, 'utf8'), text);
    }
    assert.equal((await readdir(f.dir)).length, 1);
  });

  test(`new hosts: ${kind} doctor separates config from runtime observation without writes`, async t => {
    const f = await fixture(t, kind);
    await f.host.install.configure(f.deps, '');
    const deps = { ...f.deps, config: { launcher: f.deps.launcher }, assetsMode: true };
    const before = await readdir(f.home);
    const checks = await f.host.doctor(deps);
    assert.equal(checks.find(c => c.name === `${kind}: native hook configuration`).ok, true);
    for (const suffix of ['trust/load', 'hook output', 'extraction']) {
      const check = checks.find(c => c.name === `${kind}: ${suffix}`);
      assert.equal(check.ok, false);
      assert.match(check.detail, /not verified|no matching|unavailable|unverified/i);
    }
    assert.deepEqual(await readdir(f.home), before);
    const doc = JSON.parse(await readFile(f.file, 'utf8'));
    delete doc.hooks[kind === 'cursor' ? 'stop' : 'AfterAgent'];
    await writeFile(f.file, JSON.stringify(doc));
    assert.equal((await f.host.doctor(deps)).find(c => c.name === `${kind}: native hook configuration`).ok, false);
  });

  test(`new hosts: ${kind} nonempty-source extraction reports a blocker without invoking any CLI`, async () => {
    const spec = hostSpec(kind);
    let calls = 0;
    let reads = 0;
    const adapter = spec.invoke.createAdapter({ home: '/unused', invoke: async () => { calls++; throw new Error('unsafe native call'); }, readSource: async (refs, turnRefs) => { reads++; assert.deepEqual(refs, ['ref']); assert.equal(turnRefs, undefined); return 'synthetic native source'; }, emit: async () => { calls++; } });
    const probe = await adapter.probe();
    assert.equal(probe.version, '0.0.0-unverified');
    for (const capability of ['before_request', 'structured_extraction', 'internal_marker', 'resume', 'compact', 'interrupt']) assert.equal(probe[capability], false);
    const result = await adapter.extract({ job_uid: 'j1', runtime_kind: kind, native_session_id: 's', source_event_refs: ['ref'], binding_uid: 'b', binding_revision: 1, soul_uid: 'soul', internal_task: true });
    assert.deepEqual(result, { error: { code: kind === 'cursor' ? 'cursor_tool_free_extraction_unavailable' : 'gemini_cli_tool_free_extraction_unverified', retryable: false } });
    assert.equal(calls, 0);
    assert.equal(reads, 1);
    const injection = await adapter.inject({ rendered_text: 'identity' });
    assert.equal(injection.delivered, false);
  });

  test(`new hosts: ${kind} installed command quotes shell metacharacters in runtime paths`, async t => {
    const f = await fixture(t, kind);
    const script = path.join(f.home, "runtime ' ` dollar$;.mjs");
    await writeFile(script, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2)}))');
    const deps = { ...f.deps, launcher: undefined, cliScriptPath: script };
    await f.host.install.configure(deps, '');
    const doc = JSON.parse(await readFile(f.file, 'utf8'));
    const command = entries(kind, doc, Object.keys(mappings[kind])[0]).find(e => e.command.includes('37soul-managed:')).command;
    const run = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 2500 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).args, ['hook', '--agent', kind, '--event', 'SessionStart']);
  });
}

test('new hosts: Cursor unsupported hook version is preserved', async t => {
  const f = await fixture(t, 'cursor', '{"version":2,"hooks":{},"custom":true}');
  const before = await readFile(f.file, 'utf8');
  await assert.rejects(() => f.host.install.configure(f.deps, ''), /version/);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('new hosts: Gemini disabled hooks remain disabled and doctor explains the blocker', async t => {
  const f = await fixture(t, 'gemini-cli', { hooksConfig: { enabled: false }, hooks: {} });
  await f.host.install.configure(f.deps, '');
  const checks = await f.host.doctor({ ...f.deps, config: { launcher: f.deps.launcher }, assetsMode: true });
  const check = checks.find(c => c.name === 'gemini-cli: native hook configuration');
  assert.equal(check.ok, false);
  assert.match(check.detail, /disabled/);
});

test('new hosts: native parsers retain only session, prompt, verbatim local pointer and turn IDs', () => {
  const gemini = hostSpec('gemini-cli').hook.parsePayload({ session_id: 'g-session', cwd: '/work', prompt: 'question', transcript_path: '/native/chat.json', hook_event_name: 'AfterAgent', prompt_response: 'private response' });
  assert.deepEqual(gemini, { sessionId: 'g-session', cwd: '/work', prompt: 'question', transcriptPath: '/native/chat.json' });
  const cursor = hostSpec('cursor').hook.parsePayload({ conversation_id: 'c-session', session_id: 'c-session', workspace_roots: ['/workspace'], prompt: 'question', transcript_path: '/native/transcript.txt', generation_id: 'gen-7', hook_event_name: 'stop', status: 'completed', user_email: 'never-retain@example.invalid', text: 'private reply' });
  assert.deepEqual(cursor, { sessionId: 'c-session', cwd: '/workspace', prompt: 'question', transcriptPath: '/native/transcript.txt', sourceTurnRefs: ['gen-7'] });
  assert.equal(JSON.stringify(cursor).includes('private'), false);
  assert.equal(hostSpec('cursor').hook.parsePayload({ conversation_id: 'x' }).transcriptPath, null);
});

test('new hosts: native parsers fail closed for malformed identities and non-completed Cursor stop', () => {
  for (const kind of kinds) {
    assert.equal(hostSpec(kind).hook.parsePayload({ session_id: {} }).sessionId, 'unknown');
    assert.equal(hostSpec(kind).hook.parsePayload({ session_id: '' }).sessionId, 'unknown');
    assert.equal(hostSpec(kind).hook.parsePayload({}).sessionId, 'unknown');
  }
  for (const status of ['aborted', 'error', undefined]) assert.equal(hostSpec('cursor').hook.parsePayload({ conversation_id: 'c', hook_event_name: 'stop', status }).sessionId, 'unknown');
  assert.equal(hostSpec('cursor').hook.parsePayload({ conversation_id: 'c', session_id: 'different' }).sessionId, 'c');
});

test('new hosts: Gemini completed source refs support documented JSON and plain JSONL, not patches or incomplete turns', () => {
  const parser = hostSpec('gemini-cli').hook.completedTurnRefs;
  const messages = [{ id: 'old-u', type: 'user', content: 'old' }, { id: 'old-a', type: 'gemini', content: 'old' }, { id: 'u1', type: 'user', content: 'human' }, { id: 'a1', type: 'gemini', content: 'answer' }];
  assert.deepEqual(parser(JSON.stringify({ messages })), ['u1', 'a1']);
  assert.deepEqual(parser(messages.map(m => JSON.stringify(m)).join('\n')), ['u1', 'a1']);
  assert.deepEqual(parser(JSON.stringify({ messages: messages.slice(0, -1) })), []);
  assert.deepEqual(parser(JSON.stringify(messages[2]) + '\n' + '{broken'), []);
  assert.deepEqual(parser(messages.map(m => JSON.stringify(m)).join('\n') + '\n' + JSON.stringify({ $patch: { id: 'a1', content: 'changed' } })), []);
});

test('new hosts: native injection output never mislabels Cursor or Gemini BeforeAgent as Claude', () => {
  const gemini = hostSpec('gemini-cli').hook;
  assert.equal(gemini.injectionChannel, 'UserPromptSubmit');
  assert.deepEqual(JSON.parse(gemini.formatContext('hello\n世界', 'UserPromptSubmit')), { hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: 'hello\n世界' } });
  assert.equal(JSON.parse(gemini.formatContext('identity', 'SessionStart')).hookSpecificOutput.hookEventName, 'SessionStart');
  const cursor = hostSpec('cursor').hook;
  assert.equal(cursor.injectionChannel, 'SessionStart');
  assert.deepEqual(JSON.parse(cursor.formatContext('hello\n世界', 'SessionStart')), { additional_context: 'hello\n世界' });
  assert.deepEqual(JSON.parse(cursor.formatContext('must not inject', 'UserPromptSubmit')), {});
});

test('new hosts: Gemini disabled managed hook names remain disabled', async t => {
  const f = await fixture(t, 'gemini-cli', { hooks: {} });
  await f.host.install.configure(f.deps, '');
  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  const hook = doc.hooks.BeforeAgent[0].hooks[0];
  for (const disabled of [hook.name]) {
    doc.hooksConfig = { disabled: [disabled] };
    await writeFile(f.file, JSON.stringify(doc));
    await f.host.install.configure(f.deps, '');
    const result = await f.host.doctor({ ...f.deps, config: { launcher: f.deps.launcher }, assetsMode: true });
    assert.equal(result.find(c => c.name === 'gemini-cli: native hook configuration').ok, false);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).hooksConfig.disabled, [disabled]);
  }
});

for (const kind of kinds) {
  test(`new hosts: ${kind} obsolete launchers and malformed uninstall leave user data intact`, async t => {
    const f = await fixture(t, kind, { hooks: {} });
    await f.host.install.configure(f.deps, '');
    const checks = await f.host.doctor({ ...f.deps, config: { launcher: '/new/runtime/bin/37soul' }, assetsMode: true });
    assert.equal(checks.find(c => c.name === `${kind}: native hook configuration`).ok, false);
    await writeFile(f.file, '{not JSON');
    const removed = [];
    await f.host.install.uninstall(f.deps, removed);
    assert.equal(await readFile(f.file, 'utf8'), '{not JSON');
    assert.deepEqual(removed, []);
  });
}



for (const kind of kinds) {
  test(`new hosts: ${kind} empty source retains the shared source-unavailable contract`, async () => {
    let calls = 0;
    let reads = 0;
    const adapter = hostSpec(kind).invoke.createAdapter({ home: '/unused', invoke: async () => { calls++; throw new Error('must not invoke'); }, readSource: async (refs, turnRefs) => { reads++; assert.deepEqual(refs, ['ref']); assert.deepEqual(turnRefs, ['native-turn']); return ''; }, emit: async () => {} });
    const result = await adapter.extract({ job_uid: 'j-empty', runtime_kind: kind, native_session_id: 's', source_event_refs: ['ref'], source_turn_refs: ['native-turn'], binding_uid: 'b', binding_revision: 1, soul_uid: 'soul', internal_task: true });
    assert.deepEqual(result, { error: { code: 'source_unavailable', retryable: true } });
    assert.equal(reads, 1);
    assert.equal(calls, 0);
  });
}


test('new hosts: Gemini reinstall preserves renamed and unnamed disabled identities across launcher updates', async t => {
  for (const name of ['My local persona', undefined, '']) {
    const f = await fixture(t, 'gemini-cli', { hooks: {} });
    await f.host.install.configure(f.deps, '');
    const doc = JSON.parse(await readFile(f.file, 'utf8'));
    const hook = doc.hooks.BeforeAgent[0].hooks[0];
    if (name === undefined) delete hook.name;
    else hook.name = name;
    const oldIdentity = hook.name || hook.command;
    doc.hooksConfig = { disabled: ['keep-vendor-disabled', oldIdentity] };
    await writeFile(f.file, JSON.stringify(doc));
    // Keep the same logical hook disabled both on reinstall and on upgrade.
    for (const launcher of [f.deps.launcher, '/new/runtime/bin/37soul']) {
      const deps = { ...f.deps, launcher };
      await f.host.install.configure(deps, '');
      const updated = JSON.parse(await readFile(f.file, 'utf8'));
      const hooks = updated.hooks.BeforeAgent.flatMap(group => group.hooks).filter(h => h.command.includes('37soul-managed:'));
      assert.equal(hooks.length, 1);
      const current = hooks[0];
      assert.equal(current.name, name, 'user-chosen name/absence must survive reinstall');
      assert.ok(updated.hooksConfig.disabled.includes(current.name || current.command), 'Gemini must still resolve the managed hook as disabled');
      assert.ok(updated.hooksConfig.disabled.includes(oldIdentity), 'old disabled identity is user configuration');
      assert.ok(updated.hooksConfig.disabled.includes('keep-vendor-disabled'));
      const checks = await f.host.doctor({ ...deps, config: { launcher }, assetsMode: true });
      const status = checks.find(c => c.name === 'gemini-cli: native hook configuration');
      assert.equal(status.ok, false);
      assert.match(status.detail, /disabled/);
      const before = await readFile(f.file, 'utf8');
      await f.host.install.configure(deps, '');
      assert.equal(await readFile(f.file, 'utf8'), before, 'disabled identity migration must be idempotent');
    }
  }
});

test('new hosts: Gemini doctor matches exactly the native name-or-command disabled identity', async t => {
  const f = await fixture(t, 'gemini-cli', { hooks: {} });
  await f.host.install.configure(f.deps, '');
  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  const hook = doc.hooks.BeforeAgent[0].hooks[0];
  const originalName = hook.name;
  for (const { name, disabled, expected } of [
    { name: originalName, disabled: hook.command, expected: true },
    { name: 'My local persona', disabled: hook.command, expected: true },
    { name: 'My local persona', disabled: 'My local persona', expected: false },
    { name: undefined, disabled: hook.command, expected: false },
    { name: '', disabled: hook.command, expected: false },
    { name: undefined, disabled: originalName, expected: true },
  ]) {
    if (name === undefined) delete hook.name;
    else hook.name = name;
    doc.hooksConfig = { disabled: [disabled] };
    await writeFile(f.file, JSON.stringify(doc));
    const before = await readFile(f.file, 'utf8');
    const checks = await f.host.doctor({ ...f.deps, config: { launcher: f.deps.launcher }, assetsMode: true });
    const status = checks.find(c => c.name === 'gemini-cli: native hook configuration');
    assert.equal(status.ok, expected, JSON.stringify({ name, disabled }));
    if (!expected) assert.match(status.detail, /disabled/);
    assert.equal(await readFile(f.file, 'utf8'), before, 'doctor must not rewrite disabled identities');
  }
});
