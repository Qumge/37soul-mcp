import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../dist/cli.js';
import { openStore } from '../dist/local/store.js';

for (const command of [['soul', 'list'], ['sync']]) {
  for (const [label, configured, override, expected] of [
    ['persisted HTTP base and path', 'http://127.0.0.1:3000/site///', undefined, 'http://127.0.0.1:3000/site/hosts/243'],
    ['explicit environment override', 'https://saved.example/app', 'http://localhost:4321/dev/', 'http://localhost:4321/dev/hosts/243'],
    ['default base', undefined, undefined, 'https://37soul.com/hosts/243'],
  ]) {
    test(`${command.join(' ')} displays ${label}`, async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'feedback-cli-'));
      const root = path.join(home, '.37soul');
      const oldHome = process.env.SOUL37_HOME, oldBase = process.env.SOUL37_BASE_URL;
      const oldFetch = globalThis.fetch;
      process.env.SOUL37_HOME = home;
      if (override === undefined) delete process.env.SOUL37_BASE_URL; else process.env.SOUL37_BASE_URL = override;
      globalThis.fetch = async () => { throw new Error('network forbidden in display test'); };
      try {
        mkdirSync(root, { recursive: true });
        if (configured) writeFileSync(path.join(root, 'config.json'), JSON.stringify({ api_base_url: configured, machine_id: 'test', tokens: {} }));
        const store = await openStore(root, 'default');
        try { await store.transact(d => {
          d.souls.s1 = { soul_uid: 's1', legacy_host_id: 243, identity_revision: 1, identity: { name: 'Example' }, state: 'active', public: true };
        }); } finally { await store.close(); }
        let output = '';
        await main([...command, '--profile', 'default'], { stdout: t => { output += t; }, stderr: () => {}, stdin: async () => '' });
        assert.ok(output.includes(`public: ${expected}`), output);
      } finally {
        globalThis.fetch = oldFetch;
        if (oldHome === undefined) delete process.env.SOUL37_HOME; else process.env.SOUL37_HOME = oldHome;
        if (oldBase === undefined) delete process.env.SOUL37_BASE_URL; else process.env.SOUL37_BASE_URL = oldBase;
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
}

test('install --plan names the proxy keys it would persist, never the values', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'plan-proxy-'));
  const keys = ['SOUL37_HOME', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.SOUL37_HOME = home;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    let output = '';
    await main(['install', '--plan'], { stdout: t => { output += t; }, stderr: () => {}, stdin: async () => '' });
    assert.match(output, /would persist proxy: HTTPS_PROXY/);
    assert.ok(!output.includes('127.0.0.1:7890'), 'the proxy value must not be printed');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
