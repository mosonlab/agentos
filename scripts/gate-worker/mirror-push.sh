#!/usr/bin/env bash
#
# Push this repository into the gate worker's bare mirror. Runs ON THE LOCAL
# MACHINE (issue #132):
#
#   scripts/gate-worker/mirror-push.sh <server>            # push refs + harness
#   scripts/gate-worker/mirror-push.sh <server> --dry-run  # show what would go
#   AGENTOS_GATE_SERVER=<server> scripts/gate-worker/mirror-push.sh
#
# <server> is anything ssh accepts: a Host alias from ~/.ssh/config (preferred —
# it keeps the address, the user, the port and the key in one place that is not
# this repository) or user@host. Add --port for a one-off.
#
# The worker hosts one mirror per repository, under ~/gate/<repo>/, where <repo>
# is the origin repository's name. The mirror is created on first push; the
# worker-wide toolchain is provision.sh's job, a repository arriving is this
# script's. Everything about one repository — mirror, worktrees, logs, harness —
# lives under its own directory, so a second project can be gated on the same
# worker without either seeing the other.
#
# This is the only path by which code reaches the worker. The worker holds no
# GitHub credential and its mirror has no remote configured, so no repository
# content arrives there except by this push, and the mirror cannot fetch. That
# is a statement about how code gets in, not about what the worker's network can
# reach: the gate executes the candidate commit's own code, and nothing here
# constrains what that code connects to. docs/runbooks/gate-worker.md states the
# boundary.
#
# Two things are pushed:
#
#   1. every ref, with --mirror, so any commit reachable from a ref here can be
#      gated by object id without naming a branch. Reachable from a ref: an oid
#      that only a reflog or a detached HEAD holds has no ref to carry it and
#      does not travel, which the local-HEAD readback below is what catches;
#   2. scripts/gate-worker/run-gate.sh, installed at ~/gate/<repo>/run-gate.sh,
#      so the harness on the worker is the one in this checkout. The install is
#      a copy to a temporary name in that directory followed by a rename, so the
#      harness a gate reads is always a whole file even if two pushes race.
#
# One thing is checked: that origin's current default-branch head is among the
# objects that arrived. The gate's frozen-record rules are evaluated against a
# baseline oid that remote-gate.sh reads from origin, and the worker cannot
# fetch it later — so a mirror without it can only produce a gate that refuses
# to run. Catching that here, where the fix is one fetch, is the whole reason
# to look.
#
# --mirror deletes refs on the worker that no longer exist here. That is correct
# for a mirror whose only reader is a gate that resolves object ids: the worker
# is a cache of this repository's ref graph, never a place work is authored, and
# a ref that only exists on the worker is drift, not data.
#
# Sends no credential of any kind. The push is git-over-ssh; the ssh key stays on
# this machine and is used for authentication, never copied.
#
# <server>, --gate-home and the repository name all become part of a command
# string a remote login shell parses. Each is validated against an allowlist in
# lib.sh before anything is sent, and refused rather than quoted when it falls
# outside; the values are a trust boundary, not a formatting problem.
set -uo pipefail

SERVER="${AGENTOS_GATE_SERVER:-}"
GATE_HOME="${GATE_HOME:-gate}"   # relative to the remote account's $HOME
SSH_PORT=""
DRY_RUN=0

usage() {
  sed -n '2,58p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
  exit "${1:-0}"
}

die() { printf 'mirror-push: %s\n' "$1" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || die "--port needs a number" 64
      SSH_PORT="$2"; shift ;;
    --port=*) SSH_PORT="${1#--port=}" ;;
    --gate-home)
      [ $# -ge 2 ] || die "--gate-home needs a path" 64
      GATE_HOME="$2"; shift ;;
    --gate-home=*) GATE_HOME="${1#--gate-home=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage 0 ;;
    -*) printf 'mirror-push: unknown argument %s\n\n' "$1" >&2; usage 64 ;;
    *)
      [ -z "$SERVER" ] || die "more than one server given: $SERVER and $1" 64
      SERVER="$1" ;;
  esac
  shift
