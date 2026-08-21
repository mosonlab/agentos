#!/bin/bash
# Read-only gate for the OS isolation described in
# the per-runner account model. Every check that can distinguish
# "isolated" from "not isolated" is a hard failure: a green run here is what the
# runbook treats as permission to proceed, so it must not be reachable while any
# runner still launches its CLI as the operator.
#
#   scripts/os-isolation/verify.sh                  # full gate: every runner must be loaded and wired
#   scripts/os-isolation/verify.sh --staged         # mid-rollout: not-yet-loaded runners are allowed
#   scripts/os-isolation/verify.sh --probe          # + live cross-account containment probe
#
# --probe creates and deletes one scratch directory per account under the
# workspace root, named agentos-isolation-probe-*, and attempts a cross-account
# delete that MUST fail. It never touches a real run directory. Everything else
# only reads.
#
# WARN is reserved for things that cannot decide the question (a runner that is
# deliberately not loaded under --staged, an advisory path hint). Anything that
# could hide a runner still writing to the operator's root is a FAIL.
set -uo pipefail

PROBE=0
STAGED=0
for arg in "$@"; do
  case "$arg" in
    --probe) PROBE=1 ;;
    --staged) STAGED=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

RUNNER_COUNT="${RUNNER_COUNT:-8}"
ACCOUNT_PREFIX="${ACCOUNT_PREFIX:-_agentos}"
GROUP_NAME="${GROUP_NAME:-agentos-runners}"
GROUP_GID="${GROUP_GID:-620}"
BASE_UID="${BASE_UID:-620}"
AGENTOS_PREFIX="${AGENTOS_PREFIX:-/opt/agentos}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$AGENTOS_PREFIX/runs}"
HOME_BASE="${HOME_BASE:-$AGENTOS_PREFIX/accounts}"
LIB_DIR="$AGENTOS_PREFIX/lib"
BIN_DIR="$AGENTOS_PREFIX/bin"
SUDOERS_FILE="${SUDOERS_FILE:-/etc/sudoers.d/agentos-runners}"
AGENT_DIR="${AGENT_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHER_USER="${LAUNCHER_USER:-$(id -un)}"
API_LABEL="com.agentos.api"
DOMAIN="gui/$(id -u)"
PLIST_BUDDY=/usr/libexec/PlistBuddy

