import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { host as codex } from '../dist/hosts/codex.js';
import { host as opencode } from '../dist/hosts/opencode.js';
import { host as hermes } from '../dist/hosts/hermes.js';

for (const host of [opencode, hermes]) {
  test(`${host.kind}: installed without runtime evidence waits with setup guidance and separate observation boundaries`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'feedback-host-'));
    try {
      mkdirSync(path.join(home, '.codex'), { recursive: true });
      const result = await host.install.configure({ home, runCommand: async () => { throw new Error('commands forbidden'); } }, '');
      assert.equal(result.report.trusted, false);
      assert.equal(result.report.events_seen, false);
      assert.equal(result.report.extraction_capable, false);
      assert.equal(result.report.injection_capable, false);
      const checks = await host.doctor({ home, config: {}, assetsMode: true });
      const bridgeName = host.kind === 'codex' ? 'codex: SessionStart hook' : `${host.kind}: plugin bridge`;
      const check = checks.find(c => c.name === bridgeName);
      assert.ok(check, 'host setup diagnostic exists');
      assert.equal(check.ok, false);
      assert.equal(check.waiting, true);
      assert.notEqual(check.fatal, true);
      assert.match(check.detail, host.kind === 'codex' ? /load the hook configuration.*same request/i : /restart|new session|reopen/i, 'explain when manual setup takes effect');
      assert.match(check.detail, /approve/i, 'setup requires host-owned approval');
      assert.match(check.detail, /trust.*not inferred|not inferred.*trust/i, 'installation does not establish host trust');
      assert.doesNotMatch(check.detail, /extraction stays off|no model call authorized/i);
      for (const name of [`${host.kind}: hook output`, `${host.kind}: extraction`]) {
        const observation = checks.find(c => c.name === name);
        assert.ok(observation, 'hook output and extraction have independent diagnostics');
        assert.equal(observation.ok, false);
        assert.equal(observation.waiting, true);
        assert.notEqual(observation.fatal, true);
        assert.match(observation.detail, /no matching.*observed/i, 'missing evidence is not a disabled capability');
      }
      if (host.kind === 'codex') assert.match(check.detail, /\/hooks/);
      if (host.kind === 'opencode') assert.match(check.detail, /plugins|plugin/);
      if (host.kind === 'hermes') assert.match(check.detail, /config\.yaml/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

 test('codex: installer exposes a local session bridge without pending hook trust', async () => {
 const home=mkdtempSync(path.join(tmpdir(),'codex-native-guide-'));
 try {mkdirSync(path.join(home,'.codex'),{recursive:true});const result=await codex.install.configure({home,runCommand:async()=>{throw Error('forbidden');}},'');assert.equal(result.hook,false);assert.equal(result.report,undefined);const checks=await codex.doctor({home,config:{},assetsMode:true});const row=checks.find(c=>c.name==='codex: local session bridge');assert.equal(row.ok,true);assert.match(row.detail,/No 37Soul hook approval required/);assert.match(row.detail,/does not prove model adoption/);assert.ok(!checks.some(c=>c.name==='codex: SessionStart hook'));}finally{rmSync(home,{recursive:true,force:true});}
 });
