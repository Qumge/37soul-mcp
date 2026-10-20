/**
 * Task 9: the single managed Hermes bridge file (Python).
 *
 * One static, self-contained Python file (standard library only — no third-party
 * Python dependency) is written into the user's Hermes plugin directory and
 * recorded in the install manifest by exact path + SHA-256. Install backs it up
 * and replaces only this one entry; uninstall removes only this one entry —
 * another vendor's plugin file is never touched.
 *
 * The bridge performs no model call and schedules nothing itself: it only forwards
 * the native session/request/message lifecycle to the local 37soul writer by
 * invoking `hook --agent hermes --event <event>` with a fixed argv list (no shell),
 * a bounded payload and a short timeout. A bridge failure never fails the user's
 * work and never writes to the host's stdout; every error path exits 0.
 *
 * The whole hook/plugin API shape is UNVERIFIED: no authorized live probe has
 * confirmed it against a real Hermes host. It exists as explicit data so the
 * adapter can record the modeled mechanism (install/doctor) without claiming the
 * CLI surface is verified. The canonical source lives beside this module in
 * `hermes.py`; the byte-identical copy below is embedded so the dist/bundle
 * runtime can install it without shipping a separate .py next to the bundle.
 */

/** The exact file name install writes into the plugin directory (the only entry we own). */
export const HERMES_PLUGIN_FILENAME = "37soul-soul.py" as const;

/**
 * The complete, self-contained Python bridge source, installed verbatim. Standard
 * library only (json/os/subprocess/sys); no third-party Python dependency. The
 * marker `hermes_bridge` is declared so tests can pin that the installed file is
 * exactly this source.
 */
export const HERMES_PLUGIN_SOURCE = `#!/usr/bin/env python3
"""
37soul Hermes bridge -- ONE managed static file.

UNVERIFIED against a live Hermes host: the hook/plugin API shape below is
MODELED, not confirmed by an authorized live probe. It performs no model call
and schedules nothing -- it forwards the native session/request/message
lifecycle to the local 37soul writer via \`hook --agent hermes --event <event>\`.
A bridge failure never fails the user's work and never writes to the host's
stdout. Standard library only -- no third-party Python dependency.
"""

import json
import os
import subprocess
import sys

# The bridge spawns exactly ONE command: the installed 37soul launcher's local
# \`hook --agent hermes --event <event>\` -- a fixed argv list (no shell), never the
# host runtime, never a network call. Exit code 0 is the only success signal
# relied on; the writer's own exit code is never inspected.
MAX_BRIDGE_PAYLOAD_BYTES = 8192
BRIDGE_TIMEOUT_SECONDS = 2.0


def _launcher():
    env = os.environ.get("SOUL37_LAUNCHER")
    if env and os.path.isfile(env):
        return env
    local = os.path.join(os.path.expanduser("~"), ".local", "bin", "37soul")
    if os.path.isfile(local):
        return local
    return "37soul"


def _bounded_payload(payload):
    if not isinstance(payload, dict):
        payload = {}
    bounded = {}
    for key, value in payload.items():
        if isinstance(value, str):
            value = value[:1024]
        bounded[key] = value
    try:
        text = json.dumps(bounded)
    except (TypeError, ValueError):
        text = "{}"
    if len(text.encode("utf-8")) > MAX_BRIDGE_PAYLOAD_BYTES:
        text = text[:MAX_BRIDGE_PAYLOAD_BYTES]
    return text


def _bridge(event, payload):
    """Forward one lifecycle event to the local writer.

    Never raises and never waits past the timeout: a bridge failure never fails
    the user's work. The writer's exit code is deliberately ignored -- the only
    outcome the host depends on is that this call returns.
    """
    try:
        proc = subprocess.Popen(
            [_launcher(), "hook", "--agent", "hermes", "--event", event],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return
    try:
        proc.communicate(_bounded_payload(payload).encode("utf-8"), timeout=BRIDGE_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        try:
            proc.kill()
        except OSError:
            pass
        try:
            proc.communicate()
        except OSError:
            pass


def _session_id(payload):
    if not isinstance(payload, dict):
        return None
    for key in ("session_id", "sessionID", "sessionId"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def on_event(event, payload=None):
    """Modeled Hermes hook surface (UNVERIFIED). Always returns {}."""
    if not isinstance(payload, dict):
        payload = {}
    sid = _session_id(payload)
    if not sid:
        return {}
    mapping = {
        "session.started": ("SessionStart", lambda p: {"session_id": sid, "cwd": p.get("cwd"), "source": "startup"}),
        "session.reset": ("SessionStart", lambda p: {"session_id": sid, "cwd": p.get("cwd"), "source": "reset"}),
        "session.ended": ("SessionEnd", lambda p: {"session_id": sid}),
        "session.compacted": ("PreCompact", lambda p: {"session_id": sid}),
        "request.submitted": ("UserPromptSubmit", lambda p: {"session_id": sid, "prompt": p.get("prompt", "")}),
        "message.completed": ("Stop", lambda p: {"session_id": sid, "last_assistant_message": p.get("message", "")}),
    }
    mapped = mapping.get(event)
    if mapped is None:
        return {}
    hook_event, build = mapped
    _bridge(hook_event, build(payload))
    return {}


def main(argv=None):
    """Read a JSON event from stdin and forward it. Always exit 0."""
    argv = argv if argv is not None else sys.argv[1:]
    event = argv[0] if argv else ""
    if not event:
        return 0
    try:
        payload = json.load(sys.stdin)
    except (TypeError, ValueError):
        payload = {}
    try:
        on_event(event, payload)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
