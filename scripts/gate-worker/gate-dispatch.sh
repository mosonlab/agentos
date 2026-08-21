#!/usr/bin/env bash
#
# Run one merge gate in the first free slot: this machine first, then one of the
# offshore worker's two. Runs ON THE LOCAL MACHINE:
#
#   scripts/gate-worker/gate-dispatch.sh                    # gate the local HEAD
#   scripts/gate-worker/gate-dispatch.sh <oid>              # gate that commit
#   scripts/gate-worker/gate-dispatch.sh <oid> --master <oid>
#   AGENTOS_GATE_SERVER=<server> scripts/gate-worker/gate-dispatch.sh <oid>
#
# The slot model: gates are whole-machine loads, so what is being rationed is
# machines, not processes. This machine contributes one slot — a gate saturates
# every core, and the machine is also where the agent sessions and the local
# services live — and the worker contributes two, which is what its four vCPUs
# were measured to carry. Three slots, machine-wide, shared by every repository
# that dispatches from this machine.
#
# The accounting is three mkdir locks under ${XDG_CACHE_HOME:-~/.cache}/
# gate-dispatch/, outside any repository because the slots belong to the
# machines, not to a checkout. Every dispatch on this machine contends for the
# same three, which makes the local locks the whole truth — with one honest
# exception: a merge-gate.sh or remote-gate.sh run directly, without this
# script, is invisible to it. That is an operator overriding the rationing, and
# the override is theirs to answer for; nothing here tries to detect it.
#
# The local slot is only eligible when this worktree is already the thing a
# local gate would test: HEAD at the requested commit and the tree clean.
# Otherwise merge-gate.sh would refuse anyway, so the dispatch goes straight to
# the worker, which can gate any pushed oid without a local checkout.
#
# A remote slot pushes first, always: mirror-push.sh is idempotent, a stale
# mirror is the one failure the runbook calls both most common and always
# benign, and automating the fix is cheaper than documenting it.
#
# When every slot is taken, this blocks and re-polls — the caller wanted a
# verdict, not an errand. It gives up after --timeout-minutes, because a wait
# that long means the queue is systemically full, which the caller should hear
# about rather than sit in.
#
# Exit codes: the gate's own verdict codes pass through unchanged, and the two
# codes this script adds are chosen to collide with nothing the gate can emit:
#
#   0  PASS               3   NOT AUTHORITATIVE
#   1  FAIL               75  no slot freed up within the timeout; nothing ran,
#   2  usage error            no verdict exists — re-dispatch, this is not a FAIL
#   255 ssh transport failure from the remote path — also not a verdict; re-run
set -uo pipefail

EXIT_FAIL=1
EXIT_USAGE=2
EXIT_NO_SLOT=75

SERVER="${AGENTOS_GATE_SERVER:-agentos-gate}"
POLL_SECONDS="${GATE_DISPATCH_POLL_SECONDS:-30}"
TIMEOUT_MINUTES="${GATE_DISPATCH_TIMEOUT_MINUTES:-60}"
SLOT_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/gate-dispatch"

OID=""
MASTER_OID=""

usage() {
  sed -n '2,47p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'
  exit "${1:-0}"
}

die() { printf 'gate-dispatch: %s\n' "$1" >&2; exit "${2:-$EXIT_USAGE}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --master)
      [ $# -ge 2 ] || die "--master needs an object id"
      MASTER_OID="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift ;;
    --master=*) MASTER_OID="$(printf '%s' "${1#--master=}" | tr '[:upper:]' '[:lower:]')" ;;
    --server)
      [ $# -ge 2 ] || die "--server needs a value"
      SERVER="$2"; shift ;;
    --server=*) SERVER="${1#--server=}" ;;
    --timeout-minutes)
      [ $# -ge 2 ] || die "--timeout-minutes needs a number"
      TIMEOUT_MINUTES="$2"; shift ;;
    --timeout-minutes=*) TIMEOUT_MINUTES="${1#--timeout-minutes=}" ;;
    -h|--help) usage 0 ;;
    -*) printf 'gate-dispatch: unknown argument %s\n\n' "$1" >&2; usage "$EXIT_USAGE" ;;
    *)
      [ -z "$OID" ] || die "more than one commit given: $OID and $1"
      OID="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" ;;
  esac
  shift
done

case "$TIMEOUT_MINUTES" in ''|*[!0-9]*) die "--timeout-minutes needs a number, got: $TIMEOUT_MINUTES" ;; esac
case "$POLL_SECONDS" in ''|*[!0-9]*|0) die "GATE_DISPATCH_POLL_SECONDS needs a positive number, got: $POLL_SECONDS" ;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
[ -f "${REPO_ROOT}/scripts/merge-gate.sh" ] \
  || die "${REPO_ROOT} has no scripts/merge-gate.sh; nothing to dispatch" "$EXIT_FAIL"

if [ -z "$OID" ]; then
  OID="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$OID" ] || die "no commit given and ${REPO_ROOT} has no resolvable HEAD"
  printf 'gate-dispatch: no commit given, using the local HEAD\n' >&2
