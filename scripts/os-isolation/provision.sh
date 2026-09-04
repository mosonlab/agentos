#!/bin/bash
# Provision the per-runner OS accounts, the shared workspace root, the sudoers
# grant, and the staged runner assets that let each runner launch under its own
# low-privilege macOS account. Idempotent: every step checks the current state first, so re-running
# after a partial failure is safe and prints "ok" for what already exists.
#
# Structure: everything is validated before anything is written, and everything
# written is read back before the script claims success. An account that merely
# has the right *name* is not the account this design needs — every containment
# property here is a property of a uid — so the pre-flight compares identities,
# not existence, and refuses to adopt a stranger.
#
# It does NOT touch launchd, does NOT restart anything, and does NOT set
# RUNNER_RUN_AS_PREFIX. That is patch-runner-plists.sh, deliberately separate:
# this script needs root and that one must not have it.
#
#   scripts/os-isolation/provision.sh              # dry run, prints the plan
#   sudo scripts/os-isolation/provision.sh --apply
#
# Undo: scripts/os-isolation/rollback.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../deploy/service-platform.sh
source "$SCRIPT_DIR/../deploy/service-platform.sh"
if ! SERVICE_PLATFORM="$(agentos_service_platform)"; then
  exit 64
fi

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

ACCOUNT_COUNT="${ACCOUNT_COUNT:-8}"
ACCOUNT_PREFIX="${ACCOUNT_PREFIX:-_agentos}"
GROUP_NAME="${GROUP_NAME:-agentos-runners}"
GROUP_GID="${GROUP_GID:-620}"
BASE_UID="${BASE_UID:-620}"
if [ "$SERVICE_PLATFORM" = "linux" ]; then
  ACCOUNT_SHELL="${ACCOUNT_SHELL:-/bin/bash}"
  ROOT_GROUP=root
else
  ACCOUNT_SHELL="${ACCOUNT_SHELL:-/bin/zsh}"
  ROOT_GROUP=wheel
fi
AGENTOS_PREFIX="${AGENTOS_PREFIX:-/opt/agentos}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$AGENTOS_PREFIX/runs}"
HOME_BASE="${HOME_BASE:-$AGENTOS_PREFIX/accounts}"
LIB_DIR="$AGENTOS_PREFIX/lib"
BIN_DIR="$AGENTOS_PREFIX/bin"
ETC_DIR="$AGENTOS_PREFIX/etc"
MANIFEST_DIR="${MANIFEST_DIR:-$ETC_DIR/plist-manifest}"
SUDOERS_FILE="${SUDOERS_FILE:-/etc/sudoers.d/agentos-runners}"
# Whoever owns the runner daemons and the API: the account that will be allowed
# to become the runner accounts, and the owner of the shared workspace root.
LAUNCHER_USER="${LAUNCHER_USER:-${SUDO_USER:-$(id -un)}}"
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

if [ "$LAUNCHER_USER" = "root" ]; then
  echo "LAUNCHER_USER resolved to root. Run this with sudo from the operator account, or set LAUNCHER_USER explicitly." >&2
  exit 64
fi
if [ "$APPLY" = 1 ] && [ "$(id -u)" != 0 ]; then
  echo "--apply needs root: sudo $0 --apply" >&2
  exit 64
fi

if [ ! -x "$ACCOUNT_SHELL" ]; then
  echo "account-shell-not-executable:$ACCOUNT_SHELL" >&2
  exit 64
fi

failures=0
note() { printf '  %s\n' "$*"; }
ok()   { printf '  ok      %s\n' "$*"; }
plan() { printf '  PLAN    %s\n' "$*"; }
warn() { printf '  WARN    %s\n' "$*"; }
fail() { printf '  FAIL    %s\n' "$*"; failures=$((failures + 1)); }
step() { printf '\n== %s\n' "$*"; }

# Runs the command when --apply was given, prints it otherwise. Everything that
# mutates the host goes through here, so a dry run cannot change anything.
run() {
  if [ "$APPLY" = 1 ]; then
    "$@"
  else
    plan "$*"
  fi
}

accounts=()
for i in $(seq 1 "$ACCOUNT_COUNT"); do accounts+=("${ACCOUNT_PREFIX}${i}"); done

