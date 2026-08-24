#!/usr/bin/env bash
#
# A/B benchmark of the database step's concurrency. Runs ON THE WORKER, or in
# any checkout with docker and node:
#
#   scripts/gate-worker/bench-dbtest-concurrency.sh --oid <oid> --trials 3
#   scripts/gate-worker/bench-dbtest-concurrency.sh --here --trials 3
#
# It is bench-postgres.sh's discipline pointed at the other half of the same
# step. That script held the tree fixed and changed the container; this one
# holds the tree AND the container fixed — both arms get the gate's current
# tmpfs, durability-off PostgreSQL — and changes nothing but the two
# environment variables that decide how the files are executed:
#
#   A  serial     AGENTOS_DBTEST_PROVISION=0, AGENTOS_DBTEST_CONCURRENCY=1
#                 every file drops and re-applies one shared schema, so only
#                 one may run at a time — the step as it ran before this change
#   B  parallel   the defaults: one template migration, a database per file,
#                 and cores-1 (capped at 4) files at once
#
# Both arms run `npm run test:db -w @agentos/api`, the gate's own command, under
# the environment merge-gate.sh exports for it, with a fresh container, fresh
# isolated host directories and a fresh database each trial.
#
# `--arms B` runs one arm only. Ten of those is the check a change to how the
# files are executed has to pass before it is believed: ten consecutive green
# parallel runs, on the host the gate actually runs on.
#
# A trial fails the benchmark outright — rather than being recorded and moved
# past — if it leaves a scratch database behind, if any test failed, or if it
# ran a different number of tests than the trials before it. Ten green parallel
# trials is the claim; a harness that prints a leak and carries on is not
# checking it.
#
# A trial that saw a concurrent gate is marked CONTAMINATED and excluded: the
# worker deliberately allows two gates to overlap, and an overlapped sample of a
# parallel arm measures the overlap rather than the arm. The summary prints
# every trial's seconds, the median and the range, plus the node:test counts —
# equal counts across arms are what make the two numbers comparable at all.
set -uo pipefail

GATE_HOME="${GATE_HOME:-${HOME}/gate}"
MIRROR_DIR="${MIRROR_DIR:-${GATE_HOME}/agentos/mirror.git}"
TRIALS=3
OID=""
HERE=0
OUT_DIR=""
CONCURRENCY=""
ARMS="A B"

EXIT_FAIL=1
EXIT_USAGE=2

# The whole header block, however long it grows, rather than a line range that
# silently starts truncating it.
usage() { awk 'NR > 1 && /^#/ { sub(/^#+ ?/, ""); print; next } NR > 1 { exit }' "$0"; exit "${1:-0}"; }
die() { printf '\nbench: %s\n' "$1" >&2; exit "$EXIT_FAIL"; }
say() { printf '\n== %s\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --oid) OID="${2:-}"; shift 2 || usage "$EXIT_USAGE" ;;
    --trials) TRIALS="${2:-}"; shift 2 || usage "$EXIT_USAGE" ;;
    --out) OUT_DIR="${2:-}"; shift 2 || usage "$EXIT_USAGE" ;;
    --concurrency) CONCURRENCY="${2:-}"; shift 2 || usage "$EXIT_USAGE" ;;
    --arms) ARMS="${2:-}"; shift 2 || usage "$EXIT_USAGE" ;;
    --here) HERE=1; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'bench: unknown argument %s\n' "$1" >&2; usage "$EXIT_USAGE" ;;
  esac
done

case "$TRIALS" in ''|*[!0-9]*) die "--trials must be a positive integer" ;; esac
[ "$TRIALS" -ge 1 ] || die "--trials must be at least 1"
case "$CONCURRENCY" in '') ;; *[!0-9]*) die "--concurrency must be a positive integer" ;; esac
case "$ARMS" in "A B"|"A"|"B") ;; *) die "--arms must be A, B, or 'A B'" ;; esac
[ -n "$OID" ] || [ "$HERE" -eq 1 ] || usage "$EXIT_USAGE"

command -v docker >/dev/null 2>&1 || die "docker is required"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
command -v node >/dev/null 2>&1 || die "node is required"

POSTGRES_IMAGE="${AGENTOS_GATE_POSTGRES_IMAGE:-postgres:16-alpine}"

gate_running() { pgrep -f '^bash scripts/merge-gate' >/dev/null 2>&1; }

wait_for_idle() {
  local waited=0
  while gate_running; do
    [ "$waited" -eq 0 ] && printf '   a gate is running; waiting for the host to go idle\n'
    sleep 15
    waited=$(( waited + 15 ))
    [ "$waited" -le 5400 ] || die "gates have held this host for 90 minutes; benchmark later"
  done
}

# --- the tree, fixed for every trial ----------------------------------------

