# 37Soul current-protocol delivery contract

User-approved objective: a new user follows public documentation and completes installation, login, selecting/creating a Soul, native session context, extraction, asset sync, website correction, a fresh native session, and revocation. Do not merely remove README caveats. No compatibility with old host versions or raw transcript protocols is required. Existing user assets, identities, credentials and host-owned trust preferences are preserved; no automatic data deletion or trust bypass.

Only soul-assets/v1 is the local runtime's sync protocol. Missing, damaged or unknown mode metadata never grants raw upload permission. Remove legacy transcript uploads and legacy MCP transcript writeback tools. Existing current host mapping named legacy_host_id remains until a separate coordinated schema change; its name does not make it obsolete.

Credentials must be bound to the normalized issuing server as well as profile, owner, device and runtime. Server changes require fresh credentials; never forward old credentials to another server. Server token authentication must reject banned users across PAT, MCP, sync and Mobile JWT routes.

Five promised hosts: Claude Code, Codex, OpenCode, Hermes and Pi. Use current tested host interfaces rather than compatibility branches. Install, capture, native extraction, local asset persistence, consent sync, current-session context and fresh-session cloud correction must be individually demonstrated per host. No fabricated capability flags or disabling host trust. A runtime that cannot provide a promised capability is not release-ready.

Public README in en/zh-CN/ja: exact supported versions, prerequisites, copyable valid commands (no optional brackets mixed into commands), explicit approval steps required by host, local-only start and authorized sync, success checks and recoverable failure instructions. Download traffic is not 'zero HTTP requests'; anonymous installation performs no account API or transcript upload. Internal counts, historical smoke and validation gaps belong in developer evidence, never silently reclassified as complete.

Release distribution stays GitHub tarball plus checksum, manifest and VERSION through website install.sh. No npm publication. Local tests, native real runs, package validation, GitHub CI, release upload and public curl verification are separate gates. Merge/push/release and modifying the user's installed runtime are not performed merely because implementation is ready.
