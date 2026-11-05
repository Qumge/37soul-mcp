# Local persona read routing repair

User request: inspect the complete read flow and fix the detour into operator credentials/browser when a connected Soul is asked about posts, media, social life or memory.

Evidence: lightweight connect deliberately omits recent_life/photos/videos/circle/thread; full local whoami already returns them through existing scoped credentials. Skill operator routing currently catches social questions before that local read is considered. A live read of the already selected host276 confirmed two retained posts and one public photo. Do not use that private identity for model evaluation.

Decision: retain compact connect; add bounded, target-specific read capabilities, also on local context recovery. Update the Skill's first intent routing, operator reference and public guide. Existing whoami/recall paths perform every read; no new API, credentials, MCP server, automatic fetch, paid write or browser integration.

Read table: persona/life/retained posts/public media/circle/thread -> whoami for the verified selected Host ID/runtime; user facts/preferences -> recall --host ID --kind relationship; reusable methods -> kind experience. Reuse already held matching data; fresh social questions may refresh whoami once. No routine status/help/doctor/host preflight for a known target. No --all fallback. Missing, empty and dated results remain labelled; two posts is a bounded recent snapshot, not complete history. Writes/new media stay explicitly authorized operator actions. First-use consent, owner/device/issuer/runtime isolation and denial remain unchanged.

Limits: connect remains below existing2500-byte rich fixture bound, with no additional HTTP request. Context recovery including its read hint stays within4096 bytes plus final newline. Unknown/malformed host/runtime cannot produce executable hints. No body/album data is preloaded. No additional paid model evaluations; screenshot is the observed baseline failure, offline consuming-CLI tests prove command behavior rather than model adoption.
