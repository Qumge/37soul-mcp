import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { host as codex } from '../dist/hosts/codex.js';
import { host as opencode } from '../dist/hosts/opencode.js';
import { host as hermes } from '../dist/hosts/hermes.js';

for (const host of [codex, opencode, hermes]) {
  test(`${host.kind}: installed but unverified doctor gives a manual next step and its boundary`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'feedback-host-'));
    try {
      mkdirSync(path.join(home, '.codex'), { recursive: true });
      const result = await host.install.configure({ home, runCommand: async () => { throw new Error('commands forbidden'); } }, '');
      assert.equal(result.report.trusted, false);
      assert.equal(result.report.events_seen, false);
      assert.equal(result.report.extraction_capable, false);
      assert.equal(result.report.injection_capable, false);
      const checks = await host.doctor({ home, config: {}, assetsMode: true });
      const check = checks.find(c => /hook|plugin bridge/.test(c.name));
      assert.equal(check.ok, false);
      assert.match(check.detail, /restart|new session|reopen/i, 'explain when manual setup takes effect');
      assert.match(check.detail, /load|execut|event/i, 'explain what approval enables');
      assert.match(check.detail, /extract.*(?:off|unverified|not verified)|(?:off|unverified|not verified).*extract/i);
      assert.match(check.detail, /inject.*(?:unverified|not verified)|(?:unverified|not verified).*inject/i);
      if (host.kind === 'codex') assert.match(check.detail, /\/hooks/);
      if (host.kind === 'opencode') assert.match(check.detail, /plugins|plugin/);
      if (host.kind === 'hermes') assert.match(check.detail, /config\.yaml/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
