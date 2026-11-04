import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHookCommand } from '../dist/hook.js';
import { openStore, ipcSocketPath } from '../dist/local/store.js';

async function setup(t, acknowledgeEventAfter) {
  const home = await mkdtemp(path.join(tmpdir(), '37soul-hook-budget-'));
  const root = path.join(home, '.37soul');
  const store = await openStore(root, 'p1', { deviceId: 'dev-1' });
  await store.transact(d => {
    d.souls.s1 = { soul_uid: 's1', legacy_host_id: null, identity_revision: 1,
      identity: { name: 'Synthetic Sophia', description: '', character: '', greeting: '' }, state: 'active', origin: 'local' };
    d.bindings['p1\0dev-1\0claude-code\0native-1'] = {
      binding_uid: 'b1', session_ref: '30000000-0000-4000-8000-000000000001',
      profile_id: 'p1', device_id: 'dev-1', runtime_kind: 'claude-code', native_session_id: 'native-1',
      soul_uid: 's1', revision: 1, state: 'bound',
    };
  });
  await store.close();
  await writeFile(path.join(root, 'profiles/p1/device.json'), JSON.stringify({ device_id: 'dev-1' }));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ api_base_url: 'https://invalid.test', machine_id: 'm1', tokens: {}, active_profile_id: 'p1' }));
  await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ anonymous: { profile_id: 'p1', cloud_issuer: null, default_soul_uid: null, soul_sync_mode: 'assets_only' } }));
  await mkdir(path.dirname(ipcSocketPath(root)), { recursive: true });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const sockets = new Set();
  const requests = [];
  const acknowledged = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]);
      requests.push(request.command);
      if (request.command === 'runtime_event' && acknowledgeEventAfter !== undefined) {
        await new Promise(resolve => setTimeout(resolve, acknowledgeEventAfter));
      } else {
        await blocked;
      }
      if (!socket.destroyed) { acknowledged.add(request.command); socket.write(JSON.stringify({ ok: true, result: {} }) + '\n'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ipcSocketPath(root), resolve); });
  t.after(async () => {
    release();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  return { home, release, requests, acknowledged };
}

async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
  test(`hook budget: ${event} leaves a stalled writer without late context or receipts`, async t => {
    const fixture = await setup(t);
    const output = [];
    const started = performance.now();
    const run = runHookCommand({
      home: fixture.home, agentKind: 'claude-code', event, timeoutMs: 40,
      stdin: JSON.stringify({ session_id: 'native-1', prompt: 'hello' }),
      fetch: async () => { throw new Error('no network permitted'); },
      stdout: value => output.push(value), stderr: () => {},
    });
    const exitedBeforeRelease = await within(run, 160);
    const elapsed = performance.now() - started;
    const beforeRelease = output.slice();
    fixture.release();
    await run;
    assert.equal(exitedBeforeRelease, true, `${event} waited for the stalled queue (${elapsed.toFixed(1)}ms)`);
    assert.deepEqual(output, beforeRelease, 'expired hook must not emit context after the writer recovers');
    assert.equal(fixture.requests.includes('record_receipt'), false, 'no false injected receipt after expiry');
  });
}

test('hook budget: runtime acknowledgement and receipt share one deadline', async t => {
  const fixture = await setup(t, 80);
  const output = [];
  const started = performance.now();
  const run = runHookCommand({
    home: fixture.home, agentKind: 'claude-code', event: 'SessionStart', timeoutMs: 100,
    stdin: JSON.stringify({ session_id: 'native-1' }),
    fetch: async () => { throw new Error('no network permitted'); },
    stdout: value => output.push(value), stderr: () => {},
  });
  const exited = await within(run, 155);
  const elapsed = performance.now() - started;
  fixture.release();
  await run;
  assert.equal(exited, true, `receipt got an extra timeout after the event acknowledgement (${elapsed.toFixed(1)}ms)`);
  assert.equal(output.length, 1, 'healthy context delivery is preserved while only receipt acknowledgement stalls');
  assert.match(output[0], /Synthetic Sophia/);
});

test('hook budget: bundled CLI exits with a writer socket that never replies', async t => {
  const fixture = await setup(t);
  const bundle = fileURLToPath(new URL('../dist/bundle/cli.js', import.meta.url));
  const child = spawn(process.execPath, [bundle, 'hook', '--agent', 'claude-code', '--event', 'SessionStart'], {
    env: { ...process.env, SOUL37_HOME: fixture.home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.resume();
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  child.stdin.end(JSON.stringify({ session_id: 'native-1' }));
  const exited = await within(exit, 850);
  if (!exited) child.kill('SIGKILL');
  const code = await exit;
  fixture.release();
  assert.equal(exited, true, 'an IPC socket kept the actual CLI process alive past the hook processing budget');
  assert.equal(code, 0);
  assert.equal(stdout, '', 'stalled hook fails open without stale identity output');
});

// Stop is a completed-turn boundary, not a lightweight notification: allow the
// context/completion deadline to acknowledge bounded durable local work.
test('hook budget: default Stop acknowledges a healthy completion taking more than a lightweight notification', async t => {
  const fixture = await setup(t, 80);
  const output = [];
  await runHookCommand({
    home: fixture.home, agentKind: 'claude-code', event: 'Stop',
    stdin: JSON.stringify({ session_id: 'native-1' }),
    fetch: async () => { throw new Error('no network permitted'); },
    stdout: value => output.push(value), stderr: () => {},
  });
  assert.equal(fixture.acknowledged.has('runtime_event'), true, 'a healthy completed-turn acknowledgement was abandoned prematurely');
  assert.deepEqual(output, []);
});
