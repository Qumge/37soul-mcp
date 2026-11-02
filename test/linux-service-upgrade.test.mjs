import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installService, renderSystemdUnit, systemdPath } from '../dist/service.js';

const ok = () => ({ code: 0, stdout: '', stderr: '' });
const argv = action => ['systemctl', '--user', action, ...(action === 'daemon-reload' ? [] : ['37soul-agentd.service'])];
async function fixture(t, previous = true) {
  const home = await mkdtemp(path.join(tmpdir(), '37soul-linux-upgrade-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const spec = { home, nodePath: '/fake/node', scriptPath: '/fake/cli.js', launcherPath: path.join(home, '.37soul/runtime/0.14.0/bin/37soul'), logPath: path.join(home, 'agentd.log'), platform: 'linux' };
  const old = renderSystemdUnit({ ...spec, launcherPath: path.join(home, '.37soul/runtime/0.13.4/bin/37soul') });
  const file = systemdPath(home);
  await mkdir(path.dirname(file), { recursive: true });
  if (previous) await writeFile(file, old);
  return { spec, file, old };
}

test('Linux active upgrade reloads, enables and restarts so the new ExecStart takes effect', async t => {
  const { spec, file, old } = await fixture(t);
  const commands = []; let loaded = old; let active = old;
  const result = await installService(spec, async command => {
    commands.push(command);
    if (command[2] === 'daemon-reload') loaded = await readFile(file, 'utf8');
    if (command[2] === 'restart') active = loaded;
    return ok();
  });
  assert.deepEqual(commands, [argv('daemon-reload'), argv('enable'), argv('restart')]);
  assert.deepEqual(result.commands, commands);
  assert.equal(result.serviceFile, file);
  assert.equal(active, renderSystemdUnit(spec));
});

for (const mode of ['exit', 'throw']) test(`Linux restart ${mode} restores and restarts the previous unit without reporting success`, async t => {
  const { spec, file, old } = await fixture(t);
  const commands = []; const restarted = [];
  await assert.rejects(installService(spec, async command => {
    commands.push(command);
    if (command[2] === 'restart') {
      restarted.push(await readFile(file, 'utf8'));
      if (restarted.length === 1) {
        if (mode === 'throw') throw new Error('restart transport failure');
        return { code: 1, stdout: '', stderr: 'new binary cannot start' };
      }
    }
    return ok();
  }), mode === 'throw' ? /restart.*restart transport failure/ : /restart.*new binary cannot start/);
  assert.deepEqual(commands, [argv('daemon-reload'), argv('enable'), argv('restart'), argv('daemon-reload'), argv('restart')]);
  assert.deepEqual(restarted, [renderSystemdUnit(spec), old]);
  assert.equal(await readFile(file, 'utf8'), old);
});

for (const failed of ['daemon-reload', 'enable']) test(`Linux ${failed} failure preserves old unit and does not restart the running job`, async t => {
  const { spec, file, old } = await fixture(t);
  const commands = []; let rejected = false;
  await assert.rejects(installService(spec, async command => {
    commands.push(command);
    if (command[2] === failed && !rejected) { rejected = true; return { code: 1, stdout: '', stderr: 'permission denied' }; }
    return ok();
  }), new RegExp(`${failed}.*permission denied`));
  assert.equal(await readFile(file, 'utf8'), old);
  assert.equal(commands.filter(c => c[2] === 'restart').length, 0);
  assert.deepEqual(commands.at(-1), argv('daemon-reload'));
});

test('Linux rollback failure preserves both original and recovery diagnostics', async t => {
  const { spec, file, old } = await fixture(t); let restarts = 0;
  await assert.rejects(installService(spec, async command => {
    if (command[2] === 'restart') return { code: 1, stdout: '', stderr: ++restarts === 1 ? 'new launch failed' : 'old launch failed' };
    return ok();
  }), /restart.*new launch failed.*previous service restore failed.*old launch failed/);
  assert.equal(await readFile(file, 'utf8'), old);
});

test('Linux fresh installation failure removes the staged unit and reloads without retrying restart', async t => {
  const { spec, file } = await fixture(t, false); const commands = [];
  await assert.rejects(installService(spec, async command => {
    commands.push(command);
    return command[2] === 'restart' ? { code: 1, stdout: '', stderr: 'cannot start' } : ok();
  }), /restart.*cannot start/);
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });
  assert.deepEqual(commands, [argv('daemon-reload'), argv('enable'), argv('restart'), ['systemctl', '--user', 'disable', '--now', '37soul-agentd.service'], argv('daemon-reload')]);
});

test('Linux new service restart failure disables and stops it before removing its enabled unit', async t => {
  const { spec, file } = await fixture(t, false); const commands = [];
  let enabled = false; let possiblyRunning = false;
  await assert.rejects(installService(spec, async command => {
    commands.push(command);
    if (command[2] === 'enable') enabled = true;
    if (command[2] === 'restart') {
      possiblyRunning = true;
      return { code: 1, stdout: '', stderr: 'partial startup failed' };
    }
    if (command[2] === 'disable') {
      assert.deepEqual(command, ['systemctl', '--user', 'disable', '--now', '37soul-agentd.service']);
      assert.equal(await readFile(file, 'utf8'), renderSystemdUnit(spec));
      enabled = false; possiblyRunning = false;
    }
    return ok();
  }), /restart.*partial startup failed/);
  assert.equal(enabled, false);
  assert.equal(possiblyRunning, false);
  assert.deepEqual(commands, [argv('daemon-reload'), argv('enable'), argv('restart'), ['systemctl', '--user', 'disable', '--now', '37soul-agentd.service'], argv('daemon-reload')]);
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });
});
