import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../dist/cli.js";
import { openStore } from "../dist/local/store.js";

const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const ORPHAN = "10000000-0000-4000-8000-000000000099";

function soul(uid, name, host = null) {
  return {
    soul_uid: uid, legacy_host_id: host, identity_revision: 1,
    identity: { name, description: "", character: "Test character", greeting: "" },
    state: "active",
  };
}

function asset(uid, soulUid, content, overrides = {}) {
  return {
    asset_uid: uid, soul_uid: soulUid, kind: "relationship", trait: "preference",
    content, applicability: "", tags: [], evidence: "explicit_user_statement",
    verification: "unverified", sensitivity: "normal", state: "active",
    revision: 1, supersedes_uid: null, pinned: false,
    source: {
      runtime_kind: "codex", session_ref: "local-test-session", event_ref: uid,
      occurred_at: "2026-11-01T10:00:00Z",
    },
    sync_state: "local_only", cloud_revision: null, ...overrides,
  };
}

function filesUnder(dir) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory()
        ? Object.entries(filesUnder(file)).map(([name, bytes]) => [entry.name + "/" + name, bytes])
        : [[entry.name, readFileSync(file).toString("base64")]];
    }));
}

async function fixture(t, options = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "recall-cli-"));
  const root = path.join(home, ".37soul");
  const previous = Object.fromEntries(["HOME", "SOUL37_HOME", "SOUL37_BASE_URL"].map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  process.env.HOME = home;
  process.env.SOUL37_HOME = home;
  process.env.SOUL37_BASE_URL = "https://network-forbidden.invalid";
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("recall must not use network or models");
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  async function seed(profile, souls, assets) {
    mkdirSync(path.join(root, "profiles", profile), { recursive: true });
    writeFileSync(path.join(root, "profiles", profile, "device.json"),
      JSON.stringify({ device_id: "test-device-" + profile }));
    const store = await openStore(root, profile);
    try {
      await store.transact(draft => {
        draft.souls = Object.fromEntries(souls.map(s => [s.soul_uid, s]));
        draft.assets = Object.fromEntries(assets.map(a => [a.asset_uid, a]));
      });
    } finally {
      await store.close();
    }
  }
  await seed("p1",
    options.souls ?? [soul(A, "Alice", 101), soul(B, "Bob", 202)],
    options.assets ?? [
      asset("a1", A, "ALICE_MEMORY tea document"),
      asset("b1", B, "BOB_MEMORY coffee document"),
      asset("orphan", ORPHAN, "ORPHAN_MEMORY tea", { pinned: true }),
    ]);
  writeFileSync(path.join(root, "config.json"), JSON.stringify({
    active_profile_id: "p1", api_base_url: "https://network-forbidden.invalid", machine_id: "test-machine", tokens: {},
  }));
  writeFileSync(path.join(root, "accounts.json"), JSON.stringify({
    anonymous: { profile_id: "p1", default_soul_uid: A, soul_sync_mode: "assets_only" },
  }));
  writeFileSync(path.join(root, "profiles", "p1", "defaults.json"), JSON.stringify({
    account_default_soul_uid: A, tool_defaults: { codex: A },
  }));

  async function run(args = []) {
    const before = filesUnder(home);
    const out = { stdout: "", stderr: "" };
    const code = await main(["recall", ...args], {
      stdout: text => { out.stdout += text; },
      stderr: text => { out.stderr += text; },
      stdin: async () => { throw new Error("recall must not request stdin/session"); },
    });
    assert.deepEqual(filesUnder(home), before, "recall leaves all local files unchanged");
    assert.equal(networkCalls, 0, "recall never calls a server or model");
    return { code, ...out };
  }
  return { home, root, seed, run };
}

function noMemories(result) {
  assert.doesNotMatch(result.stdout + result.stderr, /ALICE_MEMORY|BOB_MEMORY|ORPHAN_MEMORY|OTHER_PROFILE_MEMORY/);
}

test("recall CLI: multiple local Souls require a choice despite account/tool defaults", async t => {
  const { run } = await fixture(t);
  const result = await run(["document"]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Alice/);
  assert.match(result.stderr, /Bob/);
  for (const id of [A, B, "101", "202"]) assert.ok(result.stderr.includes(id), result.stderr);
  for (const flag of ["--soul", "--host", "--name", "--all"]) assert.ok(result.stderr.includes(flag), result.stderr);
  noMemories(result);
});

