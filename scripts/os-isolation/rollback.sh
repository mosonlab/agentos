#!/bin/bash
# Undo scripts/os-isolation/provision.sh: remove the sudoers grant, the runner
# accounts, and the group.
#
# It never deletes $WORKSPACE_ROOT or anything under it. Those directories hold
# workspaces owned by the accounts this script is about to remove, and deleting
# them here is exactly the blast radius the whole exercise exists to prevent —
# reclaiming them is a separate, deliberate act.
#
# Turning isolation OFF does not need this script. Clearing RUNNER_RUN_AS_PREFIX
# is the whole rollback:
#   scripts/os-isolation/patch-runner-plists.sh --revert --apply
# and then reload the agents. The accounts and sudoers file are inert without the
# prefix. Run this only when the accounts themselves should be gone.
#
#   scripts/os-isolation/rollback.sh              # dry run
#   sudo scripts/os-isolation/rollback.sh --apply
set -euo pipefail

APPLY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

RUNNER_COUNT="${RUNNER_COUNT:-8}"
ACCOUNT_PREFIX="${ACCOUNT_PREFIX:-_agentos}"
GROUP_NAME="${GROUP_NAME:-agentos-runners}"
AGENTOS_PREFIX="${AGENTOS_PREFIX:-/opt/agentos}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$AGENTOS_PREFIX/runs}"
HOME_BASE="${HOME_BASE:-$AGENTOS_PREFIX/accounts}"
SUDOERS_FILE="${SUDOERS_FILE:-/etc/sudoers.d/agentos-runners}"
if [ -z "${AGENT_DIR:-}" ]; then
  # Under sudo, $HOME is root's. The plists belong to the operator.
  if [ -n "${SUDO_USER:-}" ]; then
    operator_home="$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
    AGENT_DIR="${operator_home:-$HOME}/Library/LaunchAgents"
  else
    AGENT_DIR="$HOME/Library/LaunchAgents"
  fi
fi

if [ "$APPLY" = 1 ] && [ "$(id -u)" != 0 ]; then
  echo "--apply needs root: sudo $0 --apply" >&2
  exit 64
fi

ok()   { printf '  ok      %s\n' "$*"; }
plan() { printf '  PLAN    %s\n' "$*"; }
warn() { printf '  WARN    %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

run() {
  if [ "$APPLY" = 1 ]; then
    "$@"
  else
    plan "$*"
  fi
}

printf 'AgentOS OS isolation rollback — %s\n' "$([ "$APPLY" = 1 ] && echo APPLY || echo 'dry run (no changes)')"

step "1. is any runner still configured to use these accounts?"
still_wired=0
for file in "$AGENT_DIR"/com.agentos.runner*.plist; do
  [ -f "$file" ] || continue
  prefix="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:RUNNER_RUN_AS_PREFIX" "$file" 2>/dev/null || true)"
  case "$prefix" in
    *"$ACCOUNT_PREFIX"*)
      warn "$(basename "$file" .plist) still has RUNNER_RUN_AS_PREFIX=$prefix"
      still_wired=$((still_wired + 1))
      ;;
  esac
done
if [ "$still_wired" -gt 0 ] && [ "$FORCE" != 1 ]; then
  echo
  echo "Refusing to delete accounts that $still_wired runner(s) still launch as: every task would fail" >&2
  echo "at spawn. Run patch-runner-plists.sh --revert --apply and reload the agents first," >&2
  echo "or pass --force if the plists are already gone." >&2
  exit 1
fi
if [ "$still_wired" -eq 0 ]; then ok "no runner plist references these accounts"; fi

step "2. sudoers grant"
if [ -f "$SUDOERS_FILE" ]; then
  run rm -f "$SUDOERS_FILE"
else
  ok "$SUDOERS_FILE is already gone"
fi

step "3. accounts and group"
for i in $(seq 1 "$RUNNER_COUNT"); do
  account="${ACCOUNT_PREFIX}${i}"
  if dscl . -read "/Users/$account" UniqueID >/dev/null 2>&1; then
    run dscl . -delete "/Users/$account"
  else
    ok "$account is already gone"
  fi
  # Home directories are left in place: they hold the CLI logins, which are the
  # expensive part to recreate, and nothing there is reachable once the account
  # no longer exists.
  if [ -d "$HOME_BASE/$account" ]; then warn "$HOME_BASE/$account left in place (holds that account's CLI login)"; fi
done
if dscl . -read "/Groups/$GROUP_NAME" PrimaryGroupID >/dev/null 2>&1; then
  run dscl . -delete "/Groups/$GROUP_NAME"
else
  ok "group $GROUP_NAME is already gone"
fi

step "4. workspaces (not touched)"
if [ -d "$WORKSPACE_ROOT" ]; then
  count="$(find "$WORKSPACE_ROOT" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  warn "$WORKSPACE_ROOT still holds $count directory(ies), now owned by deleted uids."
  warn "Reclaim them deliberately, as root, after confirming no run is active."
else
  ok "$WORKSPACE_ROOT does not exist"
fi

echo
if [ "$APPLY" = 1 ]; then
  echo "Rolled back. Reload the API and the runners so they pick up the reverted plists."
else
  echo "Dry run only. Re-run with --apply (as root) to make these changes."
fi