# The value can contain spaces (RealName, and a shell with an odd path), so this
# prints everything after the key rather than the second field.
# `|| true`, not decoration: dscl exits non-zero for a record that does not
# exist, and with `set -o pipefail` that status would end the script through
# `set -e` at the first absent account — before the message explaining it.
dscl_value() { dscl . -read "$1" "$2" 2>/dev/null | awk '{ $1=""; sub(/^ /,""); print }' || true; }
dscl_search() { dscl . -search "$1" "$2" "$3" 2>/dev/null | awk 'NR==1{print $1}' || true; }
passwd_field() { getent passwd "$1" 2>/dev/null | awk -F: -v field="$2" 'NR == 1 { print $field; exit }' || true; }
passwd_name_for_uid() { getent passwd "$1" 2>/dev/null | awk -F: 'NR == 1 { print $1; exit }' || true; }
group_field() { getent group "$1" 2>/dev/null | awk -F: -v field="$2" 'NR == 1 { print $field; exit }' || true; }
group_name_for_gid() { getent group "$1" 2>/dev/null | awk -F: 'NR == 1 { print $1; exit }' || true; }
group_has_member() {
  local group="$1" account="$2" members
  members="$(group_field "$group" 4)"
  case ",$members," in
    *",$account,"*) return 0 ;;
    *) return 1 ;;
  esac
}
linux_group_member() {
  local account="$1" group="$2" group_gid account_gid
  group_gid="$(group_field "$group" 3)"
  account_gid="$(passwd_field "$account" 4)"
  [ -n "$group_gid" ] && [ "$account_gid" = "$group_gid" ] && return 0
  group_has_member "$group" "$account"
}
linux_admin_member() {
  local account="$1"
  linux_group_member "$account" sudo || linux_group_member "$account" wheel || linux_group_member "$account" admin
}
linux_password_state() {
  # getent shadow is available to the root apply pass on Linux. Fall back to
  # the passwd database when NSS exposes a locked marker there.
  local account="$1" state
  state="$(getent shadow "$account" 2>/dev/null | awk -F: 'NR == 1 { print $2; exit }' || true)"
  if [ -z "$state" ]; then state="$(passwd_field "$account" 2)"; fi
  printf '%s' "$state"
}
linux_password_locked() {
  case "$(linux_password_state "$1")" in
    '!'*|'*') return 0 ;;
    *) return 1 ;;
  esac
}
expect() {
  local what="$1" actual="$2" wanted="$3"
  [ "$actual" = "$wanted" ] || fail "$what is '${actual:-<unset>}', expected '$wanted'"
}
staged_sources=(
  "$REPO_ROOT/packages/runner/dist/mcp-server.js"
  "$REPO_ROOT/packages/runner/assets/pi-agentos-extension.ts"
  "$REPO_ROOT/deploy/codex-with-proxy.sh"
  "$REPO_ROOT/packages/runner/assets/claude-platform-settings.json"
  "$REPO_ROOT/packages/runner/assets/session-config-baseline/codex/config.toml"
)
staged_dests=(
  "$LIB_DIR/mcp-server.js"
  "$LIB_DIR/pi-agentos-extension.ts"
  "$BIN_DIR/codex-with-proxy.sh"
  "$LIB_DIR/claude-platform-settings.json"
  "$LIB_DIR/session-config-baseline/codex/config.toml"
)
staged_modes=(644 644 755 644 644)

printf 'Anneal OS isolation — %s\n' "$([ "$APPLY" = 1 ] && echo APPLY || echo 'dry run (no changes)')"
printf '  operator account : %s\n' "$LAUNCHER_USER"
# ${accounts[-1]} is bash 4 syntax; macOS ships bash 3.2.
printf '  runner accounts  : %s..%s (uid %s..%s)\n' \
  "${accounts[0]}" "${accounts[$((ACCOUNT_COUNT - 1))]}" "$BASE_UID" "$((BASE_UID + ACCOUNT_COUNT - 1))"
printf '  workspace root   : %s\n' "$WORKSPACE_ROOT"
printf '  repo             : %s\n' "$REPO_ROOT"

step "1. identity range, and the identity of anything already there"
if [ "$SERVICE_PLATFORM" = "linux" ]; then
  existing_group_name="$(group_name_for_gid "$GROUP_GID")"
  group_gid_now="$(group_field "$GROUP_NAME" 3)"
else
  existing_group_name="$(dscl_search /Groups PrimaryGroupID "$GROUP_GID")"
  group_gid_now="$(dscl_value "/Groups/$GROUP_NAME" PrimaryGroupID)"
