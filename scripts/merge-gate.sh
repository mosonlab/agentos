#!/usr/bin/env bash
#
# AgentOS merge gate. Run this in the worktree you are about to merge.
#
#   bash scripts/merge-gate.sh                       # gate the current HEAD
#   bash scripts/merge-gate.sh --expect-head <oid>   # gate exactly that commit
#   npm run merge-gate -- --expect-head <oid>        # same, through npm
#   bash scripts/merge-gate.sh --master <oid>        # state the baseline commit
#   bash scripts/merge-gate.sh --keep-postgres       # diagnosis: never authoritative
#
# Exit codes are the verdict and nothing else returns 0:
#
#   0  PASS             every step passed, on a clean worktree, at one commit
#                       that did not move, and the throwaway database is gone
#   1  FAIL             a step failed, a precondition was missing, the tree
#                       drifted, or cleanup did not complete
#   3  NOT AUTHORITATIVE the run was asked to leave state behind, so it may not
#                       be used to authorise a merge even if every step passed
#
# The last line of output is one of MERGE GATE: PASS <oid> / FAIL / NOT
# AUTHORITATIVE, and a PASS always names the commit it is a statement about.
#
# The gate owns its own throwaway PostgreSQL: it starts a container, binds it to
# a loopback ephemeral port, and deletes it on the way out. There is deliberately
# no flag to point it at an existing server, because the only way a test process
# reaches the production database is if something lets an operator aim it there.
#
# For the same reason every host path the suites could otherwise default to is
# replaced with a fresh mktemp directory, and the substitution is verified before
# a single dependency is installed. The 2026-08-18 incident was a dbtest with a
# correctly scoped scratch database that still swept the live workspace root, so
# a database-only guarantee is not the guarantee that was missing.
#
# A worktree can only host one gate at a time, so the run takes an exclusive lock
# on the worktree root before it writes anything. Two gates sharing a checkout
# share node_modules, dist/ and the prisma client, and `npm ci` deletes
# node_modules before it repopulates it: the 2026-08-17 incident was 33 gates in
# one worktree deleting each other's dependencies mid-run, which surfaced as a
# dbtest failure that had nothing to do with the code being gated. A gate that
# waited for the lock would be worse than useless — the queue would silently
# serialise runs whose commits have already moved on — so a live holder is an
# immediate FAIL naming the process that holds it.
#
# The frozen-record rules (AGENTS.md "Frozen records") are checked immediately
# after the commit is pinned and before Docker is touched: they need nothing
# installed and nothing running, and a branch that rewrites history should hear
# that instead of a preflight failure about a daemon it never needed.
#
# Those rules are about what is already on the branch being merged into, so the
# gate has to know which commit that is, and it establishes that rather than
# assuming it, in this order: --master <oid>, AGENTOS_MASTER_OID, `git ls-remote
# --symref origin HEAD` when there is an origin to ask, and otherwise this
# repository's own refs for the default branch — which is the gate worker, a
# worktree of a bare mirror with no credential and no route to GitHub, whose
# refs are verbatim copies of the operator's own push. The branch's name is read
# the same way and is not written down here: this repository's is `main`.
# Whichever it is, the oid and where it came from are printed in the preflight
# and the frozen check is bound to it. When the two local refs disagree the
# descendant wins, because a later baseline can only ever refuse more.
#
# Anything the gate cannot establish is a FAIL, never a skip.

set -euo pipefail

KEEP_POSTGRES=0
EXPECT_HEAD=""
MASTER_OID="${AGENTOS_MASTER_OID:-}"
POSTGRES_IMAGE="${AGENTOS_GATE_POSTGRES_IMAGE:-postgres:16-alpine}"

EXIT_FAIL=1
EXIT_NOT_AUTHORITATIVE=3

usage() {
  # No gate ran, so the EXIT trap must not print a verdict.
  trap - EXIT
  sed -n '2,61p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --expect-head)
      [ $# -ge 2 ] || { printf 'merge-gate: --expect-head needs an object id\n' >&2; exit 2; }
      EXPECT_HEAD="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
      shift
      ;;
    --expect-head=*)
      EXPECT_HEAD="$(printf '%s' "${1#--expect-head=}" | tr '[:upper:]' '[:lower:]')"
      ;;
    --master)
      [ $# -ge 2 ] || { printf 'merge-gate: --master needs an object id\n' >&2; exit 2; }
      MASTER_OID="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
      shift
      ;;
    --master=*)
      MASTER_OID="$(printf '%s' "${1#--master=}" | tr '[:upper:]' '[:lower:]')"
      ;;
    --keep-postgres) KEEP_POSTGRES=1 ;;
    -h|--help) usage 0 ;;
    *) printf 'merge-gate: unknown argument %s\n\n' "$1" >&2; usage 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
