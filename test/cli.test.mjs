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
import { ownerContextInput } from "../dist/sync/client.js";
import { selectContext } from "../dist/assets/context.js";

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

// R2: local creation is not cloud authorization; the real CLI entry must produce
// a legal register operation only after an explicit Soul/category choice.
test("R2: soul create stays local and soul authorize enqueues explicit consent", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  await seed(root, "p1", "dev-1");
  const previousHome = process.env.SOUL37_HOME;
  process.env.SOUL37_HOME = home;
  try {
    const created = makeIo();
    const code = await main(["soul", "create", "--profile", "p1", "--name", "Growth"], created.io);
    assert.equal(code, 0, created.out.stderr);
    const uid = /created soul ([0-9a-f-]{36})/.exec(created.out.stdout)?.[1];
    assert.ok(uid, "the CLI printed the local Soul uid");

    let snap = await readSnap(root, "p1");
    assert.equal(Object.keys(snap.outbox).length, 0, "local creation enqueues no cloud registration");

    const authorized = makeIo();
    const code2 = await main(
      ["soul", "authorize", uid, "--profile", "p1", "--categories", "identity,relationship"],
      authorized.io,
    );
    assert.equal(code2, 0, authorized.out.stderr);
    snap = await readSnap(root, "p1");
    const op = Object.values(snap.outbox).find((entry) => entry.operation_kind === "register_soul");
    assert.ok(op, "authorization enqueued a register operation");
    assert.deepEqual(op.request.consent_categories.sort(), ["identity", "relationship"]);
    assert.deepEqual(snap.souls[uid].local_identity, { name: "Growth", description: "", character: "", greeting: "" });
  } finally {
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});