test("recall CLI: exactly one local Soul auto-selects with name and UID header", async t => {
  const { run } = await fixture(t, { souls: [soul(A, "Alice")] });
  const result = await run();
  assert.equal(result.code, 0);
  assert.match(result.stdout.split("\n")[0], /Alice/);
  assert.ok(result.stdout.split("\n")[0].includes(A));
  assert.match(result.stdout, /ALICE_MEMORY/);
  assert.doesNotMatch(result.stdout, /BOB_MEMORY|ORPHAN_MEMORY/);
});

for (const [flag, value] of [["--soul", B], ["--host", "202"], ["--name", "Bob"]]) {
  test("recall CLI: " + flag + " selects only the matching local Soul", async t => {
    const { run } = await fixture(t);
    const result = await run([flag, value]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout.split("\n")[0], /Bob/);
    assert.ok(result.stdout.split("\n")[0].includes(B));
    assert.match(result.stdout, /BOB_MEMORY/);
    assert.doesNotMatch(result.stdout, /ALICE_MEMORY|ORPHAN_MEMORY/);
  });
}

for (const [flag, value] of [["--soul", ORPHAN], ["--host", "999"], ["--name", "bob"]]) {
  test("recall CLI: unknown exact selector " + flag + " fails without memory disclosure", async t => {
    const { run } = await fixture(t);
    const result = await run([flag, value]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /not found|no local Soul/i);
    noMemories(result);
  });
}

test("recall CLI: duplicate exact names require UID or host and list both identities", async t => {
  const { run } = await fixture(t, { souls: [soul(A, "Twin", 101), soul(B, "Twin", 202)] });
  const result = await run(["--name", "Twin"]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--soul/);
  assert.match(result.stderr, /--host/);
  for (const id of [A, B, "101", "202"]) assert.ok(result.stderr.includes(id), result.stderr);
  noMemories(result);
});

test("recall CLI: UID and host disambiguate duplicate names", async t => {
  const { run } = await fixture(t, { souls: [soul(A, "Twin", 101), soul(B, "Twin", 202)] });
  for (const args of [["--soul", A], ["--host", "101"]]) {
    const result = await run(args);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ALICE_MEMORY/);
    assert.doesNotMatch(result.stdout, /BOB_MEMORY|ORPHAN_MEMORY/);
  }
});

test("recall CLI: --all labels every hit with its Soul name and UID and excludes orphans", async t => {
  const { run } = await fixture(t, { assets: [
    asset("a1", A, "ALICE_MEMORY document"),
    asset("b1", B, "BOB_MEMORY document"),
    asset("a2", A, "ALICE_MEMORY second", { state: "candidate" }),
    asset("orphan", ORPHAN, "ORPHAN_MEMORY", { pinned: true }),
  ] });
  const result = await run(["--all"]);
  assert.equal(result.code, 0);
  const lines = result.stdout.split("\n").filter(line => /ALICE_MEMORY|BOB_MEMORY/.test(line));
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const [name, uid] = line.includes("ALICE_MEMORY") ? ["Alice", A] : ["Bob", B];
    assert.ok(line.includes(name) && line.includes(uid), line);
  }
  assert.doesNotMatch(result.stdout, /ORPHAN_MEMORY/);
});

for (const args of [[], ["--all"]]) {
  test("recall CLI: zero real Souls cannot expose orphan assets " + args.join(" "), async t => {
    const { run } = await fixture(t, { souls: [] });
    const result = await run(args);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no local Souls/i);
    noMemories(result);
  });
}

test("recall CLI: only the active profile's real Souls are listed or recalled", async t => {
  const { seed, run } = await fixture(t);
  await seed("p2", [soul(ORPHAN, "OtherProfile", 999)], [asset("other", ORPHAN, "OTHER_PROFILE_MEMORY")]);
  const ambiguous = await run();
  assert.notEqual(ambiguous.code, 0);
  assert.doesNotMatch(ambiguous.stderr, /OtherProfile|999/);
  const all = await run(["--all"]);
  assert.equal(all.code, 0);
  assert.doesNotMatch(all.stdout, /OTHER_PROFILE_MEMORY|ORPHAN_MEMORY/);
  const explicit = await run(["--profile", "p2", "--host", "999"]);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.match(explicit.stdout, /OTHER_PROFILE_MEMORY/);
  assert.doesNotMatch(explicit.stdout, /ALICE_MEMORY|BOB_MEMORY/);
});

