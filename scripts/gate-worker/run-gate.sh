#!/usr/bin/env bash
#
# Run one merge gate against one commit. Runs ON THE SERVER, invoked over SSH by
# scripts/gate-worker/remote-gate.sh. It lives in one repository's directory on
# the worker — ~/gate/<repo>/ — next to that repository's mirror, worktrees and
# logs, and operates on those and nothing else:
#
#   cd ~/gate/<repo> && ./run-gate.sh <oid>
#   cd ~/gate/<repo> && ./run-gate.sh <oid> --master <master-oid>
#   cd ~/gate/<repo> && ./run-gate.sh <oid> --master <master-oid> --verbose
#
# --master carries the authoritative master oid, which the frozen-record rules
# are evaluated against. remote-gate.sh reads it from origin on the local
# machine and passes it here, because this box's mirror has no remote to fetch
# through. When it is given, it
# is verified to be resolvable in the mirror before the gate starts.
#
# The supported remote path always supplies it: gate-dispatch.sh freezes the
# baseline, mirror-push.sh transports that exact object, and remote-gate.sh
# passes the oid here. The parser remains usable for a direct diagnostic
# invocation without it, but that path has only merge-gate.sh's ordinary local
# no-origin rules and is not the dispatch contract.
#
# This file is installed by mirror-push.sh from the local repository, not by
# provision.sh. That is deliberate: the harness that decides what a verdict means
# should be the copy the operator holds, not one that lives only on the worker
# and could have been edited there.
#
# Shape: check the requested oid out of the mirror into a private throwaway
# worktree, run scripts/merge-gate.sh --expect-head <oid> inside it, keep the full
# log on this host, and print exactly one verdict line on stdout. Everything else
# — progress, npm noise, docker noise — goes to the log. The caller reads one line
# and an exit code; anyone debugging scp's the log.
#
# Exit codes are merge-gate.sh's, passed through unchanged, plus one this
# harness adds for everything that stops it before merge-gate.sh forms a verdict:
#
#   0  PASS               2  usage error (this script or merge-gate.sh)
#   1  FAIL               3  NOT AUTHORITATIVE
#   76 nothing ran — no mirror, the commit is not in the mirror or a missing
#      tool. The line on stdout is
#      GATE NOT RUN: <reason>, and it is not a FAIL. Only merge-gate.sh's own
#      judgement about the commit exits 1, so a caller reading exit codes can
#      tell a verdict from an errand.
#
# The worktree is per-run and unique. The worker contributes one execution slot
# by default, or two when its worker-capacity file contains 2. Each slot is a
# worker-wide flock held by the real process for its entire run, so repositories
# share the same fixed capacity and a dropped ssh connection cannot release a
# slot while its remote gate process survives.
#
# Stateless: nothing is remembered between runs except the mirror and the logs.
# Re-running the same oid after a dropped connection is the supported recovery,
# not a special case.
set -uo pipefail

EXIT_FAIL=1
EXIT_USAGE=2
# Nothing ran, so nothing was judged. Kept distinct from FAIL because
# remote-gate.sh and gate-dispatch.sh pass this code home unchanged and an
# automation must not read a missing mirror as a verdict about a commit.
EXIT_NO_VERDICT=76

# The directory this script was installed into by mirror-push.sh, which is the
# repository's own directory on the worker. Deriving it from the script's path
# rather than a fixed ~/gate is what lets several repositories share one worker
# without any of them naming the others.
GATE_HOME="${GATE_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)}"
MIRROR_DIR="$GATE_HOME/mirror.git"
WORKTREES_DIR="$GATE_HOME/worktrees"
LOGS_DIR="$GATE_HOME/logs"
# How long an abandoned worktree is left alone before the sweep reclaims it.
# Comfortably longer than a gate takes, short enough that a killed run does not
# hold its disk for a day. Age alone never decides: the sweep also refuses to
# touch a worktree whose creating process is still alive, which is what keeps a
# gate that is merely slow — a hung registry, a stalled pull — from having its
# tree deleted underneath it by the next run.
STALE_WORKTREE_MINUTES="${STALE_WORKTREE_MINUTES:-180}"
case "$STALE_WORKTREE_MINUTES" in
  ''|*[!0-9]*) printf 'run-gate: STALE_WORKTREE_MINUTES must be a whole number of minutes, got: %s\n' \
                 "$STALE_WORKTREE_MINUTES" >&2; exit 2 ;;
esac

VERBOSE=0
OID=""
MASTER_OID=""

