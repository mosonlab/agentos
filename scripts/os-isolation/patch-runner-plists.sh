#!/bin/bash
# Add the OS-isolation environment to the launchd plists: RUNNER_RUN_AS_PREFIX
# and the paths that stop working once the CLI is a different account.
#
# Everything it touches is recorded, per label, in a manifest under
# $AGENTOS_PREFIX/etc/plist-manifest: the previous value of every key it sets (or
# that the key did not exist), and the value it wrote. --revert undoes exactly
# those keys from that record. It does not restore a whole plist: by the time a
# rollout is being rolled back, the plists have usually also gained unrelated,
# wanted changes — tokens, models, paths — and restoring a file from before the
# rollout would silently take those with it.
#
# It edits files only. It does NOT run launchctl, does not reload anything, and
# does not need root; run it as the account that owns the LaunchAgents.
#
#   scripts/os-isolation/patch-runner-plists.sh              # dry run: full pre-flight, no writes
#   scripts/os-isolation/patch-runner-plists.sh --apply
#   scripts/os-isolation/patch-runner-plists.sh --revert --apply
#   scripts/os-isolation/patch-runner-plists.sh --revert --apply --force   # revert keys that drifted
#
# Prerequisite: scripts/os-isolation/provision.sh --apply. Order and rollback:
# the staged rollout order
set -euo pipefail

APPLY=0
REVERT=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --revert) REVERT=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

RUNNER_COUNT="${RUNNER_COUNT:-8}"
ACCOUNT_PREFIX="${ACCOUNT_PREFIX:-_agentos}"
BASE_UID="${BASE_UID:-620}"
AGENTOS_PREFIX="${AGENTOS_PREFIX:-/opt/agentos}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$AGENTOS_PREFIX/runs}"
HOME_BASE="${HOME_BASE:-$AGENTOS_PREFIX/accounts}"
LIB_DIR="$AGENTOS_PREFIX/lib"
BIN_DIR="$AGENTOS_PREFIX/bin"
MANIFEST_DIR="${MANIFEST_DIR:-$AGENTOS_PREFIX/etc/plist-manifest}"
AGENT_DIR="${AGENT_DIR:-$HOME/Library/LaunchAgents}"
BACKUP_SUFFIX=".pre-os-isolation.bak"
PLIST_BUDDY=/usr/libexec/PlistBuddy
API_LABEL="com.agentos.api"

if [ "$(id -u)" = 0 ]; then
  echo "Do not run this as root: it would rewrite the operator's LaunchAgents as root-owned files." >&2
  exit 64
fi

changed=0
failures=0
labels_touched=()
ok()   { printf '  ok      %s\n' "$*"; }
plan() { printf '  PLAN    %s\n' "$*"; }
warn() { printf '  WARN    %s\n' "$*"; }
fail() { printf '  FAIL    %s\n' "$*"; failures=$((failures + 1)); }
step() { printf '\n== %s\n' "$*"; }

run() {
  if [ "$APPLY" = 1 ]; then
    "$@"
  else
    plan "$*"
  fi
}

buddy_get()    { "$PLIST_BUDDY" -c "Print :EnvironmentVariables:$2" "$1" 2>/dev/null || true; }
buddy_has()    { "$PLIST_BUDDY" -c "Print :EnvironmentVariables:$2" "$1" >/dev/null 2>&1; }
label_for()    { if [ "$1" = 1 ]; then printf 'com.agentos.runner'; else printf 'com.agentos.runner-%s' "$1"; fi; }
account_for()  { printf '%s%s' "$ACCOUNT_PREFIX" "$1"; }
manifest_for() { printf '%s/%s.manifest' "$MANIFEST_DIR" "$1"; }
# `|| true` on both: dscl exits non-zero for an account that does not exist, and
# with `set -o pipefail` that would end the script through `set -e` instead of
# reaching the pre-flight message that says which account is missing.
dscl_value()   { dscl . -read "$1" "$2" 2>/dev/null | awk '{ $1=""; sub(/^ /,""); print }' || true; }
sha256_of()    { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || true; }

printf 'AgentOS runner plists — %s%s\n' \
  "$([ "$REVERT" = 1 ] && echo 'REVERT ' || echo '')" \
  "$([ "$APPLY" = 1 ] && echo APPLY || echo 'dry run (no changes)')"
