import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHookCommand } from '../dist/hook.js';
import { openStore } from '../dist/local/store.js';
import { startWriter } from '../dist/local/writer.js';
import { hostSpec } from '../dist/hosts/registry.js';
import { drainPendingExtractions } from '../dist/extraction/scheduler.js'; // same runtime_event registration as the daemon
import { createExtractAdapters } from '../dist/agentd/native-invoker.js';


async function fixture(t, kind) {
  const home = await mkdtemp(path.join(tmpdir(), 'new-host-runtime-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, '.37soul');
  const profile = 'native-test-profile';
  await mkdir(path.join(root, 'profiles', profile), { recursive: true });
  await writeFile(path.join(root, 'profiles', profile, 'device.json'), JSON.stringify({ device_id: 'native-test-device' }));
  await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ anonymous: { profile_id: profile, default_soul_uid: 's1', soul_sync_mode: 'assets_only' } }));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ api_base_url: 'https://example.invalid', machine_id: 'test-machine', tokens: {}, active_profile_id: profile }));
  const store = await openStore(root, profile);
  await store.transact(draft => {
    draft.souls.s1 = { soul_uid: 's1', legacy_host_id: null, identity_revision: 1, state: 'active', origin: 'local', identity: { name: 'Native Test Identity', description: '', character: 'Private local fixture identity.', greeting: '' } };
  });
  await store.close();
  const source = path.join(home, 'native-transcript.jsonl');
  const records = [{ id: 'native-user-7', type: 'user', content: 'PRIVATE_RAW_CANARY_7' }, { id: 'native-answer-7', type: 'gemini', content: 'private answer' }];
  await writeFile(source, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const payload = kind === 'cursor'
    ? { conversation_id: 'cursor-conversation', session_id: 'cursor-conversation', generation_id: 'cursor-generation-7', workspace_roots: [home], transcript_path: source }
    : { session_id: 'gemini-session', cwd: home, transcript_path: source };
  const snap = async () => { const s = await openStore(root, profile); try { return await s.read(); } finally { await s.close(); } };
  const hook = async (event, native, extra = {}) => {
    const stdout = [], stderr = [];
    const code = await runHookCommand({ home, agentKind: kind, event, stdin: JSON.stringify({ ...payload, hook_event_name: native, ...extra }), timeoutMs: 3000, fetch: async () => assert.fail('native hooks must not upload raw source or call a provider'), stdout: text => stdout.push(text), stderr: text => stderr.push(text) });
    assert.equal(code, 0);
    assert.deepEqual(stderr, []);
    return stdout.join('');
  };
  return { home, root, profile, source, payload, snap, hook };
}

for (const kind of ['gemini-cli', 'cursor']) {
  test(`new hosts runtime: ${kind} emits native context and persists only local completion provenance`, async t => {
    const f = await fixture(t, kind);
    const writer = await startWriter(f.root);
    try {
      const start = await f.hook('SessionStart', kind === 'cursor' ? 'sessionStart' : 'SessionStart');
      const prompt = await f.hook('UserPromptSubmit', kind === 'cursor' ? 'beforeSubmitPrompt' : 'BeforeAgent', { prompt: 'A bounded fixture question' });
      const output = JSON.parse(kind === 'cursor' ? start : prompt);
      const text = kind === 'cursor' ? output.additional_context : output.hookSpecificOutput.additionalContext;
      assert.match(text, /Native Test Identity/);
      assert.match(text, new RegExp(`--agent ${kind}`));
      assert.ok(!text.includes('PRIVATE_RAW_CANARY_7'));
      if (kind === 'cursor') { assert.equal(output.hookSpecificOutput, undefined); assert.equal(prompt, ''); }
      else { assert.equal(start, ''); assert.equal(output.hookSpecificOutput.hookEventName, 'BeforeAgent'); }
      const before = await f.snap();
      const receipts = Object.values(before.receipts).filter(receipt => receipt.stage === 'injected');
      assert.ok(receipts.length > 0);
      assert.equal(await f.hook('Stop', kind === 'cursor' ? 'stop' : 'AfterAgent', { status: 'completed' }), '');
      const after = await f.snap();
      const watermarks = Object.values(after.extraction_watermarks);
      assert.equal(watermarks.length, 1);
      const wm = watermarks[0];
      assert.equal(wm.completed, false);
      assert.equal(wm.state, 'pending');
      assert.equal(wm.attempts, 0);
      assert.deepEqual(wm.request.source_turn_refs, kind === 'cursor' ? ['cursor-generation-7'] : ['native-user-7', 'native-answer-7']);
      const pointers = await readdir(path.join(f.root, 'sources', f.profile));
      assert.ok(pointers.length >= 1);
      const pointer = JSON.parse(await readFile(path.join(f.root, 'sources', f.profile, wm.request.source_event_refs[0] + '.json'), 'utf8'));
      assert.equal(pointer.path, f.source);
      assert.equal(pointer.runtime_kind, kind);
      assert.ok(Number.isSafeInteger(pointer.end_offset));
      assert.equal(JSON.stringify(pointer).includes('PRIVATE_RAW_CANARY_7'), false);
      assert.equal(JSON.stringify(after).includes('PRIVATE_RAW_CANARY_7'), false);
      // Use the real source reader and real adapter, which cannot launch a model.
      // Cursor generation IDs have no assumed transcript-record mapping.
      const adapters = createExtractAdapters(f.home);
      assert.deepEqual(await drainPendingExtractions(f.root, { [kind]: adapters[kind] }), { started: 1, completed: 0, failed: 1 });
      const failed = Object.values((await f.snap()).extraction_watermarks)[0];
      assert.equal(failed.completed, false);
      assert.equal(failed.state, 'error');
      assert.equal(failed.last_error, kind === 'cursor' ? 'source_unavailable' : 'gemini_cli_tool_free_extraction_unverified');
      const checks = await hostSpec(kind).doctor({ home: f.home, config: {}, assetsMode: true, nodePath: process.execPath, cliScriptPath: '/runtime/cli.js' });
      assert.equal(checks.find(c => c.name === `${kind}: hook output`).ok, true);
      assert.equal(checks.find(c => c.name === `${kind}: extraction`).ok, false);
      assert.equal(checks.find(c => c.name === `${kind}: trust/load`).ok, false);
    } finally { await writer.close(); }
  });
}

test('new hosts runtime: aborted Cursor stop cannot schedule a completed turn', async t => {
  const f = await fixture(t, 'cursor');
  const writer = await startWriter(f.root);
  try {
    await f.hook('SessionStart', 'sessionStart');
    await f.hook('Stop', 'stop', { status: 'aborted' });
    assert.deepEqual((await f.snap()).extraction_watermarks, {});
  } finally { await writer.close(); }
});

test('new hosts runtime: Gemini missing native identity cannot invent a connection hint', async t => {
  const f = await fixture(t, 'gemini-cli');
  const writer = await startWriter(f.root);
  try {
    const output = await f.hook('UserPromptSubmit', 'BeforeAgent', { session_id: undefined, prompt: 'Who am I?' });
    assert.equal(output, '');
    const snapshot = await f.snap();
    assert.deepEqual(snapshot.bindings, {});
    assert.deepEqual(snapshot.extraction_watermarks, {});
  } finally { await writer.close(); }
});
