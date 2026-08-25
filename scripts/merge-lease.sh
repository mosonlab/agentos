#!/usr/bin/env bash
#
# Serialize the final merge window through one ref on origin:
#
#   scripts/merge-lease.sh acquire --reason "Merge PR #123" [--task task-id]
#   scripts/merge-lease.sh status
#   scripts/merge-lease.sh release
#   scripts/merge-lease.sh steal --reason "Recover abandoned merge" [--human]
#
# Writing code and pushing a feature branch do not need this lease. Hold it only
# while integrating the latest main, proving the exact candidate, and advancing
# main. There is deliberately no heartbeat: a machine may steal a lease only
# after 45 minutes, while a human may steal it immediately. Release removes only
# a lease you hold; breaking somebody else's lease requires steal.
set -uo pipefail

LEASE_REF="refs/merge-lease/holder"
POLL_SECONDS="${MERGE_LEASE_POLL_SECONDS:-30}"
TIMEOUT_MINUTES="${MERGE_LEASE_TIMEOUT_MINUTES:-60}"
STALE_SECONDS=$((45 * 60))
EXIT_TIMEOUT=75

COMMAND="${1:-}"
[ $# -eq 0 ] || shift
REASON=""
TASK=""
HUMAN=0
HOLDER="${MERGE_LEASE_HOLDER:-}"

usage() {
  sed -n '2,14p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
  exit "${1:-0}"
}

die() {
  printf 'merge-lease: %s\n' "$1" >&2
  exit "${2:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --reason)
      [ $# -ge 2 ] || die "--reason needs a value" 2
      REASON="$2"
      shift ;;
    --reason=*) REASON="${1#--reason=}" ;;
    --task)
      [ $# -ge 2 ] || die "--task needs a value" 2
      TASK="$2"
      shift ;;
    --task=*) TASK="${1#--task=}" ;;
    --holder)
      [ $# -ge 2 ] || die "--holder needs a value" 2
      HOLDER="$2"
      shift ;;
    --holder=*) HOLDER="${1#--holder=}" ;;
    --poll-seconds)
      [ $# -ge 2 ] || die "--poll-seconds needs a number" 2
      POLL_SECONDS="$2"
      shift ;;
    --poll-seconds=*) POLL_SECONDS="${1#--poll-seconds=}" ;;
    --timeout-minutes)
      [ $# -ge 2 ] || die "--timeout-minutes needs a number" 2
      TIMEOUT_MINUTES="$2"
      shift ;;
    --timeout-minutes=*) TIMEOUT_MINUTES="${1#--timeout-minutes=}" ;;
    --human) HUMAN=1 ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
  shift
done

case "$COMMAND" in
  acquire|release|status|steal) ;;
  -h|--help) usage 0 ;;
  "") usage 2 ;;
  *) die "unknown command: $COMMAND" 2 ;;
esac
case "$POLL_SECONDS" in ''|*[!0-9]*|0) die "--poll-seconds needs a positive number, got: $POLL_SECONDS" 2 ;; esac
case "$TIMEOUT_MINUTES" in ''|*[!0-9]*) die "--timeout-minutes needs a number, got: $TIMEOUT_MINUTES" 2 ;; esac
case "$HUMAN" in 0|1) ;; *) die "--human is invalid" 2 ;; esac
if [ "$COMMAND" = "acquire" ] || [ "$COMMAND" = "steal" ]; then
  [ -n "$REASON" ] || die "$COMMAND requires --reason" 2
fi
if [ "$COMMAND" != "steal" ] && [ "$HUMAN" -eq 1 ]; then
  die "--human is valid only with steal" 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || die "${REPO_ROOT} is not a git repository"
git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1 \
  || die "${REPO_ROOT} has no origin remote"

if [ -z "$HOLDER" ]; then
  holder_user="$(id -un 2>/dev/null)" || die "could not determine the current user"
  holder_host="$(hostname -s 2>/dev/null || hostname 2>/dev/null)" \
    || die "could not determine the current host"
  HOLDER="${holder_user}@${holder_host}"
