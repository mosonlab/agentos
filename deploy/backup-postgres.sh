#!/bin/zsh
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" || -z "${AGENTOS_BACKUP_DIR:-}" ]]; then
  print -u2 "DATABASE_URL and AGENTOS_BACKUP_DIR are required"
  exit 64
fi

mkdir -p -- "$AGENTOS_BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_path="$AGENTOS_BACKUP_DIR/agentos-$timestamp.dump"
temporary_path="$final_path.partial"
trap 'rm -f -- "$temporary_path"' EXIT

pg_dump --format=custom --file="$temporary_path" "$DATABASE_URL"
mv -- "$temporary_path" "$final_path"
trap - EXIT

backups=("$AGENTOS_BACKUP_DIR"/agentos-*.dump(N.om))
if (( ${#backups} > 14 )); then
  rm -f -- ${backups[15,-1]}
fi