done

[ -n "$SERVER" ] || { printf 'mirror-push: no server given\n\n' >&2; usage 64; }
case "$SERVER" in
  -*) die "server looks like an option: $SERVER" 64 ;;
esac
if [ -n "$SSH_PORT" ]; then
  case "$SSH_PORT" in
    ''|*[!0-9]*) die "--port needs a number, got: $SSH_PORT" 64 ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || die "${REPO_ROOT} is not a git repository"
# The gate contract: what run-gate.sh executes inside the checked-out commit.
# A repository without it has nothing for the worker to run.
[ -f "${REPO_ROOT}/scripts/merge-gate.sh" ] \
  || die "${REPO_ROOT} has no scripts/merge-gate.sh; the worker gates repositories that ship their own gate"

# shellcheck source=scripts/gate-worker/lib.sh
. "${SCRIPT_DIR}/lib.sh"

# Checked before anything is sent: each of these is interpolated into a command
# string the remote login shell parses. lib.sh says what each one accepts.
gate_valid_server "$SERVER" >/dev/null \
  || die "not a usable ssh destination: ${SERVER}" 64
gate_valid_home "$GATE_HOME" >/dev/null \
  || die "not a usable gate home: ${GATE_HOME} (relative path, [A-Za-z0-9._-] segments, no . or ..)" 64
REPO_NAME="$(gate_repo_name "$REPO_ROOT")" \
  || die "could not derive a safe repository name for ${REPO_ROOT}"
REPO_HOME="${GATE_HOME}/${REPO_NAME}"

# Expanded as ${arr[@]+"${arr[@]}"} at every use site: bash 3.2, which is what
# /bin/bash still is on macOS, treats an empty array as unset under `set -u`
# and aborts. The + form expands to nothing when the array is empty.
SSH_OPTS=()
SCP_OPTS=()
if [ -n "$SSH_PORT" ]; then
  SSH_OPTS+=(-p "$SSH_PORT")
  SCP_OPTS+=(-P "$SSH_PORT")
  # git has no --port: the scp-style address form used below cannot carry one, and
  # the ssh:// form that can does not expand ~ in the path. Passing the port
  # through GIT_SSH_COMMAND keeps the address form that works and adds the port.
  export GIT_SSH_COMMAND="ssh -p ${SSH_PORT}"
fi

# A path relative to the remote $HOME, expanded by the remote login shell rather
# than written as ~ inside a URL: git's ssh:// URLs do not expand a tilde, and
# `ssh://host/~/gate/...` silently means a literal "~" directory on some
# servers. The scp:-style address form below leaves the expansion to the shell,
# which is the behaviour this wants.
REMOTE_MIRROR="${SERVER}:${REPO_HOME}/mirror.git"
REMOTE_HARNESS="${SERVER}:${REPO_HOME}/run-gate.sh"

printf '== Gate worker mirror push\n'
printf '   repository: %s (%s)\n' "$REPO_ROOT" "$REPO_NAME"
printf '   server:     %s%s\n' "$SERVER" "${SSH_PORT:+ (port ${SSH_PORT})}"
printf '   mirror:     %s\n' "$REMOTE_MIRROR"

# First push of a repository creates its mirror; anything else standing at that
# path is refused rather than pushed into. `git init` on an existing bare
# repository is a no-op, so this is convergent, but a non-bare directory there
# is somebody's working state and not this script's to overwrite.
if ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" "test -e ${REPO_HOME}/mirror.git" 2>/dev/null; then
  ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "test \"\$(git -C ${REPO_HOME}/mirror.git rev-parse --is-bare-repository 2>/dev/null)\" = true" 2>/dev/null \
    || die "${REPO_HOME}/mirror.git on ${SERVER} exists but is not a bare repository; refusing to push into it"
