#!/bin/zsh
set -u
set -o pipefail

script_dir="${0:A:h}"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/agentos-postgres-contract.XXXXXX")" || exit 1

cleanup() {
  if [[ -n "$test_root" && -d "$test_root" && -f "$test_root/.owned-by-ossd-contract" ]]; then
    rm -rf -- "$test_root"
  fi
}
touch "$test_root/.owned-by-ossd-contract"
trap cleanup EXIT HUP INT TERM

fail() {
  print -u2 -- "contract failure: $1"
  exit 1
}

assert_status() {
  local expected="$1"
  shift
  "$@" >"$test_root/command.out" 2>&1
  local actual=$?
  if [[ "$actual" != "$expected" ]]; then
    sed -n '1,20p' "$test_root/command.out" >&2
    fail "expected exit $expected, received $actual"
  fi
}

write_service_file() {
  local file_path="$1"
  print -- "[unit-service]" >"$file_path"
  chmod 600 "$file_path"
}

test_backup_contract() {
  local root="$test_root/backup"
  local bin="$root/bin"
  local backup_dir="$root/archives"
  local service_file="$root/pg_service.conf"
  mkdir -p "$bin" "$backup_dir"
  write_service_file "$service_file"

  print -r -- '#!/bin/zsh
set -u
output=""
for arg in "$@"; do
  [[ "$arg" == --file=* ]] && output="${arg#--file=}"
done
[[ -n "$output" ]] || exit 2
if [[ "${FAKE_DUMP_MODE:-success}" == fail ]]; then
  print -u2 -- "synthetic dump failure"
  exit 1
fi
if [[ "${FAKE_DUMP_MODE:-success}" == empty ]]; then
  : >"$output"
else
  print -n -- "synthetic-custom-archive" >"$output"
fi' >"$bin/pg_dump"

  print -r -- '#!/bin/zsh
if [[ "$1" == --list ]]; then
  [[ "${FAKE_RESTORE_LIST_MODE:-success}" == success ]] || exit 1
  [[ -s "$2" ]] || exit 1
  exit 0
fi
exit 2' >"$bin/pg_restore"
  chmod +x "$bin/pg_dump" "$bin/pg_restore"

  backup_command() {
    PATH="$bin:/usr/bin:/bin" PGSERVICE="unit-service" PGSERVICEFILE="$service_file" \
      AGENTOS_BACKUP_DIR="$backup_dir" "$script_dir/backup-postgres.sh"
  }

  FAKE_DUMP_MODE=fail assert_status 70 backup_command
  [[ -z "$(find "$backup_dir" -maxdepth 1 -name 'agentos-*.dump' -print -quit)" ]] || \
    fail "failed dump left a final-looking archive"
  [[ -z "$(find "$backup_dir" -maxdepth 1 -name '.agentos-backup-*' -print -quit)" ]] || \
    fail "failed dump left a partial archive"

  FAKE_RESTORE_LIST_MODE=fail assert_status 65 backup_command
  [[ -z "$(find "$backup_dir" -maxdepth 1 -name 'agentos-*.dump' -print -quit)" ]] || \
    fail "invalid dump left a final-looking archive"
  [[ -z "$(find "$backup_dir" -maxdepth 1 -name '.agentos-backup-*' -print -quit)" ]] || \
    fail "invalid dump left a partial archive"

  local index archive
  for index in {01..15}; do
    archive="$backup_dir/agentos-20260801T0000${index}Z-seed.dump"
    print -n -- "seed-$index" >"$archive"
    touch -t "2026080100${index}.00" "$archive"
  done
  print -- "preserve" >"$backup_dir/operator-notes.txt"
  assert_status 0 backup_command
  [[ "$(find "$backup_dir" -maxdepth 1 -type f -name 'agentos-*.dump' | wc -l | tr -d ' ')" == 14 ]] || \
    fail "retention did not keep exactly 14 archives"
  [[ ! -e "$backup_dir/agentos-20260801T000001Z-seed.dump" ]] || fail "oldest archive was retained"
  [[ ! -e "$backup_dir/agentos-20260801T000002Z-seed.dump" ]] || fail "second-oldest archive was retained"
  [[ -f "$backup_dir/operator-notes.txt" ]] || fail "retention removed an unrelated entry"
  [[ -z "$(find "$backup_dir" -maxdepth 1 -name '.agentos-backup-*' -print -quit)" ]] || \
    fail "successful backup left a partial archive"
  print -- "backup-contract: pass"
}

