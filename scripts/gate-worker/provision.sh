#!/usr/bin/env bash
#
# Provision an offshore merge-gate worker (issue #132). Runs ON THE SERVER.
#
#   scp scripts/gate-worker/provision.sh <server>:/tmp/
#   ssh <server> 'bash /tmp/provision.sh'            # dry run, prints the plan
#   ssh <server> 'bash /tmp/provision.sh --apply'    # do it
#
# What this machine is allowed to be: a stateless compute worker that checks a
# commit out of a bare mirror and runs scripts/merge-gate.sh against it. That is
# all. It holds no credential, has no remote configured on its mirror, and never
# runs an AgentOS runner or an agent session — the execution plane stays on the
# local machine (Leo's ruling, 2026-08-18). This script therefore installs a
# toolchain and a directory layout and nothing else: no service, no queue, no
# daemon, no token file, no clone of a GitHub remote.
#
# Both of those are enforced, here and in mirror-push.sh, and both are checked
# again on every run. What is deliberately NOT claimed: this box is not made
# network-isolated. Nothing here denies it a route to GitHub or anywhere else,
# and the repository does not guarantee one is denied (Leo's ruling,
# 2026-08-20). The gate's own flow never needs GitHub — the mirror arrives over
# ssh from the local machine and nothing fetches from a remote — but a candidate
# commit's build and test scripts run on this box, so what they can reach is
# whatever this box's network policy allows. Blocking GitHub alone would not
# change that, since every other host would remain reachable; the boundary that
# does the work is the one above — no credential, no remote, no merge authority,
# and a remote PASS that is evidence rather than an authoritative verdict.
#
# Idempotent by construction: every step reads the current state first and prints
# "ok" for what already matches, so re-running after a partial failure is safe
# and is the supported way to converge a half-provisioned box.
#
# Ubuntu only, and that is checked rather than assumed: the package names, the
# apt invocations and the systemd unit names below are Debian-family specifics,
# and a script that "mostly works" on another distribution would leave a worker
# whose failures look like gate failures.
set -uo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -h|--help) sed -n '2,36p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

# The exact interpreter the local machine runs, not a floor. package.json's
# engines field says ">=20.19.0", which is a compatibility floor and would let
# this box drift onto a different major than the one a PASS was observed under;
# a verdict produced on a different Node than the merge will be built with is
# weaker evidence than it looks. There is no .nvmrc in the repository (checked
# 2026-08-18), so the pin is written out here: v26.5.0 is what the local machine
# ran on 2026-08-18. If a .nvmrc is ever added it becomes the source of truth,
# and updating this default to match it is a step in the runbook.
GATE_NODE_VERSION="${GATE_NODE_VERSION:-v26.5.0}"
GATE_HOME="${GATE_HOME:-$HOME/gate}"
NODE_PREFIX="${NODE_PREFIX:-/opt/node}"
# The gate starts its own throwaway PostgreSQL; pre-pulling it here means the
# first gate run does not pay for the pull, and a pull that is going to fail
# (mirror unreachable, image renamed) fails during provisioning where it reads
# as a provisioning problem rather than as a FAIL against somebody's commit.
POSTGRES_IMAGE="${AGENTOS_GATE_POSTGRES_IMAGE:-postgres:16-alpine}"

# Mainland-China mirrors. The point is not speed: the direct sources are not
# reliably reachable from this network at all, so an unmirrored install does not
# run slowly, it hangs.
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NODE_MIRROR="${NODE_MIRROR:-https://cdn.npmmirror.com/binaries/node}"
DOCKER_REGISTRY_MIRRORS="${DOCKER_REGISTRY_MIRRORS:-https://docker.m.daocloud.io,https://dockerproxy.net}"

failures=0
note() { printf '  %s\n' "$*"; }
ok()   { printf '  ok      %s\n' "$*"; }
plan() { printf '  PLAN    %s\n' "$*"; }
# "ok" for something this run performed. Under --dry-run nothing was performed, so
# it stays silent: a plan that reports success is a plan nobody reads twice.
did()  { [ "$APPLY" = 1 ] && printf '  ok      %s\n' "$*"; return 0; }
fail() { printf '  FAIL    %s\n' "$*"; failures=$((failures + 1)); }
step() { printf '\n== %s\n' "$*"; }

