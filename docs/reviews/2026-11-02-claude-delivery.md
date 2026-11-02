# Claude Code delivery acceptance — 2026-11-02


**Result: Claude Code 2.1.316 / runtime candidate 0.14.0 functional loop PASS**, including the optional cloud-correction loop. This is local native + isolated Rails acceptance, not deployment, a production test, global service installation or browser memory-editor acceptance.

The parent-approved `browser-delivery` profile was cloned into a private 0700 HOME. Five issuer-bound runtime credentials were reused locally; no new device-code login or polling was performed. Actual installer API ran with `installService:false` and installed managed user-level Claude hooks. The runtime was built separately under `/private/tmp`; shared `dist`, real `~/.claude`, runtime source and Godel's runner were not modified by this acceptance task.

A dedicated synthetic Soul was created, selected for Claude Code, authorized and registered by the real 37soul CLI under local test user 2. It was distinct from the Pi Soul. The source preference was supplied only as a natural first-turn user request; later human prompts contained neither original nor replacement headings. No system-prompt answer injection, session-persistence disablement for product sessions, permission bypass, fake hook approval or manually seeded extraction was used.

| Stage | Observed evidence |
| --- | --- |
| Managed first session | Native exit 0; normal transcript persistence; foreground agentd produced a completed Claude extraction watermark from 3 source refs. |
| Local to cloud | Newly extracted asset reached sync_state=synced with cloud revision 1 through actual local Rails 8087 push/pull. |
| Fresh native recall | New session exit 0; assistant adopted Copper / Silver / Tin; a new injected receipt included the extracted asset. |
| Owned cloud correction | Private Rails runner resolved `user.created_hosts` by the newly created Soul UID, verified the synthetic owner, and invoked the same AssetWriter service used by website edits. No fixture Host 1 assumption. |
| Corrected fresh session | Another new session exit 0; assistant adopted Flint / River / Star; a new injected receipt included the replacement and excluded the old asset. |
| Cleanup | Owned foreground agentd stopped; private HOME, persisted synthetic native transcripts and copied auth material removed in finally. Synthetic local-test Rails records remain as evidence. |

Budget: historical Claude baseline 1 + first product session 1 + automatic extraction 1 + fresh recall 1 + corrected fresh session 1 = **5/6 cumulative**, **4 new**. A process-persistent gate shared by direct Claude calls and daemon extraction hard-refuses a seventh invocation. No native retry or additional canary was spent. These are native invocation counts, not an independent provider HTTP/billing audit.

Verification of this runner: focused pure plan/gate tests **RED 4 tests / 0 pass / 4 fail → GREEN 4 tests / 4 pass / 0 fail**; `node --check` passed. The isolated unmodified runtime TypeScript/esbuild build completed. No full suite was run by this worker during acceptance.

Synthetic data only; dedicated owned Soul under local test user 2. No production/deployment/global service changes. Native invocation counts include automatic daemon extraction; they are not a provider billing audit. Existing browser approval was reused, no device-code polling.

```json
{
  "host": "claude-code",
  "runtime_version": "0.14.0",
  "native_version": "2.1.316",
  "core_pass": true,
  "correction_pass": true,
  "service_installation": "not_run",
  "cloud_environment": "isolated Rails 8087 / test delivery auth DB",
  "prior_native_calls": 1,
  "soul_uid": "8cdd01be-eb87-4112-87c8-415fccc3b399",
  "owned_soul_registered": true,
  "managed_hooks_installed": true,
  "learn": {
    "code": 0,
    "timeout": false,
    "assistant_chars": 288,
    "assistant_sha256": "2fc2f9c4a722f611acf2101fe7a0a43b865096dba869a08d4a5439fc8691e25a",
    "session_id": "c5298368-8ac1-4fb2-8aa7-47c98212e724"
  },
  "automatic_extraction_completed": true,
  "source_ref_count": 3,
  "asset_uid": "45116466-c8cd-4cf3-b629-e2e52087ddd9",
  "cloud_asset_revision": 1,
  "recall": {
    "code": 0,
    "timeout": false,
    "assistant_chars": 535,
    "assistant_sha256": "f53d731bd4cffa5998382c8f666788d81a9dfb6928badfcb6013613745a6e8ed",
    "session_id": "448bffbf-ad44-4133-b9eb-3867abf2d17b",
    "answer_uses_preference": true,
    "injected_receipt_has_asset": true,
    "answer_not_in_prompt": true
  },
  "cloud_correction_method": "local-test-Rails-AssetWriter-owned-Soul",
  "cloud_correction_exit": 0,
  "corrected": {
    "code": 0,
    "timeout": false,
    "assistant_chars": 259,
    "assistant_sha256": "577208b524091a66199b1d210506c454946a2314cca820dff540e3ba7b4e474e",
    "session_id": "73d2b8f5-397a-412e-8832-b4814d889191",
    "answer_uses_correction": true,
    "answer_not_in_prompt": true,
    "receipt_has_replacement": true,
    "receipts_exclude_old": true
  },
  "corrected_asset_uid": "8884d503-2f43-466d-9de2-59fcc5bc0788",
  "private_auth_removed": true,
  "cumulative_native_calls": 5,
  "new_native_calls": 4,
  "timestamp": "2026-11-02T04:17:53.674Z"
}
```

Cloud correction, if completed, used the website AssetWriter service through a private local Rails runner scoped by owner and Soul UID; it was not browser UI acceptance. Session persistence was enabled for product sessions; extraction uses the runtime adapter's own invocation contract. Native raw output/authentication material was never included in this report.

Isolated candidate bundle SHA-256 (built from the current 0.14.0 source):

```json
{
  "cli.js": "41583d67b1337d644b46b623fead9864c524047b443b8f36d358eca3b0a34c33",
  "index.js": "7ceb3d0c4552d265e256313cdfc236535b5a35a051e40a04ded97d4b30b6be38"
}
```

## Future-run gate hardening after PATH resolver review

The completed Claude run above preceded the PATH resolver changes; its evidence and 5/6 cumulative native count remain unchanged. Future Claude runner setup now installs the counting gate as the isolated HOME canonical `.local/bin/claude`, rather than relying only on a prepended `native-bin` PATH entry. Both direct product calls and automatic daemon extraction therefore select the gate before a competing node-directory or HOME launcher. The gate still invokes the explicitly recorded external real binary after reserving budget.

Focused pure tests used executable fake files with the actual resolver but spawned no native processes: RED 7 tests / 5 pass / 2 fail -> GREEN 7 tests / 7 pass / 0 fail. Cases cover a competing node-bin Claude and a pre-existing isolated canonical Claude; real user HOME gate installation is refused. No runtime or Godel runner source was edited, no shared dist was rebuilt, and no additional native/API acceptance was run.
