# Hermes managed delivery evidence — 2026-11-02

Synthetic-only local Rails 8087 acceptance. The parent reviewed both managed commands in an actual Hermes chat PTY, answered the official consent prompts, and exited without a model prompt. The recorded allowlist and script mtime were verified before the run. No marker-based approval, trust bypass, service installation or real HOME configuration modification was used.

The core managed flow passed: actual installed hooks → real native learn → foreground-agentd automatic extraction → HTTP asset sync ACK → a different native session recalling the learned headings without those headings in its human prompt. The native Hermes database independently confirms the final answer and label order. Injected receipts establish hook output; model adoption is established separately by the final assistant answer.

This is not a default installer/launchd PASS or complete five-host release qualification. Website correction was not attempted: the learn, automatic extraction, fresh recall and its automatic extraction used the four remaining model entries, reaching the 6/6 cumulative cap. No parent web edit is needed now; an edit alone cannot prove post-edit model adoption without a separately authorized future budget. Any future correction must resolve the actual Soul UID and owner-scoped host 6, never fixture host 1.

The failed preparation was a harness path-length issue: a 105-byte Unix-domain socket path produced EINVAL. A shorter isolated HOME reduced it to 86 bytes and the unchanged installer succeeded. Shared source, tests and dist were not modified or rebuilt.

```json
{
  "timestamp": "2026-11-02T05:18:32.742234+00:00",
  "runtime_version": "0.14.0",
  "host": "hermes",
  "core_managed_loop_pass": true,
  "default_install_closed": false,
  "service_installation": false,
  "foreground_agentd_used": true,
  "official_parent_tty_consent": true,
  "official_approved_events": [
    "pre_llm_call",
    "post_llm_call"
  ],
  "approved_script_sha256": "3e505f6b320facc6c8939f53cec0c06ea80c70efdf8bb133bde5cd7a9057e941",
  "no_reinstall_after_approval": true,
  "independent_soul_uid": "a3473ba6-0bda-4ca0-8533-50bcc88df0a6",
  "actual_owner_host_id": 6,
  "owner_id": "2",
  "asset_uid": "52783fa8-256a-4e8f-96d1-92df3091acc8",
  "learn": {
    "exit": 0,
    "stdout_chars": 165,
    "assistant_sha256": "e99fdcf26acee6cddfb8088c522a4d776891b909de353f2eb1264558335462a0",
    "quota_error": false,
    "auth_error": false,
    "hook_error": false
  },
  "automatic_extraction": {
    "asset_found": true,
    "watermarks": [
      {
        "completed": true,
        "attempts": 1,
        "last_error": null,
        "source_turn_refs": [
          "20261102_131523_0d4f8e:67ee1519-e9c4-4913-af67-f5d3afdd7c7d:6ee1d705",
          "assistant-20261102_131523_0d4f8e:67ee1519-e9c4-4913-af67-f5d3afdd7c7d:6ee1d705"
        ]
      }
    ],
    "injected_receipts": 2
  },
  "cloud_ack": {
    "sync_state": "synced",
    "cloud_revision": 1
  },
  "fresh": {
    "exit": 0,
    "assistant_sha256": "d03e980f8483853b2831a47818283912ccde83d1f100079ee01d8d7c9f9d06ff",
    "assistant_chars": 337,
    "uses_learned_labels": true,
    "answer_not_in_prompt": true,
    "new_session_binding": true,
    "receipt_contains_asset": true,
    "new_injected_receipts": 2
  },
  "fresh_native_db_assistant_chars": 261,
  "fresh_native_db_assistant_sha256": "392df42d96f1e3d9742be1faad007b60918e93113b0dc32a651ac49843bfda1e",
  "fresh_native_db_label_order_confirmed": true,
  "fresh_receipts": [
    {
      "binding_uid": "39668d11-dfb5-4120-a1e9-50398eb80d9d",
      "stage": "injected",
      "manifest": [
        {
          "asset_uid": "52783fa8-256a-4e8f-96d1-92df3091acc8",
          "revision": 1
        }
      ],
      "rendered_sha256": "9c30970cad7acefbb85824898641f022085b5ed0671a58e38ee9b4cd8b082020"
    },
    {
      "binding_uid": "39668d11-dfb5-4120-a1e9-50398eb80d9d",
      "stage": "injected",
      "manifest": [
        {
          "asset_uid": "52783fa8-256a-4e8f-96d1-92df3091acc8",
          "revision": 1
        }
      ],
      "rendered_sha256": "9c30970cad7acefbb85824898641f022085b5ed0671a58e38ee9b4cd8b082020"
    }
  ],
  "completed_native_turns": 2,
  "gate_entries": [
    {
      "host": "hermes",
      "count": 3,
      "internal": false,
      "at": "2026-11-02T05:15:22.691Z"
    },
    {
      "host": "hermes",
      "count": 4,
      "internal": true,
      "at": "2026-11-02T05:15:28.320Z"
    },
    {
      "host": "hermes",
      "count": 5,
      "internal": false,
      "at": "2026-11-02T05:16:24.716Z"
    },
    {
      "host": "hermes",
      "count": 6,
      "internal": true,
      "at": "2026-11-02T05:16:28.347Z"
    }
  ],
  "cumulative_budget": 6,
  "model_calls_after_cap": 0,
  "cloud_correction_verified": false,
  "parent_web_edit_needed_now": false,
  "correction_not_run_reason": "budget_exhausted_after_core_loop_and_automatic_extraction",
  "harness_preparation_root_cause": "105-byte Unix socket path returned EINVAL; shorter 86-byte path succeeded; no global product modification",
  "owned_daemon_stopped": true,
  "isolated_private_home_removed": true,
  "old_incomplete_home_credential_copies_removed": true
}
```