die_usage() {
  printf 'run-gate: %s\n' "$1" >&2
  printf 'usage: run-gate.sh <40-hex-oid> [--master <40-hex-oid>] [--verbose]\n' >&2
  exit "$EXIT_USAGE"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --verbose|-v) VERBOSE=1 ;;
    --master)
      [ $# -ge 2 ] || die_usage "--master needs an object id"
      MASTER_OID="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift ;;
    --master=*) MASTER_OID="$(printf '%s' "${1#--master=}" | tr '[:upper:]' '[:lower:]')" ;;
    -h|--help) sed -n '2,55p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    -*) die_usage "unknown argument $1" ;;
    *)
      [ -z "$OID" ] || die_usage "more than one commit given: $OID and $1"
      OID="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
      ;;
  esac
  shift
done

# A full 40-character object id and nothing else. An abbreviation or a branch name
# would let the meaning of a verdict drift between the moment the caller asked and
# the moment the gate resolved it, and merge-gate.sh --expect-head refuses anything
# shorter anyway. Validating here also means the value is never a shell surprise.
[ -n "$OID" ] || die_usage "no commit given"
case "$OID" in
  *[!0-9a-f]* | "") die_usage "not a full object id: $OID" ;;
esac
[ "${#OID}" -eq 40 ] || die_usage "not a full 40-character object id: $OID"

# Same rules for the master oid when one is given: a branch name or an
# abbreviation would put the meaning of the verdict back in the hands of
# whatever this box happens to have.
if [ -n "$MASTER_OID" ]; then
  case "$MASTER_OID" in
    *[!0-9a-f]*) die_usage "not a full object id: $MASTER_OID" ;;
  esac
  [ "${#MASTER_OID}" -eq 40 ] || die_usage "not a full 40-character object id: $MASTER_OID"
fi

# --- preconditions ----------------------------------------------------------

# A verdict about the commit. Reserved for the one precondition that is a
# property of the commit rather than of this box.
fail_out() {
  printf 'run-gate: %s\n' "$1" >&2
  printf 'MERGE GATE: FAIL (%s)\n' "$1"
  exit "$EXIT_FAIL"
}

# Everything that stops the harness before merge-gate.sh runs. The state of this
# box, of its mirror and of its toolchain says nothing about the commit, so it
# must not be reported in the same words or the same code as a judgement.
no_verdict() {
  printf 'run-gate: %s\n' "$1" >&2
  printf 'GATE NOT RUN: %s\n' "$1"
  exit "$EXIT_NO_VERDICT"
}

[ -d "$MIRROR_DIR" ] || no_verdict "no mirror at ${MIRROR_DIR}; run scripts/gate-worker/mirror-push.sh from the local machine first"
command -v git >/dev/null 2>&1 || no_verdict "git is not installed on the worker"
command -v node >/dev/null 2>&1 || no_verdict "node is not installed on the worker"
command -v flock >/dev/null 2>&1 || no_verdict "flock is not installed on the worker"
# Docker is deliberately not pre-checked here. merge-gate.sh requires it too, and
# does so after the frozen-record rules, which need neither a daemon nor an
# install: a documentation branch that rewrites history should be told that,
# not told about a daemon it never needed. One ordering, defined in one place.

# The commit has to already be in the mirror. The worker never fetches because
# its mirror has no remote, so "unknown commit" always
# means the local machine has not pushed it yet, and saying so precisely is the
# difference between a one-command fix and a debugging session.
if ! git -C "$MIRROR_DIR" cat-file -e "${OID}^{commit}" 2>/dev/null; then
  no_verdict "commit ${OID} is not in the mirror; run scripts/gate-worker/mirror-push.sh from the local machine"
fi

# The same is true of the master the caller bound the verdict to: an oid this
# mirror cannot resolve would make the gate's own baseline unresolvable, and the
# honest answer is that the mirror is behind the machine that asked.
if [ -n "$MASTER_OID" ] && ! git -C "$MIRROR_DIR" cat-file -e "${MASTER_OID}^{commit}" 2>/dev/null; then
  no_verdict "master ${MASTER_OID} is not in the mirror; run scripts/gate-worker/mirror-push.sh from the local machine"
fi

mkdir -p "$WORKTREES_DIR" "$LOGS_DIR" || no_verdict "could not create the gate directories under ${GATE_HOME}"