elif [ "$DRY_RUN" -eq 1 ]; then
  printf '   would create the bare mirror %s\n' "$REMOTE_MIRROR"
else
  ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "mkdir -p ${REPO_HOME} && git init --bare -q ${REPO_HOME}/mirror.git" \
    || die "could not create ${REPO_HOME}/mirror.git on ${SERVER}"
  printf '   created the bare mirror\n'
fi

# A mirror that has acquired a remote is a mirror that could fetch, and "the
# mirror fetches from nowhere" is a property this script gets to keep true on
# every push, not only at creation.
#
# The question asked is "does `git remote` succeed and print nothing", not "is
# the output empty": those differ exactly when git itself failed, and a guard
# that cannot tell them apart reports a mirror it never managed to inspect as
# clean. `git remote` on a readable repository exits 0 with no output, so a
# non-zero exit here — git's or ssh's — is a mirror whose remotes are unknown,
# and unknown is refused.
if [ "$DRY_RUN" -eq 0 ]; then
  if ! mirror_remotes="$(ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "git -C ${REPO_HOME}/mirror.git remote" 2>/dev/null)"; then
    die "could not read the remotes of ${REPO_HOME}/mirror.git on ${SERVER}; refusing to push into a mirror this check could not inspect"
  fi
  if [ -n "$mirror_remotes" ]; then
    die "${REPO_HOME}/mirror.git has a remote configured (${mirror_remotes}); the worker fetches from nowhere — remove it"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n== Dry run: refs that would be pushed\n'
  git -C "$REPO_ROOT" push --mirror --dry-run "$REMOTE_MIRROR" || die "dry-run push failed"
  printf '\n   would also install scripts/gate-worker/run-gate.sh at %s (copy to a\n   temporary name in the same directory, then rename into place)\n' "$REMOTE_HARNESS"
  printf '\nMIRROR PUSH: DRY RUN OK\n'
  exit 0
fi

printf '\n== Pushing every ref (--mirror)\n'
git -C "$REPO_ROOT" push --mirror "$REMOTE_MIRROR" || die "the mirror push failed"

printf '\n== Installing the gate harness\n'
# scp truncates its target and then streams into it, so copying straight onto
# ${REPO_HOME}/run-gate.sh leaves a window in which the harness on the worker is
# a half-written file. Two mirror-pushes racing each other widens that window
# into interleaved writes, and a gate that starts during it reads whatever
# happens to be there — which has already corrupted the worker's run-gate.sh
# once. So the copy lands on a name nobody else uses and a rename moves it into
# place: rename(2) within one directory is atomic, and a reader either gets the
# whole old file or the whole new one, never a mixture. A concurrent push then
# only decides which complete harness wins, which is harmless because both are
# the same file, and an already-running gate keeps executing the inode it opened.
HARNESS_TMP_NAME="run-gate.sh.tmp.$$.${RANDOM}"
REMOTE_HARNESS_TMP="${SERVER}:${REPO_HOME}/${HARNESS_TMP_NAME}"

remove_harness_tmp() {
  ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
    "rm -f ${REPO_HOME}/${HARNESS_TMP_NAME}" >/dev/null 2>&1 || true
}

scp ${SCP_OPTS[@]+"${SCP_OPTS[@]}"} -q "${SCRIPT_DIR}/run-gate.sh" "$REMOTE_HARNESS_TMP" || {
  remove_harness_tmp
  die "could not copy run-gate.sh to ${REMOTE_HARNESS_TMP}"
}
# chmod before the rename, so the file is never in place without its mode: the
# name ${REPO_HOME}/run-gate.sh only ever refers to a complete executable file.
ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
    "chmod 755 ${REPO_HOME}/${HARNESS_TMP_NAME} && mv -f ${REPO_HOME}/${HARNESS_TMP_NAME} ${REPO_HOME}/run-gate.sh" || {
  remove_harness_tmp
  die "could not install ${REPO_HOME}/run-gate.sh atomically"
}
printf '   %s\n' "$REMOTE_HARNESS"

