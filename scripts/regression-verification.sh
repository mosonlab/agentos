#!/usr/bin/env bash
# Token-free mechanical half of canonical regression verification.
#
# The model invokes `prepare`, performs only the semantic recheck, then invokes
# `finalize` (or `review-fail <summary>`). This script owns every git/network,
# lease, gate, verdict-transcription, and AgentOS-output operation. PASS retains
# the merge lease for readiness and the merge executor; every non-PASS outcome
# acquired here releases it immediately.

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

for required in AGENTOS_API_URL AGENTOS_SESSION_TOKEN AGENTOS_RUN_ID AGENTOS_FENCING_TOKEN \
  AGENTOS_WORKSPACE_PATH AGENTOS_CHAIN_ID AGENTOS_PULL_REQUEST_BASE; do
  require_env "$required"
done

cd "$AGENTOS_WORKSPACE_PATH" || die "cannot enter AGENTOS_WORKSPACE_PATH"
git check-ref-format --branch "$AGENTOS_PULL_REQUEST_BASE" >/dev/null 2>&1 \
  || die "AGENTOS_PULL_REQUEST_BASE is not a valid branch"

SCRIPT_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="${AGENTOS_REGRESSION_STATE:-$AGENTOS_WORKSPACE_PATH/.git/agentos-regression-state}"
MERGE_LEASE="${REGRESSION_MERGE_LEASE:-$SCRIPT_ROOT/scripts/merge-lease.sh}"
GATE_DISPATCH="${REGRESSION_GATE_DISPATCH:-$SCRIPT_ROOT/scripts/gate-worker/gate-dispatch.sh}"
API_CLIENT="${REGRESSION_API_CLIENT:-curl}"
LEASE_HELD=false
RETAIN_LEASE=false
GATE_LOG=""
# shellcheck source=scripts/gate-worker/lib.sh
. "$SCRIPT_ROOT/scripts/gate-worker/lib.sh"

cleanup() {
  [ -z "$GATE_LOG" ] || rm -f -- "$GATE_LOG"
  if [ "$LEASE_HELD" = true ] && [ "$RETAIN_LEASE" != true ]; then
    "$MERGE_LEASE" release --task "$AGENTOS_CHAIN_ID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

valid_sha() { [[ "$1" =~ $SHA_RE ]]; }

head_sha() {
  local head
  head="$(git rev-parse HEAD)" || die "cannot resolve workspace HEAD"
  valid_sha "$head" || die "workspace HEAD is not a 40-hex commit: $head"
  printf '%s' "$head"
}

fetch_base() {
  local attempt
  for attempt in 1 2 3; do
    if GIT_TERMINAL_PROMPT=0 git fetch --no-tags origin "refs/heads/$AGENTOS_PULL_REQUEST_BASE"; then
      local fetched
      fetched="$(git rev-parse FETCH_HEAD)" || die "cannot resolve fetched target"
      valid_sha "$fetched" || die "target head is not a 40-hex commit: $fetched"
      printf '%s' "$fetched"
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      printf 'regression-verification: target fetch failed; retrying attempt=%s/3\n' "$((attempt + 1))" >&2
      sleep 1
    fi
  done
  die "target fetch failed after 3 attempts"
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

api_request() {
  local method="$1" path="$2" body="$3"
  "$API_CLIENT" --fail-with-body --silent --show-error \
    -X "$method" \
    -H "Authorization: Bearer $AGENTOS_SESSION_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary "$body" \
    "${AGENTOS_API_URL%/}/session/runs/$AGENTOS_RUN_ID$path"
}

persist_output() {
  local verdict="$1" commit_sha="$2" request
  request="$(node -e '
const [fencingToken, kind, body, commitSha] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ fencingToken, kind, body, commitSha }));
' "$AGENTOS_FENCING_TOKEN" "$OUTPUT_KIND" "$verdict" "$commit_sha")"
  api_request PUT /output "$request" >/dev/null \
    || die "AgentOS rejected the mechanical regression output"
}

record_failure() {
  local message="$1" request
  request="$(node -e '
const [fencingToken, body] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ fencingToken, actorType: "agent", body }));
' "$AGENTOS_FENCING_TOKEN" "$message")"
  api_request POST /activity "$request" >/dev/null 2>&1 || true
}

release_lease() {
  "$MERGE_LEASE" release --task "$AGENTOS_CHAIN_ID" \
    || die "merge lease release failed for $AGENTOS_CHAIN_ID"
  LEASE_HELD=false
}

persist_refresh_conflict() {
  local pre_head="$1" target_head="$2" conflicts="$3" acquired="${4:-false}" verdict display_mode
  [ -n "$conflicts" ] || conflicts="unknown conflicted paths"
  verdict="$(json_verdict refresh-conflict "$pre_head" "$target_head" "$conflicts")"
  persist_output "$verdict" "$pre_head"
  if [ "$acquired" = true ]; then release_lease; fi
  display_mode="$(printf '%s' "$MODE" | tr '[:lower:]' '[:upper:]')"
  printf 'REGRESSION %s: refresh-conflict %s\n' "$display_mode" "$conflicts"
}

