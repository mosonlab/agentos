#!/usr/bin/env bash
#
# Run one merge gate in the first free slot: the offshore worker first, then
# this machine while the worker is busy. Runs ON THE LOCAL MACHINE:
#
#   scripts/gate-worker/gate-dispatch.sh                    # gate the local HEAD
#   scripts/gate-worker/gate-dispatch.sh <oid>              # gate that commit
#   scripts/gate-worker/gate-dispatch.sh <oid> --master <oid>
#   AGENTOS_GATE_SERVER=<server> scripts/gate-worker/gate-dispatch.sh <oid>
#
# The slot model: gates are whole-machine loads, so what is being rationed is
# machines, not processes. This machine contributes one slot — a gate saturates
# every core, and the machine is also where the agent sessions and the local
# services live — and the four-vCPU worker contributes one. Two slots,
# machine-wide, shared by every repository that dispatches from this machine.
#
# The accounting is two lock files under ${XDG_CACHE_HOME:-~/.cache}/
# gate-dispatch/, outside any repository because the slots belong to the
# machines, not to a checkout. lib.sh holds the locking itself and says why it
# is shaped the way it is. Every dispatch on this machine contends for the same
# two. A direct merge-gate.sh is invisible to this accounting. A direct
# remote-gate.sh bypasses the local accounting too, but run-gate.sh holds the
# worker-wide execution lock for the real process lifetime, so it can wait but
# cannot turn one worker slot into concurrent full gates.
#
# The local slot is only eligible when this worktree is already the thing a
# local gate would test: HEAD at the requested commit and the tree clean.
# Otherwise merge-gate.sh would refuse anyway, so the dispatch goes straight to
# the worker, which can gate any pushed oid without a local checkout.
#
# A remote slot pushes first, always. The dispatcher fixes the candidate and
# baseline oids before taking a slot; mirror-push.sh transports exactly those
# objects under immutable cache refs and never mirrors the checkout's ref set.
#
# When every slot is taken, this blocks and re-polls — the caller wanted a
# verdict, not an errand. It gives up after --timeout-minutes, because a wait
# that long means the queue is systemically full, which the caller should hear
# about rather than sit in.
#
# Exit codes. A verdict and the absence of a verdict are different answers and
# never share a code: the gate's own codes pass through unchanged, and every way
# this script can end without a gate having run maps to one of the three codes
# that mean "no verdict exists". An automation may read 1 as FAIL only because
# nothing else here can produce it.
#
#   0  PASS                 75  every slot was busy for the whole timeout
#   1  FAIL                 76  nothing ran: a precondition, the mirror push or
#   2  usage error              a slot lock failed, so no verdict was formed
#   3  NOT AUTHORITATIVE    255 ssh transport failure on the remote path
#
# 75, 76 and 255 are not FAILs and must never be read as one.
#
# 75 and 76 divide on one question: was there ever a slot that could have been
# taken? 75 means yes and they stayed occupied — a queue, so re-dispatching later
# is the answer. 76 means no: a lock could not be operated at all, and waiting
# for that is waiting for nothing. A slot whose lock is broken is never counted
# as busy.
set -uo pipefail

# No EXIT_FAIL here on purpose: this script transports verdicts and forms none,
# so the only 1 a caller can ever see from it is one the gate itself produced.
EXIT_USAGE=2
EXIT_NO_SLOT=75
EXIT_NO_VERDICT=76

SERVER="${AGENTOS_GATE_SERVER:-agentos-gate}"
POLL_SECONDS="${GATE_DISPATCH_POLL_SECONDS:-30}"
TIMEOUT_MINUTES="${GATE_DISPATCH_TIMEOUT_MINUTES:-60}"
SLOT_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/gate-dispatch"

OID=""
MASTER_OID=""
DEFAULT_REF=""

