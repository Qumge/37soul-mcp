import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHealth, requireHostedRunner } from './acceptance.mjs';
test('refuses service operations outside a hosted disposable runner', () => {
  for (const env of [{}, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }])
    assert.throws(() => requireHostedRunner(env), /hosted/);
  requireHostedRunner({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' });
});
test('requires live daemon writer matching the system manager PID and installed entrypoint', () => {
  const health = { ok: true, result: { writer_pid: 42, agentd: true, entrypoint: '/home/u/.37soul/runtime/0.14.0/dist/bundle/cli.js' } };
  assert.equal(validateHealth(health, 42, '/home/u/.37soul/runtime/0.14.0'), 42);
  for (const reply of [{ ...health, ok: false }, { ok: true, result: { ...health.result, agentd: false } }, { ok: true, result: { ...health.result, writer_pid: 41 } }, { ok: true, result: { ...health.result, entrypoint: '/tmp/cli.js' } }])
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
