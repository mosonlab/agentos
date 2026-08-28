#!/usr/bin/env bash
# Token-free mechanical half of canonical regression verification.
#
# The model invokes `prepare`, performs only the semantic recheck, then invokes
# `finalize` (or `review-fail <summary>`). This script owns every git/network,
# gate, verdict transcription, and the local Runner handoff. The Runner owns
# the fenced control-plane write outside the Agent sandbox. Merge readiness owns
# the short merge-lease window after a durable exact-head PASS exists, so lease
# transport failures never consume a semantic-verification Run.

set -u
set -o pipefail

EXIT_SEMANTIC_STALE=77
OUTPUT_KIND="regression-verification-v2"
SHA_RE='^[0-9a-f]{40}$'

die() { printf 'regression-verification: %s\n' "$1" >&2; exit "${2:-1}"; }

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || die "$name is required"
}

for required in AGENTOS_RUN_ID AGENTOS_WORKSPACE_PATH AGENTOS_PULL_REQUEST_BASE; do
  require_env "$required"
done

cd "$AGENTOS_WORKSPACE_PATH" || die "cannot enter AGENTOS_WORKSPACE_PATH"
git check-ref-format --branch "$AGENTOS_PULL_REQUEST_BASE" >/dev/null 2>&1 \
  || die "AGENTOS_PULL_REQUEST_BASE is not a valid branch"

SCRIPT_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="${AGENTOS_REGRESSION_STATE:-$AGENTOS_WORKSPACE_PATH/.git/agentos-regression-state}"
OUTPUT_FILE="$AGENTOS_WORKSPACE_PATH/.agentos/regression-output.json"
GATE_DISPATCH="${REGRESSION_GATE_DISPATCH:-$SCRIPT_ROOT/scripts/gate-worker/gate-dispatch.sh}"
GATE_LOG=""
# shellcheck source=scripts/gate-worker/lib.sh
. "$SCRIPT_ROOT/scripts/gate-worker/lib.sh"

cleanup() {
  [ -z "$GATE_LOG" ] || rm -f -- "$GATE_LOG"
}
trap cleanup EXIT

valid_sha() { [[ "$1" =~ $SHA_RE ]]; }

head_sha() {
  local head
  head="$(git rev-parse HEAD)" || return 1
  valid_sha "$head" || return 1
  printf '%s' "$head"
}

fetch_base() {
  local attempt
  for attempt in 1 2 3; do
    if GIT_TERMINAL_PROMPT=0 git fetch --no-tags origin "refs/heads/$AGENTOS_PULL_REQUEST_BASE" \
      >/dev/null 2>&1; then
      local fetched
      fetched="$(git rev-parse FETCH_HEAD)" || return 1
      valid_sha "$fetched" || return 1
      printf '%s' "$fetched"
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      printf 'regression-verification: target fetch failed; retrying attempt=%s/3\n' "$((attempt + 1))" >&2
      sleep 1
    fi
  done
  printf 'regression-verification: target fetch failed after 3 attempts\n' >&2
  return 1
}

write_state() {
  local verified_head="$1" base_head="$2"
  valid_sha "$verified_head" && valid_sha "$base_head" || die "refusing malformed regression state"
  umask 077
  printf 'verifiedHeadSha=%s\nbaseHeadSha=%s\n' "$verified_head" "$base_head" > "$STATE_FILE"
}

read_state() {
  [ -f "$STATE_FILE" ] || die "prepare has not recorded regression state"
  VERIFIED_HEAD_SHA="$(sed -n 's/^verifiedHeadSha=//p' "$STATE_FILE")"
  BASE_HEAD_SHA="$(sed -n 's/^baseHeadSha=//p' "$STATE_FILE")"
  valid_sha "$VERIFIED_HEAD_SHA" && valid_sha "$BASE_HEAD_SHA" \
    || die "recorded regression state is malformed"
}

