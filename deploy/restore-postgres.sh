#!/bin/zsh
set -u
set -o pipefail

readonly EX_USAGE=64
readonly EX_DATAERR=65
readonly EX_UNAVAILABLE=69
readonly EX_SOFTWARE=70
readonly EX_CONFIG=78
readonly TARGET_MARKER="agentos:isolated-restore-target"

diagnostic_dir=""

cleanup() {
  if [[ -n "$diagnostic_dir" && -d "$diagnostic_dir" ]]; then
    rm -f -- "$diagnostic_dir"/psql.err "$diagnostic_dir"/pg_restore.err
    rmdir -- "$diagnostic_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

fail() {
  local code="$1"
  local message="$2"
  print -u2 -- "restore refused (exit $code): $message"
  exit "$code"
}

if (( $# != 1 )); then
  fail "$EX_USAGE" "usage: restore-postgres.sh ARCHIVE"
fi
readonly archive_path="$1"

if [[ -z "${PGSERVICE:-}" || -z "${PGSERVICEFILE:-}" || -z "${AGENTOS_RESTORE_CONFIRM:-}" ]]; then
  fail "$EX_USAGE" "PGSERVICE, PGSERVICEFILE, and AGENTOS_RESTORE_CONFIRM are required"
fi
if [[ "$PGSERVICE" != agentos-restore-* || "$PGSERVICE" == *[!A-Za-z0-9._-]* ]]; then
  fail "$EX_CONFIG" "service alias is not an isolated restore alias"
fi
if [[ "$PGSERVICEFILE" != /* || ! -f "$PGSERVICEFILE" ]]; then
  fail "$EX_USAGE" "PGSERVICEFILE must name an absolute regular file"
fi
if [[ ! -f "$archive_path" || ! -r "$archive_path" ]]; then
  fail "$EX_USAGE" "archive must be a readable regular file"
fi
if ! command -v psql >/dev/null 2>&1 || ! command -v pg_restore >/dev/null 2>&1; then
  fail "$EX_USAGE" "PostgreSQL restore tools are unavailable"
fi

umask 077
diagnostic_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentos-restore.XXXXXX")" || \
  fail "$EX_UNAVAILABLE" "temporary diagnostics could not be created"

run_scalar() {
  local sql="$1"
  psql --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
    --command "$sql" 2>"$diagnostic_dir/psql.err"
}

if ! pg_restore --list "$archive_path" >/dev/null 2>"$diagnostic_dir/pg_restore.err"; then
  fail "$EX_DATAERR" "archive is not a readable custom-format dump"
fi

target_database="$(run_scalar 'SELECT current_database()' | tr -d '[:space:]')" || \
  fail "$EX_UNAVAILABLE" "target identity could not be verified"
if [[ "$target_database" != agentos_restore_* || "$target_database" == *[!A-Za-z0-9_]* ]]; then
  fail "$EX_CONFIG" "target database name is outside the isolated namespace"
fi
if [[ "$AGENTOS_RESTORE_CONFIRM" != "restore:$target_database" ]]; then
  fail "$EX_CONFIG" "confirmation does not match the isolated target"
fi

target_marker="$(run_scalar "SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = current_database()" | tr -d '\r\n')" || \
  fail "$EX_UNAVAILABLE" "target marker could not be verified"
if [[ "$target_marker" != "$TARGET_MARKER" ]]; then
  fail "$EX_CONFIG" "target database is not marked for isolated restore"
fi

readonly emptiness_sql="
WITH user_namespaces AS (
  SELECT oid FROM pg_namespace
  WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
), user_objects AS (
  SELECT c.oid FROM pg_class c
  WHERE c.relnamespace IN (SELECT oid FROM user_namespaces)
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT p.oid FROM pg_proc p
  WHERE p.pronamespace IN (SELECT oid FROM user_namespaces)
  UNION ALL
  SELECT t.oid FROM pg_type t
  WHERE t.typnamespace IN (SELECT oid FROM user_namespaces)
    AND t.typtype IN ('d', 'e', 'r')
  UNION ALL
  SELECT n.oid FROM pg_namespace n
  WHERE n.oid IN (SELECT oid FROM user_namespaces) AND n.nspname <> 'public'
)
SELECT count(*) FROM user_objects"

object_count="$(run_scalar "$emptiness_sql" | tr -d '[:space:]')" || \
  fail "$EX_UNAVAILABLE" "target emptiness could not be verified"
if [[ "$object_count" != "0" ]]; then
  fail "$EX_CONFIG" "target database is not empty"
fi

if ! pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
  --dbname="service=$PGSERVICE" "$archive_path" \
  >/dev/null 2>"$diagnostic_dir/pg_restore.err"; then
  fail "$EX_SOFTWARE" "transactional restore failed; target was not cleaned automatically"
fi

cleanup
diagnostic_dir=""
trap - EXIT HUP INT TERM
print -- "restore: pass"
