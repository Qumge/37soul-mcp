#!/usr/bin/env node
/**
 * Task 5 fix round: the owner write commands (`soul review` / `soul delete`) are
 * interactive-CLI-only. They refuse to run when stdin is not a TTY, never appear as
 * MCP tools, and drive the single-writer path for the happy cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { main, agentdExtractAdapters } from "../dist/cli.js";
import { openStore } from "../dist/local/store.js";
import { startWriter } from "../dist/local/writer.js";
import { configureSyncHttp, ownerContextInput } from "../dist/sync/client.js";
import { resolveBinding } from "../dist/local/bindings.js";
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
const PROFILE_ARGS = ["--sex", "female", "--age", "24", "--character", "这是一个完整的人设描述，包含性格、表达方式和长期相处边界，用于通过至少五十个字符的创建质量门槛，并保留完整细节。"];

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
test("profile: local create requires name/sex/age and a 50-character character", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  await seed(root, "p1", "dev-1");
  const previousHome = process.env.SOUL37_HOME;
  process.env.SOUL37_HOME = home;
  try {
    const missing = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1"], missing.io), 2);
    assert.match(missing.out.stderr, /name.*sex.*age.*character/);
    const young = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A", "--sex", "female", "--age", "15", "--character", "这是一个足够长的人设描述，包含性格、表达方式和长期边界，用于验证年龄两端。"] , young.io), 2);
    assert.match(young.out.stderr, /age/);
    const short = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A", "--sex", "female", "--age", "24", "--character", "short"], short.io), 2);
    assert.match(short.out.stderr, /character/);
    const repetitive = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A", "--sex", "female", "--age", "24", "--character", "啊".repeat(60)], repetitive.io), 2);
    assert.match(repetitive.out.stderr, /character/);
    const decimal = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A", "--sex", "female", "--age", "26.9", "--character", "这是一个足够长的人设描述，包含性格、表达方式和长期边界，用于验证小数年龄会被拒绝。"] , decimal.io), 2);
    assert.match(decimal.out.stderr, /age/);
    const badSex = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A", "--sex", "robot", "--age", "24", "--character", "这是一个足够长的人设描述，包含性格、表达方式和长期边界，用于验证非法性别会被拒绝。"] , badSex.io), 2);
    assert.match(badSex.out.stderr, /sex/);

    const created = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A", ...PROFILE_ARGS], created.io), 0);
    const uid = /created soul ([0-9a-f-]{36})/.exec(created.out.stdout)?.[1];
    let store = await openStore(root, "p1");
    let soul = (await store.read()).souls[uid];
    await store.close();
    assert.match(soul.avatar_url, new RegExp(`seed=soul-${uid}`));
    assert.equal(soul.publish_profile, true);
    const avatarBefore = soul.avatar_url;
    assert.equal(await main(["soul", "edit", uid, "--profile", "p1", "--name", "Renamed"], makeIo().io), 0);
    store = await openStore(root, "p1"); soul = (await store.read()).souls[uid]; await store.close();
    assert.equal(soul.avatar_url, avatarBefore, "default avatar seed follows soul UID, not nickname");
  } finally {
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile: --avatar stays local and authorize carries the public intent", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  await seed(root, "p1", "dev-1");
  const avatar = path.join(home, "avatar.png");
  writeFileSync(avatar, Buffer.from("not-a-real-png"));
  const previousHome = process.env.SOUL37_HOME;
  process.env.SOUL37_HOME = home;
  try {
    const created = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A", ...PROFILE_ARGS, "--avatar", avatar], created.io), 0);
    const uid = /created soul ([0-9a-f-]{36})/.exec(created.out.stdout)?.[1];
    let store = await openStore(root, "p1"); let snap = await store.read(); await store.close();
    assert.equal(snap.souls[uid].local_avatar_path, avatar);
    assert.equal(Object.keys(snap.outbox).length, 0, "anonymous create performs no upload");
    assert.equal(await main(["soul", "authorize", uid, "--profile", "p1", "--categories", "identity,relationship"], makeIo().io), 0);
    store = await openStore(root, "p1"); snap = await store.read(); await store.close();
    const op = Object.values(snap.outbox).find((entry) => entry.operation_kind === "register_soul");
    assert.equal(op.request.publish_profile, true);
    assert.equal(op.request.identity.sex, "female");
    assert.equal(op.request.identity.age, 24);
  } finally {
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile: an old local Soul cannot publish until its missing fields are filled", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  const legacyUid = "10000000-0000-4000-8000-0000000000aa";
  await seed(root, "p1", "dev-1", (d) => {
    d.souls[legacyUid] = {
      soul_uid: legacyUid, legacy_host_id: null, identity_revision: 1,
      identity: { name: "Legacy", description: "", character: "legacy local character", greeting: "" },
      state: "active", origin: "local",
      local_identity: { name: "Legacy", description: "", character: "legacy local character", greeting: "" },
      local_identity_revision: 1,
    };
  });
  const previousHome = process.env.SOUL37_HOME;
  process.env.SOUL37_HOME = home;
  try {
    const refused = makeIo();
    assert.equal(await main(["soul", "authorize", legacyUid, "--profile", "p1", "--categories", "identity,relationship"], refused.io), 1);
    assert.match(refused.out.stderr, /invalid_profile.*sex.*age.*character/);
    let store = await openStore(root, "p1"); let snap = await store.read(); await store.close();
    assert.equal(Object.keys(snap.outbox).length, 0, "refused authorization must not enqueue a public registration");

    assert.equal(await main(["soul", "edit", legacyUid, "--profile", "p1", "--name", "Legacy", "--sex", "female", "--age", "30", "--character", "补齐后的完整人设，包含稳定的性格、说话方式、兴趣背景和长期相处边界，并沿用原来的本地 UUID，不影响其他 Soul。"], refused.io), 0);
    assert.equal(await main(["soul", "authorize", legacyUid, "--profile", "p1", "--categories", "identity,relationship"], refused.io), 0);
    store = await openStore(root, "p1"); snap = await store.read(); await store.close();
    const op = Object.values(snap.outbox).find((entry) => entry.operation_kind === "register_soul");
    assert.equal(op.request.publish_profile, true, "new explicit authorization publishes the completed local profile");
    assert.equal(op.request.identity.age, 30);
  } finally {
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile: an already queued legacy register body is never mutated", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  const uid = "10000000-0000-4000-8000-0000000000ab";
  await seed(root, "p1", "dev-1", (d) => {
    d.souls[uid] = {
      soul_uid: uid, legacy_host_id: null, identity_revision: 1,
      identity: { name: "Old", description: "", character: "补齐后的完整人设，包含稳定的性格、说话方式、兴趣背景和长期相处边界，并沿用原来的本地 UUID，不影响其他 Soul。", greeting: "", sex: "male", age: 31 },
      state: "active", origin: "local",
      local_identity: { name: "Old", description: "", character: "补齐后的完整人设，包含稳定的性格、说话方式、兴趣背景和长期相处边界，并沿用原来的本地 UUID，不影响其他 Soul。", greeting: "", sex: "male", age: 31 },
      local_identity_revision: 1,
    };
    d.outbox["legacy-register"] = {
      operation_id: "legacy-register", operation_kind: "register_soul",
      request: { soul_uid: uid, identity: d.souls[uid].identity, consent_categories: ["identity"] },
      predecessor_operation_ids: [],
    };
  });
  const previousHome = process.env.SOUL37_HOME;
  process.env.SOUL37_HOME = home;
  try {
    assert.equal(await main(["soul", "authorize", uid, "--profile", "p1", "--categories", "identity"], makeIo().io), 0);
    const store = await openStore(root, "p1"); const snap = await store.read(); await store.close();
    assert.equal(snap.outbox["legacy-register"], undefined, "the old operation is removed from the active outbox");
    assert.equal(snap.quarantine["legacy-register"].operation.request.publish_profile, undefined, "its old body is preserved untouched");
    const current = Object.values(snap.outbox).find((entry) => entry.operation_kind === "register_soul");
    assert.equal(current.request.publish_profile, true, "the new operation carries the new intent");
  } finally {
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile: --avatar relative paths are frozen absolute at command time", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  const work = path.join(home, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "avatar.png"), Buffer.from("relative-bytes"));
  const previousHome = process.env.SOUL37_HOME;
  const previousCwd = process.cwd();
  process.env.SOUL37_HOME = home;
  process.chdir(work);
  try {
    const created = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "Relative", "--sex", "female", "--age", "24", "--character", "这是相对路径头像入口的完整人设，包含稳定的性格、表达方式、兴趣背景和长期边界，长度明确超过五十个字符的要求。", "--avatar", "./avatar.png"], created.io), 0, created.out.stderr);
    const uid = /created soul ([0-9a-f-]{36})/.exec(created.out.stdout)?.[1];
    process.chdir(previousCwd);
    const store = await openStore(root, "p1"); const snap = await store.read(); await store.close();
    assert.equal(snap.souls[uid].local_avatar_path, path.join(realpathSync(work), "avatar.png"));
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile: avatar upload sends bytes only after login and keeps a retryable local copy", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  const uid = "10000000-0000-4000-8000-0000000000ac";
  const avatar = path.join(home, "chosen.png");
  writeFileSync(avatar, Buffer.from("PNG-BYTES"));
  await seed(root, "p1", "dev-1", (d) => {
    d.owner_id = "owner-1";
    d.cloud_device_uid = "cdu-1";
    d.souls[uid] = {
      soul_uid: uid, legacy_host_id: 77, identity_revision: 1,
      identity: { name: "Avatar", description: "", character: "补齐后的完整人设，包含性格、表达方式和长期边界，用于头像上传路径。", greeting: "", sex: "female", age: 28 },
      state: "active", origin: "local", local_avatar_path: avatar, avatar_uploaded: false,
    };
    d.consents[`cdu-1:${uid}`] = {
      cloud_device_uid: "cdu-1", soul_uid: uid, revision: 1,
      categories: ["identity"], enabled: true,
    };
  });
  writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    api_base_url: "https://fake.test", machine_id: "m1", tokens: {},
    credentials: [{ token: "token-1", owner_id: "owner-1", cloud_device_uid: "cdu-1", runtime_kind: "hermes", profile_id: "p1", obtained_at: "x" }],
  })}\n`, { mode: 0o600 });
  const previousHome = process.env.SOUL37_HOME;
  const previousFetch = globalThis.fetch;
  process.env.SOUL37_HOME = home;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ protocol: "soul-assets/v1", avatar_url: "https://cdn.example/avatar.webp" }),
    };
  };
  try {
    const run = makeIo();
    assert.equal(await main(["soul", "avatar", uid, "--profile", "p1", "--file", avatar], run.io), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PUT");
    assert.match(calls[0].url, new RegExp(`/souls/${uid}/avatar$`));
    assert.equal(calls[0].headers.authorization, "Bearer token-1");
    assert.match(calls[0].url, /^https:\/\/fake\.test\//, "uses config.api_base_url, not the CLI default");
    assert.equal(typeof calls[0].body.get, "function", "multipart FormData is sent, not a local path string");
    assert.equal(calls[0].body.get("file").name, "chosen.png");
    const store = await openStore(root, "p1"); const snap = await store.read(); await store.close();
    assert.equal(snap.souls[uid].avatar_url, "https://cdn.example/avatar.webp");
    assert.equal(snap.souls[uid].avatar_uploaded, true);

    globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) });
    const failed = makeIo();
    assert.equal(await main(["soul", "avatar", uid, "--profile", "p1", "--file", avatar], failed.io), 1);
    const store2 = await openStore(root, "p1"); const snap2 = await store2.read(); await store2.close();
    assert.equal(snap2.souls[uid].local_avatar_path, avatar, "failed upload keeps the local image");
    assert.equal(snap2.souls[uid].avatar_uploaded, false);

    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
    const empty = makeIo();
    assert.equal(await main(["soul", "avatar", uid, "--profile", "p1", "--file", avatar], empty.io), 1);
    assert.match(empty.out.stderr, /avatar upload failed/);
    const store3 = await openStore(root, "p1"); const snap3 = await store3.read(); await store3.close();
    assert.equal(snap3.souls[uid].avatar_uploaded, false, "an empty 200 is not success");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile: create --avatar uploads after explicit registration on the sync path", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  const avatar = path.join(home, "chosen.png");
  writeFileSync(avatar, Buffer.from("LOCAL-AVATAR-BYTES"));
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
  const calls = [];
  const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body });
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push(`${init.method ?? "GET"} ${pathname}`);
    if (init.method === "GET" && pathname.endsWith("/capabilities")) {
      return reply(200, { protocol: "soul-assets/v1", capabilities: ["soul_profile_public_v1"] });
    }
    if (init.method === "POST" && pathname.endsWith("/souls")) {
      return reply(201, {
        protocol: "soul-assets/v1",
        soul: { soul_uid: body.soul_uid, legacy_host_id: 99, identity_revision: 1, identity: body.identity, public: true, avatar_url: "https://cdn.example/default.webp", state: "active" },
        consent: { cloud_device_uid: "cdu-1", soul_uid: body.soul_uid, revision: 1, categories: body.consent_categories, enabled: true },
      });
    }
    if (init.method === "PUT" && pathname.endsWith("/avatar")) {
      calls.push("AVATAR_BODY:" + (typeof init.body?.get === "function" ? init.body.get("file")?.name : "not-formdata"));
      return reply(200, { protocol: "soul-assets/v1", avatar_url: "https://cdn.example/chosen.webp" });
    }
    if (init.method === "GET" && pathname.endsWith("/pull")) return reply(200, { protocol: "soul-assets/v1", events: [], next_cursor: "0", has_more: false });
    return reply(500, { error: { code: "unexpected" } });
  };
  try {
    const created = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "Avatar Sync", "--sex", "female", "--age", "24", "--character", "这是创建时选择头像并写入同步主链的完整人设，包含性格、表达方式、兴趣背景和长期边界，长度明确超过五十个字符的要求。", "--avatar", avatar], created.io), 0);
    const uid = /created soul ([0-9a-f-]{36})/.exec(created.out.stdout)?.[1];
    assert.ok(uid);
    assert.equal(await main(["soul", "authorize", uid, "--profile", "p1", "--categories", "identity,relationship"], makeIo().io), 0);
    const sync = makeIo();
    assert.equal(await main(["sync", "--profile", "p1"], sync.io), 0, sync.out.stderr);
    const store = await openStore(root, "p1"); const snap = await store.read(); await store.close();
    assert.equal(snap.souls[uid].avatar_uploaded, true);
    assert.equal(snap.souls[uid].avatar_url, "https://cdn.example/chosen.webp");
    assert.ok(calls.some((call) => call.startsWith("PUT /api/v1/me/soul_sync/souls/") && call.endsWith("/avatar")), "sync must upload the chosen image after registration");
    assert.ok(calls.includes("AVATAR_BODY:chosen.png"), "the multipart body carries the image bytes, not the local path");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile: a slow manual avatar ACK cannot overwrite a concurrent CLI create", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  const oldUid = "10000000-0000-4000-8000-0000000000af";
  const file = path.join(home, "old-avatar.png");
  writeFileSync(file, Buffer.from("OLD-BYTES"));
  await seed(root, "p1", "dev-1", (d) => {
    d.owner_id = "owner-1";
    d.cloud_device_uid = "cdu-1";
    d.souls[oldUid] = {
      soul_uid: oldUid, legacy_host_id: 77, identity_revision: 1, public: true,
      identity: { name: "Old", description: "", character: "旧 Soul 的完整人设，包含性格、表达方式和长期边界，长度超过五十个字符。", greeting: "", sex: "female", age: 30 },
      state: "active", origin: "local", local_avatar_path: file, avatar_uploaded: false,
    };
    d.consents[`cdu-1:${oldUid}`] = { cloud_device_uid: "cdu-1", soul_uid: oldUid, revision: 1, categories: ["identity"], enabled: true };
  });
  writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    api_base_url: "https://fake.test", machine_id: "m1", tokens: {},
    credentials: [{ token: "token-1", owner_id: "owner-1", cloud_device_uid: "cdu-1", runtime_kind: "hermes", profile_id: "p1", obtained_at: "x" }],
  })}\n`, { mode: 0o600 });
  const previousHome = process.env.SOUL37_HOME;
  const previousFetch = globalThis.fetch;
  process.env.SOUL37_HOME = home;
  let releaseUpload;
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  let enteredUpload;
  const entered = new Promise((resolve) => { enteredUpload = resolve; });
  const fake = async (url, init = {}) => {
    if (init.method === "PUT" && String(url).endsWith("/avatar")) {
      enteredUpload();
      await uploadGate;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ protocol: "soul-assets/v1", avatar_url: "https://cdn.example/old.webp" }) };
    }
    return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
  };
  globalThis.fetch = fake;
  configureSyncHttp(fake);
  const writer = await startWriter(root);
  try {
    const avatarRun = main(["soul", "avatar", oldUid, "--profile", "p1", "--file", file], makeIo().io);
    await entered;
    const create = makeIo();
    const createRun = main(["soul", "create", "--profile", "p1", "--name", "Concurrent", "--sex", "male", "--age", "25", "--character", "并发创建的新 Soul，包含稳定的性格、表达方式、兴趣背景、说话习惯和长期边界，长度明确超过五十个字符。"], create.io);
    releaseUpload();
    assert.equal(await avatarRun, 0);
    assert.equal(await createRun, 0, create.out.stderr);
    const uid = /created soul ([0-9a-f-]{36})/.exec(create.out.stdout)?.[1];
    const snap = await readSnap(root);
    assert.ok(snap.souls[oldUid], "the old Soul remains");
    assert.ok(uid && snap.souls[uid], "the concurrently created Soul must survive the old avatar ACK");
    assert.equal(snap.souls[oldUid].avatar_uploaded, true);
  } finally {
    await writer.close().catch(() => {});
    globalThis.fetch = previousFetch;
    configureSyncHttp(previousFetch);
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile: registered does not imply public when the cloud says private", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  const uid = "10000000-0000-4000-8000-0000000000ad";
  await seed(root, "p1", "dev-1", (d) => {
    d.souls[uid] = {
      soul_uid: uid, legacy_host_id: 88, identity_revision: 2, public: false,
      identity: { name: "Private registered", description: "", character: "完整人设，包含性格、表达方式、兴趣背景和长期边界，长度明确超过五十个字符的要求。", greeting: "", sex: "female", age: 30 },
      state: "active",
    };
  });
  const previousHome = process.env.SOUL37_HOME;
  process.env.SOUL37_HOME = home;
  try {
    const listed = makeIo();
    assert.equal(await main(["soul", "list", "--profile", "p1"], listed.io), 0);
    assert.match(listed.out.stdout, /registered private/);
    assert.doesNotMatch(listed.out.stdout, /public: https/);

    const unknownUid = "10000000-0000-4000-8000-0000000000ae";
    const store = await openStore(root, "p1"); await store.transact((d) => {
      d.souls[unknownUid] = { ...d.souls[uid], soul_uid: unknownUid, public: undefined };
    }); await store.close();
    const unknown = makeIo();
    assert.equal(await main(["soul", "list", "--profile", "p1"], unknown.io), 0);
    assert.match(unknown.out.stdout, /public state unknown/);
  } finally {
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("R2: soul create stays local and soul authorize enqueues explicit consent", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  await seed(root, "p1", "dev-1");
  const previousHome = process.env.SOUL37_HOME;
  process.env.SOUL37_HOME = home;
  try {
    const created = makeIo();
    const code = await main(["soul", "create", "--profile", "p1", "--name", "Growth", ...PROFILE_ARGS], created.io);
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
    assert.deepEqual(snap.souls[uid].local_identity, { name: "Growth", description: "", character: "这是一个完整的人设描述，包含性格、表达方式和长期相处边界，用于通过至少五十个字符的创建质量门槛，并保留完整细节。", greeting: "", sex: "female", age: 24 });
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
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "Growth", "--sex", "female", "--age", "24", "--character", "ORIGINAL_CANARY 这是一个足够长的人设描述，包含性格、表达方式和长期相处边界，用于测试编辑后的注入版本。"], created.io), 0);
    const uid = /created soul ([0-9a-f-]{36})/.exec(created.out.stdout)?.[1];
    assert.ok(uid);
    const edited = makeIo();
    assert.equal(await main(["soul", "edit", uid, "--profile", "p1", "--character", "UPDATED_CANARY 这是一个足够长的人设描述，包含性格、表达方式和长期相处边界，用于测试编辑后的注入版本。"], edited.io), 0);
    const bound = makeIo();
    assert.equal(await main(["bind", "--profile", "p1", "--soul", uid, "--session", "ns-1"], bound.io), 0);

    const store = await openStore(root, "p1");
    const snap = await store.read();
    await store.close();
    const soul = snap.souls[uid];
    assert.match(soul.identity.character, /^UPDATED_CANARY/);
    assert.match(soul.local_identity.character, /^UPDATED_CANARY/, "the local original is updated too");
    assert.equal(soul.identity_revision, 2);
    assert.equal(soul.local_identity_revision, 2, "the version is not reset to 1");
    const binding = Object.values(snap.bindings)[0];
    const bundle = selectContext(ownerContextInput(snap, uid, binding, "task", 4096));
    assert.match(bundle.rendered_text, /UPDATED_CANARY/);
    assert.doesNotMatch(bundle.rendered_text, /ORIGINAL_CANARY/);

    const exported = makeIo();
    assert.equal(await main(["soul", "export", "--profile", "p1"], exported.io), 0);
    const exportBody = JSON.parse(exported.out.stdout);
    assert.match(exportBody.souls[uid].identity.character, /^UPDATED_CANARY/);
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
    if (init.method === "GET" && pathname.endsWith("/capabilities")) {
      return response(200, { protocol: "soul-assets/v1", capabilities: ["soul_profile_public_v1"] });
    }
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
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A", ...PROFILE_ARGS], a.io), 0);
    const aUid = /created soul ([0-9a-f-]{36})/.exec(a.out.stdout)?.[1];
    assert.equal(await main(["bind", "--profile", "p1", "--soul", aUid, "--session", "ns-shared", "--agent", "hermes"], makeIo().io), 0);

    const b = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "B", ...PROFILE_ARGS], b.io), 0);
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
    if (init.method === "GET" && pathname.endsWith("/capabilities")) {
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ protocol: "soul-assets/v1", capabilities: ["soul_profile_public_v1"] }) };
    }
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
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A", ...PROFILE_ARGS], a.io), 0);
    const aUid = /created soul ([0-9a-f-]{36})/.exec(a.out.stdout)?.[1];
    assert.equal(await main(["bind", "--profile", "p1", "--soul", aUid, "--session", "ns-A", "--agent", "hermes"], makeIo().io), 0);
    const b = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "B", ...PROFILE_ARGS], b.io), 0);
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

test("P2-1: A(base0)+B(base1) parked in the same session stays unusable until a new session", async () => {
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
    if (init.method === "GET" && pathname.endsWith("/capabilities")) {
      return response(200, { protocol: "soul-assets/v1", capabilities: ["soul_profile_public_v1"] });
    }
    if (init.method === "POST" && pathname.endsWith("/souls")) {
      return response(201, {
        protocol: "soul-assets/v1",
        soul: { soul_uid: body.soul_uid, legacy_host_id: 91, identity_revision: 1, identity: body.identity, state: "active" },
        consent: { cloud_device_uid: "cdu-1", soul_uid: body.soul_uid, revision: 1, categories: body.consent_categories, enabled: true },
      });
    }
    if (init.method === "PUT" && pathname.includes("/bindings/")) {
      const bindingUid = pathname.split("/").pop();
      bindingRequests.push({ bindingUid, body: { ...body } });
      const existing = bindings.get(bindingUid);
      if (!existing) {
        if (body.base_revision !== 0) return response(409, { error: { code: "revision_conflict", current_revision: 0 } });
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
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "A", ...PROFILE_ARGS], a.io), 0);
    const aUid = /created soul ([0-9a-f-]{36})/.exec(a.out.stdout)?.[1];
    assert.equal(await main(["bind", "--profile", "p1", "--soul", aUid, "--session", "ns-shared", "--agent", "hermes"], makeIo().io), 0);

    const b = makeIo();
    assert.equal(await main(["soul", "create", "--profile", "p1", "--name", "B", ...PROFILE_ARGS], b.io), 0);
    const bUid = /created soul ([0-9a-f-]{36})/.exec(b.out.stdout)?.[1];
    // Both are unauthorized: the local switch is allowed and leaves A(base0)+B(base1).
    assert.equal(await main(["bind", "--profile", "p1", "--soul", bUid, "--session", "ns-shared", "--agent", "hermes"], makeIo().io), 0);
    assert.equal(await main(["soul", "authorize", bUid, "--profile", "p1", "--categories", "identity"], makeIo().io), 0);

    const before = await readSnap(root, "p1");
    const beforeOps = Object.values(before.outbox).filter((op) => op.operation_kind === "binding");
    assert.deepEqual(beforeOps.map((op) => op.request.base_revision).sort(), [0, 1]);
    assert.equal(beforeOps.length, 2, "A and B are both queued before the first sync");

    assert.equal(await main(["sync", "--profile", "p1"], makeIo().io), 0);
    assert.equal(await main(["sync", "--profile", "p1"], makeIo().io), 0);
    const parked = await readSnap(root, "p1");
    assert.ok(Object.values(parked.outbox).some((op) => op.operation_kind === "binding" && op.request.soul_uid === aUid), "A stays local");
    assert.ok(Object.values(parked.quarantine).some((entry) => entry.operation.request.soul_uid === bUid && entry.reason === "needs_new_session"));
    assert.equal(bindings.size, 0, "neither A nor B created a cloud binding");
    assert.equal(bindingRequests.length, 0, "the invalid B CAS was never sent");

    const key = { profile_id: "p1", device_id: "dev-1", runtime_kind: "hermes", native_session_id: "ns-shared" };
    assert.equal(await resolveBinding(key, bUid, { root }), null, "explicit resolve cannot inject parked B");
    assert.equal(await resolveBinding(key, undefined, { root }), null, "implicit resolve cannot inject parked B");
    const refused = makeIo();
    assert.equal(await main(["bind", "--profile", "p1", "--soul", bUid, "--session", "ns-shared", "--agent", "hermes"], refused.io), 1);
    assert.match(refused.out.stderr, /start a new session/);

    assert.equal(await main(["bind", "--profile", "p1", "--soul", bUid, "--session", "ns-new", "--agent", "hermes"], makeIo().io), 0);
    assert.equal(await main(["sync", "--profile", "p1"], makeIo().io), 0);
    assert.equal(bindings.size, 1, "new-session B creates a legal cloud binding");
    assert.ok(bindingRequests.some((request) => request.body.base_revision === 0 && request.body.soul_uid === bUid));
    const final = await readSnap(root, "p1");
    assert.ok(Object.values(final.outbox).some((op) => op.operation_kind === "binding" && op.request.soul_uid === aUid), "A remains local and unsent");
    assert.ok(!Object.values(final.outbox).some((op) => op.operation_kind === "binding" && op.request.soul_uid === bUid), "new-session B is accepted");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.SOUL37_HOME;
    else process.env.SOUL37_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