json_verdict() {
  node -e '
const [outcome, headSha, baseHeadSha, proofOrSummary] = process.argv.slice(1);
const value = outcome === "pass"
  ? { schemaVersion: 2, outcome, headSha, baseHeadSha, gateVerdict: "PASS", gateProof: proofOrSummary }
  : outcome === "gate-fail"
    ? { schemaVersion: 2, outcome, headSha, baseHeadSha, gateVerdict: "FAIL", gateProof: proofOrSummary, summary: proofOrSummary.slice("MERGE GATE: FAIL (".length, -1) }
    : { schemaVersion: 2, outcome, headSha, baseHeadSha, summary: proofOrSummary };
process.stdout.write(JSON.stringify(value));
' "$1" "$2" "$3" "$4"
}

persist_output() {
  local verdict="$1" commit_sha="$2" output_dir temporary
  output_dir="$(dirname "$OUTPUT_FILE")"
  if [ -L "$output_dir" ]; then
    die "refusing symlinked regression output directory"
  fi
  umask 077
  mkdir -p -- "$output_dir" || die "cannot create regression output directory"
  [ -d "$output_dir" ] || die "regression output directory is not a directory"
  temporary="$(mktemp "${OUTPUT_FILE}.XXXXXXXX")" \
    || die "cannot create regression output handoff"
  printf '%s\0%s\0%s\0%s' "$AGENTOS_RUN_ID" "$OUTPUT_KIND" "$verdict" "$commit_sha" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
const [runId, kind, body, commitSha] = input.split("\0");
process.stdout.write(JSON.stringify({ schemaVersion: 1, runId, kind, body, commitSha }));
});
' > "$temporary" || { rm -f -- "$temporary"; die "cannot encode regression output handoff"; }
  chmod 600 "$temporary" || { rm -f -- "$temporary"; die "cannot protect regression output handoff"; }
  mv -f -- "$temporary" "$OUTPUT_FILE" \
    || { rm -f -- "$temporary"; die "cannot publish regression output handoff"; }
}

persist_refresh_conflict() {
  local pre_head="$1" target_head="$2" conflicts="$3" verdict display_mode
  valid_sha "$pre_head" && valid_sha "$target_head" \
    || die "refusing malformed refresh-conflict verdict"
  [ -n "$conflicts" ] || die "refusing refresh-conflict verdict without unmerged paths"
  verdict="$(json_verdict refresh-conflict "$pre_head" "$target_head" "$conflicts")"
  persist_output "$verdict" "$pre_head"
  display_mode="$(printf '%s' "$MODE" | tr '[:lower:]' '[:upper:]')"
  printf 'REGRESSION %s: refresh-conflict %s\n' "$display_mode" "$conflicts"
}

refresh_onto_target() {
  local target_head="$1" pre_head conflicts merge_output merge_status
  valid_sha "$target_head" || die "refusing to merge malformed target head: $target_head"
  pre_head="$(head_sha)" || die "cannot resolve a valid workspace HEAD"
  merge_output="$(git merge --no-edit "$target_head" 2>&1)"
  merge_status=$?
  if [ "$merge_status" -eq 0 ]; then
    return 0
  fi
  conflicts="$(git diff --name-only --diff-filter=U | paste -sd, -)"
  git merge --abort >/dev/null 2>&1 || true
  if [ -n "$conflicts" ]; then
    persist_refresh_conflict "$pre_head" "$target_head" "$conflicts"
    return 2
  fi
  [ -z "$merge_output" ] || printf '%s\n' "$merge_output" >&2
  die "target refresh merge failed without conflicts (exit $merge_status)"
}

prepare() {
  local base_head result prepared_head output_dir
  output_dir="$(dirname "$OUTPUT_FILE")"
  [ ! -L "$output_dir" ] || die "refusing symlinked regression output directory"
  rm -f -- "$OUTPUT_FILE" || die "cannot clear stale regression output handoff"
  base_head="$(fetch_base)" || die "cannot refresh target head"
  refresh_onto_target "$base_head"
  result=$?
  [ "$result" -eq 0 ] || return 0
  prepared_head="$(head_sha)" || die "cannot resolve prepared workspace HEAD"
  write_state "$prepared_head" "$base_head"
  printf 'REGRESSION PREPARE: ready %s %s\n' "$prepared_head" "$base_head"
}