CONTAINER="agentos-merge-gate-$$"
# The lock lives in the worktree because the worktree is what is being contended:
# two checkouts of the same repository may gate at the same time, two gates in one
# checkout may not. It is a directory because mkdir is the one filesystem create
# that is atomic and fails on an existing name everywhere this runs.
LOCK_DIR="${REPO_ROOT}/.merge-gate.lock"
LOCK_HELD=0
GATE_TMP=""
POSTGRES_STARTED=0
GATED_HEAD=""
FAILED_STEP=""
STEP_REPORT=()

# --- plumbing ---------------------------------------------------------------

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }
die() {
  printf '\n\033[31mmerge-gate: %s\033[0m\n' "$1" >&2
  FAILED_STEP="${FAILED_STEP:-preflight}"
  exit "${EXIT_FAIL}"
}

# Only ever discards the directory this run created, identified by the prefix it
# was created with. A cleanup routine that trusts a variable is how a scratch run
# reaches a real tree.
discard_gate_tmp() {
  [ -n "${GATE_TMP}" ] || return 0
  case "${GATE_TMP}" in
    */agentos-merge-gate.????????)
      [ -d "${GATE_TMP}" ] || return 0
      rm -rf -- "${GATE_TMP}"
      ;;
    *)
      printf 'merge-gate: refusing to remove unexpected temp path %s\n' "${GATE_TMP}" >&2
      return 1
      ;;
  esac
}

# Same rule as discard_gate_tmp: only ever release a lock this run is holding, and
# only after re-reading the pid file, so a run that somehow lost the race cannot
# delete the directory that another gate is standing on.
release_lock() {
  [ "${LOCK_HELD}" -eq 1 ] || return 0
  local owner=""
  owner="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  if [ "${owner}" != "$$" ]; then
    printf 'merge-gate: refusing to release %s, it is now held by pid %s\n' \
      "${LOCK_DIR}" "${owner:-unknown}" >&2
    return 1
  fi
  rm -rf -- "${LOCK_DIR}"
}

# Acquire before the first write of any kind. mkdir either creates the directory
# or fails, with no window in between, so the loser of a race is always the one
# that sees the failure. A holder whose process is gone left the lock behind by
# being killed rather than by exiting, so it is reclaimed; a holder that is alive
# is reported and this run stops.
acquire_lock() {
  local holder=""
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    LOCK_HELD=1
    printf '%s\n' "$$" > "${LOCK_DIR}/pid"
    return 0
  fi

  holder="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  if [ -n "${holder}" ] && kill -0 "${holder}" 2>/dev/null; then
    die "another merge gate is running in ${REPO_ROOT} (pid ${holder}); this gate does not queue, rerun once that one has finished"
  fi

  # Stale: nobody owns the recorded pid, or no pid was ever recorded because the
  # holder died between mkdir and the write. Pids are recycled, so `kill -0`
  # succeeding on an unrelated process only ever costs a spurious FAIL and a
  # rerun, which is the direction this check is allowed to be wrong in.
  note "reclaiming stale lock ${LOCK_DIR} (pid ${holder:-none} is gone)"
  rm -rf -- "${LOCK_DIR}"
  mkdir "${LOCK_DIR}" 2>/dev/null \
    || die "could not take the merge gate lock ${LOCK_DIR} after reclaiming it; another gate started in the same instant"
  LOCK_HELD=1
  printf '%s\n' "$$" > "${LOCK_DIR}/pid"
}