fi

RETRY_OUTPUT=""
retry_git() {
  local label="$1" attempt status
  shift
  for attempt in 1 2 3; do
    RETRY_OUTPUT="$(GIT_TERMINAL_PROMPT=0 "$@" 2>&1)"
    status=$?
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      printf 'merge-lease: %s failed; retrying attempt=%s/3\n' "$label" "$((attempt + 1))" >&2
      sleep "$attempt"
    fi
  done
  [ -z "$RETRY_OUTPUT" ] || printf '%s\n' "$RETRY_OUTPUT" >&2
  return "$status"
}

REMOTE_SHA=""
read_remote_sha() {
  retry_git "origin lease read" git -C "$REPO_ROOT" ls-remote --refs origin "$LEASE_REF" \
    || return 1
  REMOTE_SHA="$(printf '%s\n' "$RETRY_OUTPUT" | awk -v ref="$LEASE_REF" '$2 == ref {print $1; exit}')"
  if [ -n "$REMOTE_SHA" ]; then
    case "$REMOTE_SHA" in *[!0-9a-f]*) return 1 ;; esac
    [ "${#REMOTE_SHA}" -eq 40 ] || return 1
  fi
}

LEASE_JSON=""
load_lease() {
  read_remote_sha || die "could not read ${LEASE_REF} from origin after 3 attempts"
  [ -n "$REMOTE_SHA" ] || { LEASE_JSON=""; return 0; }
  if ! git -C "$REPO_ROOT" cat-file -e "${REMOTE_SHA}^{blob}" 2>/dev/null; then
    retry_git "origin lease fetch" git -C "$REPO_ROOT" fetch --no-tags --no-write-fetch-head origin "$LEASE_REF" \
      || die "could not fetch ${LEASE_REF} from origin after 3 attempts"
  fi
  LEASE_JSON="$(git -C "$REPO_ROOT" cat-file blob "$REMOTE_SHA" 2>/dev/null)" \
    || die "origin lease ${REMOTE_SHA} is not a readable blob"
  printf '%s' "$LEASE_JSON" | node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      let lease;
      try { lease = JSON.parse(body); } catch { process.exit(1); }
      if (!lease || typeof lease !== "object" || Array.isArray(lease)
          || typeof lease.holder !== "string" || lease.holder.length === 0
          || typeof lease.acquiredAt !== "string" || Number.isNaN(Date.parse(lease.acquiredAt))
          || typeof lease.reason !== "string" || lease.reason.length === 0) process.exit(1);
    });
  ' || die "origin lease ${REMOTE_SHA} contains invalid JSON"
}

NEW_SHA=""
make_lease_blob() {
  local stolen_json="${1:-}" acquired_at token
  acquired_at="$(node -e 'process.stdout.write(new Date().toISOString())')" \
    || die "could not create an acquisition timestamp"
  token="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')" \
    || die "could not create a lease token"
  NEW_SHA="$(node -e '
    const [holder, task, acquiredAt, reason, token, stolen] = process.argv.slice(1);
    const lease = { holder, acquiredAt, reason, token };
    if (task) lease.task = task;
    if (stolen) lease.stolenFrom = JSON.parse(stolen);
    process.stdout.write(JSON.stringify(lease) + "\n");
  ' "$HOLDER" "$TASK" "$acquired_at" "$REASON" "$token" "$stolen_json" \
    | git -C "$REPO_ROOT" hash-object -w --stdin)" \
    || die "could not create the lease object"
}

# Return 0 when this object owns the ref, 1 when another holder won, and 2 for
# an operational failure. A unique token makes an ambiguous successful push
# distinguishable from somebody else's lease.
try_create_lease() {
  local attempt status
  for attempt in 1 2 3; do
    RETRY_OUTPUT="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" push --porcelain origin "${NEW_SHA}:${LEASE_REF}" 2>&1)"
    status=$?
    read_remote_sha || return 2
    if [ "$REMOTE_SHA" = "$NEW_SHA" ]; then
      return 0
    fi
    if [ -n "$REMOTE_SHA" ]; then
      return 1
    fi
    if [ "$status" -eq 0 ]; then
      printf 'merge-lease: push reported success but %s is absent\n' "$LEASE_REF" >&2
      return 2
    fi
    if [ "$attempt" -lt 3 ]; then
      printf 'merge-lease: lease create push failed; retrying attempt=%s/3\n' "$((attempt + 1))" >&2
      sleep "$attempt"
    fi
  done
  [ -z "$RETRY_OUTPUT" ] || printf '%s\n' "$RETRY_OUTPUT" >&2
  return 2
}

