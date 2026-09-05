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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../deploy/service-platform.sh
source "$SCRIPT_DIR/../deploy/service-platform.sh"
if ! SERVICE_PLATFORM="$(agentos_service_platform)"; then
  exit 64
fi
# shellcheck source=../deploy/service-inventory.sh
source "$SCRIPT_DIR/../deploy/service-inventory.sh"

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

ACCOUNT_COUNT="${ACCOUNT_COUNT:-8}"
agentos_load_service_inventory || exit 64
SERVICE_RUNNER_COUNT="$AGENTOS_RUNNER_SERVICE_COUNT"
ACCOUNT_PREFIX="${ACCOUNT_PREFIX:-_agentos}"
GROUP_NAME="${GROUP_NAME:-agentos-runners}"
AGENTOS_PREFIX="${AGENTOS_PREFIX:-/opt/agentos}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$AGENTOS_PREFIX/runs}"
HOME_BASE="${HOME_BASE:-$AGENTOS_PREFIX/accounts}"
SUDOERS_FILE="${SUDOERS_FILE:-/etc/sudoers.d/agentos-runners}"
if [ -z "${AGENT_DIR:-}" ]; then
  # Under sudo, $HOME is root's. The plists belong to the operator.
  if [ "$SERVICE_PLATFORM" = "linux" ]; then
    AGENT_DIR=""
  elif [ -n "${SUDO_USER:-}" ]; then
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

printf 'Anneal OS isolation rollback — %s\n' "$([ "$APPLY" = 1 ] && echo APPLY || echo 'dry run (no changes)')"

step "1. is any runner still configured to use these accounts?"
still_wired=0
if [ "$SERVICE_PLATFORM" = "linux" ]; then
  SYSTEMCTL="${SYSTEMCTL_BIN:-systemctl}"
  if ! command -v "$SYSTEMCTL" >/dev/null 2>&1; then
    echo "systemd-systemctl-unavailable" >&2
    exit 1
  fi
  for i in $(seq 1 "$SERVICE_RUNNER_COUNT"); do
    label="${AGENTOS_RUNNER_LABELS[$i]}"
    unit="${AGENTOS_RUNNER_UNITS[$i]}"
    if ! environment_output="$("$SYSTEMCTL" show -p Environment --value "$unit" 2>/dev/null)"; then
      echo "systemd-runner-inspection-failed:$unit" >&2
      exit 1
    fi
    case "$environment_output" in
      *RUNNER_RUN_AS_PREFIX=*"$ACCOUNT_PREFIX"*)
        warn "$label still has RUNNER_RUN_AS_PREFIX naming a managed account"
        still_wired=$((still_wired + 1))
        ;;
    esac
  done
else
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
fi
if [ "$still_wired" -gt 0 ] && [ "$FORCE" != 1 ]; then
  echo
  echo "Refusing to delete accounts that $still_wired runner(s) still launch as: every task would fail" >&2
  echo "at spawn. Run patch-runner-plists.sh --revert --apply and reload the agents first," >&2
  echo "or pass --force if the plists are already gone." >&2
  exit 1
fi
if [ "$still_wired" -eq 0 ]; then ok "no runner service references these accounts"; fi

step "2. sudoers grant"
if [ -f "$SUDOERS_FILE" ]; then
  run rm -f "$SUDOERS_FILE"
else
  ok "$SUDOERS_FILE is already gone"
fi

step "3. accounts and group"
for i in $(seq 1 "$ACCOUNT_COUNT"); do
  account="${ACCOUNT_PREFIX}${i}"
  if [ "$SERVICE_PLATFORM" = "linux" ]; then
    account_exists=0
    getent passwd "$account" >/dev/null 2>&1 && account_exists=1 || true
  else
    account_exists=0
    dscl . -read "/Users/$account" UniqueID >/dev/null 2>&1 && account_exists=1 || true
  fi
  if [ "$account_exists" = 1 ]; then
    if [ "$SERVICE_PLATFORM" = "linux" ]; then
      # Never use userdel -r: account homes hold operator-established CLI,
      # Git and GitHub state and are deliberately retained for inspection.
      run userdel "$account"
    else
      run dscl . -delete "/Users/$account"
    fi
  else
    ok "$account is already gone"
  fi
  # Home directories are left in place: they hold the CLI logins, which are the
  # expensive part to recreate, and nothing there is reachable once the account
  # no longer exists.
  if [ -d "$HOME_BASE/$account" ]; then warn "$HOME_BASE/$account left in place (holds that account's CLI login)"; fi
done
if [ "$SERVICE_PLATFORM" = "linux" ]; then
  group_exists=0
  getent group "$GROUP_NAME" >/dev/null 2>&1 && group_exists=1 || true
else
  group_exists=0
  dscl . -read "/Groups/$GROUP_NAME" PrimaryGroupID >/dev/null 2>&1 && group_exists=1 || true
fi
if [ "$group_exists" = 1 ]; then
  if [ "$SERVICE_PLATFORM" = "linux" ]; then
    run groupdel "$GROUP_NAME"
  else
    run dscl . -delete "/Groups/$GROUP_NAME"
  fi
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
