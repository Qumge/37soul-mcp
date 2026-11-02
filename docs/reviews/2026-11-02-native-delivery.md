# Native delivery evidence — 2026-11-02

## Current result (supersedes historical attempts below)

| Host | Core managed foreground loop | Cloud correction in a fresh native session | Cumulative native entries |
| --- | --- | --- | ---: |
| Pi 1.4.0 | PASS | PASS | 5/6 |
| Claude Code 2.1.316 | PASS | PASS | 5/6 |
| Codex 0.166.0 | PASS | PASS after parent actual website edit and legitimate device-code recovery | 6/6 |
| Hermes 0.21.0 | PASS | Not run: core loop and automatic extraction reached the cap | 6/6 |
| OpenCode 2.0.32 | Bridge output observed; model loop blocked by provider quota | Not run | 2/6 |

The real product loops use installer-managed host files, actual foreground agentd, native source refs, automatic extraction and real local Rails HTTP sync. No explicit answer injection, fake trust file or trust-bypass flag qualified these results. Claude and Hermes have separate detailed reports; OpenCode's provider blocker is recorded separately.

Parent completed actual browser device-code authorization, actual Pi and Codex website edits, and separate revocation/cache-clearing acceptance. Codex was not re-taught after the first loop's owner guard correctly stopped its fixture-host correction: parent edited owned host 5 in the real website, a new legitimate browser-approved device restored that Soul, parent approved its hooks through official Codex TUI, and a fresh session adopted the corrected asset while excluding the old one.

All five default global background-service installations remain unverified in this round. Functional foreground PASS does not qualify a public release, remote CI or Linux-native execution. Existing user host config and com.37soul service were not changed. The bounded run ends here; no additional model entries may be taken under the recorded six-entry cap.

## Historical sanitized records

Synthetic only. Explicit-context baseline and native extraction are separate from default-install closure. No trust bypass or production account. Private credential copies are removed after each host invocation.

```json
{
  "host": "pi",
  "code": 0,
  "timeout": false,
  "adopted": true,
  "assistant_sha256": "fba9ecf397fa602c5f06c44ddd2bf3e7c26fbb9b625fa5f7ecb318796b0b3a82",
  "assistant_chars": 15,
  "error_class": null,
  "default_install_closed": false,
  "stage": "explicit-context-baseline",
  "version": "1.4.0",
  "pass": true,
  "attempt": 1,
  "timestamp": "2026-11-02T03:25:20.937Z",
  "private_auth_removed": true
}
```

```json
{
  "host": "claude-code",
  "code": 0,
  "timeout": false,
  "adopted": true,
  "assistant_sha256": "c251b5e9a1dd79b199344bcab995ef9811377bdd7658ba61833417e7ba93d33f",
  "assistant_chars": 15,
  "error_class": "cli_option_rejected",
  "default_install_closed": false,
  "stage": "explicit-context-baseline",
  "version": "2.1.316",
  "pass": true,
  "attempt": 1,
  "timestamp": "2026-11-02T03:25:40.559Z",
  "private_auth_removed": true
}
```

```json
{
  "host": "codex",
  "code": 0,
  "timeout": false,
  "adopted": true,
  "assistant_sha256": "a1e3d095f23a81a545282a52c74bfe2280e350fc055d4f2ec5b827fc915ff46b",
  "assistant_chars": 15,
  "error_class": null,
  "default_install_closed": false,
  "stage": "explicit-context-baseline",
  "version": "0.166.0",
  "pass": true,
  "attempt": 1,
  "timestamp": "2026-11-02T03:26:22.698Z",
  "private_auth_removed": true
}
```

```json
{
  "host": "opencode",
  "code": 1,
  "timeout": false,
  "adopted": false,
  "assistant_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "assistant_chars": 0,
  "error_class": "native_nonzero",
  "default_install_closed": false,
  "stage": "explicit-context-baseline",
  "version": "unknown",
  "pass": false,
  "attempt": 1,
  "timestamp": "2026-11-02T03:26:37.543Z",
  "private_auth_removed": true
}
```

```json
{
  "host": "hermes",
  "code": 0,
  "timeout": false,
  "adopted": true,
  "assistant_sha256": "f4fa14687fae6adfced0f0c90498ca397a405699924c0e2db4bb3e21c310dfd0",
  "assistant_chars": 195,
  "error_class": null,
  "default_install_closed": false,
  "stage": "explicit-context-baseline",
  "version": "2026.8.31",
  "pass": true,
  "attempt": 1,
  "timestamp": "2026-11-02T03:27:12.246Z",
  "private_auth_removed": true
}
```

