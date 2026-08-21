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
# machine and passes it here, because this box cannot ask anyone: it holds no
# credential and never talks to GitHub. When it is given, it is verified to be
# resolvable in the mirror before the gate starts.
#
# It is optional on purpose. This harness is installed by mirror-push.sh, so a
# worker can be running an older copy than the commit being gated, and a
# required argument here would mean a repository change could only be gated
# after a deployment — the gate would be broken by its own improvement. Without
# it, merge-gate.sh falls back to this mirror's own master refs, which are
# verbatim copies of the operator's own push.
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
# Exit codes are merge-gate.sh's, passed through unchanged:
#
#   0  PASS               2  usage error (this script or merge-gate.sh)
#   1  FAIL               3  NOT AUTHORITATIVE
#
# The worktree is per-run and unique, so two gates for different commits can run
# concurrently and neither waits for the other. #131's per-worktree lock still
# applies inside each one; because no two runs share a worktree, a live-lock FAIL
# here means a previous run in the same directory was killed, which the sweep at
# the top of this script is what clears.
#
# Stateless: nothing is remembered between runs except the mirror and the logs.
# Re-running the same oid after a dropped connection is the supported recovery,
# not a special case.
set -uo pipefail

EXIT_FAIL=1
EXIT_USAGE=2

# The directory this script was installed into by mirror-push.sh, which is the
# repository's own directory on the worker. Deriving it from the script's path
# rather than a fixed ~/gate is what lets several repositories share one worker
# without any of them naming the others.
GATE_HOME="${GATE_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)}"
MIRROR_DIR="$GATE_HOME/mirror.git"
WORKTREES_DIR="$GATE_HOME/worktrees"
LOGS_DIR="$GATE_HOME/logs"
# How long an abandoned worktree is left alone before the sweep reclaims it. Long
# enough that it can never catch a running gate (a full gate is 10-15 minutes),
# short enough that a killed run does not hold its disk for a day.
STALE_WORKTREE_MINUTES="${STALE_WORKTREE_MINUTES:-180}"

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
    -h|--help) sed -n '2,50p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
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

# --- red line: this box holds no secrets ------------------------------------

# Re-checked on every run, not just at provisioning time. ssh can carry variables
# across with SendEnv/PermitUserEnvironment, and a shell profile can acquire one
# months after provisioning; a worker that runs with a token in its environment is
# outside the boundary this design was approved under, so it refuses rather than
# produces a verdict.
for var in OPERATOR_TOKEN RUNNER_TOKEN AGENTOS_API_TOKEN AGENTOS_SESSION_TOKEN AGENTOS_FENCING_TOKEN VITE_API_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN GH_TOKEN GITHUB_TOKEN; do
  eval "value=\${$var:-}"
  # shellcheck disable=SC2154
  if [ -n "$value" ]; then
    printf 'run-gate: %s is set in this environment; the gate worker holds no credentials\n' "$var" >&2
    printf 'MERGE GATE: FAIL (worker environment carries %s)\n' "$var"
    exit "$EXIT_FAIL"
  fi
done

# --- preconditions ----------------------------------------------------------

fail_out() {
  printf 'run-gate: %s\n' "$1" >&2
  printf 'MERGE GATE: FAIL (%s)\n' "$1"
  exit "$EXIT_FAIL"
}

[ -d "$MIRROR_DIR" ] || fail_out "no mirror at ${MIRROR_DIR}; run scripts/gate-worker/mirror-push.sh from the local machine first"
command -v git >/dev/null 2>&1 || fail_out "git is not installed on the worker"
command -v node >/dev/null 2>&1 || fail_out "node is not installed on the worker"
# Docker is deliberately not pre-checked here. merge-gate.sh requires it too, and
# does so after the frozen-record rules, which need neither a daemon nor an
# install: a documentation branch that rewrites history should be told that,
# not told about a daemon it never needed. One ordering, defined in one place.

# The commit has to already be in the mirror. The worker never fetches — it has no
# GitHub credential and no route worth relying on — so "unknown commit" always
# means the local machine has not pushed it yet, and saying so precisely is the
# difference between a one-command fix and a debugging session.
if ! git -C "$MIRROR_DIR" cat-file -e "${OID}^{commit}" 2>/dev/null; then
  fail_out "commit ${OID} is not in the mirror; run scripts/gate-worker/mirror-push.sh from the local machine"
fi

# The same is true of the master the caller bound the verdict to: an oid this
# mirror cannot resolve would make the gate's own baseline unresolvable, and the
# honest answer is that the mirror is behind the machine that asked.
if [ -n "$MASTER_OID" ] && ! git -C "$MIRROR_DIR" cat-file -e "${MASTER_OID}^{commit}" 2>/dev/null; then
  fail_out "master ${MASTER_OID} is not in the mirror; run scripts/gate-worker/mirror-push.sh from the local machine"
fi

mkdir -p "$WORKTREES_DIR" "$LOGS_DIR" || fail_out "could not create the gate directories under ${GATE_HOME}"

# --- reclaim what earlier runs abandoned ------------------------------------

# Only ever directories this script's own naming scheme created, under the
# worktrees root, older than the window above. A killed gate leaves a worktree, a
# registration in the mirror, and possibly a #131 lock inside it; all three go
# together, so removing the directory and pruning the registration is the whole
# reclaim. Failures here are noted and not fatal: a stale directory wastes disk,
# it does not make this run's verdict wrong.
sweep_stale_worktrees() {
  local dir
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
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
LOG="${LOGS_DIR}/${STAMP}-${OID}.log"
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
  || fail_out "could not write the log at ${LOG}"
{
  printf 'run-gate: worker %s\n' "$(uname -srm)"
  printf 'run-gate: node %s, npm %s\n' "$(node -v 2>/dev/null)" "$(npm -v 2>/dev/null)"
  printf 'run-gate: started %s\n' "$STAMP"
  printf 'run-gate: worktree %s\n\n' "$WORKTREE"
} >> "$LOG"

# --detach: the gate is a statement about a commit, not about a branch, and a
# detached checkout is the only state where HEAD cannot be moved by a later push
# into the mirror while the gate is running.
if ! git -C "$MIRROR_DIR" worktree add --detach --quiet "$WORKTREE" "$OID" >> "$LOG" 2>&1; then
  printf 'run-gate: could not check %s out of the mirror; see %s\n' "$OID" "$LOG" >&2
  printf 'MERGE GATE: FAIL (could not check out %s on the worker)\n' "$OID"
  printf 'run-gate: log %s\n' "$LOG"
  exit "$EXIT_FAIL"
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
  verdict="MERGE GATE: FAIL (the gate produced no verdict line; exit ${status})"
  [ "$status" -eq 0 ] && status="$EXIT_FAIL"
fi

printf '%s\n' "$verdict"
printf 'run-gate: log %s\n' "$LOG"
exit "$status"
