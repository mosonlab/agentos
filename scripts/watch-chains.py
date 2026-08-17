#!/usr/bin/env python3
"""Watch selected AgentOS chains and exit when operator attention is needed."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


API_BASE = os.environ.get("AGENTOS_API_BASE", "http://127.0.0.1:3000")
POLL_SECONDS = float(os.environ.get("AGENTOS_WATCH_POLL_SECONDS", "3"))
HEARTBEAT_SECONDS = int(os.environ.get("AGENTOS_WATCH_HEARTBEAT_SECONDS", "600"))
SEEN_PATH = Path(os.environ.get("AGENTOS_WATCH_SEEN", "/private/tmp/agentos-seen-failures.json"))
DEFAULT_CHAINS = (
    "d4d3e3ea-b123-43f4-ba76-397aa5397bdb",
    "a12d9f39-2266-4b9f-b59a-8a4b992604fd",
    "5e571ad1-8c5a-4f28-b7fb-570470d334c9",
)


def load_token() -> str:
    token = os.environ.get("OPERATOR_TOKEN")
    if token:
        return token
    for line in Path(".env").read_text().splitlines():
        if line.startswith("OPERATOR_TOKEN="):
            return line.split("=", 1)[1]
    raise RuntimeError("OPERATOR_TOKEN is unavailable")


TOKEN = load_token()


def get_json(path: str):
    request = urllib.request.Request(
        f"{API_BASE}{path}", headers={"Authorization": f"Bearer {TOKEN}"}
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def load_seen() -> set[str]:
    try:
        value = json.loads(SEEN_PATH.read_text())
        return {str(item) for item in value if isinstance(item, str)}
    except (FileNotFoundError, json.JSONDecodeError, TypeError):
        return set()


def save_seen(seen: set[str]) -> None:
    SEEN_PATH.write_text(json.dumps(sorted(seen), indent=2) + "\n")


def relevant_tasks(chain_ids: set[str], task_ids: set[str]) -> list[dict]:
    tasks = get_json("/tasks?enrich=chain")
    return sorted(
        (
            task
            for task in tasks
            if task.get("chainId") in chain_ids or task.get("id") in task_ids
        ),
        key=lambda task: (task.get("chainId") or "", task.get("chainIndex") or -1),
    )


def task_snapshot(tasks: list[dict]) -> dict[str, dict]:
    snapshot: dict[str, dict] = {}
    for task in tasks:
        runs = task.get("runs") or []
        latest = max(runs, key=lambda run: run.get("runNumber", 0), default={})
        run_status = latest.get("status")
        if run_status in {"QUEUED", "CLAIMED", "RUNNING"}:
            run_status = "ACTIVE"
        snapshot[task["id"]] = {
            "name": task.get("name"),
            "chainId": task.get("chainId"),
            "chainIndex": task.get("chainIndex"),
            "taskStatus": task.get("status"),
            "runNumber": latest.get("runNumber"),
            "runStatus": run_status,
            "headSha": latest.get("headSha"),
            "pullRequestNumber": latest.get("pullRequestNumber"),
        }
    return snapshot


def pending_inbox_ids() -> set[str]:
    return {
        message["id"]
        for message in get_json("/inbox/messages")
        if message.get("status") not in {"ANSWERED", "CLOSED"}
    }


def unseen_failures(tasks: list[dict], seen: set[str]) -> list[dict]:
    found = []
    for task in tasks:
        if task.get("status") == "DONE":
            continue
        runs = task.get("runs") or []
        latest = max(runs, key=lambda run: run.get("runNumber", 0), default=None)
        if not latest or latest.get("status") not in {"FAILED", "TIMED_OUT"}:
            continue
        key = f"{task['id']}:{latest.get('runNumber')}"
        if key in seen:
            continue
        seen.add(key)
        found.append(
            {
                "key": key,
                "taskId": task["id"],
                "name": task.get("name"),
                "taskStatus": task.get("status"),
                "runStatus": latest.get("status"),
                "failureClass": latest.get("failureClass"),
                "failureReason": latest.get("failureReason"),
                "headSha": latest.get("headSha"),
            }
        )
    return found


def emit(kind: str, payload) -> None:
    print(json.dumps({"kind": kind, "payload": payload}, ensure_ascii=False), flush=True)


def main() -> int:
    chain_ids = set(sys.argv[1:] or DEFAULT_CHAINS)
    task_ids = {
        task_id.strip()
        for task_id in os.environ.get("AGENTOS_WATCH_TASK_IDS", "").split(",")
        if task_id.strip()
    }
    seen = load_seen()
    errors = 0
    started = time.monotonic()

    while True:
        try:
            tasks = relevant_tasks(chain_ids, task_ids)
            failures = unseen_failures(tasks, seen)
            if failures:
                save_seen(seen)
                emit("new-failure", failures)
                return 0
            baseline = task_snapshot(tasks)
            inbox = pending_inbox_ids()
            break
        except (OSError, ValueError, urllib.error.URLError) as error:
            errors += 1
            if errors >= 3:
                emit("watch-error", {"error": str(error), "attempts": errors})
                return 1
            time.sleep(POLL_SECONDS)

    emit(
        "watch-started",
        {"chains": sorted(chain_ids), "standaloneTasks": sorted(task_ids), "tasks": len(baseline)},
    )
    while time.monotonic() - started < HEARTBEAT_SECONDS:
        time.sleep(POLL_SECONDS)
        try:
            tasks = relevant_tasks(chain_ids, task_ids)
            failures = unseen_failures(tasks, seen)
            if failures:
                save_seen(seen)
                emit("new-failure", failures)
                return 0
            current = task_snapshot(tasks)
            current_inbox = pending_inbox_ids()
            changes = [
                {"before": baseline.get(task_id), "after": value}
                for task_id, value in current.items()
                if baseline.get(task_id) != value
            ]
            removed = [baseline[task_id] for task_id in baseline.keys() - current.keys()]
            new_inbox = sorted(current_inbox - inbox)
            if changes or removed or new_inbox:
                emit(
                    "state-change",
                    {"changes": changes, "removed": removed, "newInboxMessageIds": new_inbox},
                )
                return 0
            errors = 0
        except (OSError, ValueError, urllib.error.URLError) as error:
            errors += 1
            if errors >= 3:
                emit("watch-error", {"error": str(error), "attempts": errors})
                return 1

    emit("watch-heartbeat", {"elapsedSeconds": HEARTBEAT_SECONDS})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
