import test from "node:test";
import assert from "node:assert/strict";

import { captureProxyEnvironment, renderPlist, renderSystemdUnit } from "../dist/service.js";

const spec = (extra = {}) => ({
  home: "/home/u",
  nodePath: "/node",
  scriptPath: "/cli.js",
  logPath: "/tmp/agentd.log",
  executionPath: "/usr/bin",
  ...extra,
});

test("service proxy: captures the standard proxy variables from the install shell", () => {
  const captured = captureProxyEnvironment({
    https_proxy: "http://127.0.0.1:7890",
    ALL_PROXY: "socks5://127.0.0.1:7890",
    NO_PROXY: "localhost,127.0.0.1",
    http_proxy: "",
    PATH: "/usr/bin",
    HOME: "/home/u",
  });

  assert.deepEqual(captured.environment, {
    HTTPS_PROXY: "http://127.0.0.1:7890",
    ALL_PROXY: "socks5://127.0.0.1:7890",
    NO_PROXY: "localhost,127.0.0.1",
  });
  assert.deepEqual(captured.skipped, []);
});

test("service proxy: uppercase wins and no other environment variable is serialized", () => {
  const captured = captureProxyEnvironment({
    HTTPS_PROXY: "http://upper:1",
    https_proxy: "http://lower:2",
    SECRET_TOKEN: "must-not-be-persisted",
  });

  assert.deepEqual(captured.environment, { HTTPS_PROXY: "http://upper:1" });
});

test("service proxy: a proxy URL carrying credentials is skipped, never written", () => {
  const captured = captureProxyEnvironment({
    HTTP_PROXY: "http://user:secret@proxy.example:8080",
    HTTPS_PROXY: "http://user:secret@proxy.example:8080",
  });

  assert.deepEqual(captured.environment, {});
  assert.deepEqual(captured.skipped, ["HTTP_PROXY", "HTTPS_PROXY"]);
});

test("service proxy: the plist renders proxy keys with XML escaping", () => {
  const plist = renderPlist(spec({ proxyEnvironment: { HTTPS_PROXY: "http://127.0.0.1:7890?a=1&b=2" } }));

  assert.ok(plist.includes("<key>HTTPS_PROXY</key>"));
  assert.ok(plist.includes("<string>http://127.0.0.1:7890?a=1&amp;b=2</string>"));
  assert.ok(plist.includes("<key>PATH</key>"), "PATH keeps its place in the same environment block");
});

test("service proxy: systemd renders one Environment line per variable", () => {
  const unit = renderSystemdUnit(
    spec({ proxyEnvironment: { HTTP_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost" } }),
  );

  assert.ok(unit.includes('Environment="HTTP_PROXY=http://127.0.0.1:7890"'));
  assert.ok(unit.includes('Environment="NO_PROXY=localhost"'));
  assert.ok(unit.includes('Environment="PATH=/usr/bin"'));
});

test("service proxy: with nothing captured the service files are unchanged", () => {
  assert.ok(!renderPlist(spec()).includes("PROXY"));
  assert.ok(!renderSystemdUnit(spec()).includes("PROXY"));
});
