#!/usr/bin/env bash
#
# A/B benchmark of the gate's throwaway PostgreSQL settings (issue #146). Runs
# ON THE WORKER, or in any checkout with docker and node:
#
#   scripts/gate-worker/bench-postgres.sh --oid <oid> --trials 3   # from the mirror
#   scripts/gate-worker/bench-postgres.sh --here --trials 3        # this checkout
#
# It exists because a speed claim built from two different commits is not a
# measurement of a setting — it is a measurement of two trees that also happen
# to differ by that setting. So this holds the tree fixed at ONE object id,
# changes nothing but the `docker run` arguments, and alternates the arms:
#
#   A  durability   the container as merge-gate.sh started it before #146:
#                   no tmpfs, fsync and friends at their defaults
#   B  tmpfs        the container as #146 leaves it: data directory in RAM,
#                   fsync/synchronous_commit/full_page_writes off, WAL bounded
#
# Both arms run the gate's own database step, `npm run test:db -w @agentos/api`,
# under the same environment merge-gate.sh exports for it, with a fresh
# container, fresh isolated host directories and a fresh schema each time. Only
# the timed command's server differs.
#
# Everything that could quietly turn a benchmark into fiction is refused rather
# than noted: a gate already running on this host, a container that will not
# start or become ready, a database step that fails, a port that lands on 5432.
# A trial that saw a concurrent gate is marked CONTAMINATED and excluded from
# the summary, because the worker deliberately allows two gates to overlap and
# an overlapped sample measures the overlap.
#
# The summary prints, per arm, every trial's seconds, the median and the range,
# plus the node:test counts each run reported — equal counts across arms are
# what make the two numbers comparable at all.
set -uo pipefail

GATE_HOME="${GATE_HOME:-${HOME}/gate}"
MIRROR_DIR="${MIRROR_DIR:-${GATE_HOME}/agentos/mirror.git}"
TRIALS=3
OID=""
HERE=0
OUT_DIR=""

EXIT_FAIL=1
EXIT_USAGE=2

usage() { sed -n '2,33p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit "${1:-0}"; }
die() { printf '\nbench: %s\n' "$1" >&2; exit "$EXIT_FAIL"; }
say() { printf '\n== %s\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --oid) OID="${2:-}"; shift 2 || usage "$EXIT_USAGE" ;;
    --trials) TRIALS="${2:-}"; shift 2 || usage "$EXIT_USAGE" ;;
    --out) OUT_DIR="${2:-}"; shift 2 || usage "$EXIT_USAGE" ;;
    --here) HERE=1; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'bench: unknown argument %s\n' "$1" >&2; usage "$EXIT_USAGE" ;;
  esac
done

case "$TRIALS" in ''|*[!0-9]*) die "--trials must be a positive integer" ;; esac
[ "$TRIALS" -ge 1 ] || die "--trials must be at least 1"
[ -n "$OID" ] || [ "$HERE" -eq 1 ] || usage "$EXIT_USAGE"

command -v docker >/dev/null 2>&1 || die "docker is required"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
command -v node >/dev/null 2>&1 || die "node is required"

POSTGRES_IMAGE="${AGENTOS_GATE_POSTGRES_IMAGE:-postgres:16-alpine}"

# A gate on this host would share the four vCPUs with every trial, and the
# worker permits that by design. Refuse rather than measure it.
gate_running() { pgrep -f '^bash scripts/merge-gate' >/dev/null 2>&1; }

# The worker deliberately lets gates overlap each other, so a benchmark cannot
# assume it has the four vCPUs to itself. It can only start when nothing else is
# running and refuse to believe a trial that something joined halfway.
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

OUT_DIR="${OUT_DIR:-${GATE_HOME}/bench/${OID}-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT_DIR" || die "could not create ${OUT_DIR}"

CONTAINER=""
TMP_ROOT=""