replace_lease() {
  local observed_sha="$1" attempt status
  for attempt in 1 2 3; do
    RETRY_OUTPUT="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" push --porcelain \
      --force-with-lease="${LEASE_REF}:${observed_sha}" origin "${NEW_SHA}:${LEASE_REF}" 2>&1)"
    status=$?
    read_remote_sha || die "could not verify ${LEASE_REF} after the steal push"
    [ "$REMOTE_SHA" = "$NEW_SHA" ] && return 0
    if [ "$REMOTE_SHA" != "$observed_sha" ]; then
      die "lease changed while steal was in progress; compare-and-swap refused"
    fi
    if [ "$status" -eq 0 ]; then
      die "steal push reported success but the observed lease did not change"
    fi
    if [ "$attempt" -lt 3 ]; then
      printf 'merge-lease: lease steal push failed; retrying attempt=%s/3\n' "$((attempt + 1))" >&2
      sleep "$attempt"
    fi
  done
  [ -z "$RETRY_OUTPUT" ] || printf '%s\n' "$RETRY_OUTPUT" >&2
  die "could not steal the lease after 3 attempts"
}

delete_lease() {
  local observed_sha="$1" attempt status
  for attempt in 1 2 3; do
    RETRY_OUTPUT="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" push --porcelain \
      --force-with-lease="${LEASE_REF}:${observed_sha}" origin ":${LEASE_REF}" 2>&1)"
    status=$?
    read_remote_sha || die "could not verify ${LEASE_REF} after the release push"
    [ -z "$REMOTE_SHA" ] && return 0
    if [ "$REMOTE_SHA" != "$observed_sha" ]; then
      die "lease changed while release was in progress; compare-and-swap refused"
    fi
    if [ "$status" -eq 0 ]; then
      die "release push reported success but the observed lease remains"
    fi
    if [ "$attempt" -lt 3 ]; then
      printf 'merge-lease: lease release push failed; retrying attempt=%s/3\n' "$((attempt + 1))" >&2
      sleep "$attempt"
    fi
  done
  [ -z "$RETRY_OUTPUT" ] || printf '%s\n' "$RETRY_OUTPUT" >&2
  die "could not release the lease after 3 attempts"
}

