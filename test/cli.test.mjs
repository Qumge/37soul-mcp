#!/usr/bin/env node
/**
 * Task 5 fix round: the owner write commands (`soul review` / `soul delete`) are
 * interactive-CLI-only. They refuse to run when stdin is not a TTY, never appear as
 * MCP tools, and drive the single-writer path for the happy cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { main, agentdExtractAdapters } from "../dist/cli.js";
import { openStore } from "../dist/local/store.js";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "cli-"));
}

function setTty(value) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

function makeIo() {
  const out = { stdout: "", stderr: "" };
  return {
    io: {
      stdout: (t) => { out.stdout += t; },
      stderr: (t) => { out.stderr += t; },
      stdin: async () => "",
    },
    out,
  };
}

async function seed(root, profileId, deviceId, change) {
  mkdirSync(path.join(root, "profiles", profileId), { recursive: true });
  writeFileSync(
    path.join(root, "profiles", profileId, "device.json"),
    `${JSON.stringify({ device_id: deviceId })}\n`,
    { mode: 0o600 },
  );
  const store = await openStore(root, profileId);
  await store.transact(change ?? (() => {}));
  await store.close();
}

async function readSnap(root, profileId = "p1") {
  const store = await openStore(root, profileId);
  try {
    return await store.read();
  } finally {
    await store.close();
  }
}

const SOUL = "10000000-0000-4000-8000-000000000001";

function asset(uid, state) {
  return {
    asset_uid: uid,
    soul_uid: SOUL,
    kind: "relationship",
    trait: "preference",
    content: "a fact",
    applicability: "",
    tags: [],
    evidence: "explicit_user_statement",
    verification: "unverified",
    sensitivity: "normal",
    state,
    revision: 1,
    supersedes_uid: null,
    pinned: false,
    source: { runtime_kind: "hermes", session_ref: "30000000-0000-4000-8000-000000000001", event_ref: "e1", occurred_at: "2026-10-20T04:00:00Z" },
    sync_state: "synced",
    cloud_revision: 1,
  };
}

test("cli: soul review/delete refuse without a TTY", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  process.env.SOUL37_HOME = home;
  setTty(false);
  await seed(root, "p1", "dev-1", (d) => {
    d.owner_id = "123";
    d.cloud_device_uid = "50000000-0000-4000-8000-000000000001";
    d.assets["c1"] = asset("c1", "candidate");
  });

  const { io: io1, out: out1 } = makeIo();
  const code1 = await main(["soul", "review", "c1", "--approve", "--profile", "p1"], io1);
  assert.equal(code1, 2, "review refuses without a TTY");
  assert.match(out1.stderr, /not a TTY/i, "review prints a clear non-TTY refusal");

  const { io: io2, out: out2 } = makeIo();
  const code2 = await main(["soul", "delete", "c1", "--profile", "p1"], io2);
  assert.equal(code2, 2, "delete refuses without a TTY");
  assert.match(out2.stderr, /not a TTY/i, "delete prints a clear non-TTY refusal");

  const snap = await readSnap(root);
  assert.equal(snap.assets["c1"].state, "candidate", "a refused command leaves the asset untouched");

  rmSync(home, { recursive: true, force: true });
  delete process.env.SOUL37_HOME;
});

test("cli: soul review/delete happy path with a TTY", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  process.env.SOUL37_HOME = home;
  setTty(true);
  await seed(root, "p1", "dev-1", (d) => {
    d.owner_id = "123";
    d.cloud_device_uid = "50000000-0000-4000-8000-000000000001";
    d.assets["c1"] = asset("c1", "candidate");
    d.assets["a2"] = asset("a2", "active");
  });

  const { io: io1, out: out1 } = makeIo();
  const code1 = await main(["soul", "review", "c1", "--approve", "--profile", "p1"], io1);
  assert.equal(code1, 0, "review approve succeeds on a TTY");
  assert.match(out1.stdout, /approved/, "reports the approval");

  let snap = await readSnap(root);
  assert.equal(snap.assets["c1"].state, "active", "the candidate was approved");

  const { io: io2, out: out2 } = makeIo();
  const code2 = await main(["soul", "delete", "a2", "--profile", "p1"], io2);
  assert.equal(code2, 0, "delete succeeds on a TTY");
  assert.match(out2.stdout, /deleted/, "reports the deletion");

  snap = await readSnap(root);
  assert.equal(snap.assets["a2"].state, "deleted", "the asset was deleted");

  // approve-of-invalid still surfaces the writer error code.
  const { io: io3, out: out3 } = makeIo();
  const code3 = await main(["soul", "review", "a2", "--approve", "--profile", "p1"], io3);
  assert.equal(code3, 1, "approving a non-candidate fails");
  assert.match(out3.stderr, /invalid_state_transition/, "the writer error code is surfaced");

  rmSync(home, { recursive: true, force: true });
  delete process.env.SOUL37_HOME;
});

test("cli: agentdExtractAdapters gates the four runtime adapters on assets mode", () => {
  const logger = { info: () => {}, error: () => {} };
  const root = "/tmp/37soul-adapters-root";

  // Assets mode passes the four real adapters (whose readSource resolves event refs
  // through the local path-pointer index); legacy mode passes nothing.
  const assets = agentdExtractAdapters("/home/x", true, logger, root);
  assert.ok(assets, "assets mode returns adapters, not undefined");
  assert.deepEqual(Object.keys(assets).sort(), ["claude-code", "codex", "hermes", "opencode"]);

  const legacy = agentdExtractAdapters("/home/x", false, logger, root);
  assert.equal(legacy, undefined, "legacy mode keeps its transcript-upload path and gets no extraction adapters");
});