```json
{
  "host": "pi",
  "stage": "native-extraction-synthetic-source",
  "native_calls": 1,
  "proposal_count": 1,
  "preference_extracted": true,
  "error_class": null,
  "default_install_closed": false,
  "version": "1.4.0",
  "pass": true,
  "attempt": 2,
  "timestamp": "2026-11-02T03:29:07.033Z",
  "private_auth_removed": true
}
```

## Bounded run status and evidence limits

Stopped additional model calls at parent direction. Request ledger (conservatively counts every native attempt, even a pre-answer failure):

| Host | Native attempts | Observed result | Remaining under original initial-two bound |
| --- | ---: | --- | ---: |
| Claude Code 2.1.316 | 1 | Explicit system-context canary returned in final assistant result | 1 |
| Codex 0.166.0 | 1 | Explicit developer-context canary returned in final agent_message; no hook trust bypass | 1 |
| OpenCode 2.0.32 | 1 | Native process exited 1 before any recognized assistant output; root cause not established | 1 |
| Hermes 0.21.0 | 1 | Quiet native stdout contained the injected synthetic canary; weaker than a parsed assistant-event receipt | 1 |
| Pi 1.4.0 | 2 | Explicit system-context canary adopted; actual current Pi adapter/native CLI produced 1 matching proposal from synthetic session-v3 source | 0 |

Total: **6 native invocation attempts; no retries used**. These are invocation counts, not independently audited provider HTTP/billing counts. No real user conversations, production account, Rails request, automatic trust approval, or website-paid model generation was used. The OpenCode model requested was the same local CLI free-provider identifier used by the historical native runner, not a 37Soul website model.

Important corrections to raw sanitized records above:
- Claude exited 0 and adopted the canary. Its recorded `cli_option_rejected` was a runner classifier error caused by nonfatal stderr; a focused RED regression reproduced this and the classifier was corrected. No native rerun was spent to rewrite history.
- Hermes `--version` output included a build/date-like version and the first-number parser recorded 2026.8.31. Its actual installed CLI package declares 0.21.0 in `hermes_cli/__init__.py` and `pyproject.toml`; use 0.21.0 as the host version here.
- OpenCode's isolated public help/version reports v2.0.32. The first version parser missed a digit immediately following `v`; no additional model request was used to establish its version.

The Pi extraction source was synthetic data following the current session-v3 `type=message`, `id`, `parentId`, `message.role/content/stopReason` shape. It was sent through the **actual current adapter and native CLI**. This proves native invocation plus structured proposal output; it does **not** prove a live Pi extension captured its real session file, that the daemon scheduled the job, that the writer persisted it, or that a subsequent real session used it.

Current source digests (SHA-256 prefixes at the Pi extraction check):
- src/adapters/pi.ts: 6b543594cdcf420e
- src/adapters/plugins/pi.ts: 5aefc8ffb3e64b84
- src/hosts/pi.ts: e1b7b8f4fc32e47a
- dist/adapters/pi.js: 5e57e77d3b20910e

Private host HOME directories and temporary authorization copies were removed after each invocation; follow-up inventory found **0 host directories remaining**. Only sanitized JSON results and the count ledger remain under `/private/tmp/37soul-native-delivery-20261102-bounded`. Raw stdout/stderr were held in process memory only and are not retained. No source owned by other workers was changed. No build is run after parent requested exclusive dist ownership.

## Historical runner safety review

`scripts/probe-runtime.mjs` is not safe to rerun unchanged for this authorization: its Codex path uses `--dangerously-bypass-hook-trust`; its Hermes path sets `HERMES_ACCEPT_HOOKS=1`; and failed results include raw stderr. None of those live branches was executed. Reused the existing small native-command/adapter seams, rather than rewriting product runtime code. The new focused runner tests first demonstrated five behavioral failures, then five passes; an additional stderr-classification regression was RED before the fix, then **6/6 passed**. Initial missing-module error is not counted as behavior RED. No full suite was run by this worker.

## Minimum next real-loop acceptance, pending extra call authorization

Do not spend remaining quota on more explicit system-prompt canaries. For each host:

