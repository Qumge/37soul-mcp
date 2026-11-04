import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHookCommand } from '../dist/hook.js';
import { openStore } from '../dist/local/store.js';
import { sendWriter } from '../dist/local/writer.js';

async function fixture(t, busyMs) {
  const home = await mkdtemp(path.join(tmpdir(), '37soul-writer-disconnect-'));
  const root = path.join(home, '.37soul');
  const store = await openStore(root, 'p1', { deviceId: 'synthetic-device' });
  await store.transact(() => {});
  await store.close();
  await writeFile(root + '/profiles/p1/device.json', JSON.stringify({ device_id: 'synthetic-device' }));
  await writeFile(root + '/accounts.json', JSON.stringify({ anonymous: { profile_id: 'p1', default_soul_uid: null, soul_sync_mode: 'assets_only' } }));
  await writeFile(root + '/config.json', JSON.stringify({ machine_id: 'synthetic', api_base_url: 'https://invalid.test', tokens: {}, active_profile_id: 'p1' }));
  const script = path.join(home, 'writer.mjs');
  await writeFile(script, `
    import { writeFileSync } from 'node:fs';
    import { startWriter, registerWriterCommand } from ${JSON.stringify(new URL('../dist/local/writer.js', import.meta.url).href)};
    const trace = [];
    const save = () => writeFileSync(${JSON.stringify(path.join(home, 'trace.json'))}, JSON.stringify(trace));
    registerWriterCommand('runtime_event', async () => {
      trace.push('event:start'); save();
      // Real CPU work prevents the server from observing the client's FIN before
      // its reply microtask. A timer-only fake cannot reproduce this EPIPE race.
      const until = performance.now() + ${busyMs};
      while (performance.now() < until) {}
      trace.push('event:committed'); save();
      return { completed: true };
    });
    registerWriterCommand('status', async () => { trace.push('status'); save(); return trace; });
    const writer = await startWriter(${JSON.stringify(root)});
    process.on('message', async message => {
      if (message === 'close') { await writer.close(); process.disconnect(); }
    });
    process.send('ready');
  `);
  const child = fork(script, { env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  let exited = false;
  const exit = new Promise(resolve => { child.once('exit', code => { exited = true; resolve(code); }); });
  t.after(async () => {
    if (!exited) {
      child.send('close');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exit; clearTimeout(timer);
    }
    await rm(home, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthetic writer did not start')), 5000);
    child.once('message', value => { clearTimeout(timer); value === 'ready' ? resolve() : reject(new Error('unexpected writer message')); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return { home, root, trace: () => readFile(path.join(home, 'trace.json'), 'utf8').then(JSON.parse), stderr: () => stderr, exited: () => exited };
}

for (const [label, timeoutMs, busyMs] of [['short deadline', 40, 180], ['default deadline', undefined, 450]]) {
  test(`writer disconnect: ${label} keeps the daemon alive and accepted FIFO work committed`, async t => {
    const f = await fixture(t, busyMs);
    const code = await runHookCommand({
      home: f.home, agentKind: 'claude-code', event: 'SessionStart', ...(timeoutMs ? { timeoutMs } : {}),
      stdin: JSON.stringify({ session_id: 'synthetic-native' }),
      fetch: async () => { throw new Error('no model or network permitted'); }, stdout: () => {}, stderr: () => {},
    });
    assert.equal(code, 0, 'the foreground hook keeps the host working');
    const following = await sendWriter(f.root, { request_uid: 'following', profile_id: 'p1', command: 'status', payload: {} }, { timeoutMs: 1500 });
    assert.equal(following.ok, true, `writer died after the timed-out client disconnected: ${f.stderr()}`);
    assert.deepEqual(following.result, ['event:start', 'event:committed', 'status']);
    assert.deepEqual(await f.trace(), ['event:start', 'event:committed', 'status']);
    assert.equal(f.exited(), false, 'background service survives the peer disconnect');
    assert.doesNotMatch(f.stderr(), /EPIPE|Unhandled|unhandled/);
  });
}