printf '  LaunchAgents: %s\n' "$AGENT_DIR"
printf '  manifest    : %s\n' "$MANIFEST_DIR"

# ---------------------------------------------------------------------------
# Pre-flight. Nothing below writes anything; a single FAIL here stops the script
# before the first write, because a partial patch is the state that verify.sh
# and the runbook are least able to describe: some runners isolated, some not,
# and no single place that says which.
# ---------------------------------------------------------------------------
step "pre-flight"
[ -x "$PLIST_BUDDY" ] || fail "$PLIST_BUDDY is missing"

found=()
while IFS= read -r file; do
  [ -n "$file" ] || continue
  found+=("$file")
done < <(find "$AGENT_DIR" -maxdepth 1 -name 'com.agentos.runner*.plist' 2>/dev/null | sort)
if [ "${#found[@]}" -ne "$RUNNER_COUNT" ]; then
  fail "found ${#found[@]} com.agentos.runner*.plist under $AGENT_DIR, expected $RUNNER_COUNT (set RUNNER_COUNT if that is wrong)"
fi

targets=()
for i in $(seq 1 "$RUNNER_COUNT"); do
  label="$(label_for "$i")"
  file="$AGENT_DIR/$label.plist"
  if [ ! -f "$file" ]; then
    fail "$file does not exist"
    continue
  fi
  [ -w "$file" ] || fail "$file is not writable by $(id -un)"
  plutil -lint "$file" >/dev/null 2>&1 || fail "$file is not a valid plist; refusing to edit it"
  targets+=("$label")
done
for file in "${found[@]:-}"; do
  [ -n "$file" ] || continue
  label="$(basename "$file" .plist)"
  case " ${targets[*]:-} " in
    *" $label "*) ;;
    # A stray com.agentos.runner-9.plist means the host runs more runners than
    # this script would isolate, and the extra one keeps the operator's uid.
    *) fail "$label is not one of the $RUNNER_COUNT expected runner labels; it would be left unisolated" ;;
  esac
done

api_plist="$AGENT_DIR/$API_LABEL.plist"
if [ -f "$api_plist" ]; then
  [ -w "$api_plist" ] || fail "$api_plist is not writable by $(id -un)"
  plutil -lint "$api_plist" >/dev/null 2>&1 || fail "$api_plist is not a valid plist; refusing to edit it"
else
  # The API resolves the same root for the ownership lock and for workspace GC.
  # Isolating the runners while the API still sweeps ~/.agentos/runs is not a
  # half-done rollout, it is a control plane pointed at the wrong directory.
  fail "$api_plist does not exist; the API's workspace root cannot be moved with the runners"
fi

if [ "$REVERT" = 1 ]; then
  for label in "${targets[@]:-}" "$API_LABEL"; do
    [ -n "$label" ] || continue
    manifest="$(manifest_for "$label")"
    [ -f "$manifest" ] || fail "$label has no manifest at $manifest; there is no record of what to undo (see 'Rollback' in the runbook)"
    [ ! -f "$manifest" ] || [ -w "$manifest" ] || fail "$manifest is not writable by $(id -un)"
  done
else
  for i in $(seq 1 "$RUNNER_COUNT"); do
    account="$(account_for "$i")"
    uid="$(dscl_value "/Users/$account" UniqueID)"
    expected_uid=$((BASE_UID + i - 1))
    if [ -z "$uid" ]; then
      fail "$account does not exist; run provision.sh --apply first"
    elif [ "$uid" != "$expected_uid" ]; then
      # Same name, different identity: every containment property is a property
      # of the uid, so pointing a runner at this account proves nothing.
      fail "$account has uid $uid, expected $expected_uid; provision.sh and this script disagree about the account"
    fi
    home="$(dscl_value "/Users/$account" NFSHomeDirectory)"
    [ "$home" = "$HOME_BASE/$account" ] || fail "$account home is '${home:-<unset>}', expected $HOME_BASE/$account"
  done
  # Pointing RUNNER_MCP_SERVER_PATH at a file that is not there turns every
  # session into an MCP protocol error with no mention of this rollout.
  for asset in \
    "$LIB_DIR/mcp-server.js" \
    "$LIB_DIR/pi-agentos-extension.ts" \
    "$LIB_DIR/claude-platform-settings.json" \
    "$LIB_DIR/session-config-baseline/codex/config.toml"; do
    [ -r "$asset" ] || fail "$asset is missing; run provision.sh --apply after building the runner"
  done
  [ -d "$WORKSPACE_ROOT" ] || fail "$WORKSPACE_ROOT does not exist; run provision.sh --apply first"
  if [ ! -d "$MANIFEST_DIR" ]; then
    fail "$MANIFEST_DIR does not exist; run provision.sh --apply (it creates it, owned by you)"
  elif [ ! -w "$MANIFEST_DIR" ]; then
    fail "$MANIFEST_DIR is not writable by $(id -un); --revert would have nothing to read"
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo
  echo "$failures pre-flight problem(s). Nothing was changed." >&2
  exit 1