usage() {
  sed -n '2,58p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'
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
  || die "${REPO_ROOT} has no scripts/merge-gate.sh; nothing to dispatch and no verdict exists" "$EXIT_NO_VERDICT"

# shellcheck source=scripts/gate-worker/lib.sh
. "${SCRIPT_DIR}/lib.sh"

# Validated here as well as inside the scripts that send it: this one decides
# which of them to call, and a destination it cannot vouch for is a dispatch
# that should not start rather than one that fails halfway through a push.
gate_valid_server "$SERVER" >/dev/null \
  || die "not a usable ssh destination: ${SERVER}" "$EXIT_USAGE"

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

git -C "$REPO_ROOT" cat-file -e "${OID}^{commit}" 2>/dev/null \
  || die "candidate ${OID} is not in ${REPO_ROOT}; nothing ran and no verdict exists" "$EXIT_NO_VERDICT"

# Freeze the integration baseline before slot selection. Without an explicit
# --master, origin's HEAD is the authority: fetch its branch without creating a
# local tracking ref, then read HEAD again and accept only the exact oid now
# advertised. If the branch moved beyond the fetched object, this dispatch stops
# loudly and can be retried; it never substitutes a stale local ref.
if [ -z "$MASTER_OID" ]; then
  symref="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" ls-remote --symref origin HEAD 2>/dev/null)" \
    || die "could not read HEAD from origin; pass --master <oid> to state the baseline" "$EXIT_NO_VERDICT"
  DEFAULT_REF="$(printf '%s\n' "$symref" | awk '$1 == "ref:" && $3 == "HEAD" {print $2; exit}')"
  [ -n "$DEFAULT_REF" ] \
    || die "origin did not name its default branch; pass --master <oid> to state the baseline" "$EXIT_NO_VERDICT"
  gate_valid_ref "$DEFAULT_REF" >/dev/null \
    || die "origin named a default branch this dispatcher will not fetch: ${DEFAULT_REF}" "$EXIT_NO_VERDICT"
  GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" fetch --no-tags --no-write-fetch-head origin "$DEFAULT_REF" >/dev/null 2>&1 \
    || die "could not refresh ${DEFAULT_REF} from origin; nothing ran and no verdict exists" "$EXIT_NO_VERDICT"
  refreshed="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" ls-remote --symref origin HEAD 2>/dev/null)" \
    || die "could not re-read HEAD from origin after refresh; nothing ran and no verdict exists" "$EXIT_NO_VERDICT"
  refreshed_ref="$(printf '%s\n' "$refreshed" | awk '$1 == "ref:" && $3 == "HEAD" {print $2; exit}')"
  MASTER_OID="$(printf '%s\n' "$refreshed" | awk '$2 == "HEAD" {print $1; exit}')"
  [ "$refreshed_ref" = "$DEFAULT_REF" ] \
    || die "origin changed its default branch during refresh (${DEFAULT_REF} -> ${refreshed_ref:-unknown}); retry dispatch" "$EXIT_NO_VERDICT"
  case "$MASTER_OID" in *[!0-9a-f]* | "") die "origin answered with no full baseline oid for ${DEFAULT_REF}" "$EXIT_NO_VERDICT" ;; esac
  [ "${#MASTER_OID}" -eq 40 ] \
    || die "origin answered with a short baseline oid for ${DEFAULT_REF}: ${MASTER_OID}" "$EXIT_NO_VERDICT"
fi
git -C "$REPO_ROOT" cat-file -e "${MASTER_OID}^{commit}" 2>/dev/null \
  || die "baseline ${MASTER_OID} is not in ${REPO_ROOT}; refresh the integration branch and retry" "$EXIT_NO_VERDICT"

# --- slots -------------------------------------------------------------------

HELD_SLOT=""

# 0 taken, 1 busy, 2 the lock is unusable. The distinction is the whole point:
# see the exit-code note in the header.
try_slot() {
  local outcome=0
  gate_slot_try "$SLOT_ROOT" "$1" || outcome=$?
  if [ "$outcome" -eq 0 ]; then
    HELD_SLOT="$1"
    return 0
  fi
  return "$outcome"
}

