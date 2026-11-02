#!/usr/bin/env node
// Real service integration: intentionally refuses local and self-hosted execution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, access, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

export function requireHostedRunner(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'requires hosted disposable GitHub VM');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'requires hosted disposable GitHub VM');
}
export function assertManagerAbsent(state, platform) {
  if (state === null) return;
  assert.notEqual(platform, 'darwin', 'runner must have no loaded launchd job');
  assert.doesNotMatch(state, /^ActiveState=active$/m, 'runner must have no active service');
  assert.equal(Number(state.match(/^MainPID=(\d+)$/m)?.[1] ?? 0), 0, 'runner must have no service PID');
}
export function validateHealth(reply, pid, runtime) {
  assert.equal(reply.ok, true);
  assert.equal(reply.result?.agentd, true);
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(reply.result.writer_pid, pid);
  assert.equal(reply.result.entrypoint, path.join(runtime, 'dist/cli.js'));
  return pid;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(command, args = [], options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
async function absent(file) { try { await access(file); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } }
async function health(root) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path.join(root, 'ipc/writer.sock'));
    let text = '';
    const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('IPC health timeout')), 1500);
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify({ request_uid: randomUUID(), profile_id: 'default', command: 'health', payload: {} }) + '\n'));
    socket.on('data', chunk => {
      text += chunk;
      if (text.length > 65536) return finish(new Error('IPC response too large'));
      if (text.includes('\n')) { try { finish(null, JSON.parse(text.split('\n')[0])); } catch (e) { finish(e); } }
    });
  });
}
async function eventually(check) {
  let error;
  for (let n = 0; n < 40; n++) { try { return await check(); } catch (e) { error = e; await delay(500); } }
  throw error;
}