cleanup() {
  local status=$?
  trap - EXIT
  local cleanup_error=""

  discard_gate_tmp || cleanup_error="the temporary directory could not be removed"
  release_lock || cleanup_error="${cleanup_error:+${cleanup_error}; }the merge gate lock could not be released"

  if [ "${KEEP_POSTGRES}" -eq 1 ]; then
    printf '\n   postgres container %s left running (--keep-postgres)\n' "${CONTAINER}"
  elif [ "${POSTGRES_STARTED}" -eq 1 ]; then
    # A gate that promises "deleted when this script exits" has to notice when
    # that promise is not kept; an executor can only see the exit code.
    if ! docker rm -f "${CONTAINER}" >/dev/null 2>&1; then
      cleanup_error="${cleanup_error:+${cleanup_error}; }postgres container ${CONTAINER} could not be removed"
    fi
  fi

  printf '\n'
  if [ "${#STEP_REPORT[@]}" -gt 0 ]; then
    for line in "${STEP_REPORT[@]}"; do printf '   %s\n' "${line}"; done
  fi

  if [ "${status}" -ne 0 ] || [ -n "${FAILED_STEP}" ]; then
    printf '\n\033[31mMERGE GATE: FAIL (%s)\033[0m\n' "${FAILED_STEP:-unknown}"
    exit "${EXIT_FAIL}"
  fi
  if [ -n "${cleanup_error}" ]; then
    printf '\n\033[31mMERGE GATE: FAIL (cleanup: %s)\033[0m\n' "${cleanup_error}"
    exit "${EXIT_FAIL}"
  fi
  if [ "${KEEP_POSTGRES}" -eq 1 ]; then
    printf '\n\033[33mMERGE GATE: NOT AUTHORITATIVE (--keep-postgres)\033[0m\n'
    printf 'Every step passed, but this run left a container behind and must not authorise a merge.\n'
    exit "${EXIT_NOT_AUTHORITATIVE}"
  fi
  printf '\n\033[32mMERGE GATE: PASS %s\033[0m\n' "${GATED_HEAD}"
  # What this PASS does NOT cover, stated here rather than left to be inferred
  # from a skipped test buried in the suite output. Both need live credentials
  # and neither can run inside a hermetic gate, so a green gate is silent about
  # them and must not be read as endorsing them.
  printf 'Not covered by this gate: the \xc2\xa7D-P6 GraphQL schema gate against the live GitHub schema\n'
  printf '  (npm run schema-gate -w @agentos/merge-executor, needs GITHUB_SCHEMA_GATE_TOKEN; it fails without one),\n'
  printf '  and the Step 9/10 [real] direction harnesses, which need a scratch repository and a\n'
  printf '  non-production deployment. Run those separately before a release.\n'
  exit 0
}
trap cleanup EXIT
# Ctrl-C and `kill` have to run cleanup too, or an interrupted gate leaves its lock
# and its container behind and the next run in this worktree has to reclaim both.
# Exiting from the handler is what routes the signal through the EXIT trap.
trap 'exit 130' INT
trap 'exit 143' TERM

step() {
  local label="$1"; shift
  say "${label}"
  local started; started=$(date +%s)
  FAILED_STEP="${label}"
  if ! ( cd "${REPO_ROOT}" && "$@" ); then
    STEP_REPORT+=("FAIL  ${label}")
    return 1
  fi
  STEP_REPORT+=("$(printf 'ok    %-42s %4ss' "${label}" "$(( $(date +%s) - started ))")")
  FAILED_STEP=""
}