fi
if [ -z "$existing_group_name" ] || [ "$existing_group_name" = "$GROUP_NAME" ]; then
  ok "gid $GROUP_GID is free or already ours"
else
  fail "gid $GROUP_GID is taken by group '$existing_group_name'; set GROUP_GID to a free value"
fi
if [ -n "$group_gid_now" ]; then
  # Adopting a same-named group with a different gid would put the accounts in a
  # group the workspace root does not grant, and every mkdir would fail later.
  expect "existing group $GROUP_NAME gid" "$group_gid_now" "$GROUP_GID"
fi
for i in $(seq 1 "$ACCOUNT_COUNT"); do
  uid=$((BASE_UID + i - 1))
  account="${ACCOUNT_PREFIX}${i}"
  if [ "$SERVICE_PLATFORM" = "linux" ]; then
    holder="$(passwd_name_for_uid "$uid")"
    current_uid="$(passwd_field "$account" 3)"
  else
    holder="$(dscl_search /Users UniqueID "$uid")"
    current_uid="$(dscl_value "/Users/$account" UniqueID)"
  fi
  if [ -n "$holder" ] && [ "$holder" != "$account" ]; then
    fail "uid $uid is taken by '$holder'; set BASE_UID to a free range"
  fi
  if [ -z "$current_uid" ]; then
    ok "$account does not exist yet (uid $uid is free)"
    continue
  fi
  # It exists. Every attribute below is load-bearing, and "it was already there"
  # is not evidence that any of them is right.
  expect "$account uid" "$current_uid" "$uid"
  if [ "$SERVICE_PLATFORM" = "linux" ]; then
    expect "$account PrimaryGroupID" "$(passwd_field "$account" 4)" "$GROUP_GID"
    expect "$account home" "$(passwd_field "$account" 6)" "$HOME_BASE/$account"
    expect "$account shell" "$(passwd_field "$account" 7)" "$ACCOUNT_SHELL"
    linux_password_locked "$account" || fail "$account password is not locked"
    linux_group_member "$account" "$GROUP_NAME" \
      || fail "$account exists but is not a member of $GROUP_NAME"
    if linux_admin_member "$account"; then
      fail "$account is in an administrative group; that would make every control here decorative"
    fi
  else
    expect "$account PrimaryGroupID" "$(dscl_value "/Users/$account" PrimaryGroupID)" "$GROUP_GID"
    expect "$account home" "$(dscl_value "/Users/$account" NFSHomeDirectory)" "$HOME_BASE/$account"
    expect "$account shell" "$(dscl_value "/Users/$account" UserShell)" "$ACCOUNT_SHELL"
    expect "$account IsHidden" "$(dscl_value "/Users/$account" IsHidden)" "1"
    expect "$account Password" "$(dscl_value "/Users/$account" Password)" "*"
    dseditgroup -o checkmember -m "$account" "$GROUP_NAME" >/dev/null 2>&1 \
      || fail "$account exists but is not a member of $GROUP_NAME"
    if dseditgroup -o checkmember -m "$account" admin >/dev/null 2>&1; then
      fail "$account is in the admin group; that would make every control here decorative"
    fi
  fi
done

# Staged assets are checked here, not at the point of copying: a missing build
# output used to warn and let the script finish with "Applied.", which left the
# plists pointing at files that were never staged.
for index in "${!staged_sources[@]}"; do
  src="${staged_sources[$index]}"
  [ -f "$src" ] || fail "missing $src — build it first (npm run build -w @anneal/runner), then re-run"
done

if [ -d "$WORKSPACE_ROOT" ]; then
  if [ "$SERVICE_PLATFORM" = "linux" ]; then
    root_owner="$(stat -c '%U' "$WORKSPACE_ROOT")"
  else
    root_owner="$(stat -f '%Su' "$WORKSPACE_ROOT")"
  fi
  if [ "$root_owner" != "$LAUNCHER_USER" ] && [ "$root_owner" != "root" ]; then
    # chown-ing a populated root out from under another owner is not a repair.
    fail "$WORKSPACE_ROOT is owned by '$root_owner', not $LAUNCHER_USER; resolve that by hand before provisioning"
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo
  echo "$failures problem(s). Refusing to continue: nothing was changed." >&2
  exit 1
fi

step "2. group $GROUP_NAME"
if [ -n "$group_gid_now" ]; then
  ok "group exists with gid $GROUP_GID"
elif [ "$SERVICE_PLATFORM" = "linux" ]; then
  run groupadd -g "$GROUP_GID" "$GROUP_NAME"