# Read back rather than trust the push: a --mirror push that succeeded but landed
# in the wrong repository, or a mirror that was rewound afterwards, both look
# identical from here until something is resolved against it.
LOCAL_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [ -n "$LOCAL_HEAD" ]; then
  printf '\n== Verifying the local HEAD arrived\n'
  if ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "git -C ${REPO_HOME}/mirror.git cat-file -e ${LOCAL_HEAD}^{commit}" 2>/dev/null; then
    printf '   %s is in the mirror\n' "$LOCAL_HEAD"
  else
    die "pushed, but ${LOCAL_HEAD} is not resolvable in ${REMOTE_MIRROR}"
  fi
fi

# Origin's default-branch head, asked of origin rather than read from a local
# ref: the local ref is a cache, and a mirror that carries a stale one is
# exactly how a frozen record's modification gets read as an addition. The
# branch's name is read from origin's HEAD symref in the same call, so the name
# and the oid cannot come from two different moments — this repository's is
# `main`, but that is origin's to say, not this script's.
printf '\n== Verifying the gate baseline arrived\n'
symref="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" ls-remote --symref origin HEAD 2>/dev/null)"
DEFAULT_REF="$(printf '%s\n' "$symref" | awk '$1 == "ref:" && $3 == "HEAD" {print $2; exit}')"
BASELINE_OID="$(printf '%s\n' "$symref" | awk '$2 == "HEAD" {print $1; exit}')"
if [ -z "$DEFAULT_REF" ] || [ -z "$BASELINE_OID" ]; then
  printf '   could not read the default branch from origin; remote-gate.sh will need --master <oid>\n' >&2
else
  # Origin answered, so this is input: the ref name is named in a remote command
  # string below and gets the same allowlist as everything else that travels.
  gate_valid_ref "$DEFAULT_REF" >/dev/null \
    || die "origin named a default branch this script will not send: ${DEFAULT_REF}"
  case "$BASELINE_OID" in *[!0-9a-f]*) die "origin answered with something that is not an object id: ${BASELINE_OID}" ;; esac
  [ "${#BASELINE_OID}" -eq 40 ] || die "origin answered with a short object id: ${BASELINE_OID}"
  git -C "$REPO_ROOT" cat-file -e "${BASELINE_OID}^{commit}" 2>/dev/null \
    || die "origin's ${DEFAULT_REF} ${BASELINE_OID} is not in ${REPO_ROOT}; run: git fetch origin, then push again"
  if ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "git -C ${REPO_HOME}/mirror.git cat-file -e ${BASELINE_OID}^{commit}" 2>/dev/null; then
    printf '   %s %s is in the mirror\n' "$DEFAULT_REF" "$BASELINE_OID"
  else
    die "pushed, but origin's ${DEFAULT_REF} ${BASELINE_OID} is not resolvable in ${REMOTE_MIRROR}"
  fi

  # `git push --mirror` writes refs and never touches the receiving repository's
  # HEAD, so a mirror created by `git init --bare` keeps pointing at whatever
  # that git's init.defaultBranch was — a ref the mirror may not even have. The
  # gate never reads it (every path here names an oid) but a dangling HEAD is a
  # trap for anything that does, so it is converged to the branch origin just
  # named. Convergent: set only when it differs.
  ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "test \"\$(git -C ${REPO_HOME}/mirror.git symbolic-ref -q HEAD)\" = ${DEFAULT_REF} || git -C ${REPO_HOME}/mirror.git symbolic-ref HEAD ${DEFAULT_REF}" \
    || die "could not point ${REPO_HOME}/mirror.git HEAD at ${DEFAULT_REF} on ${SERVER}"
fi

printf '\nMIRROR PUSH: OK\n'
printf 'Next: scripts/gate-worker/remote-gate.sh %s %s\n' "$SERVER" "${LOCAL_HEAD:-<oid>}"
