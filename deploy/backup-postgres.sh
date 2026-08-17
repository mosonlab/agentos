#!/bin/zsh
set -u
set -o pipefail

readonly EX_USAGE=64
readonly EX_DATAERR=65
readonly EX_SOFTWARE=70
readonly EX_CANTCREAT=73

fail() {
  local code="$1"
  local message="$2"
  print -u2 -- "backup failed (exit $code): $message"
  exit "$code"
}

if [[ -z "${PGSERVICE:-}" || -z "${PGSERVICEFILE:-}" || -z "${AGENTOS_BACKUP_DIR:-}" ]]; then
  fail "$EX_USAGE" "PGSERVICE, PGSERVICEFILE, and AGENTOS_BACKUP_DIR are required"
fi
if [[ "$PGSERVICE" == *[!A-Za-z0-9._-]* ]]; then
  fail "$EX_USAGE" "PGSERVICE contains unsupported characters"
fi
if [[ "$PGSERVICEFILE" != /* || ! -f "$PGSERVICEFILE" ]]; then
  fail "$EX_USAGE" "PGSERVICEFILE must name an absolute regular file"
fi
if [[ "$AGENTOS_BACKUP_DIR" != /* ]]; then
  fail "$EX_USAGE" "AGENTOS_BACKUP_DIR must be absolute"
fi
if ! command -v pg_dump >/dev/null 2>&1 || ! command -v pg_restore >/dev/null 2>&1; then
  fail "$EX_USAGE" "PostgreSQL backup tools are unavailable"
fi

umask 077
if ! mkdir -p -- "$AGENTOS_BACKUP_DIR"; then
  fail "$EX_CANTCREAT" "backup directory is unavailable"
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_path="$AGENTOS_BACKUP_DIR/agentos-$timestamp-$$.dump"
temporary_path=""

cleanup() {
  if [[ -n "$temporary_path" && -f "$temporary_path" ]]; then
    rm -f -- "$temporary_path"
  fi
}
trap cleanup EXIT HUP INT TERM

temporary_path="$(mktemp "$AGENTOS_BACKUP_DIR/.agentos-backup-$timestamp.XXXXXX")" || \
  fail "$EX_CANTCREAT" "temporary archive could not be created"

if ! pg_dump --format=custom --file="$temporary_path" >/dev/null 2>&1; then
  fail "$EX_SOFTWARE" "pg_dump did not complete"
fi
if [[ ! -s "$temporary_path" ]] || ! pg_restore --list "$temporary_path" >/dev/null 2>&1; then
  fail "$EX_DATAERR" "archive validation failed"
fi
if ! mv -- "$temporary_path" "$final_path"; then
  fail "$EX_CANTCREAT" "validated archive could not be published"
fi
temporary_path=""

backups=("$AGENTOS_BACKUP_DIR"/agentos-*.dump(N.om))
if (( ${#backups} > 14 )); then
  if ! rm -f -- ${backups[15,-1]}; then
    fail "$EX_CANTCREAT" "archive retention failed"
  fi
fi

trap - EXIT HUP INT TERM
print -- "backup: pass"