merge_base() {
  local target_head="$1" acquired="${2:-false}" pre_head conflicts
  pre_head="$(head_sha)"
  if git merge --no-edit "$target_head" >/dev/null; then
    return 0
  fi
  conflicts="$(git diff --name-only --diff-filter=U | paste -sd, -)"
  git merge --abort >/dev/null 2>&1 || true
  persist_refresh_conflict "$pre_head" "$target_head" "$conflicts" "$acquired"
  return 2
}

prepare() {
  local base_head result prepared_head
  base_head="$(fetch_base)"
  merge_base "$base_head" false
  result=$?
  [ "$result" -eq 0 ] || return 0
  prepared_head="$(head_sha)"
  write_state "$prepared_head" "$base_head"
  printf 'REGRESSION PREPARE: ready %s %s\n' "$prepared_head" "$base_head"
}

semantic_stale() {
  local target_head="$1" acquired="${2:-false}" result refreshed_head
  merge_base "$target_head" "$acquired"
  result=$?
  [ "$result" -eq 0 ] || return 0
  refreshed_head="$(head_sha)"
  write_state "$refreshed_head" "$target_head"
  if [ "$acquired" = true ]; then release_lease; fi
  printf 'REGRESSION FINALIZE: semantic-stale %s %s\n' "$refreshed_head" "$target_head"
  return "$EXIT_SEMANTIC_STALE"
}

review_fail() {
  local summary="$1" current verdict
  [ -n "$summary" ] || die "review-fail requires a non-empty summary"
  read_state
  current="$(head_sha)"
  [ "$current" = "$VERIFIED_HEAD_SHA" ] || die "workspace HEAD changed after prepare; rerun prepare and semantic verification"
  verdict="$(json_verdict review-fail "$current" "$BASE_HEAD_SHA" "$summary")"
  persist_output "$verdict" "$current"
  printf 'REGRESSION REVIEW-FAIL: persisted %s\n' "$current"
}

finalize() {
  local current latest result acquired_latest gate_log gate_status gate_proof attempt verdict
  read_state
  current="$(head_sha)"
  [ "$current" = "$VERIFIED_HEAD_SHA" ] || die "workspace HEAD changed after semantic verification"

  # Most drift is discovered and integrated before acquire, so no other chain
  # queues behind a tree that still needs another model pass.
  latest="$(fetch_base)"
  if [ "$latest" != "$BASE_HEAD_SHA" ]; then
    semantic_stale "$latest" false
    return $?
  fi

  "$MERGE_LEASE" acquire --task "$AGENTOS_CHAIN_ID" \
    --reason "chain merge tail $AGENTOS_CHAIN_ID" \
    || die "merge lease acquire failed for $AGENTOS_CHAIN_ID"
  LEASE_HELD=true

  # Close the fetch/acquire race. A changed tree is integrated mechanically,
  # but the lease is released before asking the model to verify it again.
  acquired_latest="$(fetch_base)"
  if [ "$acquired_latest" != "$BASE_HEAD_SHA" ]; then
    semantic_stale "$acquired_latest" true
    return $?
  fi

  current="$(head_sha)"
  gate_log="$(mktemp "${TMPDIR:-/tmp}/regression-gate.XXXXXX")" \
    || { release_lease; die "cannot create gate output file"; }
  GATE_LOG="$gate_log"
  gate_status=76
  for attempt in 1 2 3; do
    : > "$gate_log"
    set +e
    "$GATE_DISPATCH" "$current" --master "$BASE_HEAD_SHA" > "$gate_log" 2>&1
    gate_status=$?
    set -e
    cat "$gate_log"
    case "$gate_status" in
      75|76)
        [ "$attempt" -lt 3 ] && continue
        ;;
      *) break ;;
    esac
  done
  gate_proof="$(gate_verdict_read "$gate_log")"

  case "$gate_proof" in
    "MERGE GATE: PASS $current")
      verdict="$(json_verdict pass "$current" "$BASE_HEAD_SHA" "$gate_proof")"
      persist_output "$verdict" "$current"
      RETAIN_LEASE=true
      printf 'REGRESSION FINALIZE: pass %s\n' "$current"
      ;;
    'MERGE GATE: FAIL ('*')')
      verdict="$(json_verdict gate-fail "$current" "$BASE_HEAD_SHA" "$gate_proof")"
      persist_output "$verdict" "$current"
      release_lease
      printf 'REGRESSION FINALIZE: gate-fail %s\n' "$current"
      ;;
    *)
      record_failure "Regression gate dispatch produced no admissible verdict after attempt $attempt (exit $gate_status)"
      release_lease
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