1. Create a private test HOME/workdir; use only existing provider authorization and synthetic content. Keep original credential/config files read-only. Do not install into the user's actual host directories.
2. Use the product's actual managed host install/configuration functions and selected local Soul. Start the real isolated foreground agentd. Let the host load the managed extension/hook through its normal discovery path. Required host-owned trust must be reviewed manually; blocked trust is a blocker, never bypassed or fabricated.
3. First real native session: user states one synthetic durable preference, without a system-prompt canary. Verify SessionStart/UserPromptSubmit output and the actual host adoption separately.
4. Observe actual Stop/agent_settled, persisted native transcript pointer, frozen completed-turn refs, daemon extraction watermark and successful asset commit. No synthetic `readSource` override in this acceptance.
5. Start a fresh real native session; ask a neutral question without the expected preference/answer. Verify the response plus injected receipt containing the new asset. Parent/Erdos can add Rails 8087 consent/sync/correction evidence separately.

Model budget estimate: **at least 3 additional native/model invocations per host** (first native answer, automatic extraction, fresh-session answer). Allow up to **4** if the fresh session's Stop causes another extraction; automatic failure/retry needs a separately explicit allowance or a strict test-native call gate. Pi has already exhausted its initial-two allowance, and every other host's one remaining attempt is insufficient for a complete new loop. No such loop has been executed under the original budget.

Installation boundary: CLI `install` currently has no `--no-service` option and registers a background service. A changed HOME does not create a separate launchd GUI domain. To honor “no global config/service changes”, use existing installer API `installService:false` plus isolated foreground agentd for this functional loop. Report that boundary explicitly: this can validate managed host files and the functional loop, **not** the stranger-user default background-service installation. A full public-install claim still needs a disposable OS user/VM or another parent-approved isolated service environment.

All five `default_install_closed` states remain false. No release/commit/push performed.

## Rails fixture preparation / readiness hold

Parent/Erdos supplied local Rails `http://127.0.0.1:8087`, isolated test DB/Redis, and private fixture `/private/tmp/37soul-delivery-api-fixture.json`. This worker performed **offline credential preparation only**: `saveLoginCredentials` bound five scoped runtime credentials to issuer 8087; selecting them for port 8088 returned 0; HTTP was disabled and its call counter remained 0. Temporary credential files were removed. No database integer device ID was used as a runtime-local device UUID. This is seeded authorization preparation, not browser device-code login approval.

Parent then paused HTTP for the browser-device-code setup/restart. No capabilities/sync/pull HTTP was executed by this worker, and the parent-owned Puma was not touched.

Updated profile contract received from parent: snapshots now require `cloud_issuer`. For the upcoming actual fixture path, use `http://127.0.0.1:8087` explicitly; direct `mergeLoginProfile` needs `{cloudIssuer: 'http://127.0.0.1:8087'}`, and writer `login_associate` payload needs `cloud_issuer`. Existing cloud-owner profiles without a matching issuer must not be reused. The offline credential check above never created or merged a profile snapshot and does not validate this newer contract. Current dist is held as stale until parent rebuild/readiness notification. This worker will not rebuild shared dist.

At this hold point: native attempt ledger remains 6 (Pi 2, each other host 1); retries 0; actual HTTP sync calls 0; default-install closure 0/5. Additional bridge-model budget remains unapproved.

## Managed product-loop attempt

```json
{
  "host": "pi",
  "stage": "managed-product-loop",
  "pass": false,
  "product_bridge_closed": false,
  "default_install_closed": false,
  "error_class": "installed_profile_unresolvable",
  "failed_phase": "prepare",
  "final_counts": {
    "pi": 2,
    "claude-code": 1,
    "codex": 1,
    "opencode": 1,
    "hermes": 1
  },
  "new_native_attempts": 0,
  "timestamp": "2026-11-02T03:46:17.768Z",
  "private_auth_removed": true
}
```

## Updated authorization and live-loop blocker (supersedes earlier hold)

Parent/user raised the cumulative native/model attempt ceiling to **6 per host**, including earlier canary/extraction attempts. Rails 8087 second readiness was confirmed; the earlier HTTP/dist and extra-budget holds are lifted. Do not stop parent Puma (latest parent-reported pid 63813). No global `com.37soul` service registration is attempted. Foreground agentd functional evidence is required; background service evidence remains separately attributable to 0.13.4 history and candidate lifecycle tests.