# Only ever the throwaway things this run created, each matched against the name
# it was created with — the same rule run-gate.sh applies to its worktree.
discard() {
  case "$1" in
    /*/*) rm -rf -- "$1" 2>/dev/null ;;
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
printf '   node:     %s, npm %s\n' "$(node -v 2>/dev/null)" "$(npm -v 2>/dev/null)"
printf '   tree:     %s\n' "$WORKTREE"
printf '   output:   %s\n' "$OUT_DIR"

# Installed and generated once: it is shared by every trial and sits outside
# every timed region, so it cannot favour an arm.
say "Preparing the tree (once, untimed)"
( cd "$WORKTREE" && npm ci ) > "${OUT_DIR}/prepare.log" 2>&1 || die "npm ci failed; see ${OUT_DIR}/prepare.log"
( cd "$WORKTREE" && npm run db:generate ) >> "${OUT_DIR}/prepare.log" 2>&1 || die "prisma generate failed; see ${OUT_DIR}/prepare.log"

# --- the two arms -----------------------------------------------------------

# Arm A is the container merge-gate.sh started before #146; arm B is the one it
# starts after. Two argument lists over one identical `docker run`, so the
# difference between the arms is visible in one place and is nothing else.
arm_run_args() {
  case "$1" in
    A) : ;;
    B) printf '%s\n' "--env" "PGDATA=/var/lib/postgresql/data" \
                     "--tmpfs" "/var/lib/postgresql/data:rw,size=1024m" ;;
  esac
}
arm_server_args() {
  case "$1" in
    A) : ;;
    B) printf '%s\n' "-c" "fsync=off" "-c" "synchronous_commit=off" \
                     "-c" "full_page_writes=off" "-c" "max_wal_size=256MB" ;;
  esac
}

run_trial() {
  local arm="$1" round="$2"
  local label="${arm}${round}"
  local log="${OUT_DIR}/trial-${label}.log"
  CONTAINER="agentos-bench-${arm}-${round}-$$"

  local -a run_args=() server_args=()
  while IFS= read -r line; do [ -n "$line" ] && run_args+=("$line"); done < <(arm_run_args "$arm")
  while IFS= read -r line; do [ -n "$line" ] && server_args+=("$line"); done < <(arm_server_args "$arm")

  # Arm A's argument lists are empty, and an empty array under `set -u` is an
  # unbound variable on bash 3.2 (macOS). This expansion is the portable form:
  # nothing at all when the array is empty, every element quoted when it is not.
  docker run -d --rm --name "$CONTAINER" \
    -e POSTGRES_USER=agentos -e POSTGRES_PASSWORD=agentos \
    -e POSTGRES_DB=agentos_gate \
    ${run_args[@]+"${run_args[@]}"} \
    -p 127.0.0.1::5432 "$POSTGRES_IMAGE" \
    ${server_args[@]+"${server_args[@]}"} >/dev/null || die "trial ${label}: could not start ${POSTGRES_IMAGE}"

  local port
  port="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
  [ -n "$port" ] || die "trial ${label}: the container published no port"
  [ "$port" != "5432" ] || die "trial ${label}: refusing a container published on 5432"

  # Readiness over TCP, and by asking the database a question rather than asking
  # whether a socket answers. The image initialises itself behind a temporary
  # server that listens on the unix socket only, so `pg_isready` on that socket
  # says yes while `agentos_gate` does not exist yet — enough to make this
  # script's own evidence a connection error. The real server is the one
  # reachable on 127.0.0.1 inside the container.
  local ready=0 i
  for i in $(seq 1 90); do
    if docker exec "$CONTAINER" psql -h 127.0.0.1 -U agentos -d agentos_gate -Atc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" -eq 1 ] || die "trial ${label}: PostgreSQL did not become ready"

  # Proof that the arm is the arm, recorded per trial rather than assumed.
  docker exec "$CONTAINER" psql -h 127.0.0.1 -U agentos -d agentos_gate -Atc \
    "select name || '=' || setting from pg_settings where name in
     ('fsync','synchronous_commit','full_page_writes','max_wal_size','data_directory')" \
    > "${OUT_DIR}/settings-${label}.txt" 2>&1
  docker exec "$CONTAINER" sh -c 'df -h /var/lib/postgresql/data | tail -1' \
    >> "${OUT_DIR}/settings-${label}.txt" 2>&1

  TMP_ROOT="$(mktemp -d)"
  export RUNNER_WORKSPACE_ROOT="${TMP_ROOT}/workspaces"
  export CONTROL_PLANE_STATE_DIR="${TMP_ROOT}/state"
  export FILES_ROOT="${TMP_ROOT}/files"
  mkdir -p "$RUNNER_WORKSPACE_ROOT" "$CONTROL_PLANE_STATE_DIR" "$FILES_ROOT"
  export TEST_DATABASE_URL="postgresql://agentos:agentos@127.0.0.1:${port}/agentos_gate?schema=agentos_gate"
  export TEST_DATABASE_MAINTENANCE_URL="postgresql://agentos:agentos@127.0.0.1:${port}/postgres"
  export DATABASE_URL="$TEST_DATABASE_URL"
  export AGENTOS_ALLOW_SCRATCH_DATABASES=1

  # The gate's own migrate step, outside the timed region exactly as it is
  # outside the gate's database step.
  ( cd "${WORKTREE}/packages/db" && npx prisma migrate deploy ) >> "$log" 2>&1 \
    || die "trial ${label}: migrate failed; see ${log}"

  # Overlap is sampled for the whole trial. Asking once at the end answers a
  # different question — whether a gate happened to still be running at that
  # instant — and a gate that started and finished inside the timed region would
  # pass that question while owning half the CPU throughout.
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

  docker rm -f "$CONTAINER" >/dev/null 2>&1
  CONTAINER=""
  discard "$TMP_ROOT"; TMP_ROOT=""

  [ "$rc" -eq 0 ] || die "trial ${label}: the database step failed; see ${log}"

  local tests passed failed
  tests="$(grep -a '^. tests ' "$log" | tail -1 | awk '{print $3}')"
  passed="$(grep -a '^. pass ' "$log" | tail -1 | awk '{print $3}')"
  failed="$(grep -a '^. fail ' "$log" | tail -1 | awk '{print $3}')"

  local contaminated=""
  TRIAL_CLEAN=1
  if [ -s "$overlap" ]; then
    contaminated="CONTAMINATED(gate seen $(wc -l < "$overlap" | tr -d ' ') times, $(head -1 "$overlap")..$(tail -1 "$overlap"))"
    TRIAL_CLEAN=0
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$arm" "$round" "$elapsed" "$started" "$ended" "$tests" "$passed" "$failed" "$contaminated" \
    >> "${OUT_DIR}/results.tsv"
  printf '   %s trial %s: %4ss  tests=%s pass=%s fail=%s  load=%s  %s..%s %s\n' \
    "$arm" "$round" "$elapsed" "$tests" "$passed" "$failed" "$load" "$started" "$ended" "$contaminated"
}

# --- the trials -------------------------------------------------------------

: > "${OUT_DIR}/results.tsv"
say "Trials (A = pre-#146 durability, B = #146 tmpfs; alternating, serial)"
printf '   %s clean trials wanted per arm; contaminated ones are recorded, excluded and repeated\n' "$TRIALS"

TRIAL_CLEAN=0
clean_A=0
clean_B=0
MAX_ROUNDS=$(( TRIALS * 3 ))
round=0
while [ "$clean_A" -lt "$TRIALS" ] || [ "$clean_B" -lt "$TRIALS" ]; do
  round=$(( round + 1 ))
  [ "$round" -le "$MAX_ROUNDS" ] \
    || die "gave up after ${MAX_ROUNDS} rounds with A=${clean_A} B=${clean_B} clean; the host is too busy to measure on"
  for arm in A B; do
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
summarise A
summarise B
awk '
  $0 !~ /CONTAMINATED/ { v[$1 "," n[$1]++] = $3 }
  function med(arm,   i, j, t, k, a) {
    k = n[arm]; for (i = 0; i < k; i++) a[i] = v[arm "," i]
    for (i = 0; i < k; i++) for (j = i + 1; j < k; j++) if (a[j] < a[i]) { t = a[i]; a[i] = a[j]; a[j] = t }
    return (k % 2) ? a[int(k / 2)] : (a[k / 2 - 1] + a[k / 2]) / 2
  }
  END { if (n["A"] && n["B"]) printf "\nspeedup (median A / median B): %.2fx\n", med("A") / med("B") }
' "${OUT_DIR}/results.tsv"
printf '\nper-trial rows:  %s/results.tsv\nlogs:            %s/trial-*.log\nserver settings: %s/settings-*.txt\n' \
  "$OUT_DIR" "$OUT_DIR" "$OUT_DIR"