fi
ok "pre-flight clean: $RUNNER_COUNT runner plists, the API plist, and everything they will point at"

# ---------------------------------------------------------------------------
# Manifest. before/after records per key; the plist checksum is forensic only —
# drift in *other* keys is expected and is exactly what must survive a revert.
# ---------------------------------------------------------------------------
manifest_before_line() {
  local file="$1" key="$2" current
  if buddy_has "$file" "$key"; then
    current="$(buddy_get "$file" "$key")"
    printf 'before\t%s\tvalue\t%s\n' "$key" "$current"
  else
    printf 'before\t%s\tabsent\n' "$key"
  fi
}

manifest_records=""
record_before() {
  local file="$1" key="$2" manifest="$3" existing=""
  # Only the first apply sees the pre-isolation value; later runs must not
  # overwrite the record with a value this script itself wrote.
  if [ -f "$manifest" ]; then
    existing="$(awk -F'\t' -v k="$2" '$1 == "before" && $2 == k' "$manifest")"
  fi
  if [ -n "$existing" ]; then
    manifest_records="$manifest_records$existing
"
  else
    manifest_records="$manifest_records$(manifest_before_line "$file" "$key")
"
  fi
}

set_env() {
  local file="$1" label="$2" key="$3" value="$4" manifest="$5" current
  case "$value" in
    *$'\t'*|*$'\n'*) fail "$label: refusing to manage $key: the value contains a tab or newline and could not be recorded"; return ;;
  esac
  record_before "$file" "$key" "$manifest"
  manifest_records="$manifest_records$(printf 'after\t%s\t%s' "$key" "$value")
"
  current="$(buddy_get "$file" "$key")"
  if [ "$current" = "$value" ] && buddy_has "$file" "$key"; then
    ok "$label: $key already $value"
    return
  fi
  # PlistBuddy has no upsert, and Add on an existing key is an error, so the
  # existence check is not optional.
  if buddy_has "$file" "$key"; then
    run "$PLIST_BUDDY" -c "Set :EnvironmentVariables:$key $value" "$file"
  else
    run "$PLIST_BUDDY" -c "Add :EnvironmentVariables:$key string $value" "$file"
  fi
  changed=$((changed + 1))
}

backup() {
  local file="$1"
  # Kept as evidence of the pre-rollout file, never as the revert path: see the
  # header. The first one is the only one that predates any of this.
  if [ -f "$file$BACKUP_SUFFIX" ]; then
    ok "$(basename "$file"): backup already exists"
  else
    run cp -p "$file" "$file$BACKUP_SUFFIX"
  fi
}

# Keys this run did not touch — because they were already correct and the code
# path that sets them was skipped — are still keys a previous apply changed. Drop
# their records and --revert silently leaves those keys behind: that is how
# RUNNER_PATH kept /opt/agentos/bin through a revert during testing.
carry_forward_records() {
  local manifest="$1" touched key line
  [ -f "$manifest" ] || return 0
  touched="$(printf '%s' "$manifest_records" | awk -F'\t' '$1 == "before" { print $2 }')"
  while IFS= read -r line; do
    case "$line" in
      before*|after*) key="$(printf '%s' "$line" | awk -F'\t' '{print $2}')" ;;
      *) continue ;;
    esac
    case " $(printf '%s' "$touched" | tr '\n' ' ') " in
      *" $key "*) continue ;;
    esac
    manifest_records="$manifest_records$line
"
  done < "$manifest"
}

