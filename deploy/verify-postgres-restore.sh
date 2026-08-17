#!/bin/zsh
set -u
set -o pipefail

readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_SOFTWARE=70

diagnostic_dir=""

cleanup() {
  if [[ -n "$diagnostic_dir" && -d "$diagnostic_dir" ]]; then
    rm -f -- "$diagnostic_dir"/psql.err
    rmdir -- "$diagnostic_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

fail() {
  local code="$1"
  local assertion="$2"
  print -u2 -- "$assertion: fail"
  exit "$code"
}

if [[ -z "${PGSERVICE:-}" || -z "${PGSERVICEFILE:-}" ]]; then
  fail "$EX_USAGE" "verification-config"
fi
if [[ "$PGSERVICE" != agentos-restore-* || "$PGSERVICE" == *[!A-Za-z0-9._-]* ]]; then
  fail "$EX_USAGE" "verification-target"
fi
if [[ "$PGSERVICEFILE" != /* || ! -f "$PGSERVICEFILE" ]]; then
  fail "$EX_USAGE" "verification-config"
fi
if [[ -n "${AGENTOS_SOURCE_PGSERVICE:-}" && "$AGENTOS_SOURCE_PGSERVICE" == *[!A-Za-z0-9._-]* ]]; then
  fail "$EX_USAGE" "source-comparison"
fi
if ! command -v psql >/dev/null 2>&1; then
  fail "$EX_USAGE" "verification-tools"
fi

umask 077
diagnostic_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentos-verify-restore.XXXXXX")" || \
  fail "$EX_UNAVAILABLE" "verification-temporary-state"

run_scalar() {
  local service="$1"
  local sql="$2"
  PGSERVICE="$service" psql --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only \
    --no-align --quiet --command "$sql" 2>"$diagnostic_dir/psql.err"
}

assert_sql() {
  local assertion="$1"
  local sql="$2"
  local result
  result="$(run_scalar "$PGSERVICE" "$sql" | tr -d '[:space:]')" || \
    fail "$EX_UNAVAILABLE" "$assertion"
  [[ "$result" == "pass" ]] || fail "$EX_SOFTWARE" "$assertion"
  print -- "$assertion: pass"
}

assert_sql "schema-shape" "
SELECT CASE WHEN
  to_regclass('public.\"Project\"') IS NOT NULL
  AND to_regclass('public.\"Agent\"') IS NOT NULL
  AND to_regclass('public.\"Task\"') IS NOT NULL
  AND to_regclass('public.\"Run\"') IS NOT NULL
  AND to_regclass('public.\"InboxMessage\"') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Run' AND column_name = 'pushedBranch'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Agent' AND column_name = 'disabledTools'
  )
THEN 'pass' ELSE 'fail' END"

assert_sql "project-row" "
SELECT CASE WHEN count(*) = 1 THEN 'pass' ELSE 'fail' END
FROM \"Project\"
WHERE id = 'ossd-project' AND name = 'OSS-D Fixture'
  AND slug = 'ossd-fixture' AND \"maxDurationMin\" = 45
  AND \"stallTimeoutMin\" = 7 AND \"maxSessionsPerTask\" = 4
  AND \"spendCap\" = 12.34"

assert_sql "agent-row" "
SELECT CASE WHEN count(*) = 1 THEN 'pass' ELSE 'fail' END
FROM \"Agent\"
WHERE id = 'ossd-agent' AND \"projectId\" = 'ossd-project'
  AND \"environmentId\" = 'ossd-environment' AND name = 'restore-verifier'
  AND title = 'Restore Verifier' AND model = 'synthetic-model'
  AND \"runnerPreference\" = 'codex' AND \"inboxAccess\" = true
  AND \"disabledTools\" = ARRAY['web']::text[]"

assert_sql "task-row" "
SELECT CASE WHEN count(*) = 1 THEN 'pass' ELSE 'fail' END
FROM \"Task\"
WHERE id = 'ossd-task' AND \"projectId\" = 'ossd-project'
  AND \"assigneeAgentId\" = 'ossd-agent' AND name = 'Backup restore fixture'
  AND status = 'review' AND source = 'manual'
  AND \"targetBranch\" = 'synthetic/restore' AND \"opensPullRequest\" = false
  AND \"maxDurationMin\" = 45 AND \"stallTimeoutMin\" = 7
  AND \"maxSessionsPerTask\" = 4"

assert_sql "run-row" "
SELECT CASE WHEN count(*) = 1 THEN 'pass' ELSE 'fail' END
FROM \"Run\"
WHERE id = 'ossd-run' AND \"projectId\" = 'ossd-project'
  AND \"taskId\" = 'ossd-task' AND \"agentId\" = 'ossd-agent'
  AND \"runNumber\" = 1 AND \"dedupeKey\" = 'ossd-fixture-run'
  AND status = 'succeeded' AND runner = 'codex'
  AND model = 'synthetic-model' AND \"promptHash\" = 'ossd-prompt-hash'
  AND \"opensPullRequest\" = false AND \"pushedBranch\" = 'synthetic/restore'"

assert_sql "inbox-row" "
SELECT CASE WHEN count(*) = 1 THEN 'pass' ELSE 'fail' END
FROM \"InboxMessage\"
WHERE id = 'ossd-inbox' AND \"from\" = 'agent'
  AND \"agentId\" = 'ossd-agent' AND \"taskId\" = 'ossd-task'
  AND kind = 'multiple-choice' AND body = 'Synthetic restore survived?'
  AND choices = '[{\"id\":\"yes\",\"label\":\"Yes\"}]'::jsonb
  AND \"selectedChoiceId\" = 'yes' AND status = 'answered'
  AND \"deliveryStatus\" = 'delivered' AND \"deliveryAttempts\" = 1"

script_dir="${0:A:h}"
repo_root="${script_dir:h}"
migration_dirs=("$repo_root"/packages/db/prisma/migrations/*(/N))
expected_migration_count="${#migration_dirs}"

migration_state_sql="
SELECT count(*)::text || ':' ||
       count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::text || ':' ||
       md5(COALESCE(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name), ''))
FROM \"_prisma_migrations\""

target_migration_state="$(run_scalar "$PGSERVICE" "$migration_state_sql" | tr -d '[:space:]')" || \
  fail "$EX_UNAVAILABLE" "migration-state"
target_migration_count="${target_migration_state%%:*}"
target_finished_count="${${target_migration_state#*:}%%:*}"
if [[ "$target_migration_count" != "$expected_migration_count" || "$target_finished_count" != "$expected_migration_count" ]]; then
  fail "$EX_SOFTWARE" "migration-state"
fi
print -- "migration-state: pass"
print -- "migration-count: $target_migration_count"

if [[ -n "${AGENTOS_SOURCE_PGSERVICE:-}" ]]; then
  source_migration_state="$(run_scalar "$AGENTOS_SOURCE_PGSERVICE" "$migration_state_sql" | tr -d '[:space:]')" || \
    fail "$EX_UNAVAILABLE" "source-comparison"
  [[ "$source_migration_state" == "$target_migration_state" ]] || \
    fail "$EX_SOFTWARE" "source-comparison"

  readonly fixture_fingerprint_sql="
  SELECT md5(concat_ws('|',
    (SELECT row_to_json(p)::text FROM (SELECT id, name, slug, \"maxDurationMin\", \"stallTimeoutMin\", \"maxSessionsPerTask\", \"spendCap\"::text FROM \"Project\" WHERE id = 'ossd-project') p),
    (SELECT row_to_json(a)::text FROM (SELECT id, \"projectId\", \"environmentId\", name, title, model, \"runnerPreference\"::text, \"inboxAccess\", \"disabledTools\" FROM \"Agent\" WHERE id = 'ossd-agent') a),
    (SELECT row_to_json(t)::text FROM (SELECT id, \"projectId\", \"assigneeAgentId\", name, status::text, source::text, \"targetBranch\", \"opensPullRequest\" FROM \"Task\" WHERE id = 'ossd-task') t),
    (SELECT row_to_json(r)::text FROM (SELECT id, \"projectId\", \"taskId\", \"agentId\", \"runNumber\", \"dedupeKey\", status::text, runner::text, model, \"promptHash\", \"opensPullRequest\", \"pushedBranch\" FROM \"Run\" WHERE id = 'ossd-run') r),
    (SELECT row_to_json(i)::text FROM (SELECT id, \"from\"::text, \"agentId\", \"taskId\", kind::text, body, choices, \"selectedChoiceId\", status::text, \"deliveryStatus\"::text, \"deliveryAttempts\" FROM \"InboxMessage\" WHERE id = 'ossd-inbox') i)
  ))"
  target_fixture_fingerprint="$(run_scalar "$PGSERVICE" "$fixture_fingerprint_sql" | tr -d '[:space:]')" || \
    fail "$EX_UNAVAILABLE" "source-comparison"
  source_fixture_fingerprint="$(run_scalar "$AGENTOS_SOURCE_PGSERVICE" "$fixture_fingerprint_sql" | tr -d '[:space:]')" || \
    fail "$EX_UNAVAILABLE" "source-comparison"
  [[ -n "$target_fixture_fingerprint" && "$target_fixture_fingerprint" == "$source_fixture_fingerprint" ]] || \
    fail "$EX_SOFTWARE" "source-comparison"
  print -- "source-comparison: pass"
fi

cleanup
diagnostic_dir=""
trap - EXIT HUP INT TERM