case "$COMMAND" in
  status)
    load_lease
    if [ -z "$REMOTE_SHA" ]; then
      printf 'merge-lease: no lease held\n'
    else
      printf '%s' "$LEASE_JSON" | node -e '
        let body = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { body += chunk; });
        process.stdin.on("end", () => process.stdout.write(JSON.stringify(JSON.parse(body), null, 2) + "\n"));
      '
    fi
    ;;
  acquire)
    make_lease_blob
    deadline=$(( $(date +%s) + TIMEOUT_MINUTES * 60 ))
    while :; do
      create_status=0
      try_create_lease || create_status=$?
      case "$create_status" in
        0)
          printf 'merge-lease: acquired %s (%s)\n' "$LEASE_REF" "$NEW_SHA"
          exit 0 ;;
        1)
          load_lease
          if [ -n "$TASK" ] && [ -n "$REMOTE_SHA" ]; then
            current_task="$(printf '%s' "$LEASE_JSON" | node -e '
              let body = "";
              process.stdin.setEncoding("utf8");
              process.stdin.on("data", (chunk) => { body += chunk; });
              process.stdin.on("end", () => {
                const task = JSON.parse(body).task;
                if (typeof task === "string") process.stdout.write(task);
              });
            ')" || die "could not read the current lease task"
            if [ "$current_task" = "$TASK" ]; then
              printf 'merge-lease: already held for task %s (%s)\n' "$TASK" "$REMOTE_SHA"
              exit 0
            fi
          fi ;;
        *) die "could not create ${LEASE_REF} after 3 attempts" ;;
      esac
      if [ "$(date +%s)" -ge "$deadline" ]; then
        printf 'merge-lease: timed out waiting for %s after %s minute(s)\n' "$LEASE_REF" "$TIMEOUT_MINUTES" >&2
        exit "$EXIT_TIMEOUT"
      fi
      printf 'merge-lease: held by %s; polling again in %ss\n' "$REMOTE_SHA" "$POLL_SECONDS" >&2
      sleep "$POLL_SECONDS"
    done
    ;;
  release)
    load_lease
    if [ -z "$REMOTE_SHA" ]; then
      printf 'merge-lease: no lease held\n'
      exit 0
    fi
    released_sha="$REMOTE_SHA"
    if [ -n "$TASK" ]; then
      current_task="$(printf '%s' "$LEASE_JSON" | node -e '
        let body = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { body += chunk; });
        process.stdin.on("end", () => {
          const task = JSON.parse(body).task;
          if (typeof task === "string") process.stdout.write(task);
        });
      ')" || die "could not read the current lease task"
      if [ "$current_task" != "$TASK" ]; then
        printf 'merge-lease: release skipped; %s is held for task %s, not %s\n' \
          "$LEASE_REF" "${current_task:-<none>}" "$TASK"
        exit 0
      fi
    else
      current_holder="$(printf '%s' "$LEASE_JSON" | node -e '
        let body = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { body += chunk; });
        process.stdin.on("end", () => process.stdout.write(JSON.parse(body).holder));
      ')" || die "could not read the current lease holder"
      if [ "$current_holder" != "$HOLDER" ]; then
        die "release refused: ${LEASE_REF} is held by ${current_holder}, not ${HOLDER}; use steal to break it"
      fi
    fi
    delete_lease "$released_sha"
    printf 'merge-lease: released %s (%s)\n' "$LEASE_REF" "$released_sha"
    ;;
  steal)
    load_lease
    if [ -z "$REMOTE_SHA" ]; then
      make_lease_blob
      steal_create_status=0
      try_create_lease || steal_create_status=$?
      [ "$steal_create_status" -eq 0 ] \
        || die "lease appeared while steal was creating it; retry explicitly"
      printf 'merge-lease: acquired unheld %s (%s)\n' "$LEASE_REF" "$NEW_SHA"
      exit 0
    fi
    observed_sha="$REMOTE_SHA"
    observed_json="$LEASE_JSON"
    is_human="$HUMAN"
    if [ -t 0 ] || [ -t 1 ] || [ -t 2 ]; then
      is_human=1
    fi
    if [ "$is_human" -ne 1 ]; then
      age_seconds="$(printf '%s' "$observed_json" | node -e '
        let body = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { body += chunk; });
        process.stdin.on("end", () => {
          const acquired = Date.parse(JSON.parse(body).acquiredAt);
          if (Number.isNaN(acquired)) process.exit(1);
          process.stdout.write(String(Math.floor((Date.now() - acquired) / 1000)));
        });
      ')" || die "could not calculate the current lease age"
      if [ "$age_seconds" -le "$STALE_SECONDS" ]; then
        die "machine steal refused: lease age ${age_seconds}s has not exceeded ${STALE_SECONDS}s"
      fi
    fi
    stolen_summary="$(printf '%s' "$observed_json" | node -e '
      let body = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => process.stdout.write(JSON.stringify(JSON.parse(body))));
    ')" || die "could not format the stolen lease"
    printf 'merge-lease: stealing lease from %s\n' "$stolen_summary" >&2
    make_lease_blob "$observed_json"
    replace_lease "$observed_sha"
    printf 'merge-lease: stole %s (%s)\n' "$LEASE_REF" "$NEW_SHA"
    ;;
esac