problems=0
pass() { printf '  PASS  %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; problems=$((problems + 1)); }
step() { printf '\n== %s\n' "$*"; }

account_for()      { printf '%s%s' "$ACCOUNT_PREFIX" "$1"; }
expected_prefix()  { printf 'sudo -u %s -E --' "$1"; }
dscl_value()       { dscl . -read "$1" "$2" 2>/dev/null | awk '{ $1=""; sub(/^ /,""); print }'; }
as_account()       { sudo -n -u "$1" "${@:2}"; }
plist_env()        { "$PLIST_BUDDY" -c "Print :EnvironmentVariables:$2" "$1" 2>/dev/null || true; }
plist_value()      { "$PLIST_BUDDY" -c "Print :$2" "$1" 2>/dev/null || true; }
is_loaded()        { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

# launchctl print has three environment blocks — inherited, default, and the
# service's own. Only the last one reflects the plist, and only it answers "what
# is this daemon running with right now", which is the question a disk plist
# cannot answer after an edit that was never reloaded.
loaded_env() {
  launchctl print "$DOMAIN/$1" 2>/dev/null | awk -v key="$2" '
    /^\tenvironment = \{$/ { inblock = 1; next }
    inblock && /^\t\}$/    { exit }
    inblock {
      line = $0
      sub(/^\t\t/, "", line)
      if (index(line, key " => ") == 1) { print substr(line, length(key) + 5); exit }
    }'
}

# The daemon's argv[0] as launchd actually started it, not as the plist reads.
loaded_program() {
  launchctl print "$DOMAIN/$1" 2>/dev/null | awk -F' = ' '/^\tprogram = /{ print $2; exit }'
}

# Compares one expected environment value on disk and, when the service is
# loaded, in the running daemon. Both are hard: a correct plist that was never
# reloaded is exactly the state that looks provisioned and is not.
check_env() {
  local file="$1" label="$2" key="$3" expected="$4" actual loaded
  actual="$(plist_env "$file" "$key")"
  if [ "$actual" = "$expected" ]; then
    pass "$label $key = $expected"
  else
    fail "$label $key is '${actual:-<unset>}', expected '$expected'"
  fi
  if is_loaded "$label"; then
    loaded="$(loaded_env "$label" "$key")"
    if [ "$loaded" != "$expected" ]; then
      fail "$label is LOADED with $key='${loaded:-<unset>}', expected '$expected' — reload it (the plist alone proves nothing)"
    fi
  fi
}

runner_label_for() {
  # com.agentos.runner is runner 1; com.agentos.runner-N is runner N.
  if [ "$1" = 1 ]; then printf 'com.agentos.runner'; else printf 'com.agentos.runner-%s' "$1"; fi
}

step "accounts and group"
group_gid="$(dscl_value "/Groups/$GROUP_NAME" PrimaryGroupID)"
if [ "$group_gid" = "$GROUP_GID" ]; then
  pass "group $GROUP_NAME has gid $GROUP_GID"
else
  fail "group $GROUP_NAME gid is '${group_gid:-<missing>}', expected $GROUP_GID"
fi
for i in $(seq 1 "$RUNNER_COUNT"); do
  account="$(account_for "$i")"
  expected_uid=$((BASE_UID + i - 1))
  expected_home="$HOME_BASE/$account"
  uid="$(dscl_value "/Users/$account" UniqueID)"
  if [ -z "$uid" ]; then
    fail "$account does not exist"
    continue
  fi
  # Identity, not existence: an account that merely has the right name can be an
  # unrelated pre-existing user with a different uid, group, or home, and every
  # containment property here is a property of the uid.
  [ "$uid" = "$expected_uid" ] || fail "$account uid is $uid, expected $expected_uid"
  gid="$(dscl_value "/Users/$account" PrimaryGroupID)"
  [ "$gid" = "$GROUP_GID" ] || fail "$account PrimaryGroupID is '$gid', expected $GROUP_GID"
  home="$(dscl_value "/Users/$account" NFSHomeDirectory)"
  [ "$home" = "$expected_home" ] || fail "$account home is '$home', expected $expected_home"
  hidden="$(dscl_value "/Users/$account" IsHidden)"
  [ "$hidden" = "1" ] || fail "$account IsHidden is '${hidden:-<unset>}', expected 1 (it would appear at the login window)"
  password="$(dscl_value "/Users/$account" Password)"
  [ "$password" = "*" ] || fail "$account Password is '${password:-<unset>}', expected '*' (no direct login, sudo only)"
  dseditgroup -o checkmember -m "$account" "$GROUP_NAME" >/dev/null 2>&1 \
    || fail "$account is not a member of $GROUP_NAME — it cannot create its own run directory"
  # An agent account in admin would make every other control here decorative.
  if dseditgroup -o checkmember -m "$account" admin >/dev/null 2>&1; then
    fail "$account is in the admin group"
  fi
  if [ -d "$expected_home" ]; then
    mode="$(stat -f '%Lp' "$expected_home")"
    owner="$(stat -f '%Su' "$expected_home")"
    [ "$mode" = "700" ] || fail "$expected_home is mode $mode, expected 700 (CLI credentials live here)"
    [ "$owner" = "$account" ] || fail "$expected_home is owned by $owner, expected $account"
  else
    fail "$expected_home does not exist"
  fi
done

step "workspace root"
if [ -d "$WORKSPACE_ROOT" ]; then
  mode="$(stat -f '%Lp' "$WORKSPACE_ROOT")"
  owner="$(stat -f '%Su' "$WORKSPACE_ROOT")"
  group="$(stat -f '%Sg' "$WORKSPACE_ROOT")"
  if [ "$mode" = "1770" ]; then
    pass "$WORKSPACE_ROOT is $owner:$group mode 1770 (sticky: only an entry's owner may unlink it)"
  else
    fail "$WORKSPACE_ROOT is mode $mode, expected 1770 — without the sticky bit one agent can rename another's live workspace"
  fi
  [ "$group" = "$GROUP_NAME" ] || fail "$WORKSPACE_ROOT group is '$group', expected $GROUP_NAME"
  [ "$owner" = "$LAUNCHER_USER" ] || fail "$WORKSPACE_ROOT owner is '$owner', expected $LAUNCHER_USER (the API sweeps this directory)"
else
  fail "$WORKSPACE_ROOT does not exist"
fi

step "sudoers grant"
if [ -f "$SUDOERS_FILE" ]; then
  mode="$(stat -f '%Lp' "$SUDOERS_FILE")"
  owner="$(stat -f '%Su' "$SUDOERS_FILE")"
  [ "$mode" = "440" ] || fail "$SUDOERS_FILE is mode $mode, expected 440"
  [ "$owner" = "root" ] || fail "$SUDOERS_FILE is owned by $owner, expected root"
else
  fail "$SUDOERS_FILE is missing"
fi
for i in $(seq 1 "$RUNNER_COUNT"); do
  account="$(account_for "$i")"
  # Every account, not just the first: one missing name in Runas_Alias fails
  # exactly one runner, and only at its first task.
  if ! as_account "$account" /usr/bin/true 2>/dev/null; then
    fail "sudo -n -u $account failed; that runner's prefix cannot work"
    continue
  fi
  # SETENV, or sudo's env_reset drops the session token and every injected secret.
  as_account "$account" -E /usr/bin/true 2>/dev/null \
    || fail "sudo -E is refused for $account; the sudoers rule needs SETENV or its CLI loses AGENTOS_SESSION_TOKEN"
done

step "staged assets readable by every account"
for i in $(seq 1 "$RUNNER_COUNT"); do
  account="$(account_for "$i")"
  for asset in "$LIB_DIR/mcp-server.js" "$LIB_DIR/pi-agentos-extension.ts" \
    "$LIB_DIR/session-config-baseline/claude" \
    "$LIB_DIR/session-config-baseline/codex" \
    "$LIB_DIR/session-config-baseline/pi"; do
    as_account "$account" /bin/test -r "$asset" 2>/dev/null \
      || fail "$account cannot read $asset"
  done
done
[ "$problems" -eq 0 ] && pass "all $RUNNER_COUNT accounts can read every staged runner asset"

step "plist wiring"
plists=()
while IFS= read -r file; do
  [ -n "$file" ] || continue
  plists+=("$file")
done < <(find "$AGENT_DIR" -maxdepth 1 -name 'com.agentos.runner*.plist' 2>/dev/null | sort)
if [ "${#plists[@]}" -ne "$RUNNER_COUNT" ]; then
  # Silence here was the original hole: with no matching plist the loop below
  # simply did not run, and the script exited 0.
  fail "found ${#plists[@]} com.agentos.runner*.plist under $AGENT_DIR, expected $RUNNER_COUNT"
fi
for i in $(seq 1 "$RUNNER_COUNT"); do
  label="$(runner_label_for "$i")"
  account="$(account_for "$i")"
  file="$AGENT_DIR/$label.plist"
  if [ ! -f "$file" ]; then
    fail "$label.plist is missing from $AGENT_DIR"
    continue
  fi
  # Exact, per label. 'contains -E' also accepts `sudo -u root -E --` and accepts
  # runner 3 launching as _agentos5, which shares one uid across two runners.
  check_env "$file" "$label" RUNNER_RUN_AS_PREFIX "$(expected_prefix "$account")"
  check_env "$file" "$label" RUNNER_HOME "$HOME_BASE/$account"
  check_env "$file" "$label" RUNNER_WORKSPACE_ROOT "$WORKSPACE_ROOT"
  check_env "$file" "$label" RUNNER_MCP_SERVER_PATH "$LIB_DIR/mcp-server.js"
  check_env "$file" "$label" RUNNER_PI_EXTENSION_PATH "$LIB_DIR/pi-agentos-extension.ts"
  if ! is_loaded "$label"; then
    if [ "$STAGED" = 1 ]; then
      warn "$label is not loaded (allowed by --staged; it proves nothing about the running system)"
    else
      fail "$label is not loaded — the full gate requires every runner running with this configuration (use --staged mid-rollout)"
    fi
  fi
done

api_plist="$AGENT_DIR/$API_LABEL.plist"
if [ -f "$api_plist" ]; then
  # The API canonicalises this root for the ownership lock and sweeps it for GC.
  # Disagreement here points the control plane at a directory the runners left.
  check_env "$api_plist" "$API_LABEL" RUNNER_WORKSPACE_ROOT "$WORKSPACE_ROOT"
  # Advisory to the API itself — it only decides whether to warn that
  # FilesystemGrant has no OS backstop — but the patch script always writes it, so
  # its absence means the API plist was patched by something else, or not at all.
  check_env "$api_plist" "$API_LABEL" RUNNER_RUN_AS_PREFIX "$(expected_prefix "$(account_for 1)")"
  if ! is_loaded "$API_LABEL"; then
    if [ "$STAGED" = 1 ]; then
      warn "$API_LABEL is not loaded (allowed by --staged)"
    else
      fail "$API_LABEL is not loaded"
    fi
  fi
else
  fail "$api_plist is missing; the API would keep sweeping the old root"
fi

step "the Node each runner actually runs the MCP server with"
# process.execPath is a resolved path — a Homebrew Cellar or version-manager
# directory, not the symlink on RUNNER_PATH — and it is what the CLI is told to
# start the MCP server with. Checking this shell's `command -v node` does not
# answer whether the *runner's* interpreter is reachable by the launched account.
for i in $(seq 1 "$RUNNER_COUNT"); do
  label="$(runner_label_for "$i")"
  account="$(account_for "$i")"
  file="$AGENT_DIR/$label.plist"
  [ -f "$file" ] || continue
  program="$(loaded_program "$label")"
  [ -n "$program" ] || program="$(plist_value "$file" "ProgramArguments:0")"
  if [ -z "$program" ]; then
    fail "$label has no ProgramArguments[0] and is not loaded; cannot tell what Node it runs"
    continue
  fi
  resolved="$(/usr/bin/readlink -f "$program" 2>/dev/null || printf '%s' "$program")"
  as_account "$account" /bin/test -x "$resolved" 2>/dev/null \
    || fail "$account cannot execute $resolved (the real path behind $label's $program) — the MCP server would fail inside the session"

  # The daemon publishes what it is really using; nothing else can confirm that
  # RUNNER_NODE_BINARY, the staged asset paths, and the prefix all took effect.
  log="$(plist_value "$file" StandardOutPath)"
  descriptor=""
  if [ -n "$log" ] && [ -r "$log" ]; then
    descriptor="$(grep '"runtime":"agentos-runner"' "$log" 2>/dev/null | tail -1)"
  fi
  if [ -z "$descriptor" ]; then
    if is_loaded "$label"; then
      fail "$label is loaded but its log (${log:-<no StandardOutPath>}) has no agentos-runner startup line; it predates this build or is not writing there"
    else
      warn "$label has no startup line yet (not loaded); its runtime paths are unverified"
    fi
    continue
  fi
  field() { printf '%s' "$descriptor" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
  descriptor_prefix="$(field runAsPrefix)"
  if [ "$descriptor_prefix" != "$(expected_prefix "$account")" ]; then
    fail "$label reported runAsPrefix='${descriptor_prefix:-<empty>}', expected '$(expected_prefix "$account")' — this is the running process, not the plist"
  fi
  for pair in "nodeBinary:x" "mcpServerPath:r" "piExtensionPath:r"; do
    path="$(field "${pair%%:*}")"
    [ -n "$path" ] || continue
    as_account "$account" "/bin/test" "-${pair##*:}" "$path" 2>/dev/null \
      || fail "$account cannot reach $label's ${pair%%:*} ($path)"
  done
done

step "toolchain reachable by every account, on that runner's own PATH"
for i in $(seq 1 "$RUNNER_COUNT"); do
  label="$(runner_label_for "$i")"
  account="$(account_for "$i")"
  file="$AGENT_DIR/$label.plist"
  [ -f "$file" ] || continue
  runner_path="$(loaded_env "$label" RUNNER_PATH)"
  [ -n "$runner_path" ] || runner_path="$(plist_env "$file" RUNNER_PATH)"
  if [ -z "$runner_path" ]; then
    fail "$label has no RUNNER_PATH; the runner would search a default PATH the account may not share"
    continue
  fi
  for cli in claude codex pi node git gh; do
    # Resolved *as the account*, with the runner's PATH: a directory the operator
    # can traverse and the account cannot silently drops the entry.
    if ! as_account "$account" /usr/bin/env PATH="$runner_path" /bin/sh -c "command -v $cli" >/dev/null 2>&1; then
      fail "$account cannot run '$cli' on $label's RUNNER_PATH — reinstall it under $BIN_DIR or /usr/local/bin (see plan §5)"
    fi
  done
done

if [ "$PROBE" = 1 ]; then
  step "containment probe (creates and removes scratch directories)"
  # A ring: every account is both a victim and an attacker exactly once, so a
  # single mis-provisioned account cannot hide behind a 1-vs-2 spot check.
  probe_dir() { printf '%s/agentos-isolation-probe-%s' "$WORKSPACE_ROOT" "$1"; }
  for i in $(seq 1 "$RUNNER_COUNT"); do
    account="$(account_for "$i")"
    dir="$(probe_dir "$i")"
    as_account "$account" /bin/sh -c "mkdir -p '$dir' && chmod 711 '$dir' && : > '$dir/held'" 2>/dev/null \
      || fail "$account cannot create its own run directory under $WORKSPACE_ROOT"
  done
  for i in $(seq 1 "$RUNNER_COUNT"); do
    victim=$i
    attacker=$(( i % RUNNER_COUNT + 1 ))
    [ "$attacker" = "$victim" ] && continue
    victim_account="$(account_for "$victim")"
    attacker_account="$(account_for "$attacker")"
    dir="$(probe_dir "$victim")"
    [ -d "$dir" ] || continue
    # The whole point of #117: these three MUST fail.
    if as_account "$attacker_account" /bin/rm -rf "$dir" 2>/dev/null && [ ! -d "$dir" ]; then
      fail "$attacker_account deleted $victim_account's directory — isolation is NOT in place"
      continue
    fi
    if as_account "$attacker_account" /bin/mv "$dir" "$dir-stolen" 2>/dev/null; then
      fail "$attacker_account renamed $victim_account's directory — the sticky bit is missing"
      as_account "$victim_account" /bin/rm -rf "$dir-stolen" 2>/dev/null || true
      continue
    fi
    if as_account "$attacker_account" /bin/ls "$dir" >/dev/null 2>&1; then
      fail "$attacker_account can list $victim_account's directory — run directories should be 0711"
      continue
    fi
    pass "$attacker_account cannot delete, rename, or enumerate $victim_account's directory"
  done
  for i in $(seq 1 "$RUNNER_COUNT"); do
    as_account "$(account_for "$i")" /bin/rm -rf "$(probe_dir "$i")" 2>/dev/null || true
  done
  for i in $(seq 1 "$RUNNER_COUNT"); do
    [ -d "$(probe_dir "$i")" ] && fail "probe directory $(probe_dir "$i") survived cleanup; remove it before dispatching"
  done
fi

echo
echo "Reminder: this gate proves separation *between* runner accounts. Each account"
echo "can still delete its own earlier workspaces, including WAITING_INBOX and"
echo "retained-failure ones."
if [ "$problems" -gt 0 ]; then
  echo
  echo "$problems problem(s). Isolation is NOT verified; do not enable it on the remaining runners." >&2
  exit 1
fi
echo "All checks passed$([ "$STAGED" = 1 ] && echo ' (--staged: unloaded runners were not checked)' || echo '')."
[ "$PROBE" = 1 ] || echo "Re-run with --probe for the live cross-account containment check."
