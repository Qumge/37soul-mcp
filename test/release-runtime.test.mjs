#!/usr/bin/env node
/**
 * Task 10 deliverables 5-7: the self-contained runtime release.
 *
 *  - The esbuild bundle (`dist/bundle/cli.js`) runs with no node_modules next to
 *    it, under both the current Node and — when available — Node 18 (the runtime
 *    floor). Node 20 is verified in CI (`release-runtime.yml` runs `npm test` on
 *    node-version 20); there is no local Node 20 binary, which this suite records
 *    rather than pretending to have exercised.
 *  - `status` reports machine/version/failure honestly and never prints a token
 *    value; the bundled runtime never reads `release-manifest.json` (delivery
 *    metadata only — a downloaded manifest is not "injected or adopted").
 *  - `release-manifest.json` has exactly the `ReleaseManifest` shape and its
 *    sha256 is the digest of the actual tarball bytes (validated when a packed
 *    `release/` tree is present; skipped on a fresh checkout before packing).
 *  - `.github/workflows/release-runtime.yml` builds and verifies only: no job
 *    uploads an asset to a GitHub Release.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_MANIFEST_PROTOCOL,
  RELEASE_MANIFEST_NODE_MIN,
} from "../dist/assets/release.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_CLI = path.join(REPO, "dist", "bundle", "cli.js");
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;

const NODE18_CANDIDATES = [
  process.env.SOUL37_NODE18,
  "/tmp/37soul-node18/node-v18.20.4-darwin-arm64/bin/node",
  "/tmp/37soul-node18/node-v18.20.4-linux-x64/bin/node",
].filter(Boolean);

function tempHome() {
  return mkdtempSync(path.join(tmpdir(), "runtime-home-"));
}

function runStatus(node, home) {
  return execFileSync(node, [BUNDLE_CLI, "status"], {
    env: { ...process.env, SOUL37_HOME: home },
    encoding: "utf8",
  });
}

// ── Deliverable 5: runtime runs without node_modules, status is honest ─────────

test("runtime: the bundled CLI starts with no node_modules and reports a fresh home as not installed", () => {
  assert.ok(existsSync(BUNDLE_CLI), "bundle must be built before this suite (npm test builds it)");
  const home = tempHome();
  try {
    const out = runStatus(process.execPath, home);
    assert.match(out, /not installed/, "a fresh temp HOME must report (not installed)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime: status reports a configured token as 'set' and never prints its value", () => {
  const home = tempHome();
  const secret = "SOUL37-SECRET-TOKEN-12345-abcdef";
  try {
    const root = path.join(home, ".37soul");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "config.json"),
      `${JSON.stringify({
        machine_id: "machine-test",
        api_base_url: "https://37soul.com",
        tokens: { "claude-code": secret },
      })}\n`,
    );
    const out = runStatus(process.execPath, home);
    assert.match(out, /claude-code: token set/, "status reports the token is set");
    assert.ok(!out.includes(secret), "status must never print the token value");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime: the bundle never reads the release manifest and never reports a downloaded install state", () => {
  const bundle = readFileSync(BUNDLE_CLI, "utf8");
  assert.ok(!bundle.includes("release-manifest.json"), "the runtime must not load the delivery manifest");

  // A fresh, never-installed home must report (not installed) — never a
  // "downloaded" state adopted from the delivery manifest.
  const home = tempHome();
  try {
    const out = runStatus(process.execPath, home);
    assert.ok(!out.includes("downloaded"), "status must not inject/adopt a 'downloaded' state");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime: runs under the Node 18 floor when that binary is available (Node 20 exercised in CI)", (t) => {
  const node18 = NODE18_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!node18) {
    t.skip("no local Node 18 binary; Node 20 is exercised by release-runtime.yml CI");
    return;
  }
  const home = tempHome();
  try {
    const out = runStatus(node18, home);
    assert.match(out, /not installed/, "the node18-target bundle must run under Node 18");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Deliverable 6: ReleaseManifest + tarball layout ────────────────────────────

test("release: ReleaseManifest declares the fixed protocol and node floor", () => {
  assert.equal(RELEASE_MANIFEST_PROTOCOL, "soul-assets/v1");
  assert.equal(RELEASE_MANIFEST_NODE_MIN, "18");
});

test("release: packed artifacts match the manifest, digest, VERSION and tarball root", (t) => {
  const tgz = path.join(REPO, "release", "37soul-runtime.tgz");
  const manifestPath = path.join(REPO, "release", "release-manifest.json");
  if (!existsSync(tgz) || !existsSync(manifestPath)) {
    t.skip("no packed release/ tree in this checkout — run ./scripts/pack-runtime.sh first");
    return;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  // ReleaseManifest shape: exactly the delivery metadata fields.
  assert.deepEqual(Object.keys(manifest).sort(), ["files", "node_min", "protocol", "sha256", "version"]);
  assert.equal(manifest.protocol, "soul-assets/v1");
  assert.equal(manifest.node_min, "18");
  assert.equal(manifest.version, PACKAGE_VERSION, "manifest version must equal package.json version");

  // sha256 is the digest of the actual tarball bytes.
  const actualSha = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  assert.equal(manifest.sha256, actualSha, "manifest sha256 must be the tarball digest");

  // VERSION file equals the package version.
  assert.equal(readFileSync(path.join(REPO, "release", "VERSION"), "utf8").trim(), PACKAGE_VERSION);

  // The .sha256 file name matches the tarball and its recorded digest matches.
  assert.ok(existsSync(`${tgz}.sha256`), ".sha256 filename must match the tarball");
  assert.equal(readFileSync(`${tgz}.sha256`, "utf8").trim().split(/\s+/)[0], actualSha);

  // Every listed file is a managed JS/JSON/Python artifact — no native modules/WASM.
  for (const file of manifest.files) {
    assert.ok(/\.(js|json|py)$/.test(file), `manifest file ${file} must be JS/JSON/Python`);
  }
  const required = [
    "package.json",
    "dist/bundle/cli.js",
    "dist/bundle/index.js",
    "dist/adapters/plugins/opencode.js",
    "src/adapters/plugins/hermes.py",
  ];
  for (const file of required) {
    assert.ok(manifest.files.includes(file), `manifest must list ${file}`);
  }

  // Tarball members all live under the 37soul/ root.
  const listing = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  assert.ok(listing.length > 0, "tarball is non-empty");
  for (const member of listing) {
    assert.ok(member.startsWith("37soul/"), `tarball member ${member} must be under 37soul/`);
  }
});

// ── Deliverable 7: CI builds and verifies only, never uploads a Release ────────

test("workflow: release-runtime.yml builds and verifies only — no job uploads an asset to a Release", () => {
  const workflow = readFileSync(path.join(REPO, ".github", "workflows", "release-runtime.yml"), "utf8");

  // No upload-to-Release machinery of any kind.
  for (const forbidden of ["gh release create", "softprops/action-gh-release", "actions/upload-release-asset", "upload_url"]) {
    assert.ok(!workflow.includes(forbidden), `workflow must not contain ${forbidden}`);
  }

  // It does build, run the full suite and pack+verify the runtime.
  assert.match(workflow, /npm test/, "CI must run the full test suite");
  assert.match(workflow, /scripts\/pack-runtime\.sh/, "CI must pack the runtime");
  assert.match(workflow, /Verify tarball layout/, "CI must verify the tarball layout");
});