fi
case "$OID" in *[!0-9a-f]*) die "not a full object id: $OID" ;; esac
[ "${#OID}" -eq 40 ] || die "not a full 40-character object id: $OID"
if [ -n "$MASTER_OID" ]; then
  case "$MASTER_OID" in *[!0-9a-f]*) die "not a full object id: $MASTER_OID" ;; esac
  [ "${#MASTER_OID}" -eq 40 ] || die "not a full 40-character object id: $MASTER_OID"
fi

# --- slots -------------------------------------------------------------------

HELD_SLOT=""

# Same discipline as merge-gate.sh's own lock: mkdir is the one atomic
# create-or-fail every filesystem here offers, the pid inside names the holder,
# and a recorded pid that no longer runs means the holder was killed rather
# than exited, so the slot is reclaimed. `kill -0` succeeding on a recycled pid
# only ever costs waiting out a slot that was actually free, which is the
# direction this check is allowed to be wrong in.
try_slot() {
  local slot="$1" dir="${SLOT_ROOT}/${1}.lock" holder=""
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" > "${dir}/pid"
    HELD_SLOT="$slot"
    return 0
  fi
  holder="$(cat "${dir}/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    return 1
  fi
  printf 'gate-dispatch: reclaiming stale slot %s (pid %s is gone)\n' "$slot" "${holder:-none}" >&2
  rm -rf -- "$dir"
  mkdir "$dir" 2>/dev/null || return 1
  printf '%s\n' "$$" > "${dir}/pid"
  HELD_SLOT="$slot"
  return 0
}

release_slot() {
  [ -n "$HELD_SLOT" ] || return 0
  local dir="${SLOT_ROOT}/${HELD_SLOT}.lock" holder=""
  holder="$(cat "${dir}/pid" 2>/dev/null || true)"
  if [ "$holder" = "$$" ]; then
    rm -rf -- "$dir"
  else
    printf 'gate-dispatch: not releasing slot %s, it is now held by pid %s\n' \
      "$HELD_SLOT" "${holder:-unknown}" >&2
  fi
  HELD_SLOT=""
}

cleanup() {
  local status=$?
  trap - EXIT
  release_slot
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The local slot only helps when a local gate could actually run: merge-gate.sh
# refuses a worktree that is not exactly the requested commit, clean. Deciding
# that here keeps an ineligible dispatch from occupying the local slot just to
# hear the refusal.
local_eligible() {
  [ "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)" = "$OID" ] || return 1
  [ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]
}

mkdir -p "$SLOT_ROOT" || die "could not create ${SLOT_ROOT}" "$EXIT_FAIL"

printf 'gate-dispatch: %s, slots local(1) + %s(2), poll %ss, timeout %smin\n' \
  "$OID" "$SERVER" "$POLL_SECONDS" "$TIMEOUT_MINUTES" >&2

# --- dispatch ----------------------------------------------------------------

run_local() {
  printf 'gate-dispatch: running in the local slot\n' >&2
  ( cd "$REPO_ROOT" && bash scripts/merge-gate.sh --expect-head "$OID" \
      ${MASTER_OID:+--master "$MASTER_OID"} )
}

run_remote() {
  printf 'gate-dispatch: running in %s (%s)\n' "$1" "$SERVER" >&2
  # The push and the gate share the slot: a push racing another dispatch's gate
  # is safe (the worker's worktrees are per-run and detached), but the slot is
  # what meters how much of the worker one dispatch may occupy, and the push is
  # part of the occupancy.
  bash "${SCRIPT_DIR}/mirror-push.sh" "$SERVER" >&2 || {
    printf 'gate-dispatch: mirror-push failed; no gate was run\n' >&2
    return "$EXIT_FAIL"
  }
  bash "${SCRIPT_DIR}/remote-gate.sh" "$SERVER" "$OID" \
    ${MASTER_OID:+--master "$MASTER_OID"}
}

DEADLINE=$(( $(date +%s) + TIMEOUT_MINUTES * 60 ))
FIRST=1
while :; do
  if local_eligible && try_slot local; then
    run_local
    exit $?
  fi
  for slot in remote-1 remote-2; do
    if try_slot "$slot"; then
      run_remote "$slot"
      exit $?
    fi
  done
  now="$(date +%s)"
  if [ "$now" -ge "$DEADLINE" ]; then
    printf 'gate-dispatch: no slot freed up in %s minutes; nothing ran and no verdict exists\n' \
      "$TIMEOUT_MINUTES" >&2
    printf 'GATE DISPATCH: NO SLOT\n'
    exit "$EXIT_NO_SLOT"
  fi
  if [ "$FIRST" -eq 1 ]; then
    FIRST=0
    if ! local_eligible; then
      printf 'gate-dispatch: local slot ineligible (worktree not clean at %s); remote only\n' "${OID:0:12}" >&2
    fi
    printf 'gate-dispatch: all slots busy, polling every %ss until %s\n' \
      "$POLL_SECONDS" "$(date -r "$DEADLINE" '+%H:%M:%S' 2>/dev/null || date -d "@${DEADLINE}" '+%H:%M:%S')" >&2
  fi
  sleep "$POLL_SECONDS"
done
