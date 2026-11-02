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

test('public candidate runs literal curl with no release override; baseline stays local', async () => {
  const { installerInvocation } = await import('./acceptance.mjs');
  const inherited = { PATH: '/bin', SOUL37_RELEASE_BASE: 'https://wrong.invalid', SOUL37_BASE_URL: 'https://wrong.invalid' };
  const spec = installerInvocation('candidate', true, '/fixture/install.sh', 'http://127.0.0.1:9', inherited);
  assert.equal(spec.command, 'bash');
  assert.deepEqual(spec.args, ['-o', 'pipefail', '-c', 'curl -fsSL https://37soul.com/install.sh | bash']);
  assert.equal(spec.env.SOUL37_RELEASE_BASE, undefined);
  assert.equal(spec.env.SOUL37_BASE_URL, undefined);
  assert.equal(inherited.SOUL37_RELEASE_BASE, 'https://wrong.invalid');
  for (const [which, publicMode] of [['baseline', true], ['candidate', false]]) {
    const local = installerInvocation(which, publicMode, '/fixture/install.sh', 'http://127.0.0.1:9', inherited);
    assert.deepEqual(local.args, ['/fixture/install.sh']);
    assert.equal(local.env.SOUL37_RELEASE_BASE, `http://127.0.0.1:9/${which}`);
  }
});

test('public metadata rejects wrong version, archive digest and manifest drift', async () => {
  const { validateReleaseMetadata } = await import('./public-release.mjs');
  const { createHash } = await import('node:crypto');
  const archive = Buffer.from('synthetic archive');
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const files = { '37soul-runtime.tgz': archive, '37soul-runtime.tgz.sha256': Buffer.from(`${sha256}  37soul-runtime.tgz\n`), VERSION: Buffer.from('0.14.0\n'), 'release-manifest.json': Buffer.from(JSON.stringify({ version: '0.14.0', sha256, protocol: 'soul-assets/v1' })) };
  assert.deepEqual(validateReleaseMetadata(files, '0.14.0'), { version: '0.14.0', sha256 });
  assert.throws(() => validateReleaseMetadata(files, '0.14.1'));
  assert.throws(() => validateReleaseMetadata({ ...files, '37soul-runtime.tgz': Buffer.from('tampered') }, '0.14.0'));
  assert.throws(() => validateReleaseMetadata({ ...files, 'release-manifest.json': Buffer.from(JSON.stringify({ version: '0.13.4', sha256, protocol: 'soul-assets/v1' })) }, '0.14.0'));
  assert.throws(() => validateReleaseMetadata({ ...files, 'release-manifest.json': Buffer.from(JSON.stringify({ version: '0.14.0', sha256: '0'.repeat(64), protocol: 'soul-assets/v1' })) }, '0.14.0'));
});

test('actual native workflow shell passes optional public flag under system Bash nounset', async t => {
  const { mkdtemp, mkdir, writeFile, readFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const workflow = await readFile(new URL('../../.github/workflows/release-runtime.yml', import.meta.url), 'utf8');
  const section = workflow.slice(workflow.indexOf('        id: acceptance\n'));
  const body = section.match(/        run: \|\n((?:          .*\n)+)/)[1].split('\n').map(line => line.slice(10)).join('\n');
  const dir = await mkdtemp(path.join(tmpdir(), '37soul-workflow-shell-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); await mkdir(bin);
  // Argument recorder only: never execute the native harness or any service.
  const recorder = path.join(bin, 'node');
  await writeFile(recorder, '#!/bin/sh\nprintf "%s\\n" "$@"\n'); await chmod(recorder, 0o700);
  for (const mode of ['false', 'true']) {
    const result = spawnSync('/bin/bash', ['-c', body], { cwd: dir, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PUBLIC_RELEASE: mode }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), ['test/service/acceptance.mjs', 'service-inputs/baseline/release', 'service-inputs/candidate/release', 'service-inputs/install.sh', 'service-evidence', ...(mode === 'true' ? ['--public-release'] : [])]);
  }
});