write_manifest() {
  local label="$1" file="$2" manifest tmp
  manifest="$(manifest_for "$label")"
  carry_forward_records "$manifest"
  if [ "$APPLY" != 1 ]; then
    plan "write $manifest ($(printf '%s' "$manifest_records" | grep -c '^before' || true) key(s) recorded)"
    return
  fi
  tmp="$manifest.tmp.$$"
  {
    printf '# Written by scripts/os-isolation/patch-runner-plists.sh — --revert reads this.\n'
    printf 'schema\t1\n'
    printf 'plist\t%s\n' "$file"
    printf '%s' "$manifest_records"
    printf 'applied-sha256\t%s\n' "$(sha256_of "$file")"
  } > "$tmp"
  mv "$tmp" "$manifest"
}

expected_keys() {
  # The keys this script manages, per label. Kept in one place so apply, revert,
  # and the post-apply re-read cannot drift apart.
  local label="$1"
  if [ "$label" = "$API_LABEL" ]; then
    printf 'RUNNER_WORKSPACE_ROOT RUNNER_RUN_AS_PREFIX'
  else
    printf 'RUNNER_RUN_AS_PREFIX RUNNER_HOME RUNNER_WORKSPACE_ROOT RUNNER_MCP_SERVER_PATH RUNNER_PI_EXTENSION_PATH RUNNER_CLAUDE_SETTINGS_PATH RUNNER_SESSION_CONFIG_BASELINE_ROOT RUNNER_PATH'
  fi
}

if [ "$REVERT" = 1 ]; then
  step "revert pre-flight: has anything moved since the patch?"
  # Checked for every label before the first write. A revert that stops halfway
  # leaves some runners isolated and some not, which is the one state neither
  # this script nor verify.sh can describe in a single sentence.
  for label in "${targets[@]:-}" "$API_LABEL"; do
    [ -n "$label" ] || continue
    file="$AGENT_DIR/$label.plist"
    manifest="$(manifest_for "$label")"
    [ -f "$file" ] || continue
    if [ "$(sha256_of "$file")" != "$(awk -F'\t' '$1 == "applied-sha256" { print $2 }' "$manifest")" ]; then
      # Expected on a long-lived host, and the reason this is field-level: the
      # unrelated changes stay, only the recorded keys go back.
      ok "$label has changed since it was patched; reverting only the recorded keys"
    fi
    while IFS=$'\t' read -r kind key value; do
      [ "$kind" = "after" ] || continue
      current="$(buddy_get "$file" "$key")"
      if [ "$current" != "$value" ]; then
        if [ "$FORCE" = 1 ]; then
          warn "$label: $key is '${current:-<unset>}', not the '$value' this script wrote — reverting anyway (--force)"
        else
          fail "$label: $key is '${current:-<unset>}', not the '$value' this script wrote; someone changed it deliberately. Re-run with --force to revert it anyway."
        fi
      fi
    done < "$manifest"
  done
  if [ "$failures" -gt 0 ]; then
    echo
    echo "$failures managed key(s) no longer hold the value this script wrote. Nothing was changed." >&2
    echo "Either restore those keys, or re-run with --force to revert them anyway." >&2
    exit 1
  fi

  step "field-level revert"
  for label in "${targets[@]:-}" "$API_LABEL"; do
    [ -n "$label" ] || continue
    file="$AGENT_DIR/$label.plist"
    manifest="$(manifest_for "$label")"
    [ -f "$file" ] || continue
    while IFS=$'\t' read -r kind key state value; do
      [ "$kind" = "before" ] || continue
      if [ "$state" = "absent" ]; then
        if buddy_has "$file" "$key"; then
          run "$PLIST_BUDDY" -c "Delete :EnvironmentVariables:$key" "$file"
          changed=$((changed + 1))
        else
          ok "$label: $key is already gone"
        fi
      elif buddy_has "$file" "$key"; then
        run "$PLIST_BUDDY" -c "Set :EnvironmentVariables:$key $value" "$file"
        changed=$((changed + 1))
      else
        run "$PLIST_BUDDY" -c "Add :EnvironmentVariables:$key string $value" "$file"
        changed=$((changed + 1))
      fi
    done < "$manifest"
    labels_touched+=("$label")
  done

  if [ "$APPLY" = 1 ]; then
    step "re-read after revert"
    for label in "${labels_touched[@]:-}"; do
      [ -n "$label" ] || continue
      file="$AGENT_DIR/$label.plist"
      manifest="$(manifest_for "$label")"
      plutil -lint "$file" >/dev/null 2>&1 || fail "$label is no longer a valid plist"
      while IFS=$'\t' read -r kind key state value; do
        [ "$kind" = "before" ] || continue
        current="$(buddy_get "$file" "$key")"
        if [ "$state" = "absent" ]; then
          if buddy_has "$file" "$key"; then fail "$label: $key should have been deleted but is '$current'"; fi
        else
          [ "$current" = "$value" ] || fail "$label: $key should be '$value' but is '${current:-<unset>}'"
        fi
      done < "$manifest"
      # The manifest describes a patch that no longer exists. Keeping it would
      # make the next --revert undo a rollout that never happened.
      mv "$manifest" "$manifest.reverted"
      ok "$label reverted; record kept at $(basename "$manifest").reverted"
    done
  fi