# Everything that mutates the host goes through here, so a dry run cannot change
# anything and the plan it prints is the literal command list.
run() {
  if [ "$APPLY" = 1 ]; then
    "$@"
  else
    plan "$*"
  fi
}

# Same, for the handful of steps that need a shell (redirection, pipes).
run_sh() {
  if [ "$APPLY" = 1 ]; then
    sh -c "$1"
  else
    plan "sh -c $1"
  fi
}

SUDO=""
if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# Package installs and /etc writes need root. A worker account that cannot reach
# root can still be provisioned — by the operator running this himself — so this
# is a hard stop only under --apply, and only once something actually needs
# installing.
sudo_run() {
  if [ "$APPLY" = 1 ]; then
    if [ -z "$SUDO" ] && [ "$(id -u)" != 0 ]; then
      fail "this step needs root and neither root nor sudo is available: $*"
      return 1
    fi
    $SUDO "$@"
  else
    plan "${SUDO:+sudo }$*"
  fi
}

# --- preflight --------------------------------------------------------------

step "Preflight"

if [ ! -r /etc/os-release ]; then
  echo "no /etc/os-release: this script provisions Ubuntu only" >&2
  exit 64
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "this script provisions Ubuntu only, found ID=${ID:-unknown} (${PRETTY_NAME:-unknown})" >&2
  echo "its package names and unit names are Debian-family specifics; port it deliberately, do not force it" >&2
  exit 64
fi
ok "Ubuntu ${VERSION_ID:-unknown} (${PRETTY_NAME:-unknown})"

case "$(uname -m)" in
  x86_64)  NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo "unsupported architecture $(uname -m): no pinned Node build for it" >&2; exit 64 ;;
esac
ok "architecture $(uname -m) -> node ${NODE_ARCH} build"

if [ "$APPLY" = 1 ]; then
  note "applying"
else
  note "dry run — nothing below will be changed; re-run with --apply"
fi

# --- red line: this box holds no secrets ------------------------------------

# Checked before anything is installed, and checked again by run-gate.sh on every
# gate run. The worst case this design accepts is a compromised worker forging a
# PASS; it must not be able to escalate that into a leaked credential, so a box
# that already carries one is not a box this script will finish provisioning.
step "Red line: no AgentOS credentials on this host"

SECRET_VARS="OPERATOR_TOKEN RUNNER_TOKEN AGENTOS_API_TOKEN AGENTOS_SESSION_TOKEN AGENTOS_FENCING_TOKEN VITE_API_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN GH_TOKEN GITHUB_TOKEN FEISHU_APP_SECRET"
for var in $SECRET_VARS; do
  eval "value=\${$var:-}"
  # shellcheck disable=SC2154
  if [ -n "$value" ]; then
    fail "$var is set in this environment; unset it and remove it from the shell profile before provisioning"
  fi
done

for path in "$HOME/.config/gh/hosts.yml" "$HOME/.claude/.credentials.json" "$HOME/.agentos" "$HOME/.netrc"; do
  if [ -e "$path" ]; then
    fail "$path exists on this host; the worker holds no credentials — remove it"
  fi
done
[ "$failures" = 0 ] && ok "no known credential variable or file present"

# --- packages ---------------------------------------------------------------

step "Base packages"
missing_pkgs=""
for pkg in git curl ca-certificates xz-utils; do
  if dpkg -s "$pkg" >/dev/null 2>&1; then
    ok "$pkg"
  else
    missing_pkgs="${missing_pkgs} ${pkg}"
  fi
done
if [ -n "$missing_pkgs" ]; then
  # One update + one install for everything missing: apt-get update is the slow
  # part and repeating it per package turns a 20-second step into a minute.
  sudo_run apt-get update || fail "apt-get update failed"
  # shellcheck disable=SC2086
  sudo_run apt-get install -y $missing_pkgs || fail "could not install:${missing_pkgs}"
