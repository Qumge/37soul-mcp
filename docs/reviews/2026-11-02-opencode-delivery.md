# OpenCode managed delivery — 2026-11-02

Synthetic Soul; local Rails 8087; browser-approved profile reused. Actual installer with installService:false and foreground agentd. No host trust bypass. OAuth transfer uses private stdin; no secrets or raw session bodies in this report. Model invocation budget is shared and includes automatic extraction; provider-internal retries are not inferred from CLI invocation counts.

```json
{
  "timestamp": "2026-11-02T04:58:55.800Z",
  "runtime_version": "0.14.0",
  "opencode_version": "2.0.32",
  "stage": "prepared",
  "pass": false,
  "managed_install": true,
  "foreground_agentd": true,
  "soul_uid": "5611e0bc-d0ef-4ae6-b9a0-8e5a1f7c3d97",
  "service_installation": false,
  "default_install_closed": false,
  "model": "opencode/deepseek-v4.1-flash-free",
  "attempts": 1,
  "events": [],
  "error_class": null,
  "evidence": null,
  "cleanup": false
}
```

```json
{
  "timestamp": "2026-11-02T04:59:20.130Z",
  "runtime_version": "0.14.0",
  "opencode_version": "2.0.32",
  "stage": "learn_finished",
  "pass": false,
  "managed_install": true,
  "foreground_agentd": true,
  "soul_uid": "5611e0bc-d0ef-4ae6-b9a0-8e5a1f7c3d97",
  "service_installation": false,
  "default_install_closed": false,
  "model": "opencode/deepseek-v4.1-flash-free",
  "attempts": 2,
  "events": [
    {
      "stage": "learn",
      "exit": 1,
      "timeout": false,
      "stdout_bytes": 533,
      "assistant_chars": 0,
      "auth_error": false,
      "model_error": false,
      "plugin_error": false,
      "permission_error": false,
      "readiness_error": false,
      "cli_error": false,
      "answer_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ],
  "error_class": "learn_native_failed",
  "evidence": null,
  "cleanup": false
}
```

## Sanitized diagnosis and limits

The isolated OpenCode 2.0.32 server log classifies the failed learn as AI.Error.QuotaExceeded (free usage limit). No credential or private provider response is reproduced. This is not an inferred CLI, agent-field, plugin-config or readiness error. The old all-false diagnostic projection did not classify quota; the runner now classifies this failure explicitly.

Actual managed evidence: 1 matching OpenCode binding(s), 2 injected receipts; zero completed extraction watermarks, zero assistant characters. Receipts prove hook output only, not model adoption. No learned-asset sync or fresh recall was attempted.

The authenticated catalog succeeded without generation and listed both the selected free model and non-free models. Catalog presence is not proof of quota, balance or subscription entitlement. No alternate model was invoked and no subscription was purchased.

Cumulative model CLI invocations: 2/6 (one pre-existing baseline plus this failed learn); automatic extraction invocations: 0. Resolver verification selected the isolated HOME .opencode/bin/opencode budget gate; --version is exempt and run invocations are atomically charged against the shared ledger. Provider-internal HTTP retries are not independently metered by this CLI gate.

Runner tests: initial 3 RED then 3 GREEN; review follow-up exposed 3 RED (portable home, private quota classification, gate recursion protection), then 5/5 GREEN. Shared dist and production source were not rebuilt or modified. Full suite, correction, publication and deployment were not run by this worker.

```json
{
  "timestamp": "2026-11-02T05:03:21.347Z",
  "runtime_version": "0.14.0",
  "opencode_version": "2.0.32",
  "stage": "learn_finished",
  "pass": false,
  "managed_install": true,
  "foreground_agentd": true,
  "soul_uid": "5611e0bc-d0ef-4ae6-b9a0-8e5a1f7c3d97",
  "service_installation": false,
  "default_install_closed": false,
  "model": "opencode/deepseek-v4.1-flash-free",
  "attempts": 2,
  "events": [
    {
      "stage": "learn",
      "exit": 1,
      "timeout": false,
      "stdout_bytes": 533,
      "assistant_chars": 0,
      "auth_error": false,
      "model_error": false,
      "plugin_error": false,
      "permission_error": false,
      "readiness_error": false,
      "cli_error": false,
      "answer_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "error_class": "provider_quota_exceeded"
    },
    {
      "stage": "non_model_diagnosis",
      "error_class": "provider_quota_exceeded",
      "managed_bindings": 1,
      "injected_receipts": 2,
      "completed_watermarks": 0,
      "model_calls_during_diagnosis": 0
    }
  ],
  "error_class": "provider_quota_exceeded",
  "evidence": null,
  "cleanup": true
}
```

## Existing authorization follow-up

Official `opencode auth list --standalone` completed with exit 0; account labels and raw output were suppressed. Read-only credential metadata confirms one active OAuth integration (`opencode`) and no other authorized provider. The authenticated catalog lists other model IDs, but their presence does not establish quota or subscription entitlement. No alternative model request was made, no credits were purchased, and no new authorization was created.

The external `provider_quota_exceeded` blocker remains. Evidence ends at one matching managed binding and two injected receipts, not model consumption, extraction, synced learned assets or fresh-session recall. Product PASS is not asserted. Cumulative invocation count remains 2/6. Independent runner pure tests were rerun: 5/5 passed, zero skipped; runner and test files remain frozen.