else
  for i in $(seq 1 "$RUNNER_COUNT"); do
    label="$(label_for "$i")"
    account="$(account_for "$i")"
    file="$AGENT_DIR/$label.plist"
    manifest="$(manifest_for "$label")"
    step "$label -> $account"
    manifest_records=""
    backup "$file"
    # -E is required: sudo's env_reset would otherwise strip the session and
    # fencing tokens, the API URL, and every injected secret from the CLI's
    # environment. It is only honoured because the sudoers rule carries SETENV.
    set_env "$file" "$label" RUNNER_RUN_AS_PREFIX "sudo -u $account -E --" "$manifest"
    # The launched account's own home, so its CLI credentials are its own.
    set_env "$file" "$label" RUNNER_HOME "$HOME_BASE/$account" "$manifest"
    # Off the operator's home: macOS homes are 0700, so no runner account can
    # traverse into one to reach the old default root.
    set_env "$file" "$label" RUNNER_WORKSPACE_ROOT "$WORKSPACE_ROOT" "$manifest"
    # The CLI spawns these itself, as the runner account, so they have to be
    # readable by it. provision.sh stages root-owned copies.
    set_env "$file" "$label" RUNNER_MCP_SERVER_PATH "$LIB_DIR/mcp-server.js" "$manifest"
    set_env "$file" "$label" RUNNER_PI_EXTENSION_PATH "$LIB_DIR/pi-agentos-extension.ts" "$manifest"
    set_env "$file" "$label" RUNNER_CLAUDE_SETTINGS_PATH "$LIB_DIR/claude-platform-settings.json" "$manifest"
    set_env "$file" "$label" RUNNER_SESSION_CONFIG_BASELINE_ROOT "$LIB_DIR/session-config-baseline" "$manifest"
    if [ -f "$BIN_DIR/codex-with-proxy.sh" ] && [ -n "$(buddy_get "$file" CODEX_BINARY)" ]; then
      set_env "$file" "$label" CODEX_BINARY "$BIN_DIR/codex-with-proxy.sh" "$manifest"
    fi
    runner_path="$(buddy_get "$file" RUNNER_PATH)"
    case ":$runner_path:" in
      *":$BIN_DIR:"*) ok "$label: RUNNER_PATH already includes $BIN_DIR" ;;
      *) set_env "$file" "$label" RUNNER_PATH "$BIN_DIR${runner_path:+:$runner_path}" "$manifest" ;;
    esac
    # Entries under the operator's home are unreadable by the runner account
    # (macOS homes are 0700), so a CLI installed only there resolves to
    # BINARY_NOT_FOUND on the first task. verify.sh proves this per account;
    # here it is only a hint, because the fix is to move the binary.
    for entry in $(printf '%s' "$runner_path" | tr ':' ' '); do
      case "$entry" in
        "$HOME"/*) warn "$label: RUNNER_PATH entry $entry is inside $HOME and $account cannot read it" ;;
      esac
    done
    write_manifest "$label" "$file"
    labels_touched+=("$label")
  done

  step "$API_LABEL"
  manifest_records=""
  backup "$api_plist"
  set_env "$api_plist" "$API_LABEL" RUNNER_WORKSPACE_ROOT "$WORKSPACE_ROOT" "$(manifest_for "$API_LABEL")"
  # Advisory only: the API reads this to decide whether to warn that
  # FilesystemGrant has no OS backstop (packages/api/src/files/config.ts).
  set_env "$api_plist" "$API_LABEL" RUNNER_RUN_AS_PREFIX "sudo -u $(account_for 1) -E --" "$(manifest_for "$API_LABEL")"
  write_manifest "$API_LABEL" "$api_plist"
  labels_touched+=("$API_LABEL")

  if [ "$APPLY" = 1 ]; then
    step "re-read after apply"
    # Re-read from disk rather than trusting the writes: PlistBuddy reports
    # nothing useful on a partial failure, and "Applied." is what the runbook
    # treats as the step being done.
    for i in $(seq 1 "$RUNNER_COUNT"); do
      label="$(label_for "$i")"
      account="$(account_for "$i")"
      file="$AGENT_DIR/$label.plist"
      plutil -lint "$file" >/dev/null 2>&1 || fail "$label is no longer a valid plist"
      [ -f "$file$BACKUP_SUFFIX" ] || fail "$label has no $BACKUP_SUFFIX backup"
      [ -f "$(manifest_for "$label")" ] || fail "$label has no manifest; --revert would not know what to undo"
      for key in $(expected_keys "$label"); do
        current="$(buddy_get "$file" "$key")"
        case "$key" in
          RUNNER_RUN_AS_PREFIX)     want="sudo -u $account -E --" ;;
          RUNNER_HOME)              want="$HOME_BASE/$account" ;;
          RUNNER_WORKSPACE_ROOT)    want="$WORKSPACE_ROOT" ;;
          RUNNER_MCP_SERVER_PATH)   want="$LIB_DIR/mcp-server.js" ;;
          RUNNER_PI_EXTENSION_PATH) want="$LIB_DIR/pi-agentos-extension.ts" ;;
          RUNNER_CLAUDE_SETTINGS_PATH) want="$LIB_DIR/claude-platform-settings.json" ;;
          RUNNER_SESSION_CONFIG_BASELINE_ROOT) want="$LIB_DIR/session-config-baseline" ;;
          RUNNER_PATH)              want="" ;;
        esac
        if [ "$key" = RUNNER_PATH ]; then
          case ":$current:" in
            *":$BIN_DIR:"*) ;;
            *) fail "$label: RUNNER_PATH does not include $BIN_DIR" ;;
          esac
        elif [ "$current" != "$want" ]; then
          fail "$label: $key is '${current:-<unset>}' after the write, expected '$want'"
        fi
      done
    done
    plutil -lint "$api_plist" >/dev/null 2>&1 || fail "$API_LABEL is no longer a valid plist"
    api_root="$(buddy_get "$api_plist" RUNNER_WORKSPACE_ROOT)"
    [ "$api_root" = "$WORKSPACE_ROOT" ] || fail "$API_LABEL: RUNNER_WORKSPACE_ROOT is '${api_root:-<unset>}', expected $WORKSPACE_ROOT"
    if [ "$failures" -eq 0 ]; then ok "every managed key re-read from disk with the expected value"; fi
  fi
fi

step "next steps (not done here)"
echo "  Drain first: no run may be active. Then, for each label:"
for label in "${labels_touched[@]:-}"; do
  [ -n "$label" ] || continue
  echo "    launchctl bootout gui/\$(id -u)/$label 2>/dev/null || true"
  echo "    launchctl bootstrap gui/\$(id -u) $AGENT_DIR/$label.plist"
done
echo "  Reload the API first — it canonicalises the root and holds the ownership"
echo "  lock — then the runners. To reverse, re-run with --revert."
echo "  Then: scripts/os-isolation/verify.sh --probe   (it checks the LOADED environment)"

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures problem(s) found after writing — the plists are in a partial state. Do not reload anything." >&2
  if [ "$REVERT" = 1 ]; then
    echo "Compare each label against its .manifest.reverted record before touching launchd." >&2
  else
    echo "Fix the cause and re-run, or undo with --revert --apply." >&2
  fi
  exit 1
fi
if [ "$APPLY" = 1 ]; then
  echo "Applied ($changed value(s) written, every one re-read and confirmed)."
else
  echo "Dry run only (pre-flight passed). Re-run with --apply to write these changes."
fi