else
  run dscl . -create "/Groups/$GROUP_NAME"
  run dscl . -create "/Groups/$GROUP_NAME" PrimaryGroupID "$GROUP_GID"
  run dscl . -create "/Groups/$GROUP_NAME" RealName "Anneal runner accounts"
  run dscl . -create "/Groups/$GROUP_NAME" Password "*"
fi

step "3. runner accounts"
for i in $(seq 1 "$ACCOUNT_COUNT"); do
  account="${ACCOUNT_PREFIX}${i}"
  uid=$((BASE_UID + i - 1))
  home="$HOME_BASE/$account"
  if [ "$SERVICE_PLATFORM" = "linux" ]; then
    current_uid="$(passwd_field "$account" 3)"
  else
    current_uid="$(dscl_value "/Users/$account" UniqueID)"
  fi
  if [ -n "$current_uid" ]; then
    ok "$account exists and matched every attribute in step 1"
  elif [ "$SERVICE_PLATFORM" = "linux" ]; then
    run useradd -u "$uid" -g "$GROUP_NAME" -d "$home" -s "$ACCOUNT_SHELL" -M -r -p '*' "$account"
    run usermod -aG "$GROUP_NAME" "$account"
    run usermod -L "$account"
  else
    run dscl . -create "/Users/$account"
    run dscl . -create "/Users/$account" UniqueID "$uid"
    run dscl . -create "/Users/$account" PrimaryGroupID "$GROUP_GID"
    run dscl . -create "/Users/$account" RealName "Anneal runner $i"
    run dscl . -create "/Users/$account" NFSHomeDirectory "$home"
    # A real shell so the operator can `sudo -u <account> -i` to log the CLIs in.
    run dscl . -create "/Users/$account" UserShell "$ACCOUNT_SHELL"
    run dscl . -create "/Users/$account" IsHidden 1
    # "*" is no password, not an empty one: the account cannot be logged into
    # directly, only reached through the sudoers grant in step 6.
    run dscl . -create "/Users/$account" Password "*"
    run dseditgroup -o edit -a "$account" -t user "$GROUP_NAME"
  fi
  # Home directories are re-asserted every run: a wrong mode here is what would
  # let one agent read another's CLI credentials.
  run install -d -o "$account" -g "$GROUP_NAME" -m 700 "$home"
done

step "4. directories under $AGENTOS_PREFIX"
run install -d -o root -g "$ROOT_GROUP" -m 755 "$AGENTOS_PREFIX"
run install -d -o root -g "$ROOT_GROUP" -m 755 "$LIB_DIR"
run install -d -o root -g "$ROOT_GROUP" -m 755 "$BIN_DIR"
run install -d -o root -g "$ROOT_GROUP" -m 755 "$HOME_BASE"
# patch-runner-plists.sh runs as the operator and must not need root, so the
# record of what it changed lives somewhere the operator owns.
run install -d -o root -g "$ROOT_GROUP" -m 755 "$ETC_DIR"
run install -d -o "$LAUNCHER_USER" -g "$ROOT_GROUP" -m 755 "$MANIFEST_DIR"
# 1770: sticky, so only an entry's owner can rename or unlink it; group write, so
# each runner account can create its own run directory; no "other" bits at all.
# Owner is the operator because the API reads this directory for workspace GC.
run install -d -o "$LAUNCHER_USER" -g "$GROUP_NAME" -m 1770 "$WORKSPACE_ROOT"

step "5. staged runner assets"
# The CLI runs as a runner account and spawns these itself, so they cannot live
# under the operator's home (mode 0700, not traversable). Root-owned copies here
# are also not rewritable by an agent. They are copies: restage on every deploy.
run install -d -o root -g "$ROOT_GROUP" -m 755 "$LIB_DIR/session-config-baseline" "$LIB_DIR/session-config-baseline/codex"
for index in "${!staged_sources[@]}"; do
  src="${staged_sources[$index]}"
  dest="${staged_dests[$index]}"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    ok "$dest is current"
  else
    run install -o root -g "$ROOT_GROUP" -m "${staged_modes[$index]}" "$src" "$dest"
  fi
done

