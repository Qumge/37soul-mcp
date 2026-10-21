#!/usr/bin/env python3
"""37soul Hermes shell hook.

Installed as ONE managed script under ~/.hermes/agent-hooks and referenced from
the `hooks:` block in ~/.hermes/config.yaml. It uses only the documented Hermes
shell-hook JSON protocol:

  pre_llm_call  -> write the real user turn to a local trace, ask the local 37soul
                   hook for context, and return {"context": text}
  post_llm_call -> append the real assistant turn, then notify the local writer
                   with Stop + the trace path so extraction can schedule

No network call is made here, and no conversation text is uploaded. A failure is
always a no-op: Hermes keeps working.
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

TRACE_DIR = ".37soul"
TIMEOUT_SECONDS = 2.0


def _soul_home():
    return Path(os.environ.get("SOUL37_HOME") or os.path.expanduser("~"))


def _launcher():
    env = os.environ.get("SOUL37_LAUNCHER")
    if env and os.path.isfile(env):
        return env
    local = os.path.expanduser("~/.local/bin/37soul")
    if os.path.isfile(local):
        return local
    return "37soul"


def _trace_path(session_id):
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(session_id))
    directory = _soul_home() / TRACE_DIR / "hermes-sessions"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory / (safe + ".jsonl")


def _append(session_id, record):
    file = _trace_path(session_id)
    try:
        with open(file, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return file


def _last_record(session_id):
    try:
        with open(_trace_path(session_id), encoding="utf-8") as handle:
            lines = [line for line in handle.read().splitlines() if line.strip()]
        return json.loads(lines[-1]) if lines else None
    except (OSError, ValueError):
        return None


def _extra(payload):
    value = payload.get("extra")
    return value if isinstance(value, dict) else {}


def _field(payload, key):
    value = payload.get(key)
    if value is not None:
        return value
    return _extra(payload).get(key)


def _turn_id(payload):
    for key in ("turn_id", "task_id", "message_id"):
        value = _field(payload, key)
        if isinstance(value, str) and value:
            return value
    user = _field(payload, "user_message")
    return hashlib.sha1(str(user).encode("utf-8")).hexdigest()[:24]


def _run_hook(event, payload):
    try:
        completed = subprocess.run(
            [_launcher(), "hook", "--agent", "hermes", "--event", event],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
            env=os.environ.copy(),
        )
        return completed.stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _context_from(stdout):
    try:
        parsed = json.loads(stdout)
        value = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
        return value.strip() if isinstance(value, str) else ""
    except (ValueError, AttributeError):
        return ""


def _record_request(payload, session_id, cwd):
    text = _field(payload, "user_message")
    if not isinstance(text, str) or not text.strip():
        return
    turn_id = _turn_id(payload)
    last = _last_record(session_id)
    if last and last.get("type") == "user_message" and last.get("id") == turn_id:
        return
    _append(session_id, {
        "type": "user_message",
        "id": turn_id,
        "session_id": session_id,
        "text": text,
    })


def _record_assistant(payload, session_id):
    text = _field(payload, "assistant_response")
    if not isinstance(text, str) or not text.strip():
        return ""
    message_id = "assistant-" + _turn_id(payload)
    _append(session_id, {
        "type": "assistant_message",
        "id": message_id,
        "session_id": session_id,
        "text": text,
    })
    return text


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    event = argv[0] if argv else ""
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    if not isinstance(payload, dict):
        return 0
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return 0
    cwd = _field(payload, "cwd") or payload.get("working_directory") or os.getcwd()

    try:
        if event == "pre_llm_call":
            _record_request(payload, session_id, cwd)
            file = _trace_path(session_id)
            session_stdout = _run_hook("SessionStart", {
                "session_id": session_id,
                "cwd": cwd,
                "source": "startup",
                "transcript_path": str(file),
            })
            user_text = _field(payload, "user_message")
            prompt_stdout = ""
            if isinstance(user_text, str) and user_text.strip():
                prompt_stdout = _run_hook("UserPromptSubmit", {
                    "session_id": session_id,
                    "cwd": cwd,
                    "prompt": user_text,
                    "transcript_path": str(file),
                })
            contexts = []
            for out in (session_stdout, prompt_stdout):
                value = _context_from(out)
                if value and value not in contexts:
                    contexts.append(value)
            context = "\n\n".join(contexts)
            print(json.dumps({"context": context} if context else {}))
        elif event == "post_llm_call":
            _record_request(payload, session_id, cwd)
            response = _record_assistant(payload, session_id)
            file = _trace_path(session_id)
            _run_hook("Stop", {
                "session_id": session_id,
                "cwd": cwd,
                "transcript_path": str(file),
                "last_assistant_message": response,
            })
            print("{}")
    except Exception:
        # A broken hook must never fail a Hermes turn.
        print("{}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
