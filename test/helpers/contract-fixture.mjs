/**
 * Shared soul-assets/v1 contract fixture loader.
 *
 * The vendored test/fixtures/contracts/soul-assets-v1.json must stay byte-identical
 * to the authoritative fixture in the adjacent 37soul repo
 * (docs/superpowers/specs/2026-10-20-persistent-soul-fixtures.json). CI must not
 * depend on that repo, so the bytes are vendored here and verified against the
 * declared SHA-256 in test/fixtures/contracts/source.json on every load.
 *
 * `SOUL37_CONTRACT_FIXTURE` may override the fixture path (for example to point at
 * the sibling repo during a coordinated two-team fixture update). Overrides are
 * still checked against the declared protocol + SHA-256 — never trusted blindly.
 * When the shared source changes, both teams must bump the vendored copy and the
 * declared hash together.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.join(here, "..", "fixtures", "contracts");

/** The eight shared fixture sections the loader iterates dynamically. */
export const SECTION_NAMES = [
  "seed",
  "requests",
  "scenario_steps",
  "classification_cases",
  "context_cases",
  "privacy_fixture",
  "required_sequence_assertions",
  "wire_responses",
];

/**
 * Load the fixture, verifying the vendored/overridden bytes against the declared
 * protocol and SHA-256. Throws on any mismatch so a tampered or stale fixture can
 * never silently green the contract tests.
 */
export function loadContractFixture(env = process.env) {
  const source = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, "source.json"), "utf8"));
  if (!source || source.protocol !== "soul-assets/v1" || typeof source.sha256 !== "string") {
    throw new Error("contract fixture source.json must declare protocol and sha256");
  }

  const override = env.SOUL37_CONTRACT_FIXTURE;
  const fixturePath = override
    ? path.resolve(String(override))
    : path.join(CONTRACTS_DIR, "soul-assets-v1.json");

  const bytes = readFileSync(fixturePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== source.sha256) {
    throw new Error(
      `contract fixture SHA-256 mismatch at ${fixturePath}: declared ${source.sha256}, computed ${sha256}`,
    );
  }

  let fixture;
  try {
    fixture = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`contract fixture ${fixturePath} is not valid JSON: ${error.message}`);
  }
  if (fixture.protocol !== source.protocol) {
    throw new Error(
      `contract fixture protocol mismatch: declared ${source.protocol}, fixture ${fixture.protocol}`,
    );
  }

  return { fixture, source, fixturePath, sha256 };
}

/**
 * Map the fixture's context_cases into ContextInput objects plus their golden
 * expected values. The fixture mirrors the wire (snake_case); ContextInput's own
 * parameters are camelCase (taskHint/budgetBytes/quarantinedAssetUids), so only
 * those keys are mapped. The nested DTOs (soul/assets/binding) stay in wire
 * snake_case, and seed.binding is attached to every case.
 */
export function contextCases(fixture) {
  const binding = fixture.seed.binding;
  return fixture.context_cases.map((c) => {
    const input = {
      soul: c.input.soul,
      assets: c.input.assets,
      taskHint: c.input.task_hint,
      budgetBytes: c.input.budget_bytes,
      binding,
    };
    if (c.input.quarantined_asset_uids !== undefined) {
      input.quarantinedAssetUids = c.input.quarantined_asset_uids;
    }
    return { name: c.name, input, expected: c.expected };
  });
}

/**
 * Map the fixture's classification_cases into `{ name, proposedPayload, expected }`.
 * `proposedPayload` is null for cases that must produce no asset (e.g. a one-turn
 * instruction), which the extraction task uses as a negative example.
 */
export function classificationCases(fixture) {
  return fixture.classification_cases.map((c) => ({
    name: c.name,
    proposedPayload: c.proposed_payload ?? null,
    localOnlyInputs: c.local_only_inputs ?? null,
    expected: c.expected,
  }));
}
