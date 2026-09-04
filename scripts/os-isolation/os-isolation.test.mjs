import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIR, "../..");
const ISOLATION_DIR = join(REPOSITORY_ROOT, "scripts", "os-isolation");
const ISOLATION_SCRIPTS = [
  "provision.sh",
  "verify.sh",
  "rollback.sh",
  "patch-runner-plists.sh",
  "reclaim-orphan-workspaces.sh",
];
const PROBE_REMOTE_NAMES = [
  "AGENTOS_PROBE_REMOTE",
  "AGENTOS_VERIFY_REMOTE",
  "AGENTOS_VERIFY_PRIVATE_REMOTE",
  "AGENTOS_PRIVATE_REMOTE",
  "VERIFY_PRIVATE_REMOTE",
  "PROBE_REMOTE",
  "PRIVATE_REMOTE",
  "REPO_REMOTE",
];

const currentUser = () => spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();

const writeExecutable = (path, contents) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
};

const writeShim = (binDir, name, body, logName = name) => {
  const script = [
    "#!/bin/bash",
    "set -u",
    "printf '%s\\t' " + JSON.stringify(logName) + " >> \"$STUB_LOG\"",
    "printf '%s\\t' \"$@\" >> \"$STUB_LOG\"",
    "printf '\\n' >> \"$STUB_LOG\"",
    body,
    "",
  ].join("\n");
  writeExecutable(join(binDir, name), script);
};

const runScript = (name, args = [], environment = {}) => {
  const result = spawnSync("bash", [join(ISOLATION_DIR, name), ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: 60000,
    killSignal: "SIGKILL",
    env: { ...process.env, ...environment },
  });
  return {
    ...result,
    output: (result.stdout || "") + (result.stderr || ""),
  };
};

const snapshotTree = (root, ignored = new Set()) => {
  const rows = [];
  const visit = (path, prefix) => {
    for (const entry of readdirSync(path).sort()) {
      const child = join(path, entry);
      const relativePath = prefix ? prefix + "/" + entry : entry;
      if (ignored.has(relativePath)) continue;
      const stat = lstatSync(child);
      if (stat.isDirectory()) {
        rows.push(relativePath + "|dir|" + (stat.mode & 0o7777));
        visit(child, relativePath);
      } else if (stat.isFile()) {
        rows.push(relativePath + "|file|" + (stat.mode & 0o7777) + "|" + readFileSync(child).toString("base64"));
      } else {
        rows.push(relativePath + "|other|" + (stat.mode & 0o7777));
      }
    }
  };
  visit(root, "");
  return rows;
};

const makeProvisionFixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "agentos-os-provision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDir = join(root, "bin");
  const log = join(root, "calls.log");
  const tmp = join(root, "tmp");
  const prefix = join(root, "prefix");
  const repo = join(root, "repo");
  const homes = join(root, "homes");
  const workspace = join(root, "workspace");
  const manifest = join(root, "manifest");
  const sudoers = join(root, "sudoers");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(log, "");
  for (const path of [
    "packages/runner/dist/mcp-server.js",
    "packages/runner/assets/pi-agentos-extension.ts",
    "deploy/codex-with-proxy.sh",
    "packages/runner/assets/claude-platform-settings.json",
    "packages/runner/assets/session-config-baseline/codex/config.toml",
  ]) {
    const file = join(repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture\n");
  }

  writeShim(binDir, "getent", "exit 2");
  writeShim(
    binDir,
    "visudo",
    [
      'case "$1 $2" in',
      '  "-c -f") [ -f "$3" ] || exit 1 ;;',
      "  *) exit 1 ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );
  writeShim(binDir, "mktemp", 'case "$1" in *.XXXXXX) exec /usr/bin/mktemp "$@" ;; *) exit 1 ;; esac');
  for (const name of [
    "stat",
    "systemctl",
    "useradd",
    "groupadd",
    "install",
    "dscl",
    "dseditgroup",
    "PlistBuddy",
    "launchctl",
  ]) {
    writeShim(binDir, name, "exit 0");
  }

  const environment = {
    AGENTOS_SERVICE_PLATFORM: "linux",
    ACCOUNT_COUNT: "8",
    ACCOUNT_PREFIX: "fixture-account-",
    GROUP_NAME: "fixture-runners",
    GROUP_GID: "620",
    BASE_UID: "620",
    ACCOUNT_SHELL: "/bin/bash",
    AGENTOS_PREFIX: prefix,
    REPO_ROOT: repo,
    HOME_BASE: homes,
    WORKSPACE_ROOT: workspace,
    MANIFEST_DIR: manifest,
    SUDOERS_FILE: sudoers,
    LAUNCHER_USER: "fixture-operator",
    TMPDIR: tmp,
    STUB_LOG: log,
    PATH: binDir + ":" + (process.env.PATH || ""),
  };
  return { root, log, environment };
};

const makeLinuxFixture = (t, { runnerCount = 10, accountCount = 8 } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "agentos-os-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDir = join(root, "bin");
  const log = join(root, "calls.log");
  const prefix = join(root, "prefix");
  const homes = join(root, "homes");
  const workspace = join(root, "workspace");
  const repo = join(root, "repo");
  const tmp = join(root, "tmp");
  const sudoers = join(root, "sudoers");
  const accountPrefix = "fixture-account-";
  const groupName = "fixture-runners";
  const launcher = currentUser();
  const wrapper = join(root, "agentos-service-wrapper.mjs");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(prefix, "lib", "session-config-baseline", "codex"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  chmodSync(workspace, 0o1770);
  writeFileSync(log, "");
  writeFileSync(sudoers, "fixture sudoers\n");
  chmodSync(sudoers, 0o440);
  writeFileSync(join(prefix, "lib", "mcp-server.js"), "fixture\n");
  writeFileSync(join(prefix, "lib", "pi-agentos-extension.ts"), "fixture\n");
  writeFileSync(join(prefix, "lib", "claude-platform-settings.json"), "{}\n");
  writeFileSync(join(prefix, "lib", "session-config-baseline", "codex", "config.toml"), "fixture\n");

  const accounts = Array.from({ length: accountCount }, (_, index) => accountPrefix + (index + 1));
  for (const account of accounts) {
    const home = join(homes, account);
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    chmodSync(home, 0o700);
    writeFileSync(join(home, ".codex", "auth.json"), "codex credential\n");
    writeFileSync(join(home, ".pi", "agent", "auth.json"), "pi credential\n");
    chmodSync(join(home, ".codex", "auth.json"), 0o600);
    chmodSync(join(home, ".pi", "agent", "auth.json"), 0o600);
  }

  writeShim(
    binDir,
    "getent",
    [
      'kind="$1"',
      'key="$2"',
      'if [ "$kind" = group ]; then',
      '  if [ "$key" = "$FIXTURE_GROUP_NAME" ]; then',
      '    printf "%s:x:%s:%s\\n" "$FIXTURE_GROUP_NAME" "$FIXTURE_GROUP_GID" "$FIXTURE_MEMBERS"',
      "    exit 0",
      "  fi",
      '  case "$key" in sudo|adm|wheel) exit 2 ;; esac',
      "  exit 2",
      "fi",
      'if [ "$kind" = passwd ]; then',
      '  account="$key"',
      '  case "$account" in',
      '    "$FIXTURE_ACCOUNT_PREFIX"[0-9]*) ;;',
      "    *) exit 2 ;;",
      "  esac",
      '  index=$(printf "%s" "$account" | sed "s#^$FIXTURE_ACCOUNT_PREFIX##")',
      '  case "$index" in ""|*[!0-9]*) exit 2 ;; esac',
      '  [ "$index" -ge 1 ] && [ "$index" -le "$FIXTURE_ACCOUNT_COUNT" ] || exit 2',
      "  uid=$((FIXTURE_BASE_UID + index - 1))",
      '  printf "%s:x:%s:%s::%s/%s:/bin/bash\\n" "$account" "$uid" "$FIXTURE_GROUP_GID" "$FIXTURE_HOME_BASE" "$account"',
      "  exit 0",
      "fi",
      "exit 2",
    ].join("\n"),
  );
  writeShim(
    binDir,
    "stat",
    [
      'format="$2"',
      'path="$3"',
      'if [ "$format" = "%a" ] && [ "$path" = "$STAT_MODE_OVERRIDE" ]; then printf "%s\\n" "$STAT_MODE_VALUE"; exit 0; fi',
      'if [ "$format" = "%U" ] && [ "$path" = "$STAT_OWNER_OVERRIDE" ]; then printf "%s\\n" "$STAT_OWNER_VALUE"; exit 0; fi',
      'case "$path" in',
      '  "$FIXTURE_WORKSPACE")',
      '    [ "$format" = "%a" ] && printf "1770\\n"',
      '    [ "$format" = "%U" ] && printf "%s\\n" "$FIXTURE_LAUNCHER_USER"',
      '    [ "$format" = "%G" ] && printf "%s\\n" "$FIXTURE_GROUP_NAME"',
      "    ;;",
      '  "$FIXTURE_SUDOERS")',
      '    [ "$format" = "%a" ] && printf "440\\n"',
      '    [ "$format" = "%U" ] && printf "root\\n"',
      "    ;;",
      '  "$FIXTURE_HOME_BASE"/*)',
      '    relative=$(printf "%s" "$path" | sed "s#^$FIXTURE_HOME_BASE/##")',
      '    account=$(printf "%s" "$relative" | cut -d/ -f1)',
      '    remainder=$(printf "%s" "$relative" | cut -d/ -f2-)',
      '    if [ "$remainder" = "$relative" ]; then',
      '      [ "$format" = "%a" ] && printf "700\\n"',
      '      [ "$format" = "%U" ] && printf "%s\\n" "$account"',
      "    else",
      '      [ "$format" = "%a" ] && printf "600\\n"',
      '      [ "$format" = "%U" ] && printf "%s\\n" "$account"',
      "    fi",
      "    ;;",
      "  *)",
      '    [ "$format" = "%a" ] && printf "644\\n"',
      '    [ "$format" = "%U" ] && printf "root\\n"',
      '    [ "$format" = "%G" ] && printf "root\\n"',
      "    ;;",
      "esac",
    ].join("\n"),
  );
  writeShim(
    binDir,
    "systemctl",
    [
      'command="$1"',
      'if [ "$command" = is-active ]; then',
      '  printf "%s\\n" "$FIXTURE_ACTIVE_STATE"',
      '  [ "$FIXTURE_ACTIVE_STATE" = active ]',
      "  exit $?",
      "fi",
      'if [ "$command" != show ]; then exit 2; fi',
      'property=""',
      'unit=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -p) property="$2"; shift 2 ;;',
      "    --value) shift ;;",
      '    *) unit="$1"; shift ;;',
      "  esac",
      "done",
      'case "$property" in',
      '  NeedDaemonReload) printf "%s\\n" "$FIXTURE_NEED_RELOAD" ;;',
      "  ExecStart)",
      '    label=$(printf "%s" "$unit" | sed "s/\\.service$//")',
      '    printf "%s %s\\n" "$FIXTURE_WRAPPER_PATH" "$label"',
      "    ;;",
      "  Environment)",
      '    label=$(printf "%s" "$unit" | sed "s/\\.service$//")',
      '    if [ "$label" = com.agentos.api ]; then',
      '      account="$FIXTURE_ACCOUNT_PREFIX"1',
      '      printf "RUNNER_WORKSPACE_ROOT=%s RUNNER_RUN_AS_PREFIX=sudo -u %s -E -- RUNNER_HOME=%s/%s RUNNER_REPO_MIRROR_ROOT=%s/%s/.agentos/repo-mirrors\\n" "$FIXTURE_WORKSPACE" "$account" "$FIXTURE_HOME_BASE" "$account" "$FIXTURE_HOME_BASE" "$account"',
      "    else",
      '      case "$label" in',
      '        com.agentos.runner) index=1 ;;',
      '        com.agentos.runner-*) index=$(printf "%s" "$label" | sed "s/.*-//") ;;',
      '        *) index=1 ;;',
      '      esac',
      "      account_id=$(( (index - 1) % FIXTURE_ACCOUNT_COUNT + 1 ))",
      "      account=$FIXTURE_ACCOUNT_PREFIX$account_id",
      '      printf "RUNNER_RUN_AS_PREFIX=sudo -u %s -E -- RUNNER_HOME=%s/%s RUNNER_WORKSPACE_ROOT=%s RUNNER_MCP_SERVER_PATH=%s/lib/mcp-server.js RUNNER_PI_EXTENSION_PATH=%s/lib/pi-agentos-extension.ts RUNNER_CLAUDE_SETTINGS_PATH=%s/lib/claude-platform-settings.json RUNNER_SESSION_CONFIG_BASELINE_ROOT=%s/lib/session-config-baseline RUNNER_PATH=/usr/bin\\n" "$account" "$FIXTURE_HOME_BASE" "$account" "$FIXTURE_WORKSPACE" "$FIXTURE_PREFIX" "$FIXTURE_PREFIX" "$FIXTURE_PREFIX" "$FIXTURE_PREFIX"',
      "    fi",
      "    ;;",
      "  *) exit 2 ;;",
      "esac",
    ].join("\n"),
  );
  writeShim(
    binDir,
    "sudo",
    [
      '[ "$1" = -n ] && shift',
      'account=""',
      'if [ "$1" = -u ]; then account="$2"; shift 2; fi',
      '[ "$1" = -E ] && shift',
      'command="$1"',
      "shift || true",
      "credential_owner() {",
      '  case "$1" in',
      '    "$FIXTURE_HOME_BASE"/*) relative=$(printf "%s" "$1" | sed "s#^$FIXTURE_HOME_BASE/##"); printf "%s\\n" "$(printf "%s" "$relative" | cut -d/ -f1)" ;;',
      "  esac",
      "}",
      'case "$command" in',
      "  /usr/bin/true) exit 0 ;;",
      "  /bin/test)",
      '    if [ "$1" = -r ]; then',
      '      path="$2"; owner=$(credential_owner "$path")',
      '      [ -z "$owner" ] || [ "$owner" = "$account" ] || [ "$path" = "$SUDO_CREDENTIAL_BYPASS" ] || exit 1',
      "      exit 0",
      "    fi",
      "    ;;",
      "  /usr/bin/env) exit 0 ;;",
      "  /bin/sh)",
      '    [ "$1" = -c ] || exit 1',
      '    script="$2"',
      '    case "$script" in',
      '      *"command -v"*) exit 0 ;;',
      '      mkdir\\ -p*) /bin/sh -c "$script"; exit $? ;;',
      "      *) exit 0 ;;",
      "    esac",
      "    ;;",
      "  /bin/rm)",
      '    target="$2"',
      '    case "$target" in',
      '      *agentos-isolation-probe-*) index=$(printf "%s" "$target" | sed "s/.*-//"); account_index=$(printf "%s" "$account" | sed "s/.*-//"); [ "$index" = "$account_index" ] && /bin/rm "$@" || exit 1 ;;',
      "      *) exit 1 ;;",
      "    esac",
      "    ;;",
      "  /bin/mv|/bin/ls) exit 1 ;;",
      '  git|gh) exec "$command" "$@" ;;',
      '  *) "$command" "$@" ;;',
      "esac",
    ].join("\n"),
  );
  writeShim(binDir, "git", "exit $FIXTURE_LIVE_FAIL");
  writeShim(binDir, "gh", "exit $FIXTURE_LIVE_FAIL");

  const environment = {
    AGENTOS_SERVICE_PLATFORM: "linux",
    ACCOUNT_COUNT: String(accountCount),
    AGENTOS_RUNNER_COUNT: String(runnerCount),
    ACCOUNT_PREFIX: accountPrefix,
    GROUP_NAME: groupName,
    GROUP_GID: "620",
    BASE_UID: "620",
    AGENTOS_PREFIX: prefix,
    HOME_BASE: homes,
    WORKSPACE_ROOT: workspace,
    SUDOERS_FILE: sudoers,
    LAUNCHER_USER: launcher,
    REPO_ROOT: repo,
    WRAPPER_PATH: wrapper,
    SYSTEMCTL_BIN: "systemctl",
    STUB_LOG: log,
    FIXTURE_ACCOUNT_PREFIX: accountPrefix,
    FIXTURE_ACCOUNT_COUNT: String(accountCount),
    FIXTURE_GROUP_NAME: groupName,
    FIXTURE_GROUP_GID: "620",
    FIXTURE_BASE_UID: "620",
    FIXTURE_HOME_BASE: homes,
    FIXTURE_WORKSPACE: workspace,
    FIXTURE_SUDOERS: sudoers,
    FIXTURE_LAUNCHER_USER: launcher,
    FIXTURE_PREFIX: prefix,
    FIXTURE_WRAPPER_PATH: wrapper,
    FIXTURE_ACTIVE_STATE: "active",
    FIXTURE_NEED_RELOAD: "no",
    FIXTURE_LIVE_FAIL: "0",
    STAT_MODE_OVERRIDE: "",
    STAT_MODE_VALUE: "000",
    STAT_OWNER_OVERRIDE: "",
    STAT_OWNER_VALUE: "wrong-owner",
    SUDO_CREDENTIAL_BYPASS: "",
    PATH: binDir + ":" + (process.env.PATH || ""),
    TMPDIR: tmp,
  };
  environment.FIXTURE_MEMBERS = accounts.join(",");
  for (const name of PROBE_REMOTE_NAMES) delete environment[name];
  return {
    root,
    log,
    prefix,
    homes,
    workspace,
    sudoers,
    accounts,
    environment,
    credential(account, provider = "codex") {
      return provider === "codex"
        ? join(homes, account, ".codex", "auth.json")
        : join(homes, account, ".pi", "agent", "auth.json");
    },
  };
};

test("all os-isolation scripts remain valid Bash on both supported platforms", () => {
  for (const platform of ["darwin", "linux"]) {
    for (const script of ISOLATION_SCRIPTS) {
      const result = spawnSync("bash", ["-n", join(ISOLATION_DIR, script)], {
        encoding: "utf8",
        env: { ...process.env, AGENTOS_SERVICE_PLATFORM: platform },
      });
      assert.equal(result.status, 0, platform + " " + script + ": " + result.stderr);
    }
  }
});

test("Linux provision dry-run plans eight accounts without Darwin tools or mutation", (t) => {
  const fixture = makeProvisionFixture(t);
  const before = snapshotTree(fixture.root, new Set(["calls.log"]));
  const result = runScript("provision.sh", ["--dry-run"], fixture.environment);
  const after = snapshotTree(fixture.root, new Set(["calls.log"]));
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(after, before, "dry-run changed the fixture tree");
  for (let uid = 620; uid <= 627; uid += 1) {
    assert.match(result.stdout, new RegExp("PLAN\\s+useradd -u " + uid + " .* -M"));
  }
  const homePlans = result.stdout.split("\n").filter((line) => /PLAN\s+install -d/u.test(line) && line.includes("/homes/"));
  assert.equal(homePlans.length, 8, result.stdout);
  for (const line of homePlans) assert.match(line, /-m 700\b/u);
  assert.match(result.stdout, /Runas_Alias AGENTOS_RUNNERS/u);
  assert.match(result.stdout, /NOPASSWD: SETENV: ALL/u);
  assert.match(readFileSync(fixture.log, "utf8"), /visudo\t-c\t-f\t/u);
  assert.doesNotMatch(result.output, /\b(?:dscl|dseditgroup|PlistBuddy|launchctl)\b/u);
  assert.doesNotMatch(readFileSync(fixture.log, "utf8"), /\b(?:dscl|dseditgroup|PlistBuddy|launchctl)\b/u);
});

test("Linux verify rejects a unit that still needs daemon-reload", (t) => {
  const fixture = makeLinuxFixture(t, { runnerCount: 2, accountCount: 2 });
  const result = runScript("verify.sh", [], { ...fixture.environment, FIXTURE_NEED_RELOAD: "yes" });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /systemd-daemon-reload-required:/u);
});

test("Linux verify rejects insecure homes, credentials, ownership, and cross-account reads", (t) => {
  const fixture = makeLinuxFixture(t, { runnerCount: 2, accountCount: 2 });
  const firstHome = join(fixture.homes, fixture.accounts[0]);
  const firstCredential = fixture.credential(fixture.accounts[0]);
  for (const mode of ["0750", "0755"]) {
    const result = runScript("verify.sh", [], {
      ...fixture.environment,
      STAT_MODE_OVERRIDE: firstHome,
      STAT_MODE_VALUE: mode,
    });
    assert.notEqual(result.status, 0, "mode " + mode + " unexpectedly passed");
    assert.match(result.output, /expected 700/u);
  }
  const badCredentialMode = runScript("verify.sh", [], {
    ...fixture.environment,
    STAT_MODE_OVERRIDE: firstCredential,
    STAT_MODE_VALUE: "0644",
  });
  assert.notEqual(badCredentialMode.status, 0);
  assert.match(badCredentialMode.output, /expected 600/u);

  const badOwner = runScript("verify.sh", [], {
    ...fixture.environment,
    STAT_OWNER_OVERRIDE: firstCredential,
    STAT_OWNER_VALUE: fixture.accounts[1],
  });
  assert.notEqual(badOwner.status, 0);
  assert.match(badOwner.output, /is owned by .*expected/u);

  const crossAccountRead = runScript("verify.sh", [], {
    ...fixture.environment,
    SUDO_CREDENTIAL_BYPASS: firstCredential,
  });
  assert.notEqual(crossAccountRead.status, 0);
  assert.match(crossAccountRead.output, /can read .*credential/u);
});

test("Linux verify --probe names skipped live checks without a remote and fails live credential checks", (t) => {
  const fixture = makeLinuxFixture(t, { runnerCount: 2, accountCount: 2 });
  const skipped = runScript("verify.sh", ["--probe"], fixture.environment);
  assert.equal(skipped.status, 0, skipped.output);
  assert.match(skipped.output, /git ls-remote skipped: no private remote configured/u);
  assert.match(skipped.output, /gh auth status skipped: no private remote configured/u);
  assert.match(skipped.output, /probe-remote-unset/u);

  const liveFailure = runScript("verify.sh", ["--probe"], {
    ...fixture.environment,
    AGENTOS_PROBE_REMOTE: "fixture-private-remote",
    FIXTURE_LIVE_FAIL: "1",
  });
  assert.notEqual(liveFailure.status, 0, liveFailure.output);
  assert.match(liveFailure.output, /git ls-remote failed/u);
  assert.match(liveFailure.output, /gh auth status failed/u);
});

test("Linux patch maps runners to accounts and field-level revert preserves unrecorded drop-in keys", (t) => {
  for (const runnerCount of [10, 16]) {
    const fixture = makeLinuxFixture(t, { runnerCount });
    const staging = join(fixture.root, "staging");
    mkdirSync(staging, { recursive: true });
    const environment = { ...fixture.environment, SYSTEMD_STAGING_DIR: staging };
    const firstResult = runScript("patch-runner-plists.sh", ["--apply"], environment);
    assert.equal(firstResult.status, 0, runnerCount + ": " + firstResult.output);
    for (let index = 1; index <= runnerCount; index += 1) {
      const label = index === 1 ? "com.agentos.runner" : "com.agentos.runner-" + index;
      const account = fixture.accounts[(index - 1) % fixture.accounts.length];
      const dropin = join(staging, label + ".service.d", "os-isolation.conf");
      assert.match(readFileSync(dropin, "utf8"), new RegExp("RUNNER_HOME=.*" + account));
    }
    const firstLabel = "com.agentos.runner";
    const firstDropin = join(staging, firstLabel + ".service.d", "os-isolation.conf");
    const original = readFileSync(firstDropin, "utf8");
    writeFileSync(firstDropin, original + "Environment=UNRECORDED=keep-me\n");
    const revert = runScript("patch-runner-plists.sh", ["--revert", "--apply"], environment);
    assert.equal(revert.status, 0, runnerCount + ": " + revert.output);
    const reverted = readFileSync(firstDropin, "utf8");
    assert.match(reverted, /UNRECORDED=keep-me/u);
    assert.doesNotMatch(reverted, /RUNNER_RUN_AS_PREFIX=/u);
    assert.doesNotMatch(reverted, /RUNNER_HOME=/u);
    assert.ok(existsSync(join(staging, "plist-manifest", firstLabel + ".manifest.reverted")));
  }
});