WORKTREE=""
WORKTREE_CREATED=0
if [ "$HERE" -eq 1 ]; then
  WORKTREE="$(git rev-parse --show-toplevel 2>/dev/null)" || die "--here needs a git checkout"
  OID="$(git -C "$WORKTREE" rev-parse HEAD)"
else
  [ -d "$MIRROR_DIR" ] || die "no mirror at ${MIRROR_DIR}"
  git -C "$MIRROR_DIR" cat-file -e "${OID}^{commit}" 2>/dev/null || die "commit ${OID} is not in the mirror"
  OID="$(git -C "$MIRROR_DIR" rev-parse "${OID}^{commit}")"
  WORKTREE="${GATE_HOME}/bench/tree-${OID}-$$"
  mkdir -p "$(dirname "$WORKTREE")" || die "could not create ${GATE_HOME}/bench"
  git -C "$MIRROR_DIR" worktree add --detach --quiet "$WORKTREE" "$OID" || die "could not check out ${OID}"
  WORKTREE_CREATED=1
fi

OUT_DIR="${OUT_DIR:-${GATE_HOME}/bench/dbtest-${OID}-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT_DIR" || die "could not create ${OUT_DIR}"

CONTAINER=""
TMP_ROOT=""

# Only ever the throwaway things this run created, each matched against the name
# it was created with — the same rule bench-postgres.sh applies.
discard() {
  case "$1" in
    /*/*) command rm -rf -- "$1" 2>/dev/null ;;
    *) printf 'bench: refusing to discard unexpected path %s\n' "$1" >&2 ;;
  esac
}

cleanup() {
  local status=$?
  trap - EXIT
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1
  [ -n "$TMP_ROOT" ] && discard "$TMP_ROOT"
  if [ "$WORKTREE_CREATED" -eq 1 ]; then
    case "$WORKTREE" in
      "${GATE_HOME}"/bench/tree-*)
        discard "$WORKTREE"
        git -C "$MIRROR_DIR" worktree prune 2>/dev/null
        ;;
      *) printf 'bench: refusing to discard unexpected worktree %s\n' "$WORKTREE" >&2 ;;
    esac
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "Benchmarking ${OID} — ${TRIALS} alternating trials per arm"
printf '   host:     %s\n' "$(uname -srm)"
printf '   cores:    %s\n' "$(node -p 'require("node:os").availableParallelism()')"
printf '   node:     %s, npm %s\n' "$(node -v 2>/dev/null)" "$(npm -v 2>/dev/null)"
printf '   tree:     %s\n' "$WORKTREE"
printf '   arms:     %s\n' "$ARMS"
printf '   arm B:    %s\n' "${CONCURRENCY:-default (cores-1, capped at 4)}"
printf '   output:   %s\n' "$OUT_DIR"

# Installed and generated once: it is shared by every trial and sits outside
# every timed region, so it cannot favour an arm.
say "Preparing the tree (once, untimed)"
( cd "$WORKTREE" && npm ci ) > "${OUT_DIR}/prepare.log" 2>&1 || die "npm ci failed; see ${OUT_DIR}/prepare.log"
( cd "$WORKTREE" && npm run db:generate ) >> "${OUT_DIR}/prepare.log" 2>&1 || die "prisma generate failed; see ${OUT_DIR}/prepare.log"

# --- the two arms -----------------------------------------------------------

# The whole difference between the arms, in one place. Arm A is the environment
# the step ran under before per-file databases existed; arm B is the default.
arm_environment() {
  case "$1" in
    A) printf '%s\n' "AGENTOS_DBTEST_PROVISION=0" "AGENTOS_DBTEST_CONCURRENCY=1" ;;
    B) [ -n "$CONCURRENCY" ] && printf '%s\n' "AGENTOS_DBTEST_CONCURRENCY=${CONCURRENCY}" ;;
  esac
}

run_trial() {
  local arm="$1" round="$2"
  local label="${arm}${round}"
  local log="${OUT_DIR}/trial-${label}.log"
  CONTAINER="agentos-benchdb-${arm}-${round}-$$"

  # The container merge-gate.sh starts today, identical for both arms: the
  # server is not what is under test here.
  docker run -d --rm --name "$CONTAINER" \
    -e POSTGRES_USER=agentos -e POSTGRES_PASSWORD=gate-scratch-fixture-password-000000 \
    -e POSTGRES_DB=agentos_gate \
    -e PGDATA=/var/lib/postgresql/data \
    --tmpfs /var/lib/postgresql/data:rw,size=1024m \
    -p 127.0.0.1::5432 "$POSTGRES_IMAGE" \
    -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
    -c max_connections=200 -c max_wal_size=256MB >/dev/null \
    || die "trial ${label}: could not start ${POSTGRES_IMAGE}"

  local port
  port="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
  [ -n "$port" ] || die "trial ${label}: the container published no port"
  [ "$port" != "5432" ] || die "trial ${label}: refusing a container published on 5432"

  local ready=0 i
  for i in $(seq 1 90); do
    if docker exec "$CONTAINER" psql -h 127.0.0.1 -U agentos -d agentos_gate -Atc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" -eq 1 ] || die "trial ${label}: PostgreSQL did not become ready"

  TMP_ROOT="$(mktemp -d)"
  export RUNNER_WORKSPACE_ROOT="${TMP_ROOT}/workspaces"
  export CONTROL_PLANE_STATE_DIR="${TMP_ROOT}/state"
  export FILES_ROOT="${TMP_ROOT}/files"
  mkdir -p "$RUNNER_WORKSPACE_ROOT" "$CONTROL_PLANE_STATE_DIR" "$FILES_ROOT"
  export TEST_DATABASE_URL="postgresql://agentos:gate-scratch-fixture-password-000000@127.0.0.1:${port}/agentos_gate?schema=agentos_gate"
  export TEST_DATABASE_MAINTENANCE_URL="postgresql://agentos:gate-scratch-fixture-password-000000@127.0.0.1:${port}/postgres"
  export DATABASE_URL="$TEST_DATABASE_URL"
  export AGENTOS_ALLOW_SCRATCH_DATABASES=1
  unset AGENTOS_DBTEST_PROVISION AGENTOS_DBTEST_CONCURRENCY
  local setting
  while IFS= read -r setting; do
    [ -n "$setting" ] && export "${setting?}"
  done < <(arm_environment "$arm")

  # The gate's own migrate step, outside the timed region exactly as it is
  # outside the gate's database step.
  ( cd "${WORKTREE}/packages/db" && npx prisma migrate deploy ) >> "$log" 2>&1 \
    || die "trial ${label}: migrate failed; see ${log}"

  # Overlap is sampled for the whole trial, for the reason bench-postgres.sh
  # gives: a gate that starts and finishes inside the timed region would pass a
  # single check at the end while owning half the CPU throughout.
  local overlap="${OUT_DIR}/overlap-${label}.txt"
  : > "$overlap"
  ( while :; do
      gate_running && date -u +%Y-%m-%dT%H:%M:%SZ >> "$overlap"
      sleep 5
    done ) &
  local sampler=$!

  local load started ended elapsed rc t0
  load="$(uptime | sed 's/.*load average: //')"
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  t0=$(date +%s)
  ( cd "$WORKTREE" && npm run test:db -w @agentos/api ) >> "$log" 2>&1
  rc=$?
  elapsed=$(( $(date +%s) - t0 ))
  ended="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  kill "$sampler" >/dev/null 2>&1
  wait "$sampler" 2>/dev/null

  # What the arm actually ran under, recorded rather than assumed.
  { printf 'AGENTOS_DBTEST_PROVISION=%s\n' "${AGENTOS_DBTEST_PROVISION:-unset}"
    printf 'AGENTOS_DBTEST_CONCURRENCY=%s\n' "${AGENTOS_DBTEST_CONCURRENCY:-unset}"
    grep -a '^dbtest: ' "$log" | head -3
  } > "${OUT_DIR}/settings-${label}.txt"

  # A scratch database left behind would make the next trial start from a
  # different server, so the count is evidence about the runner's own cleanup.
  local leaked
  leaked="$(docker exec "$CONTAINER" psql -h 127.0.0.1 -U agentos -d postgres -Atc \
    "select count(*) from pg_database where datname like 'agentos_cp_a_%'" 2>/dev/null)"
  printf 'scratch databases left behind: %s\n' "${leaked:-unknown}" >> "${OUT_DIR}/settings-${label}.txt"

  docker rm -f "$CONTAINER" >/dev/null 2>&1
  CONTAINER=""
  discard "$TMP_ROOT"; TMP_ROOT=""

  [ "$rc" -eq 0 ] || die "trial ${label}: the database step failed; see ${log}"

  # Recorded and then required. A trial that leaves a database behind has not
  # demonstrated the thing ten of these trials are run to demonstrate, and a
  # count this cannot read is not evidence of zero.
  [ "${leaked:-unknown}" = "0" ] \
    || die "trial ${label}: ${leaked:-unknown} scratch database(s) left behind; see ${log}"

  local tests passed failed
  tests="$(grep -a '^. tests ' "$log" | tail -1 | awk '{print $3}')"
  passed="$(grep -a '^. pass ' "$log" | tail -1 | awk '{print $3}')"
  failed="$(grep -a '^. fail ' "$log" | tail -1 | awk '{print $3}')"

  # Two arms are comparable only if they ran the same tests, and neither arm's
  # seconds mean anything if some of those tests did not pass. An exit code of
  # zero is not enough to know either.
  { [ -n "$tests" ] && [ -n "$passed" ] && [ -n "$failed" ]; } \
    || die "trial ${label}: node:test printed no summary; see ${log}"
  [ "$failed" = "0" ] || die "trial ${label}: ${failed} test(s) failed; see ${log}"
  [ "$passed" = "$tests" ] || die "trial ${label}: ${passed} of ${tests} tests passed; see ${log}"
  if [ -z "$EXPECTED_TESTS" ]; then
    EXPECTED_TESTS="$tests"
  else
    [ "$tests" = "$EXPECTED_TESTS" ] \
      || die "trial ${label}: ${tests} tests, but earlier trials ran ${EXPECTED_TESTS}; these arms are not comparable"
  fi

  local contaminated=""
  TRIAL_CLEAN=1
  if [ -s "$overlap" ]; then
    contaminated="CONTAMINATED(gate seen $(wc -l < "$overlap" | tr -d ' ') times, $(head -1 "$overlap")..$(tail -1 "$overlap"))"
    TRIAL_CLEAN=0
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$arm" "$round" "$elapsed" "$started" "$ended" "$tests" "$passed" "$failed" "$contaminated" \
    >> "${OUT_DIR}/results.tsv"
  printf '   %s trial %s: %4ss  tests=%s pass=%s fail=%s  leaked=%s  load=%s  %s..%s %s\n' \
    "$arm" "$round" "$elapsed" "$tests" "$passed" "$failed" "${leaked:-?}" "$load" "$started" "$ended" "$contaminated"
}

# --- the trials -------------------------------------------------------------

: > "${OUT_DIR}/results.tsv"
say "Trials (A = one shared schema, serial; B = a database per file, parallel; alternating)"
printf '   %s clean trials wanted per arm; contaminated ones are recorded, excluded and repeated\n' "$TRIALS"

TRIAL_CLEAN=0
EXPECTED_TESTS=""
clean_A=0
clean_B=0
case "$ARMS" in *A*) ;; *) clean_A="$TRIALS" ;; esac
case "$ARMS" in *B*) ;; *) clean_B="$TRIALS" ;; esac
MAX_ROUNDS=$(( TRIALS * 3 ))
round=0
while [ "$clean_A" -lt "$TRIALS" ] || [ "$clean_B" -lt "$TRIALS" ]; do
  round=$(( round + 1 ))
  [ "$round" -le "$MAX_ROUNDS" ] \
    || die "gave up after ${MAX_ROUNDS} rounds with A=${clean_A} B=${clean_B} clean; the host is too busy to measure on"
  for arm in $ARMS; do
    eval "have=\$clean_${arm}"
    [ "$have" -ge "$TRIALS" ] && continue
    wait_for_idle
    run_trial "$arm" "$round"
    [ "$TRIAL_CLEAN" -eq 1 ] && eval "clean_${arm}=\$(( have + 1 ))"
  done
done

# --- summary ----------------------------------------------------------------

summarise() {
  awk -v arm="$1" '
    $1 == arm && $0 !~ /CONTAMINATED/ { v[n++] = $3 }
    END {
      if (n == 0) { printf "%s  no clean samples\n", arm; exit }
      for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) if (v[j] < v[i]) { t = v[i]; v[i] = v[j]; v[j] = t }
      median = (n % 2) ? v[int(n / 2)] : (v[n / 2 - 1] + v[n / 2]) / 2
      printf "%s  n=%d  median=%ss  range=%s-%ss  samples=", arm, n, median, v[0], v[n - 1]
      for (i = 0; i < n; i++) printf "%s%s", v[i], (i < n - 1 ? "," : "\n")
    }' "${OUT_DIR}/results.tsv"
}

say "Summary — ${OID}"
for arm in $ARMS; do summarise "$arm"; done
awk '
  $0 !~ /CONTAMINATED/ { v[$1 "," n[$1]++] = $3 }
  function med(arm,   i, j, t, k, a) {
    k = n[arm]; for (i = 0; i < k; i++) a[i] = v[arm "," i]
    for (i = 0; i < k; i++) for (j = i + 1; j < k; j++) if (a[j] < a[i]) { t = a[i]; a[i] = a[j]; a[j] = t }
    return (k % 2) ? a[int(k / 2)] : (a[k / 2 - 1] + a[k / 2]) / 2
  }
  END { if (n["A"] && n["B"]) printf "\nspeedup (median A / median B): %.2fx\n", med("A") / med("B") }
' "${OUT_DIR}/results.tsv"
printf '\nper-trial rows:  %s/results.tsv\nlogs:            %s/trial-*.log\narm settings:    %s/settings-*.txt\n' \
  "$OUT_DIR" "$OUT_DIR" "$OUT_DIR"