fi

step "Docker"
if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version 2>/dev/null | sed 's/^Docker version //')"
else
  # docker.io from the Ubuntu archive rather than Docker's own apt repository:
  # download.docker.com is exactly the kind of host this network cannot be relied
  # on to reach, and the gate only needs "run a postgres container", which the
  # distribution package does.
  sudo_run apt-get update || fail "apt-get update failed"
  sudo_run apt-get install -y docker.io || fail "could not install docker.io"
fi

# Registry mirrors, written only when absent: an existing daemon.json may carry
# settings this script knows nothing about, and silently rewriting it is how a
# provisioning run breaks the box it was supposed to converge.
if [ -f /etc/docker/daemon.json ]; then
  if grep -q 'registry-mirrors' /etc/docker/daemon.json 2>/dev/null; then
    # Present, but "configured" is not "working": this box arrived with mirrors
    # from a previous tenant that answered TLS and then never served a layer, and
    # the pull below sat there for fifteen minutes without failing. Whether these
    # mirrors are usable is decided by the timed pull at the end of this step, not
    # by the config file existing.
    note "/etc/docker/daemon.json already sets registry-mirrors; the pull below is what proves they work"
  else
    fail "/etc/docker/daemon.json exists without registry-mirrors; add ${DOCKER_REGISTRY_MIRRORS} by hand — this script will not rewrite a config it did not write"
  fi
else
  mirrors_json="$(printf '%s' "$DOCKER_REGISTRY_MIRRORS" | awk -F, '{for (i = 1; i <= NF; i++) printf "%s\"%s\"", (i > 1 ? ", " : ""), $i}')"
  sudo_run mkdir -p /etc/docker
  run_sh "printf '{\n  \"registry-mirrors\": [%s]\n}\n' '${mirrors_json}' | ${SUDO:+sudo }tee /etc/docker/daemon.json >/dev/null"
  sudo_run systemctl restart docker || fail "could not restart docker after writing daemon.json"
  did "wrote /etc/docker/daemon.json with ${DOCKER_REGISTRY_MIRRORS}"
fi

sudo_run systemctl enable --now docker || fail "could not enable the docker service"

# The gate calls plain `docker run`; requiring sudo for it would mean either a
# sudoers grant or a gate running as root, and neither is worth it on a box whose
# only job is to build and test.
if id -nG "$(id -un)" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
  ok "$(id -un) is in the docker group"
else
  sudo_run usermod -aG docker "$(id -un)" || fail "could not add $(id -un) to the docker group"
  note "group membership only takes effect in a new session: log out and back in, then re-run this script"
fi

# This pull is the load-bearing check of the whole mirror configuration, so it
# gets a deadline. A mainland box pointed at a mirror that has quietly stopped
# serving layers does not fail, it hangs — and a provisioning step that hangs is
# worse than one that fails, because the hang reappears later as a gate that
# never returns a verdict.
PULL_TIMEOUT="${PULL_TIMEOUT:-300}"
if [ "$APPLY" = 1 ] && docker info >/dev/null 2>&1; then
  if docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1; then
    ok "$POSTGRES_IMAGE already pulled"
  elif timeout "$PULL_TIMEOUT" docker pull "$POSTGRES_IMAGE"; then
    ok "pulled $POSTGRES_IMAGE"
  else
    fail "could not pull $POSTGRES_IMAGE within ${PULL_TIMEOUT}s. The mirrors in /etc/docker/daemon.json are not serving layers; replace them and re-run. Check one by hand with: timeout 150 docker pull <mirror>/library/${POSTGRES_IMAGE}"
  fi
else
  plan "timeout ${PULL_TIMEOUT} docker pull $POSTGRES_IMAGE"
fi

# --- node -------------------------------------------------------------------

step "Node ${GATE_NODE_VERSION} (pinned)"
current_node=""
if command -v node >/dev/null 2>&1; then
  current_node="$(node -v 2>/dev/null || true)"
fi