# True when either path is the other or contains it.
overlaps() {
  case "$1" in "$2"|"$2"/*) return 0 ;; esac
  case "$2" in "$1"|"$1"/*) return 0 ;; esac
  return 1
}

git_head() { git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null; }
git_dirt() { git -C "${REPO_ROOT}" status --porcelain 2>/dev/null; }

# --- preflight --------------------------------------------------------------

say "Preflight"
[ -f "${REPO_ROOT}/package.json" ] || die "no package.json at ${REPO_ROOT}"
grep -q '"name": "agentos"' "${REPO_ROOT}/package.json" || die "${REPO_ROOT} is not the agentos repository root"

# Taken here, ahead of every other precondition: the gate installs into this
# worktree's node_modules and builds into its dist/, so concurrency is the first
# thing that can invalidate a run, and it should be the verdict a second gate
# reports rather than whatever it happens to trip over next.
FAILED_STEP="worktree lock"
acquire_lock
FAILED_STEP=""
note "lock:       ${LOCK_DIR} (pid $$)"

git -C "${REPO_ROOT}" rev-parse --git-dir >/dev/null 2>&1 || die "${REPO_ROOT} is not a git worktree"

# A PASS is a statement about one commit, so the gate has to know which, and the
# tree it tests has to be that commit and nothing else. Uncommitted work — staged,
# unstaged or untracked — means the tested content is not what a merge would take.
GATED_HEAD="$(git_head)" || die "could not read HEAD"
[[ "${GATED_HEAD}" =~ ^[0-9a-f]{40}$ ]] || die "HEAD is not a full object id: ${GATED_HEAD}"

if [ -n "${EXPECT_HEAD}" ]; then
  [[ "${EXPECT_HEAD}" =~ ^[0-9a-f]{40}$ ]] \
    || die "--expect-head needs a full 40-character object id, got: ${EXPECT_HEAD}"
  [ "${EXPECT_HEAD}" = "${GATED_HEAD}" ] \
    || die "HEAD is ${GATED_HEAD} but --expect-head asked for ${EXPECT_HEAD}"
fi

PREFLIGHT_DIRT="$(git_dirt)" || die "could not read the working tree state"
if [ -n "${PREFLIGHT_DIRT}" ]; then
  printf '\n%s\n' "${PREFLIGHT_DIRT}" >&2
  die "the working tree is not clean; commit or stash the above before gating, because a merge would not take it"
fi

note "repository: ${REPO_ROOT}"
note "gating:     ${GATED_HEAD}${EXPECT_HEAD:+ (matches --expect-head)}"
note "worktree:   clean"

# --- the authoritative default branch ---------------------------------------

# Which commit the branch being merged into is, established rather than
# assumed — including which branch that is. This repository's default branch is
# `main` and the gate worker's mirror may carry another name, so the name is
# read from whoever is authoritative rather than written down here. A local
# remote-tracking ref is a cache of an answer someone once got; if it is stale,
# a frozen record the default branch already carries looks like a new file to
# the append-only check and the modification is waved through. So: what the
# caller stated, or else what origin says right now. Never a ref found lying
# around.
FAILED_STEP="authoritative default branch"
if [ -n "${MASTER_OID}" ]; then
  [[ "${MASTER_OID}" =~ ^[0-9a-f]{40}$ ]] \
    || die "--master needs a full 40-character object id, got: ${MASTER_OID}"
  MASTER_SOURCE="stated by the caller"
elif git -C "${REPO_ROOT}" remote get-url origin >/dev/null 2>&1; then
  # One question, two answers: `--symref ... HEAD` says which branch origin's
  # HEAD points at and what that branch is at, so the name and the oid cannot
  # come from two different moments.
  # GIT_TERMINAL_PROMPT=0: a gate must fail, not sit waiting for a password.
  symref="$(GIT_TERMINAL_PROMPT=0 git -C "${REPO_ROOT}" ls-remote --symref origin HEAD 2>/dev/null)" \
    || die "could not read HEAD from origin; pass --master <oid> to state it"
  DEFAULT_REF="$(printf '%s\n' "${symref}" | awk '$1 == "ref:" && $3 == "HEAD" {print $2; exit}')"
  [ -n "${DEFAULT_REF}" ] \
    || die "origin did not say which branch its HEAD points at; pass --master <oid> to state it"
  MASTER_OID="$(printf '%s\n' "${symref}" | awk '$2 == "HEAD" {print $1; exit}')"
  [[ "${MASTER_OID}" =~ ^[0-9a-f]{40}$ ]] \
    || die "origin answered with no usable oid for ${DEFAULT_REF}; pass --master <oid> to state it"
  MASTER_SOURCE="read from origin (${DEFAULT_REF})"
else
  # No remote to ask. On the gate worker that is not a broken checkout, it is
  # the design: a worktree of a bare mirror that holds no credential and never
  # talks to GitHub. Its refs are verbatim copies of the operator's, placed
  # there by the operator's own `git push --mirror`, so the master in this
  # repository *is* the master the operator has — the strongest statement
  # obtainable inside this box, and stated in the verdict rather than assumed.
  # Freshness is checked where it can be: mirror-push.sh refuses to report OK
  # unless origin's current master arrived in the mirror.
  #
  # Which of the two refs, when they disagree, is not a preference: the
  # descendant is the later master, and a later baseline can only ever refuse
  # more. A checkout whose local master trails its remote-tracking ref is the
  # ordinary case and must not be the stricter answer's loser.
  #
  # The name, with no origin to ask: `refs/remotes/origin/HEAD` where a clone
  # recorded it, and otherwise the one branch of the two conventional names
  # this repository actually has. Two candidates present is not a preference to
  # resolve quietly, and none is not a default to invent.
  default_branch=""
  default_ref="$(git -C "${REPO_ROOT}" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "${default_ref}" ]; then
    default_branch="${default_ref#refs/remotes/origin/}"
  else
    for candidate in main master; do
      if git -C "${REPO_ROOT}" rev-parse --verify --quiet "refs/heads/${candidate}^{commit}" >/dev/null \
        || git -C "${REPO_ROOT}" rev-parse --verify --quiet "refs/remotes/origin/${candidate}^{commit}" >/dev/null; then
        [ -z "${default_branch}" ] \
          || die "no origin remote to ask, and this repository has both main and master; pass --master <oid>"
        default_branch="${candidate}"
      fi
    done
  fi
  [ -n "${default_branch}" ] \
    || die "no origin remote to ask and no default branch in this repository; pass --master <oid>"

  origin_master="$(git -C "${REPO_ROOT}" rev-parse --verify --quiet "refs/remotes/origin/${default_branch}^{commit}" || true)"
  local_master="$(git -C "${REPO_ROOT}" rev-parse --verify --quiet "refs/heads/${default_branch}^{commit}" || true)"
  if [ -n "${origin_master}" ] && [ -n "${local_master}" ] && [ "${origin_master}" != "${local_master}" ]; then
    if git -C "${REPO_ROOT}" merge-base --is-ancestor "${origin_master}" "${local_master}"; then
      MASTER_OID="${local_master}"; MASTER_SOURCE="refs/heads/${default_branch}, ahead of origin/${default_branch}; no origin to ask"
    elif git -C "${REPO_ROOT}" merge-base --is-ancestor "${local_master}" "${origin_master}"; then
      MASTER_OID="${origin_master}"; MASTER_SOURCE="refs/remotes/origin/${default_branch}, ahead of ${default_branch}; no origin to ask"
    else
      die "no origin remote to ask, and this repository's two ${default_branch} refs have diverged (${origin_master} / ${local_master}); pass --master <oid>"
    fi
  elif [ -n "${origin_master}" ]; then
    MASTER_OID="${origin_master}"; MASTER_SOURCE="refs/remotes/origin/${default_branch}; no origin to ask"
  elif [ -n "${local_master}" ]; then
    MASTER_OID="${local_master}"; MASTER_SOURCE="refs/heads/${default_branch}; no origin to ask"
  else
    die "no origin remote to ask and no ${default_branch} ref in this repository; pass --master <oid>"
  fi
fi
git -C "${REPO_ROOT}" cat-file -e "${MASTER_OID}^{commit}" 2>/dev/null \
  || die "${MASTER_OID} is not in this repository; run: git fetch origin"
FAILED_STEP=""
note "baseline:   ${MASTER_OID} (${MASTER_SOURCE})"

# --- the record rules ------------------------------------------------------

# Cheapest first, and first for a reason beyond cost: these read git and nothing
# else, so they are the only steps that can run before the gate has a container,
# a node_modules or a database. A documentation branch that breaks the
# append-only rule fails here in a second, and says so even on a machine where
# Docker is not running.
step "frozen records append-only" bash scripts/check-frozen-docs.sh --master "${MASTER_OID}"
# The checker is a gate rule, so it is gated too: PR #156 shipped one whose
# date-prefix rule was unreachable by construction, and nothing ran to say so.
step "frozen-record checker fixtures" node --test scripts/check-frozen-docs.test.mjs

# --- docker ----------------------------------------------------------------

# Last of the preconditions, not the first: it is the expensive one, and the
# checks above are the ones a documentation branch actually needs to hear about.
# run-gate.sh on the worker deliberately no longer pre-checks it either, so that
# the ordering here is the ordering everywhere.
FAILED_STEP="docker preflight"
command -v docker >/dev/null 2>&1 || die "docker is required: the gate runs its own throwaway PostgreSQL"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
FAILED_STEP=""

# --- isolation --------------------------------------------------------------

say "Isolating every host path the suites could default to"
GATE_TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/agentos-merge-gate.XXXXXXXX")" && pwd -P)"
RUNNER_WORKSPACE_ROOT="${GATE_TMP}/workspace-root"
CONTROL_PLANE_STATE_DIR="${GATE_TMP}/control-plane-state"
FILES_ROOT="${GATE_TMP}/files-root"
mkdir -p "${RUNNER_WORKSPACE_ROOT}" "${CONTROL_PLANE_STATE_DIR}" "${FILES_ROOT}"
chmod 700 "${RUNNER_WORKSPACE_ROOT}" "${CONTROL_PLANE_STATE_DIR}" "${FILES_ROOT}"
export RUNNER_WORKSPACE_ROOT CONTROL_PLANE_STATE_DIR FILES_ROOT

# The paths the application resolves to when these variables are unset:
# ~/.agentos/runs, ~/.agentos/control-plane and ~/Documents/agentos. #108 made
# the application refuse the first two; a gate that trusts the code it is gating
# is not a gate, so the substitution is checked here as well.
PRODUCTION_ROOTS=("${HOME}/.agentos" "${HOME}/Documents/agentos" "${REPO_ROOT}")
for var in RUNNER_WORKSPACE_ROOT CONTROL_PLANE_STATE_DIR FILES_ROOT; do
  dir="${!var:-}"
  [ -n "${dir}" ] || die "${var} is unset"
  [ -d "${dir}" ] || die "${var}=${dir} is not a directory"
  [ -z "$(ls -A "${dir}")" ] || die "${var}=${dir} is not empty"
  case "${dir}" in "${GATE_TMP}"/*) ;; *) die "${var}=${dir} escaped ${GATE_TMP}" ;; esac
  for real in "${PRODUCTION_ROOTS[@]}"; do
    if overlaps "${dir}" "${real}"; then die "${var}=${dir} overlaps ${real}"; fi
  done
  note "${var}=${dir}"
done
# The API refuses to start when the Files Root overlaps the workspace root in
# either direction, and the ownership dbtest starts a real API.
if overlaps "${RUNNER_WORKSPACE_ROOT}" "${FILES_ROOT}"; then
  die "RUNNER_WORKSPACE_ROOT and FILES_ROOT overlap"
fi

# --- throwaway postgres -----------------------------------------------------

# This server is deleted when the script exits, so every guarantee it makes
# about surviving a crash is spent on nothing. The dbtests are ~80% of a gate
# and they are dominated by that spending: real Postgres, one shared server,
# serial. So the data directory is a tmpfs and the durability machinery is off.
#
# What this does NOT change is what the tests observe. fsync, synchronous_commit
# and full_page_writes decide when writes reach the disk, never what a
# transaction sees: isolation, constraints, locks, advisory locks, sequences and
# every query plan behave identically. The one property given up is that a
# gate whose machine loses power mid-run leaves a recoverable database — a
# database that is deleted seconds later either way.
#
# PGDATA is named explicitly even though it is the image default: the tmpfs is
# only worth anything if it is mounted exactly where the server writes, and if
# those two ever disagreed the mount would silently do nothing while still
# looking right here.
#
# The size is a ceiling, not a reservation — tmpfs pages are allocated as used,
# and a fresh cluster is ~45MB. max_wal_size is bounded to match: the default
# lets WAL grow to 1GB before forcing a checkpoint, which on a 4GB worker is the
# one way a data directory in RAM could run the machine out of it. Checkpoints
# are cheap here precisely because fsync is off.
say "Starting a throwaway PostgreSQL (${POSTGRES_IMAGE}, tmpfs data directory, durability off)"
docker run -d --rm --name "${CONTAINER}" \
  -e POSTGRES_USER=agentos -e POSTGRES_PASSWORD=agentos \
  -e POSTGRES_DB=agentos_gate \
  -e PGDATA=/var/lib/postgresql/data \
  --tmpfs /var/lib/postgresql/data:rw,size=1024m \
  -p 127.0.0.1::5432 "${POSTGRES_IMAGE}" \
  -c fsync=off \
  -c synchronous_commit=off \
  -c full_page_writes=off \
  -c max_wal_size=256MB >/dev/null \
  || die "could not start ${POSTGRES_IMAGE}"
POSTGRES_STARTED=1

PGPORT="$(docker port "${CONTAINER}" 5432/tcp | head -1 | sed 's/.*://')"
[ -n "${PGPORT}" ] || die "the container published no port"
# Self-check: 5432 is where docker-compose.yml puts the real local database.
[ "${PGPORT}" != "5432" ] || die "refusing a container published on 5432"

ready=0
for _ in $(seq 1 90); do
  if docker exec "${CONTAINER}" pg_isready -U agentos -d agentos_gate -q >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "${ready}" -eq 1 ] || die "PostgreSQL did not become ready"
note "127.0.0.1:${PGPORT}, database agentos_gate, deleted when this script exits"

# The database is called agentos_gate rather than agentos, and the schema is a
# dedicated non-public one: the dbtest harness drops and re-applies whatever
# schema it is given, and the scratch-database manager refuses a source database
# named agentos.
export TEST_DATABASE_URL="postgresql://agentos:agentos@127.0.0.1:${PGPORT}/agentos_gate?schema=agentos_gate"
export TEST_DATABASE_MAINTENANCE_URL="postgresql://agentos:agentos@127.0.0.1:${PGPORT}/postgres"
# Pointing DATABASE_URL at the same throwaway server closes the last hole: a
# subprocess that reads it — including one that would otherwise pick it up from
# a repository .env — lands in the container, never on a real database.
export DATABASE_URL="${TEST_DATABASE_URL}"
# Lets control-plane-ownership.dbtest.ts run its real-process acceptance instead
# of skipping it. That test is the closest thing the suite has to a replay of the
# incident, so a gate that silently skips it is worth very little.
export AGENTOS_ALLOW_SCRATCH_DATABASES=1

# --- the gate ---------------------------------------------------------------

# The verdict is about the commit the preflight pinned, so the last step proves
# nothing moved underneath it: no rebase, no stray edit, no build artefact that
# is not ignored. Otherwise a PASS could describe a tree that no longer exists.
verify_tree_did_not_drift() {
  local now dirt
  now="$(git_head)" || { printf 'could not re-read HEAD\n' >&2; return 1; }
  if [ "${now}" != "${GATED_HEAD}" ]; then
    printf 'HEAD moved from %s to %s while the gate was running\n' "${GATED_HEAD}" "${now}" >&2
    return 1
  fi
  dirt="$(git_dirt)"
  if [ -n "${dirt}" ]; then
    printf 'the working tree was modified while the gate was running:\n%s\n' "${dirt}" >&2
    return 1
  fi
  printf 'still at %s, working tree still clean\n' "${GATED_HEAD}"
}

# `--prefer-offline` reuses the worker's own `~/.npm` content-addressed cache
# instead of re-asking the registry for metadata it already has; a tarball
# missing from the cache is still fetched. `--no-audit` and `--no-fund` drop two
# network round trips whose output nobody reads here. None of the three can
# change *which* versions land: `npm ci` installs the closed set in
# `package-lock.json` and fails rather than resolving anything, and a cached
# tarball is keyed by the integrity hash the lockfile records — a cache hit is
# therefore a hit on exactly the bytes the lockfile names. The saving is install
# time on the gate worker, nothing else. Deliberately not cached: `node_modules`
# itself, which `npm ci` must keep deleting and repopulating.
step "npm ci" npm ci --prefer-offline --no-audit --no-fund
step "prisma generate" npm run db:generate
step "typecheck (all workspaces)" npm run typecheck
# The minimum lint gate (#143): Biome's opt-in safety rules, then the one
# type-aware rule (no-floating-promises) through typescript-eslint. Both are
# npm dependencies and nothing here shells out, so the remote gate worker runs
# it unchanged. It sits after typecheck because a type error makes the
# type-aware pass report nonsense, and before build because it needs no dist.
# Formatting is deliberately not checked — see biome.jsonc.
step "lint (biome + type-aware no-floating-promises)" npm run lint
# apps/web's CSS regression test reads the built stylesheet out of apps/web/dist,
# and the dbtests spawn the real API out of packages/api/dist.
step "build (all workspaces)" npm run build
step "unit tests (all workspaces)" npm run test --workspaces --if-present
# prisma resolves its schema from the working directory, so this has to run
# inside packages/db rather than at the repository root.
step "migrate the gate schema" sh -c 'cd packages/db && npx prisma migrate deploy'
# The Goal 5a0 preflight's first-run boundary, against this throwaway server: the
# only evidence that an empty target passes and a non-empty one still refuses.
step "database preflight tests" npm run test:db -w @agentos/db
step "api database tests" npm run test:db -w @agentos/api
step "verify the gated commit did not drift" verify_tree_did_not_drift
