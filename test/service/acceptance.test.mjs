import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHealth, requireHostedRunner } from './acceptance.mjs';
test('refuses service operations outside a hosted disposable runner', () => {
  for (const env of [{}, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }])
    assert.throws(() => requireHostedRunner(env), /hosted/);
  requireHostedRunner({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' });
});
test('requires live daemon writer matching the system manager PID and installed entrypoint', () => {
  const health = { ok: true, result: { writer_pid: 42, agentd: true, entrypoint: '/home/u/.37soul/runtime/0.14.0/dist/cli.js' } };
  assert.equal(validateHealth(health, 42, '/home/u/.37soul/runtime/0.14.0'), 42);
  for (const reply of [{ ok: true, result: { ...health.result, entrypoint: '/home/u/.37soul/runtime/0.14.0/dist/bundle/cli.js' } }, { ...health, ok: false }, { ok: true, result: { ...health.result, agentd: false } }, { ok: true, result: { ...health.result, writer_pid: 41 } }, { ok: true, result: { ...health.result, entrypoint: '/tmp/cli.js' } }])
    assert.throws(() => validateHealth(reply, 42, '/home/u/.37soul/runtime/0.14.0'));
});

test('clean manager accepts an inactive missing Linux unit and rejects live or loaded jobs', async () => {
  const { assertManagerAbsent } = await import('./acceptance.mjs');
  assertManagerAbsent('MainPID=0\nActiveState=inactive\n', 'linux');
  assertManagerAbsent(null, 'darwin');
  assert.throws(() => assertManagerAbsent('MainPID=42\nActiveState=active\n', 'linux'));
  assert.throws(() => assertManagerAbsent('MainPID=42\nActiveState=failed\n', 'linux'));
  assert.throws(() => assertManagerAbsent('state = waiting', 'darwin'));
});

test('installed dist/cli.js must equal packed dist/bundle/cli.js bytes, not a decoy path', async t => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { packedCliBytes, validateInstalledCli } = await import('./acceptance.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), '37soul-service-bytes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, 'runtime/0.14.0');
  const packed = path.join(dir, 'packed');
  const archive = path.join(dir, 'runtime.tgz');
  const bytes = Buffer.from('self-contained candidate CLI\n');
  await mkdir(path.join(packed, '37soul/dist/bundle'), { recursive: true });
  await mkdir(path.join(runtime, 'dist/bundle'), { recursive: true });
  await writeFile(path.join(packed, '37soul/dist/bundle/cli.js'), bytes);
  await writeFile(path.join(packed, '37soul/dist/cli.js'), 'wrong packed layout decoy');
  execFileSync('tar', ['-czf', archive, '-C', packed, '37soul']);
  const expected = packedCliBytes(archive);
  assert.deepEqual(expected, bytes);
  await writeFile(path.join(runtime, 'dist/cli.js'), bytes);
  await validateInstalledCli(runtime, expected);
  await writeFile(path.join(runtime, 'dist/bundle/cli.js'), bytes);
  await writeFile(path.join(runtime, 'dist/cli.js'), 'tampered installed bytes');
  await assert.rejects(validateInstalledCli(runtime, expected), /installed bytes match downloaded release/);
});
