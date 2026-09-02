#!/usr/bin/env bash
# Repository merge-gate reference. Copy to scripts/merge-gate.sh and replace
# only run_repository_tests with the target repository's test command.

set -Eeuo pipefail
readonly EXIT_USAGE=2 EXIT_PASS=0 EXIT_FAIL=1 EXIT_NOT_AUTHORITATIVE=3 EXIT_NO_VERDICT=76
EXPECT_HEAD="" EXPECT_HEAD_SET=0 MASTER_OID="" MASTER_SET=0
CURRENT_STEP="preflight" TEST_PID=""

usage() {
  printf 'usage: %s [--expect-head <full-oid>] [--master <full-oid>]\n' "$0" >&2
  printf '       %s --help\n' "$0" >&2
  exit "${1:-0}"
}
die_usage() { printf 'merge-gate: %s\n' "$1" >&2; usage "$EXIT_USAGE"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expect-head) [ "$#" -gt 1 ] || die_usage "--expect-head needs a full object id"; EXPECT_HEAD="$2"; EXPECT_HEAD_SET=1; shift ;;
    --expect-head=*) EXPECT_HEAD="${1#--expect-head=}"; EXPECT_HEAD_SET=1 ;;
    --master) [ "$#" -gt 1 ] || die_usage "--master needs a full object id"; MASTER_OID="$2"; MASTER_SET=1; shift ;;
    --master=*) MASTER_OID="${1#--master=}"; MASTER_SET=1 ;;
    -h|--help) usage 0 ;;
    *) die_usage "unknown argument $1" ;;
  esac
  shift
done

normalise_oid() { [[ "$1" =~ ^[0-9a-fA-F]{40}$ ]] || return 1; printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
fail_gate() { printf 'MERGE GATE: FAIL (%s)\n' "$1"; exit "$EXIT_FAIL"; }
not_authoritative() { printf 'MERGE GATE: NOT AUTHORITATIVE (%s)\n' "$1"; exit "$EXIT_NOT_AUTHORITATIVE"; }
not_run() { printf 'GATE NOT RUN: %s\n' "$1"; exit "$2"; }

stopped() {
  local signal="$1" status="$2"
  trap - INT TERM
  if [ -n "$TEST_PID" ]; then
    kill -TERM -- "-$TEST_PID" 2>/dev/null || kill -TERM "$TEST_PID" 2>/dev/null || true
    wait "$TEST_PID" 2>/dev/null || true
    TEST_PID=""
  fi
  not_run "the gate was stopped by SIG${signal} during ${CURRENT_STEP}" "$status"
}
trap 'stopped INT 130' INT
trap 'stopped TERM 143' TERM

if [ -n "${AGENTOS_RUN_ID:-}" ]; then
  not_run "refused inside Anneal run ${AGENTOS_RUN_ID}" "$EXIT_NO_VERDICT"
fi
if [ "$EXPECT_HEAD_SET" -eq 1 ]; then
  EXPECT_HEAD="$(normalise_oid "$EXPECT_HEAD")" || die_usage "--expect-head must be a full 40-character object id"
fi
if [ "$MASTER_SET" -eq 1 ]; then
  MASTER_OID="$(normalise_oid "$MASTER_OID")" || die_usage "--master must be a full 40-character object id"
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail_gate "not inside a Git worktree"
read_head() { git -C "$REPO_ROOT" rev-parse --verify HEAD^{commit} 2>/dev/null; }
read_dirty() { git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all 2>/dev/null; }

GATED_HEAD="$(read_head)" || fail_gate "could not read HEAD"
[[ "$GATED_HEAD" =~ ^[0-9a-f]{40}$ ]] || fail_gate "HEAD is not a full object id"
if [ "$EXPECT_HEAD_SET" -eq 1 ] && [ "$EXPECT_HEAD" != "$GATED_HEAD" ]; then
  fail_gate "HEAD is $GATED_HEAD but --expect-head asked for $EXPECT_HEAD"
fi
PREFLIGHT_DIRTY="$(read_dirty)" || fail_gate "could not read the working tree state"
[ -z "$PREFLIGHT_DIRTY" ] || fail_gate "working tree is not clean before the repository test command"
if [ "$MASTER_SET" -eq 1 ]; then
  git -C "$REPO_ROOT" cat-file -e "${MASTER_OID}^{commit}" 2>/dev/null || fail_gate "--master $MASTER_OID is not a commit in this repository"
  git -C "$REPO_ROOT" merge-base --is-ancestor "$MASTER_OID" "$GATED_HEAD" || fail_gate "--master $MASTER_OID is not an ancestor of $GATED_HEAD"
fi

# --- REPOSITORY-SPECIFIC TEST COMMAND: replace this function only. ---------
run_repository_tests() {
  npm test
}
# --- END REPOSITORY-SPECIFIC TEST COMMAND. ---------------------------------

CURRENT_STEP="the repository test command"
set -m
( cd "$REPO_ROOT"; run_repository_tests ) &
TEST_PID="$!"
set +m
if wait "$TEST_PID"; then TEST_STATUS=0; else TEST_STATUS="$?"; fi
TEST_PID=""
POST_HEAD="$(read_head)" || fail_gate "could not read HEAD after the repository test command"
POST_DIRTY="$(read_dirty)" || fail_gate "could not read the working tree state after the repository test command"
case "$TEST_STATUS" in
  129) not_run "the repository test command was stopped by SIGHUP" 129 ;;
  130) not_run "the repository test command was stopped by SIGINT" 130 ;;
  131) not_run "the repository test command was stopped by SIGQUIT" 131 ;;
  137) not_run "the repository test command was stopped by SIGKILL" 137 ;;
  143) not_run "the repository test command was stopped by SIGTERM" 143 ;;
  0) ;;
  *) fail_gate "the repository test command failed (exit $TEST_STATUS)" ;;
esac
[ "$POST_HEAD" = "$GATED_HEAD" ] || fail_gate "HEAD changed from $GATED_HEAD to $POST_HEAD during the repository test command"
[ -z "$POST_DIRTY" ] || fail_gate "working tree is not clean after the repository test command"
[ "$MASTER_SET" -eq 1 ] || not_authoritative "master not stated"
printf 'MERGE GATE: PASS %s\n' "$GATED_HEAD"
exit "$EXIT_PASS"