semantic_stale() {
  local target_head="$1" result refreshed_head
  refresh_onto_target "$target_head"
  result=$?
  [ "$result" -eq 0 ] || return 0
  refreshed_head="$(head_sha)" || die "cannot resolve refreshed workspace HEAD"
  write_state "$refreshed_head" "$target_head"
  printf 'REGRESSION FINALIZE: semantic-stale %s %s\n' "$refreshed_head" "$target_head"
  return "$EXIT_SEMANTIC_STALE"
}

review_fail() {
  local summary="$1" current verdict
  [ -n "$summary" ] || die "review-fail requires a non-empty summary"
  read_state
  current="$(head_sha)" || die "cannot resolve review-fail workspace HEAD"
  [ "$current" = "$VERIFIED_HEAD_SHA" ] || die "workspace HEAD changed after prepare; rerun prepare and semantic verification"
  verdict="$(json_verdict review-fail "$current" "$BASE_HEAD_SHA" "$summary")"
  persist_output "$verdict" "$current"
  printf 'REGRESSION REVIEW-FAIL: persisted %s\n' "$current"
}

finalize() {
  local current latest gate_log gate_status gate_proof attempt verdict
  read_state
  current="$(head_sha)" || die "cannot resolve finalize workspace HEAD"
  [ "$current" = "$VERIFIED_HEAD_SHA" ] || die "workspace HEAD changed after semantic verification"

  # Most drift is discovered and integrated before acquire, so no other chain
  # queues behind a tree that still needs another model pass.
  latest="$(fetch_base)" || die "cannot refresh target head"
  if [ "$latest" != "$BASE_HEAD_SHA" ]; then
    semantic_stale "$latest"
    return $?
  fi

  current="$(head_sha)" || die "cannot resolve gated workspace HEAD"
  gate_log="$(mktemp "${TMPDIR:-/tmp}/regression-gate.XXXXXX")" \
    || die "cannot create gate output file"
  GATE_LOG="$gate_log"
  gate_status=76
  for attempt in 1 2 3; do
    : > "$gate_log"
    gate_status=0
    "$GATE_DISPATCH" "$current" --master "$BASE_HEAD_SHA" > "$gate_log" 2>&1 \
      || gate_status=$?
    case "$gate_status" in
      75|76)
        [ "$attempt" -lt 3 ] && continue
        ;;
      *) break ;;
    esac
  done
  gate_proof="$(gate_verdict_read "$gate_log")" || gate_proof=""

  # Gate execution may be long. Do not publish evidence against a base that
  # moved while it ran; readiness performs the final check again under Lease.
  latest="$(fetch_base)" || die "cannot refresh target head after gate"
  if [ "$latest" != "$BASE_HEAD_SHA" ]; then
    semantic_stale "$latest"
    return $?
  fi

  case "$gate_proof" in
    "MERGE GATE: PASS $current")
      verdict="$(json_verdict pass "$current" "$BASE_HEAD_SHA" "$gate_proof")"
      persist_output "$verdict" "$current"
      printf 'REGRESSION FINALIZE: pass %s\n' "$current"
      ;;
    'MERGE GATE: FAIL ('*')')
      verdict="$(json_verdict gate-fail "$current" "$BASE_HEAD_SHA" "$gate_proof")"
      persist_output "$verdict" "$current"
      printf 'REGRESSION FINALIZE: gate-fail %s\n' "$current"
      ;;
    *)
      die "gate dispatch produced no admissible PASS/FAIL verdict after $attempt attempt(s) (exit $gate_status)"
      ;;
  esac
}

MODE="${1:-}"
case "$MODE" in
  prepare)
    [ "$#" -eq 1 ] || die "usage: $0 prepare"
    prepare
    ;;
  finalize)
    [ "$#" -eq 1 ] || die "usage: $0 finalize"
    finalize
    ;;
  review-fail)
    [ "$#" -eq 2 ] || die "usage: $0 review-fail <summary>"
    review_fail "$2"
    ;;
  *) die "usage: $0 prepare | finalize | review-fail <summary>" ;;
esac
