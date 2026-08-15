#!/usr/bin/env python3
"""Run one CLI experiment with closed stdin, a hard timeout, and raw evidence files."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 5 or sys.argv[3] != "--":
        print("usage: run_capture.py OUTPUT_PREFIX TIMEOUT_SECONDS -- COMMAND ...", file=sys.stderr)
        return 64

    prefix = Path(sys.argv[1])
    timeout_seconds = float(sys.argv[2])
    command = sys.argv[4:]
    prefix.parent.mkdir(parents=True, exist_ok=True)

    started_at = time.time()
    timed_out = False
    sent_signal = None
    timeout_signal = os.environ.get("RUN_CAPTURE_TIMEOUT_SIGNAL", "TERM").upper()
    if timeout_signal not in {"TERM", "KILL"}:
        print("RUN_CAPTURE_TIMEOUT_SIGNAL must be TERM or KILL", file=sys.stderr)
        return 64
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        if timeout_signal == "KILL":
            sent_signal = "SIGKILL"
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        else:
            sent_signal = "SIGTERM"
            os.killpg(process.pid, signal.SIGTERM)
            try:
                stdout, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                sent_signal = "SIGKILL"
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = process.communicate()

    ended_at = time.time()
    prefix.with_suffix(".stdout").write_bytes(stdout)
    prefix.with_suffix(".stderr").write_bytes(stderr)
    prefix.with_suffix(".meta.json").write_text(
        json.dumps(
            {
                "argv": command,
                "cwd": os.getcwd(),
                "started_at_epoch": started_at,
                "duration_seconds": round(ended_at - started_at, 3),
                "timeout_seconds": timeout_seconds,
                "timed_out": timed_out,
                "timeout_signal": sent_signal,
                "returncode": process.returncode,
            },
            indent=2,
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