Parent completed actual browser device-code approval plus CLI login, receiving 5 scoped credentials and a new cloud device. Runner reads the private HOME-pointer file and copies only this synthetic runtime profile into its private temporary HOME. This is stronger than the earlier seeded-PAT path; token values are never printed. It must preserve snapshot `cloud_issuer`, owner, device, defaults and product-generated active-profile metadata. It does not reuse fixture numeric device IDs or hand-edit snapshots.

**Actual Pi loop attempt at 03:46:17 UTC stopped before any new model call:** `installed_profile_unresolvable`. Before installation the approved `browser-delivery` profile was the sole profile, had owner 2, issuer 8087, 1 Soul and a selected default Soul, and the product resolver returned it. Actual installer API with `installService:false` created a second empty `default` profile plus anonymous account; the selected browser Soul/issuer were unchanged but the resolver returned null. Two repeat no-model installer preflights each used HTTP 0/native commands 0. Parent confirmed this as a real P1 and assigned an explicit active-profile TDD fix; no snapshot/profile deletion workaround was used.

Reproduction functions: `install` -> unconditional `ensureAnonymousAssetsProfile` -> writer `init_assets_profile(default)`; resolver `resolveLocalAssetsProfileSync` formerly returned null for any profile-directory count other than one. At the final readiness check in this worker's preparation phase, source contained the new active-profile contract but current `dist/local/profiles.js` and `dist/local/bindings.js` did not yet contain it, and the previously approved HOME had no `active_profile_id`. Wait for parent build plus a real login/legitimate migration to establish active state; do not rebuild or fabricate it here.

Runner focused tests are now **8/8 GREEN**. The newly authorized cumulative-six budget and real Pi session arguments first failed behaviorally before implementation; the additional OpenCode temporary-model pin regression also failed before its fix. All scripts/tests edits are currently frozen for parent full-suite coordination.

OpenCode follow-up: removed the historical hardcoded free-model identifier from future runner calls. Current host config has provider configuration but no explicit default model; the CLI is allowed to choose its configured/current default, not a guessed permanent model. Isolated-config and current-host `opencode models` discovery yielded no model identifiers and exited -9 under bounded execution; generation requests were 0. Original native baseline remains exit 1 / `native_nonzero` / no recognized assistant output; its raw diagnostics were deliberately not retained, so a provider-model root cause is not established and is not asserted. No model fallback was tried to manufacture green.

The loop runner now uses real installed managed extension discovery, persistent native sessions, real foreground agentd, real source-index/watermark/assets, actual CLI HTTP sync, the supplied Rails AssetWriter correction, and a new real session with no expected-answer tokens in the human prompt. A process-safe native gate counts both direct host calls and daemon extraction toward 6. The loop has not passed yet: it remains at the explicit profile-readiness blocker, with total counts unchanged (Pi 2, Claude/Codex/OpenCode/Hermes 1 each).

## Managed product-loop attempt

```json
{
  "host": "pi",
  "stage": "managed-product-loop",
  "pass": true,
  "product_bridge_closed": true,
  "default_install_closed": false,
  "runtime_version": "0.14.0",
  "installer_managed_extension": true,
  "service_installation": "not_run_global_service_constraint",
  "browser_login_profile_reused": true,
  "first_session_exit": 0,
  "first_session_assistant_sha256": "f50a2ef9c385b3fa0b7fe0bf92cc0ec26f6a65a7e5a76ca0744b0cd83d29d3d1",
  "native_source_refs": [
    "f3417176",
    "c44a3961"
  ],
  "watermark_completed": true,
  "asset_uid": "2cbfca80-360c-47e1-9241-f30da56e7a1f",
  "asset_state": "active",
  "asset_binding_uid": "942c97ab-6250-4ed2-ae4a-b512dfd5cc6c",
  "first_injected_receipts": 2,
  "asset_cloud_revision": 1,
  "asset_sync_state": "synced",
  "cloud_correction_exit": 0,
  "corrected_asset_uid": "941c506d-e993-4d5f-8910-f3b5f93cafdd",
  "corrected_asset_revision": 1,
  "old_asset_state": "superseded",
  "fresh_session_exit": 0,
  "fresh_assistant_sha256": "6b6bf9767f129b8e2e685a66ff2861d95013ef8f37c0077f1ab2fb1237811ff4",
  "fresh_answer_uses_correction": true,
  "answer_not_in_human_prompt": true,
  "fresh_receipt_has_corrected_asset": true,
  "fresh_receipt_excludes_old_asset": true,
  "version": "1.4.0",
  "final_counts": {
    "pi": 5,
    "claude-code": 1,
    "codex": 1,
    "opencode": 1,
    "hermes": 1
  },
  "new_native_attempts": 3,
  "timestamp": "2026-11-02T03:56:24.310Z",
  "private_auth_removed": true
}
```