test_restore_contract() {
  local root="$test_root/restore"
  local bin="$root/bin"
  local service_file="$root/pg_service.conf"
  local archive="$root/fixture.dump"
  local called="$root/restore-called"
  mkdir -p "$bin"
  write_service_file "$service_file"
  print -n -- "custom-archive" >"$archive"

  print -r -- '#!/bin/zsh
set -u
sql=""
previous=""
for arg in "$@"; do
  if [[ "$previous" == --command ]]; then sql="$arg"; fi
  previous="$arg"
done
if [[ "$sql" == *current_database* && "$sql" != *shobj_description* ]]; then
  print -- "${FAKE_DATABASE:-agentos_restore_unit}"
elif [[ "$sql" == *shobj_description* ]]; then
  print -- "${FAKE_MARKER:-agentos:isolated-restore-target}"
elif [[ "$sql" == *user_objects* ]]; then
  print -- "${FAKE_OBJECT_COUNT:-0}"
else
  exit 2
fi' >"$bin/psql"

  print -r -- '#!/bin/zsh
if [[ "$1" == --list ]]; then
  [[ -s "$2" ]] || exit 1
  exit 0
fi
[[ -n "${FAKE_RESTORE_CALLED:-}" ]] && touch "$FAKE_RESTORE_CALLED"
exit "${FAKE_RESTORE_STATUS:-0}"' >"$bin/pg_restore"
  chmod +x "$bin/psql" "$bin/pg_restore"

  restore_command() {
    PATH="$bin:/usr/bin:/bin" PGSERVICE="${TEST_SERVICE:-agentos-restore-unit}" \
      PGSERVICEFILE="$service_file" \
      AGENTOS_RESTORE_CONFIRM="${TEST_CONFIRM:-restore:agentos_restore_unit}" \
      FAKE_DATABASE="${TEST_DATABASE:-agentos_restore_unit}" \
      FAKE_MARKER="${TEST_MARKER:-agentos:isolated-restore-target}" \
      FAKE_OBJECT_COUNT="${TEST_OBJECT_COUNT:-0}" \
      FAKE_RESTORE_CALLED="$called" FAKE_RESTORE_STATUS="${TEST_RESTORE_STATUS:-0}" \
      "$script_dir/restore-postgres.sh" "$archive"
  }

  TEST_SERVICE=unsafe-alias assert_status 78 restore_command
  [[ ! -e "$called" ]] || fail "wrong-prefix alias reached pg_restore"
  TEST_CONFIRM=restore:wrong_target assert_status 78 restore_command
  [[ ! -e "$called" ]] || fail "wrong confirmation reached pg_restore"
  TEST_DATABASE=agentos_source TEST_CONFIRM=restore:agentos_source assert_status 78 restore_command
  [[ ! -e "$called" ]] || fail "source database reached pg_restore"
  TEST_MARKER=missing assert_status 78 restore_command
  [[ ! -e "$called" ]] || fail "unmarked target reached pg_restore"
  TEST_OBJECT_COUNT=1 assert_status 78 restore_command
  [[ ! -e "$called" ]] || fail "non-empty target reached pg_restore"
  assert_status 0 restore_command
  [[ -f "$called" ]] || fail "valid isolated restore did not invoke pg_restore"
  rm -f "$called"
  TEST_RESTORE_STATUS=1 assert_status 70 restore_command
  [[ -f "$called" ]] || fail "restore failure was not propagated"
  print -- "restore-contract: pass"
}

test_verifier_contract() {
  local root="$test_root/verifier"
  local bin="$root/bin"
  local service_file="$root/pg_service.conf"
  mkdir -p "$bin"
  write_service_file "$service_file"

  print -r -- '#!/bin/zsh
set -u
sql=""
previous=""
for arg in "$@"; do
  if [[ "$previous" == --command ]]; then sql="$arg"; fi
  previous="$arg"
done
if [[ -n "${FAKE_VERIFY_FAIL_PATTERN:-}" && "$sql" == *"$FAKE_VERIFY_FAIL_PATTERN"* ]]; then
  print -- "fail"
elif [[ "$sql" == *"_prisma_migrations"* ]]; then
  print -- "14:14:synthetic-migration-fingerprint"
elif [[ "$sql" == *concat_ws* ]]; then
  print -- "synthetic-fixture-fingerprint"
else
  print -- "pass"
fi' >"$bin/psql"
  chmod +x "$bin/psql"

  verifier_command() {
    PATH="$bin:/usr/bin:/bin" PGSERVICE="agentos-restore-unit" \
      PGSERVICEFILE="$service_file" AGENTOS_SOURCE_PGSERVICE="${TEST_SOURCE_SERVICE:-}" \
      FAKE_VERIFY_FAIL_PATTERN="${TEST_FAIL_PATTERN:-}" \
      "$script_dir/verify-postgres-restore.sh"
  }

  assert_status 0 verifier_command
  TEST_SOURCE_SERVICE=agentos-source assert_status 0 verifier_command
  TEST_FAIL_PATTERN=InboxMessage assert_status 70 verifier_command
  print -- "verifier-contract: pass"
}

case "${1:-all}" in
  backup) test_backup_contract ;;
  restore) test_restore_contract ;;
  verifier) test_verifier_contract ;;
  all)
    test_backup_contract
    test_restore_contract
    test_verifier_contract
    print -- "fast-contracts: pass"
    ;;
  *)
    print -u2 -- "usage: postgres-backup-restore.test.sh [backup|restore|verifier|all]"
    exit 64
    ;;
esac