# The repository directory is one level below the worker root installed by
# mirror-push.sh. Capacity is host state, not repository state: an absent file
# means one slot, while the only larger supported value is the measured desktop
# capacity of two. There is no load-sensitive resizing and no third slot.
WORKER_ROOT="$(dirname "$GATE_HOME")"
WORKER_CAPACITY_FILE="${WORKER_ROOT}/worker-capacity"
WORKER_CAPACITY=1
if [ -e "$WORKER_CAPACITY_FILE" ] || [ -L "$WORKER_CAPACITY_FILE" ]; then
  [ -f "$WORKER_CAPACITY_FILE" ] && [ ! -L "$WORKER_CAPACITY_FILE" ] \
    || no_verdict "worker capacity at ${WORKER_CAPACITY_FILE} is not a regular file"
  WORKER_CAPACITY="$(cat "$WORKER_CAPACITY_FILE" 2>/dev/null)" \
    || no_verdict "could not read worker capacity at ${WORKER_CAPACITY_FILE}"
  case "$WORKER_CAPACITY" in
    1|2) ;;
    *) no_verdict "worker capacity at ${WORKER_CAPACITY_FILE} must be exactly 1 or 2" ;;
  esac
fi

# Each full gate normally lets the database harness run four test files at
# once. Two gates would therefore turn the measured two-slot desktop into an
# eight-file database host, which is exactly the oversubscription the harness's
# stable ceiling avoids. Keep the host-wide database fan-out at four when the
# worker has two slots; every other gate phase remains free to use all CPUs.
if [ "$WORKER_CAPACITY" -eq 2 ]; then
  export AGENTOS_DBTEST_CONCURRENCY=2
fi

# Slot one retains the original lock path, so a rollout beside an older
# run-gate.sh still counts the old process. Slot two has one additional lock
# file. Polling both non-blockingly is what lets whichever slot frees first run
# the waiter without a queue daemon or mutable scheduler state.
WORKER_SLOT=""
printf 'run-gate: waiting for one of %s worker slot(s)\n' "$WORKER_CAPACITY" >&2
while [ -z "$WORKER_SLOT" ]; do
  for slot in $(seq 1 "$WORKER_CAPACITY"); do
    if [ "$slot" -eq 1 ]; then
      candidate_lock="${WORKER_ROOT}/.full-gate.lock"
    else
      candidate_lock="${WORKER_ROOT}/.full-gate-${slot}.lock"
    fi
    exec 9>"$candidate_lock" \
      || no_verdict "could not open worker slot ${slot} at ${candidate_lock}"
    if flock -n 9; then
      WORKER_SLOT="$slot"
      break
    fi
    exec 9>&-
  done
  [ -n "$WORKER_SLOT" ] || sleep 1
done
printf 'run-gate: acquired worker slot %s/%s\n' "$WORKER_SLOT" "$WORKER_CAPACITY" >&2

# --- reclaim what earlier runs abandoned ------------------------------------

# Only ever directories this script's own naming scheme created, under the
# worktrees root, older than the window above. A killed gate leaves a worktree, a
# registration in the mirror, and possibly a #131 lock inside it; all three go
# together, so removing the directory and pruning the registration is the whole
# reclaim. Failures here are noted and not fatal: a stale directory wastes disk,
# it does not make this run's verdict wrong.
#
# Age is necessary and not sufficient. The name a worktree was created with ends
# in the pid of the run that created it, and a pid that still answers `kill -0`
# is a gate that is still going — slowly, because the runbook's own worst case
# is a registry or a pull that hangs. Deleting that tree would not produce a
# false PASS, it would produce a false FAIL in a run that was doing nothing
# wrong, and it would do it to a *different* dispatch than the one asking. So a
# live pid keeps its worktree however old it is, and only a pid that is gone —
# or a name this scheme did not produce — is swept.
sweep_stale_worktrees() {
  local dir base pid
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    base="${dir##*/}"
    pid="${base##*-}"
    case "$pid" in
      ''|*[!0-9]*) pid="" ;;
    esac
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      printf 'run-gate: leaving %s alone, its gate (pid %s) is still running\n' "$dir" "$pid" >&2
      continue
    fi
    printf 'run-gate: reclaiming abandoned worktree %s\n' "$dir" >&2
    rm -rf -- "$dir" || printf 'run-gate: could not remove %s\n' "$dir" >&2
  done <<EOF
$(find "$WORKTREES_DIR" -mindepth 1 -maxdepth 1 -type d -name 'gate-*' -mmin "+${STALE_WORKTREE_MINUTES}" 2>/dev/null)
EOF
  git -C "$MIRROR_DIR" worktree prune 2>/dev/null || true
}
sweep_stale_worktrees

