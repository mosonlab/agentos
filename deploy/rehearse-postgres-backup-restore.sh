#!/bin/zsh
set -u
set -o pipefail

script_dir="${0:A:h}"
repo_root="${script_dir:h}"
temp_base="${TMPDIR:-/tmp}"
temp_base="${temp_base%/}"
temp_root=""
container_id=""
container_cid_file=""
container_name=""
run_token=""
private_log=""
readonly rehearsal_label="com.agentos.ossd-rehearsal"

fail() {
  print -u2 -- "rehearsal failed: $1"
  exit 1
}

cleanup_resources() {
  local cleanup_status=0
  if [[ -z "$container_id" && -n "$container_cid_file" && -f "$container_cid_file" ]]; then
    local recovered_container_id
    recovered_container_id="$(<"$container_cid_file")" || cleanup_status=1
    if [[ -n "$recovered_container_id" && ${#recovered_container_id} -ge 12 \
      && -z "${recovered_container_id//[0-9a-f]/}" ]]; then
      container_id="$recovered_container_id"
    else
      cleanup_status=1
    fi
  fi
  if [[ -n "$container_id" ]]; then
    local actual_label actual_name
    actual_label="$(docker inspect --format "{{index .Config.Labels \"$rehearsal_label\"}}" "$container_id" 2>/dev/null)" || \
      cleanup_status=1
    actual_name="$(docker inspect --format '{{.Name}}' "$container_id" 2>/dev/null)" || \
      cleanup_status=1
    actual_name="${actual_name#/}"
    if (( cleanup_status == 0 )) && [[ "$actual_label" == "$run_token" && "$actual_name" == "$container_name" ]]; then
      docker rm -f -- "$container_id" >/dev/null 2>&1 || cleanup_status=1
      container_id=""
    else
      cleanup_status=1
    fi
  fi
  if [[ -n "$temp_root" ]]; then
    if [[ "$temp_root" == "$temp_base"/agentos-ossd-rehearsal.* \
      && -f "$temp_root/.owned-by-ossd-rehearsal" \
      && "$(<"$temp_root/.owned-by-ossd-rehearsal")" == "$run_token" ]]; then
      rm -rf -- "$temp_root" || cleanup_status=1
      temp_root=""
    else
      cleanup_status=1
    fi
  fi
  return "$cleanup_status"
}

on_exit() {
  local exit_status=$?
  trap - EXIT HUP INT TERM
  if ! cleanup_resources; then
    print -u2 -- "rehearsal cleanup refused: resource identity mismatch"
    exit 1
  fi
  exit "$exit_status"
}

on_signal() {
  local signal_status="$1"
  trap - HUP INT TERM
  exit "$signal_status"
}

trap on_exit EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

for required_command in docker npm shasum awk sed grep head wc; do
  command -v "$required_command" >/dev/null 2>&1 || fail "required-tool-$required_command"
done
[[ -x "$repo_root/node_modules/.bin/prisma" ]] || fail "node-dependencies"

run_token="$(printf '%s' "$$:$(date -u +%Y%m%dT%H%M%SZ)" | shasum -a 256 | awk '{print substr($1,1,16)}')"
temp_root="$(mktemp -d "$temp_base/agentos-ossd-rehearsal.XXXXXX")" || fail "temporary-root"
print -n -- "$run_token" >"$temp_root/.owned-by-ossd-rehearsal"
chmod 600 "$temp_root/.owned-by-ossd-rehearsal"
private_log="$temp_root/private.log"
: >"$private_log"
chmod 600 "$private_log"

container_name="agentos-ossd-$run_token"
container_cid_file="$temp_root/container.cid"
docker run --detach --cidfile "$container_cid_file" --name "$container_name" \
  --label "$rehearsal_label=$run_token" \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --publish 127.0.0.1::5432 postgres:16-alpine >>"$private_log" 2>&1 || \
  fail "container-start"
[[ -f "$container_cid_file" ]] || fail "container-start"
container_id="$(<"$container_cid_file")" || fail "container-start"
[[ -n "$container_id" ]] || fail "container-start"

ready=0
for attempt in {1..60}; do
  if docker exec "$container_id" pg_isready -U postgres -d postgres >/dev/null 2>>"$private_log"; then
    ready=1
    break
  fi
  sleep 1
done
(( ready == 1 )) || fail "container-readiness"

readonly synthetic_role="ossd_synthetic"
readonly source_database="agentos_source"
readonly success_database="agentos_restore_success"
readonly nonempty_database="agentos_restore_nonempty"
readonly failure_database="agentos_restore_failure"

docker exec "$container_id" psql -X -U postgres -d postgres \
  --set=ON_ERROR_STOP=1 --command "CREATE ROLE $synthetic_role LOGIN" \
  >>"$private_log" 2>&1 || fail "synthetic-role"
for database_name in "$source_database" "$success_database" "$nonempty_database" "$failure_database"; do
  docker exec "$container_id" createdb -U postgres -O "$synthetic_role" "$database_name" \
    >>"$private_log" 2>&1 || fail "synthetic-database"
done

published_endpoint="$(docker port "$container_id" 5432/tcp 2>>"$private_log")" || fail "container-endpoint"
published_port="${published_endpoint##*:}"
[[ "$published_port" == <-> ]] || fail "container-endpoint"
readonly connection_sentinel="ossd-connection-$run_token"

service_file="$temp_root/pg_service.conf"
{
  for service_record in \
    "agentos-source:$source_database" \
    "agentos-restore-source:$source_database" \
    "agentos-restore-success:$success_database" \
    "agentos-restore-nonempty:$nonempty_database" \
    "agentos-restore-failure:$failure_database" \
    "unsafe-alias:$success_database"; do
    service_alias="${service_record%%:*}"
    database_name="${service_record#*:}"
    print -- "[$service_alias]"
    print -- "host=127.0.0.1"
    print -- "port=$published_port"
    print -- "user=$synthetic_role"
    print -- "dbname=$database_name"
    print -- "sslmode=disable"
    print -- "application_name=$connection_sentinel"
  done
} >"$service_file"
chmod 600 "$service_file"

tool_bin="$temp_root/tool-bin"
mkdir "$tool_bin"

print -r -- '#!/bin/zsh
set -u
lookup_database() {
  awk -v wanted="[$PGSERVICE]" '\''
    $0 == wanted { active = 1; next }
    /^\[/ { active = 0 }
    active && /^dbname=/ { sub(/^dbname=/, ""); print; exit }
  '\'' "$PGSERVICEFILE"
}
database_name="$(lookup_database)"
[[ -n "$database_name" ]] || exit 64
input_file=""
skip_next=0
typeset -a forwarded
for arg in "$@"; do
  if (( skip_next == 1 )); then
    input_file="$arg"
    skip_next=0
  elif [[ "$arg" == --file ]]; then
    skip_next=1
  elif [[ "$arg" == --file=* ]]; then
    input_file="${arg#--file=}"
  else
    forwarded+=("$arg")
  fi
done
if [[ -n "$input_file" ]]; then
  exec docker exec -i "$OSSD_CONTAINER_ID" psql -X -U "$OSSD_DATABASE_ROLE" -d "$database_name" "${forwarded[@]}" <"$input_file"
fi
exec docker exec -i "$OSSD_CONTAINER_ID" psql -X -U "$OSSD_DATABASE_ROLE" -d "$database_name" "${forwarded[@]}"' \
  >"$tool_bin/psql"

print -r -- '#!/bin/zsh
set -u
if [[ "${OSSD_PG_DUMP_MODE:-success}" == fail ]]; then
  for arg in "$@"; do
    [[ "$arg" == --file=* ]] && print -n -- "incomplete" >"${arg#--file=}"
  done
  exit 1
fi
database_name="$(awk -v wanted="[$PGSERVICE]" '\''
  $0 == wanted { active = 1; next }
  /^\[/ { active = 0 }
  active && /^dbname=/ { sub(/^dbname=/, ""); print; exit }
'\'' "$PGSERVICEFILE")"
output_file=""
typeset -a forwarded
for arg in "$@"; do
  if [[ "$arg" == --file=* ]]; then
    output_file="${arg#--file=}"
  else
    forwarded+=("$arg")
  fi
done
[[ -n "$database_name" && -n "$output_file" ]] || exit 64
docker exec "$OSSD_CONTAINER_ID" pg_dump -U "$OSSD_DATABASE_ROLE" -d "$database_name" "${forwarded[@]}" >"$output_file"' \
  >"$tool_bin/pg_dump"

print -r -- '#!/bin/zsh
set -u
if [[ "$1" == --list ]]; then
  [[ "${OSSD_PG_RESTORE_LIST_MODE:-success}" == success ]] || exit 1
  exec docker exec -i "$OSSD_CONTAINER_ID" pg_restore --list <"$2"
fi
database_name="$(awk -v wanted="[$PGSERVICE]" '\''
  $0 == wanted { active = 1; next }
  /^\[/ { active = 0 }
  active && /^dbname=/ { sub(/^dbname=/, ""); print; exit }
'\'' "$PGSERVICEFILE")"
archive_path="${@[-1]}"
typeset -a forwarded
for arg in "${@[1,-2]}"; do
  [[ "$arg" == --dbname=* ]] || forwarded+=("$arg")
done
[[ -n "$database_name" && -f "$archive_path" ]] || exit 64
exec docker exec -i "$OSSD_CONTAINER_ID" pg_restore -U "$OSSD_DATABASE_ROLE" -d "$database_name" "${forwarded[@]}" <"$archive_path"' \
  >"$tool_bin/pg_restore"
chmod +x "$tool_bin/psql" "$tool_bin/pg_dump" "$tool_bin/pg_restore"

export PATH="$tool_bin:$PATH"
export PGSERVICEFILE="$service_file"
export OSSD_CONTAINER_ID="$container_id"
export OSSD_DATABASE_ROLE="$synthetic_role"

source_url="postgresql://$synthetic_role@127.0.0.1:$published_port/$source_database?schema=public&sslmode=disable"
DATABASE_URL="$source_url" npm exec --workspace @agentos/db -- prisma migrate deploy \
  >>"$private_log" 2>&1 || fail "migration-deploy"
DATABASE_URL="$source_url" npm run db:validate >>"$private_log" 2>&1 || fail "schema-validation"

PGSERVICE=agentos-source psql --file "$script_dir/fixtures/postgres-backup-restore.sql" \
  >>"$private_log" 2>&1 || fail "fixture-load"

archive_dir="$temp_root/archives"
mkdir "$archive_dir"
PGSERVICE=agentos-source AGENTOS_BACKUP_DIR="$archive_dir" "$script_dir/backup-postgres.sh" \
  >>"$private_log" 2>&1 || fail "valid-backup"
valid_archives=("$archive_dir"/agentos-*.dump(N))
(( ${#valid_archives} == 1 )) || fail "valid-backup-count"
valid_archive="$valid_archives[1]"
PGSERVICE=agentos-source pg_restore --list "$valid_archive" >>"$private_log" 2>&1 || \
  fail "archive-toc"
archive_checksum="$(shasum -a 256 "$valid_archive" | awk '{print $1}')"

failed_backup_dir="$temp_root/failed-backup"
mkdir "$failed_backup_dir"
PGSERVICE=agentos-source AGENTOS_BACKUP_DIR="$failed_backup_dir" OSSD_PG_DUMP_MODE=fail \
  "$script_dir/backup-postgres.sh" >>"$private_log" 2>&1
[[ $? == 70 ]] || fail "backup-failure-status"
[[ -z "$(find "$failed_backup_dir" -maxdepth 1 -type f -name 'agentos-*.dump' -print -quit)" ]] || \
  fail "backup-failure-final"
[[ -z "$(find "$failed_backup_dir" -maxdepth 1 -name '.agentos-backup-*' -print -quit)" ]] || \
  fail "backup-failure-partial"

invalid_backup_dir="$temp_root/invalid-backup"
mkdir "$invalid_backup_dir"
PGSERVICE=agentos-source AGENTOS_BACKUP_DIR="$invalid_backup_dir" OSSD_PG_RESTORE_LIST_MODE=fail \
  "$script_dir/backup-postgres.sh" >>"$private_log" 2>&1
[[ $? == 65 ]] || fail "backup-validation-status"
[[ -z "$(find "$invalid_backup_dir" -maxdepth 1 -type f -name 'agentos-*.dump' -print -quit)" ]] || \
  fail "backup-validation-final"
[[ -z "$(find "$invalid_backup_dir" -maxdepth 1 -name '.agentos-backup-*' -print -quit)" ]] || \
  fail "backup-validation-partial"

retention_dir="$temp_root/retention"
mkdir "$retention_dir"
for index in {01..15}; do
  print -n -- "controlled-old-archive-$index" >"$retention_dir/agentos-20260701T0000${index}Z-seed.dump"
  touch -t "2026070100${index}.00" "$retention_dir/agentos-20260701T0000${index}Z-seed.dump"
done
print -- "unrelated" >"$retention_dir/operator-note.txt"
PGSERVICE=agentos-source AGENTOS_BACKUP_DIR="$retention_dir" "$script_dir/backup-postgres.sh" \
  >>"$private_log" 2>&1 || fail "retention-backup"
retention_count="$(find "$retention_dir" -maxdepth 1 -type f -name 'agentos-*.dump' | wc -l | tr -d ' ')"
[[ "$retention_count" == 14 ]] || fail "retention-count"
[[ ! -e "$retention_dir/agentos-20260701T000001Z-seed.dump" \
  && ! -e "$retention_dir/agentos-20260701T000002Z-seed.dump" \
  && -f "$retention_dir/operator-note.txt" ]] || fail "retention-selection"

for marked_database in "$success_database" "$nonempty_database"; do
  docker exec "$container_id" psql -X -U postgres -d postgres --set=ON_ERROR_STOP=1 \
    --command "COMMENT ON DATABASE $marked_database IS 'agentos:isolated-restore-target'" \
    >>"$private_log" 2>&1 || fail "target-marker"
done
PGSERVICE=agentos-restore-nonempty psql --set=ON_ERROR_STOP=1 \
  --command 'CREATE TABLE ossd_nonempty (id integer PRIMARY KEY, note text NOT NULL); INSERT INTO ossd_nonempty VALUES (1, '\''preserve'\'');' \
  >>"$private_log" 2>&1 || fail "nonempty-fixture"

user_object_count() {
  local service_alias="$1"
  PGSERVICE="$service_alias" psql --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 \
    --command "
      WITH user_namespaces AS (
        SELECT oid FROM pg_namespace
        WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
      ), user_objects AS (
        SELECT c.oid FROM pg_class c
        WHERE c.relnamespace IN (SELECT oid FROM user_namespaces)
          AND c.relkind IN ('r','p','v','m','S','f')
        UNION ALL
        SELECT p.oid FROM pg_proc p
        WHERE p.pronamespace IN (SELECT oid FROM user_namespaces)
        UNION ALL
        SELECT t.oid FROM pg_type t
        WHERE t.typnamespace IN (SELECT oid FROM user_namespaces)
          AND t.typtype IN ('d','e','r')
        UNION ALL
        SELECT n.oid FROM pg_namespace n
        WHERE n.oid IN (SELECT oid FROM user_namespaces) AND n.nspname <> 'public'
      )
      SELECT count(*) FROM user_objects" \
    2>>"$private_log" | tr -d '[:space:]'
}

expect_refusal_unchanged() {
  local assertion="$1"
  local service_alias="$2"
  local confirmation="$3"
  local snapshot_service="$4"
  local before after refusal_status
  before="$(user_object_count "$snapshot_service")" || fail "$assertion-before"
  PGSERVICE="$service_alias" AGENTOS_RESTORE_CONFIRM="$confirmation" \
    "$script_dir/restore-postgres.sh" "$valid_archive" >>"$private_log" 2>&1
  refusal_status=$?
  [[ "$refusal_status" == 78 ]] || fail "$assertion-status"
  after="$(user_object_count "$snapshot_service")" || fail "$assertion-after"
  [[ "$before" == "$after" ]] || fail "$assertion-mutation"
}

expect_refusal_unchanged "wrong-prefix-refusal" "unsafe-alias" \
  "restore:$success_database" "agentos-restore-success"
expect_refusal_unchanged "wrong-confirmation-refusal" "agentos-restore-success" \
  "restore:wrong_target" "agentos-restore-success"
expect_refusal_unchanged "source-refusal" "agentos-restore-source" \
  "restore:$source_database" "agentos-restore-source"
expect_refusal_unchanged "missing-marker-refusal" "agentos-restore-failure" \
  "restore:$failure_database" "agentos-restore-failure"
expect_refusal_unchanged "nonempty-refusal" "agentos-restore-nonempty" \
  "restore:$nonempty_database" "agentos-restore-nonempty"
nonempty_row="$(PGSERVICE=agentos-restore-nonempty psql --tuples-only --no-align --quiet \
  --command "SELECT note FROM ossd_nonempty WHERE id = 1" 2>>"$private_log" | tr -d '[:space:]')" || \
  fail "nonempty-snapshot"
[[ "$nonempty_row" == preserve ]] || fail "nonempty-snapshot"

docker exec "$container_id" psql -X -U postgres -d postgres --set=ON_ERROR_STOP=1 \
  --command "COMMENT ON DATABASE $failure_database IS 'agentos:isolated-restore-target'" \
  >>"$private_log" 2>&1 || fail "failure-target-marker"

archive_size="$(wc -c <"$valid_archive" | tr -d '[:space:]')"
corrupt_archive=""
for cut_bytes in 64 128 256 512 1024 2048 4096 8192 16384 32768; do
  remaining=$(( archive_size - cut_bytes ))
  (( remaining > 1024 )) || continue
  candidate="$temp_root/corrupt-$cut_bytes.dump"
  head -c "$remaining" "$valid_archive" >"$candidate" || fail "corrupt-copy"
  if docker exec -i "$container_id" pg_restore --list <"$candidate" >>"$private_log" 2>&1 \
    && ! docker exec -i "$container_id" pg_restore --file=/dev/null <"$candidate" >>"$private_log" 2>&1; then
    corrupt_archive="$candidate"
    break
  fi
done
[[ -n "$corrupt_archive" ]] || fail "toc-readable-corruption"

PGSERVICE=agentos-restore-failure AGENTOS_RESTORE_CONFIRM="restore:$failure_database" \
  "$script_dir/restore-postgres.sh" "$corrupt_archive" >>"$private_log" 2>&1
[[ $? == 70 ]] || fail "transactional-failure-status"
[[ "$(user_object_count agentos-restore-failure)" == 0 ]] || fail "transactional-failure-atomicity"

PGSERVICE=agentos-restore-success AGENTOS_RESTORE_CONFIRM="restore:$success_database" \
  "$script_dir/restore-postgres.sh" "$valid_archive" >>"$private_log" 2>&1 || \
  fail "valid-restore"
verification_output="$temp_root/verification.out"
PGSERVICE=agentos-restore-success AGENTOS_SOURCE_PGSERVICE=agentos-source \
  "$script_dir/verify-postgres-restore.sh" >"$verification_output" 2>>"$private_log" || \
  fail "integrity-verification"
migration_count="$(awk '/^migration-count: / {print $2}' "$verification_output")"
[[ "$migration_count" == <-> ]] || fail "migration-count-evidence"

before_rerun="$(user_object_count agentos-restore-success)" || fail "post-restore-snapshot"
PGSERVICE=agentos-restore-success AGENTOS_RESTORE_CONFIRM="restore:$success_database" \
  "$script_dir/restore-postgres.sh" "$valid_archive" >>"$private_log" 2>&1
[[ $? == 78 ]] || fail "post-restore-nonempty-refusal"
after_rerun="$(user_object_count agentos-restore-success)" || fail "post-restore-snapshot"
[[ "$before_rerun" == "$after_rerun" ]] || fail "post-restore-mutation"

client_major="$(docker exec "$container_id" pg_restore --version | sed -E 's/.* ([0-9]+).*/\1/')" || \
  fail "client-version"
server_major="$(docker exec "$container_id" psql -X -U postgres -d postgres --tuples-only --no-align \
  --command "SHOW server_version_num" | awk '{print int($1 / 10000)}')" || fail "server-version"

evidence_file="$temp_root/evidence.out"
{
  print -- "schema-validation: pass"
  print -- "backup-failure-cleanup: pass"
  print -- "archive-toc: pass"
  print -- "retention-selection: pass"
  print -- "unsafe-target-refusals: pass"
  print -- "transactional-failure-atomicity: pass"
  sed -n '/^[a-z-]*: pass$/p' "$verification_output"
  print -- "post-restore-nonempty-refusal: pass"
  print -- "postgres-client-major: $client_major"
  print -- "postgres-server-major: $server_major"
  print -- "archive-sha256: $archive_checksum"
  print -- "migration-count: $migration_count"
  print -- "row-assertions: project-row,agent-row,task-row,run-row,inbox-row"
  print -- "retention-count: $retention_count"
} >"$evidence_file"

for forbidden_value in "$connection_sentinel" 127.0.0.1 "$published_port" "$synthetic_role" \
  "$source_database" "$success_database" "$nonempty_database" "$failure_database" "$source_url"; do
  if grep -F -- "$forbidden_value" "$evidence_file" >/dev/null 2>&1; then
    fail "evidence-redaction"
  fi
done
evidence="$(<"$evidence_file")"

if ! cleanup_resources; then
  fail "cleanup"
fi
if [[ -n "$(docker ps -a --filter label="$rehearsal_label" --format '{{.ID}}')" ]]; then
  fail "labelled-cleanup-audit"
fi
trap - EXIT HUP INT TERM
print -r -- "$evidence"
print -- "cleanup: pass"
