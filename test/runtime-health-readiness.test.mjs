import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startWriter, sendWriter, registerWriterCommand, MAX_FRAME_BYTES } from '../dist/local/writer.js';

const req = (command, uid = randomUUID(), payload = {}) => ({ request_uid: uid, profile_id: 'synthetic-profile', command, payload });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'writer-health-readiness-'));
  const writer = await startWriter(root);
  t.after(async () => { await writer.close(); await rm(root, { recursive: true, force: true }); });
  return root;
}
function blockSync() {
  const entered = deferred(), gate = deferred(), done = deferred();
  registerWriterCommand('sync_once', async () => { entered.resolve(); await gate.promise; done.resolve(); return { synthetic: true }; });
  return { entered: entered.promise, release: gate.resolve, done: done.promise };
}
function raw(root, text, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.connect(path.join(root, 'ipc/writer.sock'));
    socket.setEncoding('utf8');
    let buffer = '', settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(result);
    };
    // Bound connect and response together. Explicit short deadline probes retain
    // their socket only until the released queue's late reply drains, avoiding a
    // RED cleanup EPIPE. Ordinary raw probes close on their default deadline.
    const timer = setTimeout(() => {
      finish({ ok: false, error: { code: 'test_deadline' } });
      if (timeoutMs === undefined) socket.destroy();
    }, timeoutMs ?? 1000);
    socket.once('connect', () => socket.write(text + '\n'));
    socket.on('data', chunk => {
      buffer += chunk; const at = buffer.indexOf('\n');
      if (at >= 0) {
        try { finish(JSON.parse(buffer.slice(0, at))); }
        catch { finish({ ok: false, error: { code: 'test_invalid_response' } }); }
        socket.destroy();
      }
    });
    const closed = () => finish({ ok: false, error: { code: 'test_socket_closed' } });
    socket.once('end', closed); socket.once('close', closed);
    socket.once('error', () => finish({ ok: false, error: { code: 'test_socket_error' } }));
  });
}

test('writer health: responds within a short IPC timeout while a mutation is blocked', async t => {
  const root = await fixture(t), block = blockSync();
  let completed = false;
  const mutation = sendWriter(root, req('sync_once')).then(r => { completed = true; return r; });
  await block.entered;
  try {
    const health = await raw(root, JSON.stringify(req('health')), 150);
    assert.equal(health.ok, true, JSON.stringify(health));
    assert.deepEqual(health.result, { writer_pid: process.pid, entrypoint: process.argv[1], agentd: process.argv[2] === 'agentd' });
    assert.equal(completed, false, 'health cannot wait for or release the blocked mutation');
  } finally { block.release(); await mutation; }
});

test('writer health: all ordinary commands remain FIFO and status cannot bypass a blocked mutation', async t => {
  const root = await fixture(t), entered = deferred(), gate = deferred();
  const trace = [];
  for (const command of ['sync_once', 'create_soul', 'detach']) {
    registerWriterCommand(command, async ({ request }) => {
      trace.push('start:' + request.request_uid);
      if (command === 'sync_once') { entered.resolve(); await gate.promise; }
      trace.push('end:' + request.request_uid);
      return request.request_uid;
    });
  }
  // One socket fixes arrival order across different command names.
  const socket = net.connect(path.join(root, 'ipc/writer.sock'));
  socket.setEncoding('utf8');
  await once(socket, 'connect');
  const results = new Promise((resolve, reject) => {
    let buffer = ''; const replies = [];
    socket.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); } if (replies.length === 3) { socket.destroy(); resolve(replies); } });
    socket.once('error', reject);
  });
  socket.write([req('sync_once', 'one'), req('create_soul', 'two'), req('detach', 'three')].map(JSON.stringify).join('\n') + '\n');
  await entered.promise;
  try {
    const status = await raw(root, JSON.stringify(req('status')), 60);
    assert.equal(status.ok, false, 'snapshot/status commands must stay serialized');
    assert.deepEqual(trace, ['start:one']);
  } finally { gate.resolve(); }
  const replies = await results;
  assert.deepEqual(replies.map(r => r.result), ['one', 'two', 'three']);
  assert.deepEqual(trace, ['start:one', 'end:one', 'start:two', 'end:two', 'start:three', 'end:three']);
  assert.equal((await sendWriter(root, req('status'))).ok, true);
});

test('writer health: normal frame validation still rejects malformed and oversized health requests', async t => {
  const root = await fixture(t), block = blockSync();
  const mutation = sendWriter(root, req('sync_once'));
  await block.entered;
  try {
    for (const frame of ['{not JSON', JSON.stringify({ command: 'health', profile_id: 'p' }), JSON.stringify(req('health', 'array', [])), JSON.stringify(req('unregistered-health', 'unknown'))]) {
      const result = await raw(root, frame);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'invalid_request');
    }
    const oversized = await raw(root, JSON.stringify(req('health', 'large', { text: 'x'.repeat(MAX_FRAME_BYTES + 128) })));
    assert.equal(oversized.ok, false); assert.equal(oversized.error.code, 'request_too_large');
  } finally { block.release(); await mutation; }
});

test('writer health: returns metadata only without reading or creating profile state', async t => {
  const root = await fixture(t);
  const dir = path.join(root, 'profiles/private');
  await mkdir(dir, { recursive: true });
  const bytes = '{"SYNTHETIC-PRIVATE-STATE": malformed snapshot';
  await writeFile(path.join(dir, 'snapshot.json'), bytes);
  const result = await sendWriter(root, req('health', 'metadata', { snapshot: 'SYNTHETIC-PRIVATE-PAYLOAD' }));
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.result).sort(), ['agentd', 'entrypoint', 'writer_pid']);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC-PRIVATE'));
  assert.deepEqual(await readdir(path.join(root, 'profiles')), ['private']);
  assert.equal(await readFile(path.join(dir, 'snapshot.json'), 'utf8'), bytes);
});

test('writer health: bypass is the fixed metadata handler, never a registry override with data access', async t => {
  const root = await fixture(t);
  let calls = 0;
  registerWriterCommand('health', async () => { calls++; return { unsafe_override: 'SYNTHETIC-PRIVATE-STATE' }; });
  const result = await sendWriter(root, req('health'));
  assert.equal(result.ok, true);
  assert.equal(calls, 0, 'an arbitrary registered handler must never gain FIFO bypass');
  assert.deepEqual(Object.keys(result.result).sort(), ['agentd', 'entrypoint', 'writer_pid']);
});