step "6. sudoers grant"
# A de-escalation grant only: the operator may become an account weaker than
# itself. The runner accounts appear solely as targets, never as a source, so
# nothing here gives an agent a path to root.
#
# SETENV is load-bearing. sudo's env_reset would otherwise strip
# AGENTOS_SESSION_TOKEN / AGENTOS_FENCING_TOKEN / AGENTOS_API_URL / RUNNER_PATH
# and every injected secret from the CLI's environment, and the agent would fail
# at its first MCP call with an error that names none of this. The prefix passes
# -E, which sudo only honours when the rule carries SETENV.
sudoers_body="$(cat <<EOF
# Managed by scripts/os-isolation/provision.sh. Do not edit by hand.
Runas_Alias AGENTOS_RUNNERS = $(IFS=,; echo "${accounts[*]}" | sed 's/,/, /g')
$LAUNCHER_USER ALL=(AGENTOS_RUNNERS) NOPASSWD: SETENV: ALL
EOF
)"
sudoers_tmp="$(mktemp "${TMPDIR:-/tmp}/agentos-sudoers.XXXXXX")"
printf '%s\n' "$sudoers_body" > "$sudoers_tmp"
if visudo -c -f "$sudoers_tmp" >/dev/null 2>&1; then
  ok "generated sudoers file parses"
elif [ "$(id -u)" != 0 ]; then
  # visudo can refuse for reasons other than syntax when it is not root; in a
  # dry run that is not evidence of a bad file, so it must not block the plan.
  warn "could not validate the sudoers file as a non-root user; --apply re-checks it"
else
  visudo -c -f "$sudoers_tmp" || true
  fail "generated sudoers file does not parse; not installing it"
fi
if [ "$failures" -eq 0 ]; then
  if [ -f "$SUDOERS_FILE" ] && cmp -s "$sudoers_tmp" "$SUDOERS_FILE"; then
    ok "$SUDOERS_FILE is current"
  else
    run install -o root -g "$ROOT_GROUP" -m 440 "$sudoers_tmp" "$SUDOERS_FILE"
    if [ "$APPLY" != 1 ]; then
      plan "contents of $SUDOERS_FILE:"
      printf '%s\n' "$sudoers_body" | sed 's/^/          /'
    fi
  fi
fi