test("recall CLI: consumes profile/kind/limit values without swallowing equal query words", async t => {
  const { run } = await fixture(t, { souls: [soul(A, "Alice")], assets: [
    asset("no", A, "tea only", { kind: "experience", trait: "workflow" }),
    asset("yes", A, "tea p1", { kind: "experience", trait: "workflow" }),
    asset("wrong-kind", A, "tea p1 RELATIONSHIP_ONLY", { pinned: true }),
  ] });
  const result = await run(["--profile", "p1", "--kind", "experience", "--limit", "1", "tea", "p1"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /experience\/workflow · tea p1/);
  assert.doesNotMatch(result.stdout, /tea only|RELATIONSHIP_ONLY/);
});

test("recall CLI: keyword terms retain AND matching", async t => {
  const { run } = await fixture(t);
  const result = await run(["--soul", A, "tea", "coffee"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /nothing matches tea coffee/);
  assert.doesNotMatch(result.stdout, /ALICE_MEMORY|BOB_MEMORY/);
  assert.match(result.stdout.split("\n")[0], /Alice/);
  assert.ok(result.stdout.split("\n")[0].includes(A));
});

test("recall CLI: history is opt-in and preserves states, source and match metadata", async t => {
  const { run } = await fixture(t, { souls: [soul(A, "Alice")], assets: [
    asset("candidate", A, "candidate tea", { state: "candidate", pinned: true }),
    ...["superseded", "rejected", "deleted"].map(state => asset(state, A, state + " tea", { state })),
  ] });
  const current = await run(["tea"]);
  assert.equal(current.code, 0);
  assert.match(current.stdout, /\[candidate\].*📌.*2026-11-01.*codex.*matched: content/);
  assert.doesNotMatch(current.stdout, /superseded tea|rejected tea|deleted tea/);
  const history = await run(["--history", "tea"]);
  assert.equal(history.code, 0);
  for (const state of ["superseded", "rejected", "deleted"]) {
    assert.ok(history.stdout.includes("[" + state + "]"), history.stdout);
    assert.ok(history.stdout.includes(state + " tea"), history.stdout);
  }
});

test("recall CLI: default limit is 10 across all Souls, explicit 100 is accepted", async t => {
  const assets = Array.from({ length: 105 }, (_, index) =>
    asset("item-" + index, index % 2 === 0 ? A : B, "LIMIT_MEMORY_" + index));
  const { run } = await fixture(t, { assets });
  const defaults = await run(["--all"]);
  assert.equal(defaults.code, 0);
  assert.equal(defaults.stdout.split("\n").filter(line => line.includes("LIMIT_MEMORY_")).length, 10);
  const explicit = await run(["--all", "--limit", "100"]);
  assert.equal(explicit.code, 0);
  assert.equal(explicit.stdout.split("\n").filter(line => line.includes("LIMIT_MEMORY_")).length, 100);
});

test("recall CLI: -- makes flag-looking terms literal, including selector/profile words", async t => {
  const { run } = await fixture(t, { souls: [soul(A, "Alice")], assets: [
    asset("literal", A, "literal --history --profile p2 --soul tea", { state: "active" }),
    asset("deleted", A, "literal --history --profile p2 --soul tea", { state: "deleted" }),
  ] });
  const result = await run(["--", "--history", "--profile", "p2", "--soul", "tea"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /literal --history --profile p2 --soul tea/);
  assert.doesNotMatch(result.stdout, /\[deleted\]/);
});

test("recall CLI: a selected Soul with no assets still has an identity header", async t => {
  const { run } = await fixture(t, { assets: [] });
  const result = await run(["--name", "Alice"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout.split("\n")[0], /Alice/);
  assert.ok(result.stdout.split("\n")[0].includes(A));
  assert.match(result.stdout, /not recorded anything yet/);
});

test("recall CLI: reading an existing profile without device metadata creates no files", async t => {
  const { root, run } = await fixture(t, { souls: [soul(A, "Alice")] });
  rmSync(path.join(root, "profiles", "p1", "device.json"));
  const result = await run(["--profile", "p1"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ALICE_MEMORY/);
});

test("recall CLI: a fresh home or missing explicit profile remains read-only", async t => {
  const { root, run } = await fixture(t);
  rmSync(root, { recursive: true });
  for (const args of [[], ["--profile", "missing"]]) {
    const result = await run(args);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no local Souls|profile.*not found|no.*profile/i);
  }
});

test("recall CLI: malformed active profile metadata never falls back to another Soul", async t => {
  const { root, run } = await fixture(t, { souls: [soul(A, "Alice")] });
  writeFileSync(path.join(root, "config.json"), JSON.stringify({ active_profile_id: "missing" }));
  const result = await run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /profile/i);
  noMemories(result);
});

const invalidArgs = [
  ["unknown flag", ["--wat"], /unknown.*--wat/i],
  ["unsupported short flag", ["-x"], /unknown.*-x/i],
  ["inline assignment", ["--kind=experience"], /unknown.*--kind=experience/i],
  ...["--soul", "--host", "--name", "--profile", "--kind", "--limit"].flatMap(flag => [
    ["missing " + flag, [flag], /requires|missing/i],
    ["flag in place of " + flag + " value", [flag, "--all"], /requires|missing/i],
    ["empty " + flag, [flag, ""], /requires|empty|must|invalid/i],
  ]),
  ["blank name", ["--name", "   "], /name.*requires|name.*empty|name.*must|invalid/i],
  ["invalid host", ["--host", "202oops"], /host.*integer|host.*numeric/i],
  ["fractional host", ["--host", "202.5"], /host.*integer|host.*numeric/i],
  ["nonpositive host", ["--host", "0"], /host.*integer|host.*numeric/i],
  ["unsafe host", ["--host", "9007199254740992"], /host.*integer|host.*numeric/i],
  ...["0", "-1", "1.5", "NaN", "Infinity", "2oops", "1e2", "101"].map(value =>
    ["invalid limit " + value, ["--limit", value], /limit.*1.*100|limit.*integer/i]),
  ["invalid kind", ["--kind", "identity"], /kind.*relationship.*experience/i],
  ["profile traversal", ["--profile", "../p1"], /profile.*invalid|invalid.*profile/i],
  ["two all flags", ["--all", "--all"], /duplicate|once/i],
  ["two history flags", ["--history", "--history"], /duplicate|once/i],
  ["all and host", ["--all", "--host", "101"], /exclusive|one.*selector/i],
  ["two UID selectors", ["--soul", A, "--soul", B], /duplicate|once|exclusive/i],
  ["UID and host", ["--soul", A, "--host", "101"], /exclusive|one.*selector/i],
  ["host and name", ["--host", "101", "--name", "Alice"], /exclusive|one.*selector/i],
  ["UID and all", ["--soul", A, "--all"], /exclusive|one.*selector/i],
  ["all and name", ["--all", "--name", "Alice"], /exclusive|one.*selector/i],
  ["two profiles", ["--profile", "p1", "--profile", "p2"], /duplicate|once/i],
  ["two kinds", ["--kind", "experience", "--kind", "relationship"], /duplicate|once/i],
  ["two limits", ["--limit", "1", "--limit", "2"], /duplicate|once/i],
  ["value on boolean", ["--all=true"], /unknown|invalid/i],
];

for (const [label, args, message] of invalidArgs) {
  test("recall CLI: rejects " + label + " before disclosing memories", async t => {
    const { run } = await fixture(t);
    const result = await run(args);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
    noMemories(result);
  });
}

test("recall CLI: general usage documents the scope selectors", async t => {
  await fixture(t);
  let stdout = "";
  assert.equal(await main(["--help"], {
    stdout: text => { stdout += text; }, stderr: () => {}, stdin: async () => "",
  }), 0);
  assert.match(stdout, /37soul recall/);
  for (const flag of ["--soul", "--host", "--name", "--all", "--history", "--kind", "--limit"]) {
    assert.ok(stdout.includes(flag), flag + " missing from usage");
  }
});