release_slot() {
  [ -n "$HELD_SLOT" ] || return 0
  gate_slot_release "$SLOT_ROOT" "$HELD_SLOT" || true
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

mkdir -p "$SLOT_ROOT" || die "could not create ${SLOT_ROOT}" "$EXIT_NO_VERDICT"

printf 'gate-dispatch: %s, slots %s(1) then local(1), poll %ss, timeout %smin\n' \
  "$OID" "$SERVER" "$POLL_SECONDS" "$TIMEOUT_MINUTES" >&2
printf 'gate-dispatch: baseline %s%s\n' "$MASTER_OID" "${DEFAULT_REF:+ (${DEFAULT_REF})}" >&2

# --- dispatch ----------------------------------------------------------------

run_local() {
  printf 'gate-dispatch: running in the local slot\n' >&2
  ( cd "$REPO_ROOT" && bash scripts/merge-gate.sh --expect-head "$OID" --master "$MASTER_OID" )
}

run_remote() {
  printf 'gate-dispatch: running in %s (%s)\n' "$1" "$SERVER" >&2
  # The push and the gate share the slot: a push racing another dispatch's gate
  # is safe (the worker's worktrees are per-run and detached), but the slot is
  # what meters how much of the worker one dispatch may occupy, and the push is
  # part of the occupancy.
  #
  # A push that fails is not a gate that failed. Nothing was run on the worker,
  # so there is no verdict to report and 76 says exactly that; returning the
  # gate's FAIL code here would have dressed a transport or mirror problem up as
  # a judgement about the commit.
  bash "${SCRIPT_DIR}/mirror-push.sh" "$SERVER" \
    --candidate "$OID" --baseline "$MASTER_OID" >&2 || {
    printf 'gate-dispatch: mirror-push failed; no gate was run and no verdict exists\n' >&2
    printf 'GATE NOT RUN: the mirror push failed, so nothing was gated\n'
    return "$EXIT_NO_VERDICT"
  }
  bash "${SCRIPT_DIR}/remote-gate.sh" "$SERVER" "$OID" --master "$MASTER_OID"
}

no_verdict() {
  printf 'gate-dispatch: %s\n' "$1" >&2
  printf 'GATE NOT RUN: %s\n' "$2"
  exit "$EXIT_NO_VERDICT"
}

DEADLINE=$(( $(date +%s) + TIMEOUT_MINUTES * 60 ))
FIRST=1
# Survives the rounds: once a slot's lock has been seen broken, a later 75 would
# be a lie even if that round happened to find only busy slots.
BROKEN_EVER=""
while :; do
  # Per round, because "busy" is a fact with a shelf life. round_busy counts the
  # slots that could have been taken and were not; round_broken the ones whose
  # lock could not be operated. Waiting is only justified while round_busy > 0:
  # a busy slot frees when its gate ends, a broken one does not free at all.
  round_busy=0
  round_broken=""
  outcome=0

  outcome=0
  try_slot remote-1 || outcome=$?
  case "$outcome" in
    0) run_remote remote-1; exit $? ;;
    1) round_busy=$(( round_busy + 1 )) ;;
    *) round_broken="${round_broken} remote-1" ;;
  esac

  # Local capacity protects the user's machine from concurrent gate load. It
  # is spillover only: the worker must be positively busy in this round. A
  # broken remote lock is not "busy" and never unlocks local as a silent
  # fallback.
  if [ "$round_busy" -eq 1 ] && local_eligible; then
    outcome=0
    try_slot local || outcome=$?
    case "$outcome" in
      0) run_local; exit $? ;;
      1) round_busy=$(( round_busy + 1 )) ;;
      *) round_broken="${round_broken} local" ;;
    esac
  fi
  # Union, not concatenation: a slot that is broken stays broken every round, and
  # an hour of polling would otherwise build a message naming it 120 times.
  for slot in $round_broken; do
    case " ${BROKEN_EVER} " in
      *" ${slot} "*) ;;
      *) BROKEN_EVER="${BROKEN_EVER} ${slot}" ;;
    esac
  done

  # Nothing to wait for: every slot this dispatch could have used has a lock that
  # does not work. Polling would only repeat the same failure until the timeout
  # and then report a full queue that never existed.
  if [ "$round_busy" -eq 0 ] && [ -n "$round_broken" ]; then
    no_verdict \
      "no slot could be locked (${round_broken# }); nothing ran and no verdict exists" \
      "the slot locks are unusable (${round_broken# }), so nothing was gated"
  fi

  now="$(date +%s)"
  if [ "$now" -ge "$DEADLINE" ]; then
    # A slot seen broken at any point during the wait means the timeout is not
    # the whole story, and 75 — "the queue stayed full" — would send the caller
    # to re-dispatch into the same broken lock.
    if [ -n "$BROKEN_EVER" ]; then
      no_verdict \
        "waited ${TIMEOUT_MINUTES} minutes with slots busy and the locks of${BROKEN_EVER} unusable; nothing ran" \
        "some slots stayed busy and${BROKEN_EVER} could not be locked, so nothing was gated"
    fi
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
    if [ -n "$round_broken" ]; then
      printf 'gate-dispatch: the locks of%s are unusable; waiting on the %s slot(s) that are merely busy\n' \
        "$round_broken" "$round_busy" >&2
    fi
    printf 'gate-dispatch: %s slot(s) busy, polling every %ss until %s\n' \
      "$round_busy" "$POLL_SECONDS" \
      "$(date -r "$DEADLINE" '+%H:%M:%S' 2>/dev/null || date -d "@${DEADLINE}" '+%H:%M:%S')" >&2
  fi
  sleep "$POLL_SECONDS"
done