if [ "$APPLY" = 1 ]; then
  step "7. read it all back"
  # Not a formality: dscl reports success for writes that a directory-service
  # cache can still serve stale, install(1) can succeed against a symlink, and
  # "Applied." is what the runbook treats as this step being done.
  if [ "$SERVICE_PLATFORM" = "linux" ]; then
    expect "group $GROUP_NAME gid" "$(group_field "$GROUP_NAME" 3)" "$GROUP_GID"
  else
    expect "group $GROUP_NAME gid" "$(dscl_value "/Groups/$GROUP_NAME" PrimaryGroupID)" "$GROUP_GID"
  fi
  for i in $(seq 1 "$ACCOUNT_COUNT"); do
    account="${ACCOUNT_PREFIX}${i}"
    home="$HOME_BASE/$account"
    if [ "$SERVICE_PLATFORM" = "linux" ]; then
      expect "$account uid" "$(passwd_field "$account" 3)" "$((BASE_UID + i - 1))"
      expect "$account PrimaryGroupID" "$(passwd_field "$account" 4)" "$GROUP_GID"
      expect "$account home" "$(passwd_field "$account" 6)" "$home"
      expect "$account shell" "$(passwd_field "$account" 7)" "$ACCOUNT_SHELL"
      linux_password_locked "$account" || fail "$account password is not locked"
      linux_group_member "$account" "$GROUP_NAME" || fail "$account is not a member of $GROUP_NAME"
    else
      expect "$account uid" "$(dscl_value "/Users/$account" UniqueID)" "$((BASE_UID + i - 1))"
      expect "$account PrimaryGroupID" "$(dscl_value "/Users/$account" PrimaryGroupID)" "$GROUP_GID"
      expect "$account home" "$(dscl_value "/Users/$account" NFSHomeDirectory)" "$home"
      expect "$account shell" "$(dscl_value "/Users/$account" UserShell)" "$ACCOUNT_SHELL"
      expect "$account IsHidden" "$(dscl_value "/Users/$account" IsHidden)" "1"
      expect "$account Password" "$(dscl_value "/Users/$account" Password)" "*"
      dseditgroup -o checkmember -m "$account" "$GROUP_NAME" >/dev/null 2>&1 \
        || fail "$account is not a member of $GROUP_NAME"
    fi
    if [ -d "$home" ]; then
      if [ "$SERVICE_PLATFORM" = "linux" ]; then
        expect "$home owner" "$(stat -c '%U' "$home")" "$account"
        expect "$home mode" "$(stat -c '%a' "$home")" "700"
      else
        expect "$home owner" "$(stat -f '%Su' "$home")" "$account"
        expect "$home mode" "$(stat -f '%Lp' "$home")" "700"
      fi
    else
      fail "$home was not created"
    fi
  done
  if [ "$SERVICE_PLATFORM" = "linux" ]; then
    expect "$WORKSPACE_ROOT mode" "$(stat -c '%a' "$WORKSPACE_ROOT")" "1770"
    expect "$WORKSPACE_ROOT owner" "$(stat -c '%U' "$WORKSPACE_ROOT")" "$LAUNCHER_USER"
    expect "$WORKSPACE_ROOT group" "$(stat -c '%G' "$WORKSPACE_ROOT")" "$GROUP_NAME"
    expect "$MANIFEST_DIR owner" "$(stat -c '%U' "$MANIFEST_DIR")" "$LAUNCHER_USER"
  else
    expect "$WORKSPACE_ROOT mode" "$(stat -f '%Lp' "$WORKSPACE_ROOT")" "1770"
    expect "$WORKSPACE_ROOT owner" "$(stat -f '%Su' "$WORKSPACE_ROOT")" "$LAUNCHER_USER"
    expect "$WORKSPACE_ROOT group" "$(stat -f '%Sg' "$WORKSPACE_ROOT")" "$GROUP_NAME"
    expect "$MANIFEST_DIR owner" "$(stat -f '%Su' "$MANIFEST_DIR")" "$LAUNCHER_USER"
  fi
  for index in "${!staged_sources[@]}"; do
    dest="${staged_dests[$index]}"
    if [ ! -f "$dest" ]; then
      fail "$dest was not staged"
      continue
    fi
    cmp -s "${staged_sources[$index]}" "$dest" || fail "$dest does not match ${staged_sources[$index]}"
    if [ "$SERVICE_PLATFORM" = "linux" ]; then
      expect "$dest owner" "$(stat -c '%U' "$dest")" "root"
      expect "$dest mode" "$(stat -c '%a' "$dest")" "${staged_modes[$index]}"
    else
      expect "$dest owner" "$(stat -f '%Su' "$dest")" "root"
      expect "$dest mode" "$(stat -f '%Lp' "$dest")" "${staged_modes[$index]}"
    fi
  done
  if [ -f "$SUDOERS_FILE" ]; then
    if [ "$SERVICE_PLATFORM" = "linux" ]; then
      expect "$SUDOERS_FILE mode" "$(stat -c '%a' "$SUDOERS_FILE")" "440"
      expect "$SUDOERS_FILE owner" "$(stat -c '%U' "$SUDOERS_FILE")" "root"
    else
      expect "$SUDOERS_FILE mode" "$(stat -f '%Lp' "$SUDOERS_FILE")" "440"
      expect "$SUDOERS_FILE owner" "$(stat -f '%Su' "$SUDOERS_FILE")" "root"
    fi
    cmp -s "$sudoers_tmp" "$SUDOERS_FILE" || fail "$SUDOERS_FILE does not match what this script generated"
    visudo -c -f "$SUDOERS_FILE" >/dev/null 2>&1 || fail "the installed $SUDOERS_FILE does not parse"
  else
    fail "$SUDOERS_FILE was not installed"
  fi
  if [ "$failures" -eq 0 ]; then ok "every account, directory, staged file, and the sudoers grant read back as intended"; fi
fi
rm -f "$sudoers_tmp"

step "8. next steps (not done here)"
note "a. Log each CLI in per account, once:  sudo -u ${ACCOUNT_PREFIX}1 -i"
note "   then run claude / codex / pi and complete auth. See §7 of the plan doc:"
note "   whether a hidden account's Keychain login survives is the open risk."
note "b. Make claude/codex/pi readable by the runner accounts, and confirm with:"
note "     scripts/os-isolation/verify.sh --staged"
note "c. Patch the launchd plists (as the operator, NOT with sudo):"
note "     scripts/os-isolation/patch-runner-plists.sh --apply"
note "d. Drain all active runs, then reload the agents. To reverse a-c, run"
note "     scripts/os-isolation/rollback.sh --help"

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures problem(s) above; this host is NOT provisioned as intended." >&2
  exit 1
fi
if [ "$APPLY" = 1 ]; then
  echo "Applied."
else
  echo "Dry run only. Re-run with --apply (as root) to make these changes."
fi