## Managed product-loop attempt

```json
{
  "host": "hermes",
  "stage": "managed-product-loop",
  "pass": false,
  "product_bridge_closed": false,
  "default_install_closed": false,
  "runtime_version": "0.14.0",
  "installer_managed_extension": true,
  "service_installation": "not_run_global_service_constraint",
  "browser_login_profile_reused": true,
  "independent_synthetic_soul": true,
  "soul_uid": "df0bc268-399c-45ab-adbc-81cc0e8676f7",
  "host_id": 3,
  "cloud_device_uid": "56d35070-bd52-4c35-b83a-bc76f95fc23e",
  "first_session_exit": 0,
  "first_session_assistant_sha256": "f133595bd7d05a7fcee689aafff45d4480b89078df786cb88caaae1be1ed9c6c",
  "error_class": "evidence_timeout",
  "failed_phase": "wait-daemon-extraction",
  "final_counts": {
    "pi": 5,
    "claude-code": 5,
    "codex": 1,
    "opencode": 1,
    "hermes": 2
  },
  "new_native_attempts": 1,
  "timestamp": "2026-11-02T04:21:06.641Z",
  "private_auth_removed": true
}
```

## Managed product-loop attempt

```json
{
  "host": "codex",
  "stage": "managed-product-loop",
  "pass": false,
  "product_bridge_closed": false,
  "default_install_closed": false,
  "runtime_version": "0.14.0",
  "installer_managed_extension": true,
  "service_installation": "not_run_global_service_constraint",
  "browser_login_profile_reused": true,
  "error_class": "evidence_timeout",
  "failed_phase": "prepare",
  "final_counts": {
    "pi": 5,
    "claude-code": 5,
    "codex": 1,
    "opencode": 1,
    "hermes": 2
  },
  "new_native_attempts": 0,
  "timestamp": "2026-11-02T04:25:03.399Z",
  "private_auth_removed": true
}
```

## Managed product-loop attempt

```json
{
  "host": "hermes",
  "stage": "managed-product-loop",
  "pass": false,
  "product_bridge_closed": false,
  "default_install_closed": false,
  "runtime_version": "0.14.0",
  "installer_managed_extension": true,
  "service_installation": "not_run_global_service_constraint",
  "browser_login_profile_reused": true,
  "error_class": "evidence_timeout",
  "failed_phase": "prepare",
  "final_counts": {
    "pi": 5,
    "claude-code": 5,
    "codex": 2,
    "opencode": 1,
    "hermes": 2
  },
  "new_native_attempts": 0,
  "timestamp": "2026-11-02T04:56:09.255Z",
  "private_auth_removed": true
}
```

## Managed product-loop attempt

```json
{
  "host": "codex",
  "stage": "managed-product-loop",
  "pass": false,
  "product_bridge_closed": false,
  "default_install_closed": false,
  "preserved_official_trust_setup": true,
  "budget_gate_canonical": ".local/bin/codex",
  "daemon_resolves_gate": true,
  "runtime_version": "0.14.0",
  "official_hooks_sha256": "992f10b4390ed5358fe3d3c5caff84b7339b0611a021e9c444effa1f33008f4d",
  "installer_managed_extension": true,
  "service_installation": "not_run_global_service_constraint",
  "browser_login_profile_reused": true,
  "codex_trust_method": "parent-official-hooks-tui-confirmed",
  "independent_synthetic_soul": true,
  "soul_uid": "b9401400-db4f-4834-bc11-1fc7b52b9a8e",
  "host_id": 5,
  "cloud_device_uid": "aa0869b0-cb75-489d-af1b-9243165b0d43",
  "first_session_exit": 0,
  "first_session_assistant_sha256": "ff8d082727e3fccd57b788b79c05b659e2f1be63ba921429506432fcf77b4cb9",
  "native_source_refs": [
    "11",
    "12",
    "14",
    "16"
  ],
  "watermark_completed": true,
  "asset_uid": "438fd21c-5390-46b1-afd3-ed300bff6cac",
  "asset_state": "active",
  "asset_binding_uid": "69d70670-4bc1-4607-b982-5b465b9dd536",
  "first_injected_receipts": 2,
  "asset_cloud_revision": 1,
  "asset_sync_state": "synced",
  "error_class": "loop_setup_or_runtime_error",
  "failed_phase": "cloud-correction",
  "final_counts": {
    "pi": 5,
    "claude-code": 5,
    "codex": 4,
    "opencode": 2,
    "hermes": 2
  },
  "new_native_attempts": 2,
  "timestamp": "2026-11-02T05:11:36.948Z",
  "private_auth_removed": true
}
```