// F3: an explicit local edit must change what injection actually renders, with a
// consistent revision (not a local_identity fallback stuck on the original).
test("F3: local soul create -> edit -> injection uses the edited identity", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  await seed(root, "p1", "dev-1");
  const previousHome = process.env.SOUL37_HOME;
  process.env.SOUL37_HOME = home;
  try {
    const created = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "Growth", "--character", "ORIGINAL_CANARY"], created.io), 0);
    const uid = /created soul ([0-9a-f-]{36})/.exec(created.out.stdout)?.[1];
    assert.ok(uid);
    const edited = makeIo();
    assert.equal(await main(["soul", "edit", uid, "--profile", "p1", "--character", "UPDATED_CANARY"], edited.io), 0);
    const bound = makeIo();
    assert.equal(await main(["bind", "--profile", "p1", "--soul", uid, "--session", "ns-1"], bound.io), 0);

    const store = await openStore(root, "p1");
    const snap = await store.read();
    await store.close();
    const soul = snap.souls[uid];
    assert.equal(soul.identity.character, "UPDATED_CANARY");
    assert.equal(soul.local_identity.character, "UPDATED_CANARY", "the local original is updated too");
    assert.equal(soul.identity_revision, 2);
    assert.equal(soul.local_identity_revision, 2, "the version is not reset to 1");
    const binding = Object.values(snap.bindings)[0];
    const bundle = selectContext(ownerContextInput(snap, uid, binding, "task", 4096));
    assert.match(bundle.rendered_text, /UPDATED_CANARY/);
    assert.doesNotMatch(bundle.rendered_text, /ORIGINAL_CANARY/);

    const exported = makeIo();
    assert.equal(await main(["soul", "export", "--profile", "p1"], exported.io), 0);
    const exportBody = JSON.parse(exported.out.stdout);
    assert.equal(exportBody.souls[uid].identity.character, "UPDATED_CANARY");
    assert.equal(exportBody.souls[uid].identity_revision, 2);
  } finally {
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// F1: the real create/bind entry must not send an unauthorized Soul's binding,
// and must still sync an explicitly authorized second Soul.
test("P2: real CLI refuses an unconfirmed same-session switch, then syncs B from a new session", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  await seed(root, "p1", "dev-1", (d) => {
    d.owner_id = "owner-1";
    d.cloud_device_uid = "cdu-1";
  });
  writeFileSync(path.join(root, "accounts.json"), `${JSON.stringify({
    "owner-1": { profile_id: "p1", default_soul_uid: null, soul_sync_mode: "assets_only" },
  })}\n`, { mode: 0o600 });
  writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    api_base_url: "https://fake.test", machine_id: "m1", tokens: {},
    credentials: [{ token: "token-1", owner_id: "owner-1", cloud_device_uid: "cdu-1", runtime_kind: "hermes", profile_id: "p1", obtained_at: "x" }],
  })}\n`, { mode: 0o600 });

  const previousHome = process.env.SOUL37_HOME;
  const previousFetch = globalThis.fetch;
  process.env.SOUL37_HOME = home;
  const bindings = new Map();
  const bindingRequests = [];
  const response = (status, body) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: () => null },
    body: { cancel: async () => {} },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (init.method === "POST" && pathname.endsWith("/souls")) {
      return response(201, {
        protocol: "soul-assets/v1",
        soul: { soul_uid: body.soul_uid, legacy_host_id: 88, identity_revision: 1, identity: body.identity, state: "active" },
        consent: { cloud_device_uid: "cdu-1", soul_uid: body.soul_uid, revision: 1, categories: body.consent_categories, enabled: true },
      });
    }
    if (init.method === "PUT" && pathname.includes("/bindings/")) {
      const bindingUid = pathname.split("/").pop();
      const existing = bindings.get(bindingUid);
      bindingRequests.push({ bindingUid, body: { ...body } });
      if (!existing) {
        if (body.base_revision !== 0) {
          return response(409, { error: { code: "revision_conflict", current_revision: 0 } });
        }
        const created = { ...body, binding_uid: bindingUid, revision: 1 };
        bindings.set(bindingUid, created);
        return response(200, { protocol: "soul-assets/v1", binding: created });
      }
      if (existing.revision !== body.base_revision) {
        return response(409, { error: { code: "revision_conflict", current_revision: existing.revision } });
      }
      const updated = { ...existing, ...body, revision: existing.revision + 1 };
      bindings.set(bindingUid, updated);
      return response(200, { protocol: "soul-assets/v1", binding: updated });
    }
    return response(200, { protocol: "soul-assets/v1", events: [], next_cursor: null, has_more: false });
  };

  try {
    const a = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A"], a.io), 0);
    const aUid = /created soul ([0-9a-f-]{36})/.exec(a.out.stdout)?.[1];
    assert.equal(await main(["bind", "--profile", "p1", "--soul", aUid, "--session", "ns-shared", "--agent", "hermes"], makeIo().io), 0);

    const b = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "B"], b.io), 0);
    const bUid = /created soul ([0-9a-f-]{36})/.exec(b.out.stdout)?.[1];
    assert.equal(await main(["soul", "authorize", bUid, "--profile", "p1", "--categories", "identity"], makeIo().io), 0);

    const refused = makeIo();
    assert.equal(
      await main(["bind", "--profile", "p1", "--soul", bUid, "--session", "ns-shared", "--agent", "hermes"], refused.io),
      1,
    );
    assert.match(refused.out.stderr, /start a new session/);

    const beforeSync = await readSnap(root, "p1");
    assert.equal(Object.values(beforeSync.bindings)[0].soul_uid, aUid, "A stays the local binding");
    assert.ok(
      !Object.values(beforeSync.outbox).some((op) => op.operation_kind === "binding" && op.request.soul_uid === bUid),
      "B is not queued with an invalid base revision",
    );

    // Follow the prompt: a new native session binds B at cloud base 0.
    assert.equal(await main(["bind", "--profile", "p1", "--soul", bUid, "--session", "ns-new", "--agent", "hermes"], makeIo().io), 0);
    const sync = makeIo();
    assert.equal(await main(["sync", "--profile", "p1"], sync.io), 0, sync.out.stderr);
    assert.equal(bindings.size, 1);
    assert.ok(bindingRequests.some((request) => request.body.base_revision === 0 && request.body.soul_uid === bUid));

    const afterSync = await readSnap(root, "p1");
    assert.ok(afterSync.souls[aUid], "A remains local");
    assert.ok(
      Object.values(afterSync.outbox).some((op) => op.operation_kind === "binding" && op.request.soul_uid === aUid),
      "A's unsent binding is retained locally",
    );
    assert.ok(
      !Object.values(afterSync.outbox).some((op) => op.operation_kind === "binding" && op.request.soul_uid === bUid),
      "B's binding was accepted",
    );
    assert.ok(
      !Object.values(afterSync.quarantine).some((entry) => entry.reason === "revision_conflict"),
      "B is not permanently quarantined",
    );

    const second = makeIo();
    assert.equal(await main(["sync", "--profile", "p1"], second.io), 0, second.out.stderr);
    const final = await readSnap(root, "p1");
    assert.ok(!Object.values(final.quarantine).some((entry) => entry.operation.request.soul_uid === bUid));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("F1: real CLI create/bind keeps an unauthorized Soul local and syncs the authorized one", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  await seed(root, "p1", "dev-1", (d) => {
    d.owner_id = "owner-1";
    d.cloud_device_uid = "cdu-1";
  });
  writeFileSync(path.join(root, "accounts.json"), `${JSON.stringify({
    "owner-1": { profile_id: "p1", default_soul_uid: null, soul_sync_mode: "assets_only" },
  })}\n`, { mode: 0o600 });
  writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    api_base_url: "https://fake.test", machine_id: "m1", tokens: {},
    credentials: [{ token: "token-1", owner_id: "owner-1", cloud_device_uid: "cdu-1", runtime_kind: "hermes", profile_id: "p1", obtained_at: "x" }],
  })}\n`, { mode: 0o600 });

  const previousHome = process.env.SOUL37_HOME;
  const previousFetch = globalThis.fetch;
  process.env.SOUL37_HOME = home;
  const bindingBodies = [];
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init.method ?? "GET"} ${pathname}`);
    if (init.method === "POST" && pathname.endsWith("/souls")) {
      const body = JSON.parse(String(init.body));
      return {
        status: 201, ok: true, headers: { get: () => null }, json: async () => ({
          protocol: "soul-assets/v1",
          soul: { soul_uid: body.soul_uid, legacy_host_id: 77, identity_revision: 1, identity: body.identity, state: "active" },
          consent: { cloud_device_uid: "cdu-1", soul_uid: body.soul_uid, revision: 1, categories: body.consent_categories, enabled: true },
        }),
      };
    }
    if (init.method === "PUT" && pathname.includes("/bindings/")) {
      const body = JSON.parse(String(init.body));
      bindingBodies.push(body);
      return {
        status: 200, ok: true, headers: { get: () => null }, json: async () => ({
          protocol: "soul-assets/v1",
          binding: { ...body, binding_uid: pathname.split("/").pop(), revision: 1 },
        }),
      };
    }
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ protocol: "soul-assets/v1", events: [], next_cursor: null, has_more: false }) };
  };

  try {
    const a = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A"], a.io), 0);
    const aUid = /created soul ([0-9a-f-]{36})/.exec(a.out.stdout)?.[1];
    assert.equal(await main(["bind", "--profile", "p1", "--soul", aUid, "--session", "ns-A", "--agent", "hermes"], makeIo().io), 0);
    const b = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "B"], b.io), 0);
    const bUid = /created soul ([0-9a-f-]{36})/.exec(b.out.stdout)?.[1];
    assert.equal(await main(["soul", "authorize", bUid, "--profile", "p1", "--categories", "identity,relationship"], makeIo().io), 0);
    assert.equal(await main(["bind", "--profile", "p1", "--soul", bUid, "--session", "ns-B", "--agent", "hermes"], makeIo().io), 0);

    const sync = makeIo();
    assert.equal(await main(["sync", "--profile", "p1"], sync.io), 0, sync.out.stderr);
    assert.ok(bindingBodies.some((body) => body.soul_uid === bUid), "the authorized binding was sent");
    assert.ok(!bindingBodies.some((body) => body.soul_uid === aUid), "the unauthorized binding never left the machine");
    assert.ok(calls.some((call) => call.startsWith("GET")), "Pull still ran");

    const snap = await readSnap(root, "p1");
    assert.ok(Object.values(snap.outbox).some((op) => op.operation_kind === "binding" && op.request.soul_uid === aUid), "A's binding history stays local");
    assert.ok(!Object.values(snap.outbox).some((op) => op.operation_kind === "binding" && op.request.soul_uid === bUid), "B's binding was accepted");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