# --- run --------------------------------------------------------------------

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKTREE="${WORKTREES_DIR}/gate-${OID}-${STAMP}-$$"
LOG="${LOGS_DIR}/${STAMP}-${OID}-$$.log"
WORKTREE_CREATED=0

# Only ever removes the directory this run created, matched against the name it
# was created with. A cleanup routine that trusts a variable is how a scratch run
# reaches a real tree — the same rule scripts/merge-gate.sh applies to its own
# temp directory.
cleanup() {
  local status=$?
  trap - EXIT
  if [ "$WORKTREE_CREATED" -eq 1 ]; then
    case "$WORKTREE" in
      "${WORKTREES_DIR}"/gate-*)
        rm -rf -- "$WORKTREE" 2>/dev/null || printf 'run-gate: could not remove %s\n' "$WORKTREE" >&2
        git -C "$MIRROR_DIR" worktree prune 2>/dev/null || true
        ;;
      *)
        printf 'run-gate: refusing to remove unexpected path %s\n' "$WORKTREE" >&2
        ;;
    esac
  fi
  exit "$status"
}
trap cleanup EXIT
# An interrupted run must clean up too, or its worktree sits until the sweep
# above reclaims it. Exiting from the handler is what routes the signal through
# the EXIT trap.
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'run-gate: %s\n' "$OID" > "$LOG" 2>/dev/null \
  || no_verdict "could not write the log at ${LOG}"
{
  printf 'run-gate: worker %s\n' "$(uname -srm)"
  printf 'run-gate: node %s, npm %s\n' "$(node -v 2>/dev/null)" "$(npm -v 2>/dev/null)"
  printf 'run-gate: started %s\n' "$STAMP"
  printf 'run-gate: capacity %s, dbtest concurrency %s\n' \
    "$WORKER_CAPACITY" "${AGENTOS_DBTEST_CONCURRENCY:-default}"
  printf 'run-gate: worktree %s\n\n' "$WORKTREE"
} >> "$LOG"

# --detach: the gate is a statement about a commit, not about a branch, and a
# detached checkout is the only state where HEAD cannot be moved by a later push
# into the mirror while the gate is running.
if ! git -C "$MIRROR_DIR" worktree add --detach --quiet "$WORKTREE" "$OID" >> "$LOG" 2>&1; then
  printf 'run-gate: could not check %s out of the mirror; see %s\n' "$OID" "$LOG" >&2
  printf 'GATE NOT RUN: could not check out %s on the worker\n' "$OID"
  printf 'run-gate: log %s\n' "$LOG"
  exit "$EXIT_NO_VERDICT"
fi
WORKTREE_CREATED=1

[ -f "${WORKTREE}/scripts/merge-gate.sh" ] || {
  printf 'MERGE GATE: FAIL (commit %s has no scripts/merge-gate.sh)\n' "$OID"
  printf 'run-gate: log %s\n' "$LOG"
  exit "$EXIT_FAIL"
}

# The gate is run from inside the checked-out commit, so the gate that judges a
# commit is the gate that commit ships. --expect-head makes the checkout and the
# request prove each other: if the mirror handed back anything but the requested
# commit, the gate refuses instead of quietly judging the wrong tree.
GATE_ARGS=(--expect-head "$OID")
[ -n "$MASTER_OID" ] && GATE_ARGS+=(--master "$MASTER_OID")

if [ "$VERBOSE" -eq 1 ]; then
  ( cd "$WORKTREE" && bash scripts/merge-gate.sh "${GATE_ARGS[@]}" ) 2>&1 | tee -a "$LOG"
  status=${PIPESTATUS[0]}
else
  ( cd "$WORKTREE" && bash scripts/merge-gate.sh "${GATE_ARGS[@]}" ) >> "$LOG" 2>&1
  status=$?
fi

# The verdict merge-gate.sh printed, verbatim, rather than one reconstructed from
# the exit code: the caller should see the gate's own words, including the oid a
# PASS names. Colour codes are stripped because this line is read over ssh and
# often pasted into a PR.
verdict="$(grep -a 'MERGE GATE: ' "$LOG" | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"
if [ -z "$verdict" ]; then
  # merge-gate.sh ran and printed no verdict, which means it died rather than
  # decided — killed, out of memory, a crash inside a step. That is not a FAIL:
  # calling it one would put a judgement about the commit on the record that
  # nothing actually formed. The log is where the reason is.
  verdict="GATE NOT RUN: the gate produced no verdict line (exit ${status}); read the log"
  status="$EXIT_NO_VERDICT"
fi

printf '%s\n' "$verdict"
printf 'run-gate: log %s\n' "$LOG"
exit "$status"