async function main() {
  requireHostedRunner(process.env);
  assert.ok(['darwin', 'linux'].includes(process.platform));
  assert.equal(process.env.SOUL37_HOME, undefined, 'must use default HOME');
  const home = await realpath(process.env.HOME);
  const root = path.join(home, '.37soul');
  const cli = path.join(home, '.local/bin/37soul');
  const uid = process.getuid();
  const target = `gui/${uid}/com.37soul.agentd`;
  const unit = '37soul-agentd.service';
  const mac = process.platform === 'darwin';
  const serviceFile = mac ? path.join(home, 'Library/LaunchAgents/com.37soul.agentd.plist') : path.join(home, '.config/systemd/user', unit);
  const inspect = () => mac ? run('launchctl', ['print', target]) : run('systemctl', ['--user', 'show', unit, '--property=MainPID', '--property=ActiveState', '--property=ExecStart']);
  const pid = () => {
    const state = inspect();
    if (!mac) assert.match(state, /^ActiveState=active$/m);
    return Number(state.match(mac ? /^\s*pid = (\d+)$/m : /^MainPID=(\d+)$/m)?.[1]);
  };
  if (mac) run('launchctl', ['print', `gui/${uid}`]); // unavailable GUI is FAIL, never skip/mock
  else run('systemctl', ['--user', 'show-environment']);
  assert.ok(await absent(root), 'runner must have no pre-existing runtime/data');
  assert.ok(await absent(cli), 'runner must have no pre-existing launcher');
  assert.ok(await absent(serviceFile), 'runner must have no pre-existing service file');
  let initialState = null;
  try { initialState = inspect(); } catch {}
  assertManagerAbsent(initialState, process.platform);

  const [baseline, candidate, installer, evidence = 'service-evidence'] = process.argv.slice(2).map(p => path.resolve(p));
  assert.ok(baseline && candidate && installer, 'usage: acceptance.mjs BASE_RELEASE CANDIDATE_RELEASE INSTALL_SH EVIDENCE');
  await mkdir(evidence, { recursive: true });
  const versions = await Promise.all([baseline, candidate].map(async dir => (await readFile(path.join(dir, 'VERSION'), 'utf8')).trim()));
  assert.notEqual(versions[0], versions[1], 'upgrade must cross versions');
  const server = createServer(async (req, res) => {
    const match = req.url?.match(/^\/(baseline|candidate)\/(37soul-runtime\.tgz(?:\.sha256)?)$/);
    if (!match) { res.writeHead(404).end(); return; }
    try { res.end(await readFile(path.join(match[1] === 'baseline' ? baseline : candidate, match[2]))); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const records = [];
  let owned = false;
  // Empty detection/session directories only. No host executable or model call.
  await mkdir(path.join(home, '.claude/projects'), { recursive: true });
  const install = async (which, stage) => {
    owned = true;
    // Async subprocess: the local HTTP server must keep servicing downloads.
    const { spawn } = await import('node:child_process');
    await new Promise((resolve, reject) => {
      const child = spawn('bash', [installer], { env: { ...process.env, SOUL37_RELEASE_BASE: `${base}/${which}`, SOUL37_BASE_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      child.on('error', reject);
      child.on('close', async code => {
        clearTimeout(timer);
        await writeFile(path.join(evidence, `${stage}-installer.log`), output);
        code === 0 ? resolve() : reject(new Error(`${stage}: installer exit ${code}; see artifact log`));
      });
    });
  };
  const check = async (version, stage, previous) => {
    const runtime = path.join(root, 'runtime', version);
    const archive = path.join(version === versions[0] ? baseline : candidate, '37soul-runtime.tgz');
    const expectedBundle = run('tar', ['-xOzf', archive, '37soul/dist/bundle/cli.js'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const current = await eventually(async () => {
      const currentPid = pid();
      validateHealth(await health(root), currentPid, runtime);
      if (previous) { assert.notEqual(currentPid, previous); assert.throws(() => process.kill(previous, 0)); }
      assert.match(inspect(), new RegExp(runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(JSON.parse(await readFile(path.join(runtime, 'package.json'))).version, version);
      assert.equal(hash(await readFile(path.join(runtime, 'dist/cli.js'))), hash(expectedBundle), 'installed bytes match downloaded release');
      await delay(1000);
      assert.equal(pid(), currentPid, 'service remains stable');
      validateHealth(await health(root), currentPid, runtime);
      return currentPid;
    });
    await writeFile(path.join(evidence, `${stage}-service.txt`), inspect());
    try { await writeFile(path.join(evidence, `${stage}-agentd.log`), await readFile(path.join(root, 'agentd.log'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    records.push({ stage, version, pid: current, entrypoint: path.join(runtime, 'dist/cli.js') });
    console.log(JSON.stringify(records.at(-1)));
    return current;
  };
  let retained;
  const preserve = async () => { for (const [file, bytes] of retained) assert.deepEqual(await readFile(path.join(root, file)), bytes, `${file} preserved`); };
  try {
    await install('candidate', '01-fresh');
    let previous = await check(versions[1], '01-fresh');
    // Snapshot actual profile files as well as archive/queue sentinels.
    const { readdir } = await import('node:fs/promises');
    retained = [];
    async function snapshot(dir) {
      for (const item of await readdir(path.join(root, dir), { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await snapshot(file);
        else retained.push([file, await readFile(path.join(root, file))]);
      }
    }
    await snapshot('profiles');
    assert.ok(retained.length, 'real anonymous profile must exist');
    for (const dir of ['spool', 'queue']) {
      await mkdir(path.join(root, dir), { recursive: true });
      const bytes = Buffer.from('synthetic acceptance user data\n');
      await writeFile(path.join(root, dir, 'acceptance.txt'), bytes); retained.push([`${dir}/acceptance.txt`, bytes]);
    }
    await install('candidate', '02-repeat');
    previous = await check(versions[1], '02-repeat', previous); await preserve();
    await writeFile(path.join(evidence, '02c-uninstall.log'), run(cli, ['uninstall']));
    await eventually(async () => { assert.throws(() => process.kill(previous, 0)); });
    await preserve();
    await install('baseline', '02b-baseline');
    previous = await check(versions[0], '02b-baseline'); await preserve();
    await install('candidate', '03-upgrade');
    previous = await check(versions[1], '03-upgrade', previous); await preserve();
    if (mac) run('launchctl', ['kickstart', '-k', target]);
    else run('systemctl', ['--user', 'restart', unit]);
    previous = await check(versions[1], '04-restart', previous); await preserve();
    await writeFile(path.join(evidence, '05-uninstall.log'), run(cli, ['uninstall']));
    await eventually(async () => {
      assert.throws(() => process.kill(previous, 0));
      if (mac) assert.throws(inspect);
      else {
        assert.equal(Number(inspect().match(/^MainPID=(\d+)$/m)?.[1] ?? 0), 0);
        let enabled;
        try { enabled = run('systemctl', ['--user', 'is-enabled', unit]).trim(); } catch (e) { enabled = String(e.stdout).trim(); }
        assert.notEqual(enabled, 'enabled');
      }
    });
    await preserve();
    for (const file of [cli, serviceFile, path.join(root, 'runtime'), path.join(root, 'ipc/writer.sock')]) assert.ok(await absent(file), `${file} removed`);
    records.push({ stage: '05-uninstall', preservedFiles: retained.map(([file]) => file) });
    await writeFile(path.join(evidence, 'PASS.json'), JSON.stringify({ platform: process.platform, candidateTarballSha256: createHash('sha256').update(await readFile(path.join(candidate, '37soul-runtime.tgz'))).digest('hex'), records }, null, 2));
    console.log('PASS: native service lifecycle; candidate tarball recorded in PASS.json');
    owned = false;
  } finally {
    await writeFile(path.join(evidence, 'observations.json'), JSON.stringify(records, null, 2));
    if (owned) { try { run(cli, ['uninstall']); } catch {} }
    await new Promise(resolve => server.close(resolve));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