if [ "$current_node" = "$GATE_NODE_VERSION" ]; then
  ok "node ${current_node}"
else
  [ -n "$current_node" ] && note "node ${current_node} is installed but the gate is pinned to ${GATE_NODE_VERSION}"
  tarball="node-${GATE_NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  url="${NODE_MIRROR}/${GATE_NODE_VERSION}/${tarball}"
  # The official tarball through the npmmirror binary mirror, not NodeSource:
  # this pins one exact build rather than "whatever the 26.x apt repo has today",
  # and it is a single HTTP GET against a host this network can actually reach.
  sudo_run mkdir -p "$NODE_PREFIX"
  run_sh "curl -fsSL '${url}' | ${SUDO:+sudo }tar -xJ -C '${NODE_PREFIX}' --strip-components=1" \
    || fail "could not install node from ${url}"
  sudo_run ln -sfn "$NODE_PREFIX/bin/node" /usr/local/bin/node
  sudo_run ln -sfn "$NODE_PREFIX/bin/npm" /usr/local/bin/npm
  sudo_run ln -sfn "$NODE_PREFIX/bin/npx" /usr/local/bin/npx
  did "installed node ${GATE_NODE_VERSION} to ${NODE_PREFIX}"
fi

step "npm registry"
# A user-level .npmrc rather than a global one: it carries no auth token (there
# is nothing private to fetch) and keeping it in $HOME makes "what does this box
# talk to" answerable by reading one file.
if [ -f "$HOME/.npmrc" ] && grep -q "registry=${NPM_REGISTRY}" "$HOME/.npmrc" 2>/dev/null; then
  ok "~/.npmrc points at ${NPM_REGISTRY}"
else
  run_sh "printf 'registry=%s\n' '${NPM_REGISTRY}' >> \"\$HOME/.npmrc\""
  did "appended registry=${NPM_REGISTRY} to ~/.npmrc"
fi
if [ -f "$HOME/.npmrc" ] && grep -qE '_authToken|_auth=' "$HOME/.npmrc" 2>/dev/null; then
  fail "~/.npmrc carries an auth token; this host holds no credentials — remove that line"
fi

# --- layout -----------------------------------------------------------------

# Only the root. Each repository's mirror, worktrees, logs and run-gate.sh live
# under ${GATE_HOME}/<repo>/ and are created by the first mirror-push.sh from
# the local machine, so this box knows nothing about which repositories it will
# gate — the toolchain is worker-wide, the repositories arrive by push.
step "Gate layout under ${GATE_HOME}"
run mkdir -p "$GATE_HOME"

repo_dirs="$(find "$GATE_HOME" -mindepth 2 -maxdepth 2 -type d -name mirror.git 2>/dev/null)"
if [ -n "$repo_dirs" ]; then
  while IFS= read -r mirror; do
    # "git succeeded and printed nothing", not "the output was empty": those
    # differ exactly when git failed, and a guard that cannot tell them apart
    # reports a mirror it never managed to read as clean. There is no `pipefail`
    # covering the old `git remote | grep -q .`, which is why this reads the
    # exit status directly.
    if ! mirror_remotes="$(git -C "$mirror" remote 2>&1)"; then
      fail "could not read the remotes of ${mirror}: ${mirror_remotes}"
    elif [ -n "$mirror_remotes" ]; then
      fail "${mirror} has a remote configured (${mirror_remotes}); the worker fetches from nowhere — remove it"
    else
      ok "$mirror (no remote)"
    fi
  done <<EOF2
$repo_dirs
EOF2
else
  note "no repository mirrors yet — run scripts/gate-worker/mirror-push.sh from the local machine"
fi

# --- verdict ----------------------------------------------------------------

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'PROVISION: FAIL (%s problem(s) above)\n' "$failures"
  exit 1
fi
if [ "$APPLY" = 1 ]; then
  printf 'PROVISION: OK\n'
  printf 'Next, from the local machine: scripts/gate-worker/gate-dispatch.sh <candidate-oid>\n'
else
  printf 'PROVISION: DRY RUN OK — re-run with --apply\n'
fi