## Codex actual fresh recovery after parent website correction

```json
{
  "host": "codex",
  "stage": "fresh-recovery-after-parent-web-correction",
  "profile": "codex-recovery",
  "home": "/private/tmp/37soul-native-delivery-20261102-bounded/cx-FraEBi",
  "pass": true,
  "learn_repeated": false,
  "cloud_correction_actor": "parent actual website form",
  "official_trust_actor": "parent official /hooks TUI, PTY75745 exit0",
  "pre_native_sync": true,
  "corrected_asset_uid": "0c384e45-c255-446b-920c-a3fcf95d2105",
  "corrected_revision": 1,
  "old_active_asset_count": 0,
  "native_exit": 0,
  "native_session_id": "01a19ab4-a29a-7ba2-826e-524d500a36a0",
  "assistant_sha256": "cdbd20f1cfae9ad90a936f01fc4f9d99a86b91f53c0f1055d22b81f52727b27d",
  "answer_uses_correction": true,
  "expected_answer_absent_from_human_prompt": true,
  "fresh_binding_count": 1,
  "fresh_injected_receipts": 2,
  "receipt_has_corrected_asset": true,
  "receipt_excludes_old_asset": true,
  "official_hooks_unchanged": true,
  "counts": {
    "pi": 5,
    "claude-code": 5,
    "codex": 6,
    "opencode": 2,
    "hermes": 6
  },
  "timestamp": "2026-11-02T05:21:45.247Z",
  "home_retained_for_parent": true
}
```

## Codex final retained evidence and authorized cleanup

Fresh recovery PASS joins the prior real learn/Stop/daemon extraction/sync evidence through the same synthetic Soul and cloud asset. Website correction and both official hook approvals were performed by parent. Recovery used its newly issued device and did not repeat learning. No claim of default global-service installation.

```json
{
  "evidence": {
    "synthetic_final_answer": "### Coral\n\nFictional project \u201cPocket Garden\u201d is complete, with all planned features delivered.\n\n### Indigo\n\nAll checks passed, and the final handoff is ready.\n\n### Pearl\n\nNo blockers or remaining work.",
    "transcript_final_sha256": "cdbd20f1cfae9ad90a936f01fc4f9d99a86b91f53c0f1055d22b81f52727b27d",
    "answer_hash_matches_result": true,
    "fresh_receipt_manifests": [
      {
        "binding_uid": "92db0911-b410-4791-9a45-e9c296e0f1a8",
        "binding_revision": 1,
        "stage": "injected",
        "manifest": [
          {
            "asset_uid": "0c384e45-c255-446b-920c-a3fcf95d2105",
            "revision": 1
          }
        ],
        "rendered_sha256": "028d2ff103b2584a977df5945dd368230b244e9edb92e228877a1fdc1b596170"
      },
      {
        "binding_uid": "92db0911-b410-4791-9a45-e9c296e0f1a8",
        "binding_revision": 1,
        "stage": "injected",
        "manifest": [
          {
            "asset_uid": "0c384e45-c255-446b-920c-a3fcf95d2105",
            "revision": 1
          }
        ],
        "rendered_sha256": "028d2ff103b2584a977df5945dd368230b244e9edb92e228877a1fdc1b596170"
      }
    ],
    "official_hooks_sha256_after": "5d343a51afa8b22c3cae9e4477998febad4f042be5c9819d60a3e472f460785a"
  },
  "cleanup": {
    "host": "codex",
    "owned_processes_found_and_stopped": 4,
    "owned_processes_force_stopped": 0,
    "owned_home_dirs_removed": [
      "cx-FraEBi",
      "approved-codex-PR2eQN"
    ],
    "owned_home_dirs_remaining": 0,
    "parent_browser_home_preserved": true,
    "shared_ledger_preserved": true,
    "cloud_assets_deleted": false,
    "browser57_touched": false,
    "counts": {
      "pi": 5,
      "claude-code": 5,
      "codex": 6,
      "opencode": 2,
      "hermes": 6
    }
  }
}
```
