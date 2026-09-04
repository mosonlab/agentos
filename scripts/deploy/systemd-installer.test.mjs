import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  autoDeployEnvironmentValues,
  controlledLaunchdPath,
  installLaunchd,
  installLaunchdServices,
  installStagedSystemdAutoDeploy,
  installStagedSystemdServices,
  planSystemdAutoDeploy,
  renderAutoDeploySystemdUnit,
  renderAutoDeploySystemdTimer,
  renderLaunchdPlist,
  renderServiceLaunchdPlist,
  renderServiceSystemdUnit,
  renderSystemdSudoers,
  serviceEnvironmentValues,
  servicePlistValues,
  verifySystemdAutoDeployDefinitions,
  verifySystemdServiceDefinitions,
} from "./install-launchd.mjs";
import { SERVICE_LABELS } from "./launchd-service-wrapper.mjs";

const withLinux = async (work) => {
  const previous = process.env.AGENTOS_SERVICE_PLATFORM;
  process.env.AGENTOS_SERVICE_PLATFORM = "linux";
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.AGENTOS_SERVICE_PLATFORM;
    else process.env.AGENTOS_SERVICE_PLATFORM = previous;
  }
};

const accountLookup = () => "anneal-test:x:620:620::/var/lib/anneal-test:/bin/bash";
const digest = (contents) => createHash("sha256").update(contents).digest("hex");

const spawnServiceInstallerCli = ({ root, args, context }) => {
  const harnessPath = join(root, "service-installer-cli-harness.mjs");
  const recorderPath = join(root, "service-installer-cli-records.jsonl");
  const entrypoint = new URL("./install-launchd-services.mjs", import.meta.url);
  writeFileSync(harnessPath, `
import { appendFileSync } from "node:fs";
import { runServiceInstaller } from ${JSON.stringify(entrypoint.href)};
const config = JSON.parse(process.env.AGENTOS_INSTALLER_TEST_CONTEXT);
process.env.AGENTOS_SERVICE_PLATFORM = "linux";
process.argv[1] = config.entrypoint;
const record = (value) => appendFileSync(config.recorderPath, JSON.stringify(value) + "\\n");
process.exitCode = runServiceInstaller(process.argv.slice(2), {
  ...config.context,
  userLookup: () => "anneal-test:x:620:620::/var/lib/anneal-test:/bin/bash",
  execute: (_command, commandArgs) => { record({ operation: "execute", args: commandArgs }); return ""; },
  chown: (path, uid, gid) => record({ operation: "chown", path, uid, gid }),
});
`);
  const result = spawnSync(process.execPath, [harnessPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTOS_INSTALLER_TEST_CONTEXT: JSON.stringify({
        context,
        entrypoint: entrypoint.pathname,
        recorderPath,
      }),
    },
  });
  const records = existsSync(recorderPath)
    ? readFileSync(recorderPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { ...result, records };
};

const writeSudoPolicyStub = (root) => {
  const path = join(root, "sudo-policy-stub.mjs");
  writeFileSync(path, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const [nonInteractive, ...command] = process.argv.slice(2);
if (nonInteractive !== "-n") process.exit(2);
const policy = readFileSync(process.env.SUDOERS_POLICY, "utf8").trim();
const allowed = new Set(policy.split("NOPASSWD: ")[1].split(", "));
process.exit(allowed.has(command.join(" ")) ? 0 : 1);
`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
};

const unitEnvironmentKeys = (unit) => [...unit.matchAll(/^Environment=([A-Za-z_][A-Za-z0-9_]*)=/gmu)].map((match) => match[1]);

const plistEnvironmentKeys = (plist) => {
  const block = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u)?.[1] ?? "";
  return [...block.matchAll(/<key>([A-Za-z_][A-Za-z0-9_]*)<\/key>/gu)].map((match) => match[1]);
};

test("systemd service units carry the exact plist environment contract", () => {
  const root = join(tmpdir(), "agentos-systemd-fixture");
  const values = SERVICE_LABELS.map((label) => servicePlistValues({
    label,
    nodeBinary: "/usr/bin/node",
    repositoryRoot: root,
    sharedRoot: join(root, "shared"),
    stdoutPath: "/tmp/stdout.log",
    stderrPath: "/tmp/stderr.log",
    path: "/usr/bin:/bin with space:100%",
    wrapperPath: join(root, "shared/bin/agentos-service-wrapper.mjs"),
  }));
  const definitions = Object.fromEntries(values.map((value) => [
    value.label,
    renderServiceSystemdUnit(undefined, { ...value, serviceUser: "anneal-test" }),
  ]));
  assert.equal(verifySystemdServiceDefinitions(definitions), true);
  for (const value of values) {
    const unit = definitions[value.label];
    const plist = renderServiceLaunchdPlist(
      readFileSync(new URL("./com.agentos.service.plist.in", import.meta.url), "utf8"),
      value,
    );
    assert.deepEqual(new Set(unitEnvironmentKeys(unit)), new Set(plistEnvironmentKeys(plist)));
    assert.deepEqual(new Set(unitEnvironmentKeys(unit)), new Set(Object.keys(serviceEnvironmentValues(value))));
    assert.doesNotMatch(unit, /^EnvironmentFile=/mu);
    assert.match(unit, new RegExp(`^ExecStart="/usr/bin/node" .* ${value.label}$`, "mu"));
    assert.match(unit, /PATH=".*%%"/u);
    assert.match(unit, /^User=(?!root$)\S+$/mu);
  }
});

test("auto-deploy units match the plist environment contract in both backup modes", () => {
  const template = readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8");
  const root = join(tmpdir(), "agentos-auto-deploy-fixture");
  for (const backup of [
    { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
    {
      mode: "container",
      dockerBinary: "/usr/bin/docker",
      container: "configured-container",
      pgDumpBinary: "/usr/bin/pg_dump",
    },
  ]) {
    const values = {
      nodeBinary: "/usr/bin/node",
      deployScript: join(root, "current/scripts/deploy/quiet-window-deploy.mjs"),
      repositoryRoot: root,
      stdoutPath: "/tmp/anneal.stdout",
      stderrPath: "/tmp/anneal.stderr",
      path: "/usr/bin:/bin with space:100%",
      gitBinary: "/usr/bin/git",
      npmBinary: "/usr/bin/npm",
      sourceRemote: "configured-remote",
      serviceUser: "anneal-test",
      backup,
    };
    const plist = renderLaunchdPlist(template, values);
    const service = renderAutoDeploySystemdUnit(undefined, values);
    const timer = renderAutoDeploySystemdTimer();
    assert.equal(verifySystemdAutoDeployDefinitions({ service, timer }), true);
    assert.deepEqual(new Set(unitEnvironmentKeys(service)), new Set(plistEnvironmentKeys(plist)));
    assert.deepEqual(new Set(unitEnvironmentKeys(service)), new Set(Object.keys(autoDeployEnvironmentValues(values))));
    assert.doesNotMatch(service, /^EnvironmentFile=/mu);
    assert.match(service, /PATH=".*%%"/u);
  }
});

test("non-default runner count is persisted in service and auto-deploy definitions", () => {
  const root = "/fixture";
  const serviceValues = servicePlistValues({
    label: "com.agentos.runner-16",
    runnerCount: 16,
    nodeBinary: "/usr/bin/node",
    repositoryRoot: root,
    stdoutPath: "/tmp/stdout",
    stderrPath: "/tmp/stderr",
    path: "/usr/bin:/bin",
  });
  const plist = renderServiceLaunchdPlist(
    readFileSync(new URL("./com.agentos.service.plist.in", import.meta.url), "utf8"),
    serviceValues,
  );
  const unit = renderServiceSystemdUnit(undefined, { ...serviceValues, serviceUser: "anneal-test" });
  assert.match(plist, /<key>AGENTOS_RUNNER_COUNT<\/key>\s*<string>16<\/string>/u);
  assert.match(unit, /^Environment=AGENTOS_RUNNER_COUNT="16"$/mu);
  const autoValues = {
    nodeBinary: "/usr/bin/node",
    deployScript: "/fixture/current/scripts/deploy/quiet-window-deploy.mjs",
    repositoryRoot: root,
    stdoutPath: "/tmp/stdout",
    stderrPath: "/tmp/stderr",
    path: "/usr/bin:/bin",
    gitBinary: "/usr/bin/git",
    npmBinary: "/usr/bin/npm",
    sourceRemote: "origin",
    backup: { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
    serviceUser: "anneal-test",
    runnerCount: 16,
  };
  assert.match(renderLaunchdPlist(readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8"), autoValues), /<key>AGENTOS_RUNNER_COUNT<\/key>\s*<string>16<\/string>/u);
  assert.match(renderAutoDeploySystemdUnit(undefined, autoValues), /^Environment=AGENTOS_RUNNER_COUNT="16"$/mu);
});

test("systemd path directives escape whitespace and percent specifiers", () => {
  const root = "/opt/Anneal Runtime 100%";
  const values = servicePlistValues({
    label: "com.agentos.api",
    nodeBinary: "/opt/Node Runtime 100%/node",
    repositoryRoot: root,
    sharedRoot: `${root}/shared`,
    stdoutPath: "/tmp/stdout",
    stderrPath: "/tmp/stderr",
    path: "/usr/bin:/bin",
    wrapperPath: `${root}/shared/bin/agentos-service-wrapper.mjs`,
  });
  const unit = renderServiceSystemdUnit(undefined, { ...values, serviceUser: "anneal-test" });
  assert.match(unit, /^WorkingDirectory=\/opt\/Anneal\\x20Runtime\\x20100%%$/mu);
  assert.match(unit, /^ExecStart="\/opt\/Node Runtime 100%%\/node" "\/opt\/Anneal Runtime 100%%\/shared\/bin\/agentos-service-wrapper\.mjs" com\.agentos\.api$/mu);
});

test("default Darwin render, manifest entries, and plan stdout match 9a52c6ad bytes", () => {
  const previousPlatform = process.env.AGENTOS_SERVICE_PLATFORM;
  const previousCount = process.env.AGENTOS_RUNNER_COUNT;
  process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
  delete process.env.AGENTOS_RUNNER_COUNT;
  try {
    const baseline = JSON.parse(readFileSync(new URL("./fixtures/darwin-9a52c6ad-baseline.json", import.meta.url), "utf8"));
    const root = process.cwd();
    const plan = installLaunchdServices({
      repositoryRoot: root,
      userHome: join(root, "fixture-home"),
      nodeBinary: "/usr/bin/node",
      gitBinary: "/usr/bin/git",
      path: "/usr/bin:/bin",
      effectiveUid: 501,
      apply: false,
    });
    const normalize = (value) => value.replaceAll(root, "<ROOT>");
    const hashes = Object.fromEntries(Object.entries(plan.rendered).map(([label, contents]) => [
      label,
      digest(normalize(contents)),
    ]));
    assert.deepEqual(hashes, baseline.renderedPlistSha256);
    assert.deepEqual(plan.entries.map(normalize), baseline.serviceManifestEntries);
    const autoTemplate = readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8");
    const autoPlist = renderLaunchdPlist(autoTemplate, {
      nodeBinary: "/usr/bin/node",
      deployScript: "/fixture/current/scripts/deploy/quiet-window-deploy.mjs",
      repositoryRoot: "/fixture",
      stdoutPath: "/fixture/stdout",
      stderrPath: "/fixture/stderr",
      path: "/usr/bin:/bin",
      gitBinary: "/usr/bin/git",
      npmBinary: "/usr/bin/npm",
      sourceRemote: "origin",
      backup: { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
    });
    assert.equal(digest(autoPlist), baseline.autoDeployPlistSha256);
    const autoHome = mkdtempSync(join(tmpdir(), "agentos-darwin-auto-home-"));
    const resolvedCommand = (name) => realpathSync(spawnSync("/usr/bin/which", [name], { encoding: "utf8" }).stdout.trim());
    const actualGit = resolvedCommand("git");
    const autoBin = join(autoHome, "bin");
    const autoGitPath = join(autoBin, "git");
    mkdirSync(autoBin);
    writeFileSync(autoGitPath, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.length === 5 && args[0] === "-C" && args.slice(2).join(" ") === "remote get-url origin") {
  process.stdout.write("origin\\n");
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(actualGit)}, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    const autoGit = realpathSync(autoGitPath);
    const autoEntrypoint = spawnSync(process.execPath, [
      "scripts/deploy/install-launchd.mjs",
      "--pg-dump-mode", "host",
      "--pg-dump-binary", "/usr/bin/true",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTOS_SERVICE_PLATFORM: "darwin",
        HOME: autoHome,
        // Gate worktrees need not have an origin; the shim supplies the frozen
        // baseline value and delegates every other Git command.
        PATH: `${autoBin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(autoEntrypoint.status, 0, autoEntrypoint.stderr);
    const autoNode = realpathSync(process.execPath);
    const autoNpm = resolvedCommand("npm");
    const autoPath = controlledLaunchdPath({ nodeBinary: autoNode, gitBinary: autoGit });
    const normalizeAuto = (value) => value
      .replaceAll(autoPath, "<CONTROLLED_PATH>")
      .replaceAll(autoNode, "<NODE>")
      .replaceAll(autoGit, "<GIT>")
      .replaceAll(autoNpm, "<NPM>")
      .replaceAll(autoHome, "<HOME>")
      .replaceAll(root, "<ROOT>");
    const normalizedAutoStdout = normalizeAuto(autoEntrypoint.stdout);
    assert.equal(normalizedAutoStdout, baseline.autoDeployPlanStdout);
    assert.deepEqual(
      normalizedAutoStdout.match(/^PLAN destination=(.*)$/mu)?.slice(1) ?? [],
      baseline.autoDeployManifestEntries,
    );
    rmSync(autoHome, { recursive: true, force: true });
    const entrypoint = spawnSync(process.execPath, ["scripts/deploy/install-launchd-services.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, AGENTOS_SERVICE_PLATFORM: "darwin" },
    });
    assert.equal(entrypoint.status, 0, entrypoint.stderr);
    assert.equal(normalize(entrypoint.stdout), baseline.servicePlanStdout);
  } finally {
    if (previousPlatform === undefined) delete process.env.AGENTOS_SERVICE_PLATFORM;
    else process.env.AGENTOS_SERVICE_PLATFORM = previousPlatform;
    if (previousCount === undefined) delete process.env.AGENTOS_RUNNER_COUNT;
    else process.env.AGENTOS_RUNNER_COUNT = previousCount;
  }
});

test("rendered unit syntax is verified by systemd-analyze when available", (t) => {
  const available = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") {
    t.skip("systemd-analyze unavailable on this host");
    return;
  }
  assert.equal(available.status, 0, available.stderr);
  const root = mkdtempSync(join(tmpdir(), "agentos-systemd-analyze-"));
  try {
    const wrapper = join(root, "agentos-service-wrapper.mjs");
    writeFileSync(wrapper, "#!/usr/bin/env node\n", { mode: 0o755 });
    const serviceUser = process.env.USER && process.env.USER !== "root" ? process.env.USER : "nobody";
    const values = SERVICE_LABELS.map((label) => servicePlistValues({
      label,
      nodeBinary: process.execPath,
      repositoryRoot: root,
      sharedRoot: join(root, "shared"),
      stdoutPath: join(root, "stdout"),
      stderrPath: join(root, "stderr"),
      path: "/usr/bin:/bin",
      wrapperPath: wrapper,
    }));
    const files = [];
    for (const value of values) {
      const path = join(root, `${value.label}.service`);
      writeFileSync(path, renderServiceSystemdUnit(undefined, { ...value, serviceUser }));
      files.push(path);
    }
    const autoValues = {
      nodeBinary: process.execPath,
      deployScript: wrapper,
      repositoryRoot: root,
      path: "/usr/bin:/bin",
      gitBinary: "/usr/bin/git",
      npmBinary: "/usr/bin/npm",
      sourceRemote: "configured-remote",
      serviceUser,
      backup: { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
    };
    const autoService = join(root, "com.agentos.auto-deploy.service");
    const autoTimer = join(root, "com.agentos.auto-deploy.timer");
    writeFileSync(autoService, renderAutoDeploySystemdUnit(undefined, autoValues));
    writeFileSync(autoTimer, renderAutoDeploySystemdTimer());
    files.push(autoService, autoTimer);
    for (const path of files) {
      const verified = spawnSync("systemd-analyze", ["verify", path], {
        encoding: "utf8",
        env: { ...process.env, SYSTEMD_UNIT_PATH: `${root}:` },
      });
      const output = `${verified.stdout ?? ""}${verified.stderr ?? ""}`;
      assert.equal(verified.status, 0, output);
      assert.doesNotMatch(output, /Unknown|Failed to parse/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real service CLI enforces the Linux root boundary and sudo -n policy", async () => {
  await withLinux(async () => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-installer-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    try {
      const plan = installLaunchdServices({
        repositoryRoot: root,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        unitDirectory,
        sudoersPath,
        apply: false,
      });
      assert.equal(plan.entries.length, SERVICE_LABELS.length + 1);
      assert.equal(existsSync(plan.staging), false);
      const stagedDropIn = join(plan.staging, "units/com.agentos.api.service.d/os-isolation.conf");
      mkdirSync(join(plan.staging, "units/com.agentos.api.service.d"), { recursive: true });
      writeFileSync(stagedDropIn, "[Service]\nEnvironment=RUNNER_WORKSPACE_ROOT=\"/configured/workspaces\"\n");
      const staged = installLaunchdServices({
        repositoryRoot: root,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        unitDirectory,
        sudoersPath,
        visudoPath: "/usr/bin/true",
        apply: true,
      });
      assert.equal(staged.entries.length, SERVICE_LABELS.length + 1);
      assert.equal(staged.manifest.auxiliaryEntries.some(({ kind }) => kind === "drop-in"), true);
      assert.equal(existsSync(join(root, ".agentos-deploy/launchd/manifest.json")), true);
      const stableWrapper = join(root, "shared/bin/agentos-service-wrapper.mjs");
      const wrapperBeforeRoot = statSync(stableWrapper);
      assert.throws(
        () => installStagedSystemdServices({
          repositoryRoot: root,
          unitDirectory,
          sudoersPath,
          systemctlPath: "/usr/bin/false",
          effectiveUid: 0,
          execute: (_command, args) => {
            if (args[0] === "-c") return "";
            throw new Error("recorder refusal");
          },
          serviceUser: "anneal-test",
          userLookup: accountLookup,
          visudoPath: "/usr/bin/true",
        }),
        /systemd-control-failed:daemon-reload/u,
      );
      // The recorder test runs without root; make the root-owned production
      // mode writable again before exercising the successful retry.
      chmodSync(sudoersPath, 0o600);
      const cli = spawnServiceInstallerCli({
        root,
        args: ["--install-units", "--service-user", "anneal-test"],
        context: {
        repositoryRoot: root,
        unitDirectory,
        sudoersPath,
        systemctlPath: "/usr/bin/true",
        effectiveUid: 0,
        visudoPath: "/usr/bin/true",
        },
      });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stdout, `APPLY platform=linux\nAPPLY unit-directory=${unitDirectory}\nAPPLY units=${SERVICE_LABELS.length}\nAPPLY staging=${staged.staging}\n`);
      const calls = cli.records.filter(({ operation }) => operation === "execute").map(({ args }) => args);
      const ownership = cli.records.filter(({ operation }) => operation === "chown");
      const wrapperAfterRoot = statSync(stableWrapper);
      assert.equal(wrapperAfterRoot.ino, wrapperBeforeRoot.ino);
      assert.equal(wrapperAfterRoot.mtimeMs, wrapperBeforeRoot.mtimeMs);
      const systemctlCalls = calls.filter((args) => args[0] !== "-c");
      assert.deepEqual(systemctlCalls, [
        ["daemon-reload"],
        ...SERVICE_LABELS.map((label) => ["enable", "--now", `${label}.service`]),
      ]);
      const installedTargets = [
        ...staged.manifest.entries.filter(({ kind }) => kind !== "wrapper"),
        ...staged.manifest.auxiliaryEntries,
      ];
      for (const entry of installedTargets) {
        assert.equal(existsSync(entry.path), true, entry.path);
        assert.equal(statSync(entry.path).mode & 0o777, entry.kind === "sudoers" ? 0o440 : 0o644, entry.path);
        assert.equal(ownership.some((change) => change.path === entry.path && change.uid === 0 && change.gid === 0), true, entry.path);
      }
      const sudoers = readFileSync(sudoersPath, "utf8");
      assert.equal(sudoers, renderSystemdSudoers({
        serviceUser: "anneal-test",
        systemctlPath: "/bin/systemctl",
      }));
      assert.match(sudoers, /systemctl show -p ExecStart --value com\.agentos\.api\.service/u);
      assert.doesNotMatch(sudoers, /\b(?:enable|disable|daemon-reload)\b/u);
      const sudo = writeSudoPolicyStub(root);
      const executePolicy = (args) => spawnSync(sudo, ["-n", "/bin/systemctl", ...args], {
        encoding: "utf8",
        env: { ...process.env, SUDOERS_POLICY: sudoersPath },
      });
      for (const label of SERVICE_LABELS) {
        const unit = `${label}.service`;
        assert.equal(executePolicy(["restart", unit]).status, 0, unit);
        assert.equal(executePolicy(["show", "-p", "ExecStart", "--value", unit]).status, 0, unit);
        assert.equal(executePolicy(["is-active", unit]).status, 0, unit);
        assert.equal(executePolicy(["enable", unit]).status, 1, unit);
      }
      assert.equal(executePolicy(["daemon-reload"]).status, 1);
      assert.equal(executePolicy(["restart", "com.agentos.unknown.service"]).status, 1);
      assert.equal(executePolicy(["show", "-p", "ExecStart", "--value", "com.agentos.unknown.service"]).status, 1);
      assert.equal(executePolicy(["is-active", "com.agentos.unknown.service"]).status, 1);

      const apiUnit = join(unitDirectory, "com.agentos.api.service");
      const installedApi = readFileSync(apiUnit, "utf8");
      writeFileSync(apiUnit, "operator mutation\n");
      const callsBeforeDrift = calls.length;
      const execute = (_command, args) => { calls.push(args); return ""; };
      assert.throws(
        () => installStagedSystemdServices({
          repositoryRoot: root,
          unitDirectory,
          sudoersPath,
          systemctlPath: "/usr/bin/true",
          effectiveUid: 0,
          execute,
          revert: true,
          serviceUser: "anneal-test",
          userLookup: accountLookup,
          visudoPath: "/usr/bin/true",
        }),
        /systemd-service-definition-drift/u,
      );
      assert.equal(calls.length, callsBeforeDrift);
      assert.equal(readFileSync(apiUnit, "utf8"), "operator mutation\n");
      writeFileSync(apiUnit, installedApi);
      const wrapperPath = join(root, "shared/bin/agentos-service-wrapper.mjs");
      rmSync(wrapperPath);
      const manifestPath = join(root, ".agentos-deploy/launchd/manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.wrapperReverted = true;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const reverted = installStagedSystemdServices({
        repositoryRoot: root,
        unitDirectory,
        sudoersPath,
        systemctlPath: "/usr/bin/true",
        effectiveUid: 0,
        execute,
        revert: true,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        visudoPath: "/usr/bin/true",
      });
      assert.equal(reverted.reverted, true);
      assert.equal(reverted.platform, "linux");
      assert.equal(existsSync(join(unitDirectory, "com.agentos.api.service")), false);
      assert.equal(existsSync(join(unitDirectory, "com.agentos.api.service.d")), false);
      assert.equal(existsSync(join(unitDirectory, ".anneal-service-transaction.json")), false);
      assert.deepEqual(
        calls.filter((args) => args[0] !== "-c").slice(-(SERVICE_LABELS.length + 1)),
        [
          ...SERVICE_LABELS.map((label) => ["disable", "--now", `${label}.service`]),
          ["daemon-reload"],
        ],
      );
      assert.deepEqual(calls.at(-1), ["daemon-reload"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("systemd install privilege and service-account boundaries are explicit", async () => {
  await withLinux(() => {
    assert.throws(
      () => installStagedSystemdServices({ effectiveUid: 1000 }),
      /systemd-installer-requires-root/u,
    );
    assert.throws(
      () => installLaunchdServices({ repositoryRoot: process.cwd(), serviceUser: "root", userLookup: accountLookup }),
      /systemd-service-user-root/u,
    );
    assert.throws(
      () => installLaunchdServices({ repositoryRoot: process.cwd(), serviceUser: "missing", userLookup: () => "" }),
      /systemd-service-user-unknown:missing/u,
    );
  });
});

test("privileged service install rejects tampered paths, symlinks, units, and sudoers", async () => {
  await withLinux(() => {
    const variants = ["target", "staged", "backup", "backup-symlink", "cleanup", "symlink", "root-unit", "sudoers"];
    for (const variant of variants) {
      const root = mkdtempSync(join(tmpdir(), `agentos-systemd-tamper-${variant}-`));
      const unitDirectory = join(root, "etc/systemd/system");
      const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
      try {
        if (variant === "backup-symlink") {
          mkdirSync(unitDirectory, { recursive: true });
          writeFileSync(join(unitDirectory, "com.agentos.api.service"), "previous definition\n");
        }
        const staged = installLaunchdServices({
          repositoryRoot: root,
          serviceUser: "anneal-test",
          userLookup: accountLookup,
          nodeBinary: process.execPath,
          gitBinary: process.execPath,
          unitDirectory,
          sudoersPath,
          visudoPath: "/usr/bin/true",
          effectiveUid: 501,
          replaceExisting: variant === "backup-symlink",
          apply: true,
        });
        const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
        if (variant === "target") manifest.entries[1].path = join(root, "outside-target");
        if (variant === "staged") manifest.entries[1].stagedPath = join(root, "outside-staged");
        if (variant === "backup") {
          manifest.entries[1].existed = true;
          manifest.entries[1].backupPath = join(root, "outside-backup");
        }
        if (variant === "backup-symlink") {
          const entry = manifest.entries[1];
          const contents = readFileSync(entry.backupPath);
          rmSync(entry.backupPath);
          const real = `${entry.backupPath}.real`;
          writeFileSync(real, contents);
          symlinkSync(real, entry.backupPath);
        }
        if (variant === "cleanup") manifest.stagingRoot = join(root, "outside-cleanup");
        if (variant === "symlink") {
          const target = manifest.entries[1].stagedPath;
          const contents = readFileSync(target);
          rmSync(target);
          const real = `${target}.real`;
          writeFileSync(real, contents);
          symlinkSync(real, target);
        }
        if (variant === "root-unit") {
          const entry = manifest.entries[1];
          const contents = readFileSync(entry.stagedPath, "utf8").replace("User=anneal-test", "User=root");
          writeFileSync(entry.stagedPath, contents);
          entry.installedSha256 = digest(contents);
        }
        if (variant === "sudoers") {
          const entry = manifest.auxiliaryEntries.find(({ kind }) => kind === "sudoers");
          const contents = `${readFileSync(entry.stagedPath, "utf8").trim()}, /bin/systemctl daemon-reload\n`;
          chmodSync(entry.stagedPath, 0o600);
          writeFileSync(entry.stagedPath, contents);
          entry.installedSha256 = digest(contents);
        }
        writeFileSync(staged.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        assert.throws(() => installStagedSystemdServices({
          repositoryRoot: root,
          unitDirectory,
          sudoersPath,
          systemctlPath: "/usr/bin/true",
          visudoPath: "/usr/bin/true",
          effectiveUid: 0,
          serviceUser: "anneal-test",
          userLookup: accountLookup,
          execute: () => "",
        }), /systemd-(?:service-manifest-invalid|target-outside-directory|symlink-refused|staged-unit-invalid|staged-sudoers-invalid)/u, variant);
        assert.equal(existsSync(join(root, "outside-target")), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

test("replace-existing restores unit bytes, mode, and enabled/active state", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-replace-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const apiUnit = join(unitDirectory, "com.agentos.api.service");
    mkdirSync(unitDirectory, { recursive: true });
    writeFileSync(apiUnit, "operator-owned definition\n", { mode: 0o600 });
    const stageExecute = (_command, args) => {
      if (args[0] === "is-enabled") return args[1] === "com.agentos.api.service" ? "enabled\n" : "disabled\n";
      if (args[0] === "is-active") return args[1] === "com.agentos.api.service" ? "active\n" : "inactive\n";
      return "";
    };
    try {
      const staged = installLaunchdServices({
        repositoryRoot: root,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        unitDirectory,
        sudoersPath,
        systemctlPath: "/usr/bin/true",
        visudoPath: "/usr/bin/true",
        execute: stageExecute,
        replaceExisting: true,
        effectiveUid: 501,
        apply: true,
      });
      const calls = [];
      const execute = (_command, args) => {
        calls.push(args);
        if (args[0] === "is-enabled" && args[1] === "com.agentos.api.service") return "enabled\n";
        if (args[0] === "is-active" && args[1] === "com.agentos.api.service") return "active\n";
        return "";
      };
      installLaunchdServices({
        repositoryRoot: root, serviceUser: "anneal-test", userLookup: accountLookup,
        unitDirectory, sudoersPath, systemctlPath: "/usr/bin/true", visudoPath: "/usr/bin/true",
        execute, effectiveUid: 0, installUnits: true,
      });
      assert.notEqual(readFileSync(apiUnit, "utf8"), "operator-owned definition\n");
      installLaunchdServices({
        repositoryRoot: root, serviceUser: "anneal-test", userLookup: accountLookup,
        unitDirectory, sudoersPath, execute, effectiveUid: 501, revert: true, apply: true,
      });
      installLaunchdServices({
        repositoryRoot: root, serviceUser: "anneal-test", userLookup: accountLookup,
        unitDirectory, sudoersPath, systemctlPath: "/usr/bin/true", execute,
        effectiveUid: 0, installUnits: true, revert: true,
      });
      assert.equal(readFileSync(apiUnit, "utf8"), "operator-owned definition\n");
      assert.equal(statSync(apiUnit).mode & 0o777, 0o600);
      assert.equal(calls.some((args) => args.join(" ") === "enable com.agentos.api.service"), true);
      assert.equal(calls.some((args) => args.join(" ") === "start com.agentos.api.service"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a count of sixteen produces twenty-entry service manifests on both platforms", () => {
  const source = String.raw`
    import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { installLaunchdServices } from "./scripts/deploy/install-launchd.mjs";
    const roots = [mkdtempSync(join(tmpdir(), "agentos-linux-16-")), mkdtempSync(join(tmpdir(), "agentos-darwin-16-"))];
    try {
      process.env.AGENTOS_SERVICE_PLATFORM = "linux";
      const linux = installLaunchdServices({
        repositoryRoot: roots[0], serviceUser: "anneal-test", userLookup: () => "anneal-test:x:620:620::/tmp:/bin/bash",
        nodeBinary: process.execPath, gitBinary: process.execPath, visudoPath: "/usr/bin/true", effectiveUid: 501, apply: true,
        unitDirectory: join(roots[0], "etc/systemd/system"), sudoersPath: join(roots[0], "etc/sudoers.d/anneal-service-control"),
      });
      process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
      mkdirSync(join(roots[1], "shared"), { recursive: true });
      writeFileSync(join(roots[1], "shared/.env"), "DATABASE_URL=configured\n");
      mkdirSync(join(roots[1], "releases/release-1"), { recursive: true });
      symlinkSync("releases/release-1", join(roots[1], "current"));
      const darwin = installLaunchdServices({
        repositoryRoot: roots[1], userHome: join(roots[1], "home"), nodeBinary: process.execPath,
        gitBinary: process.execPath, effectiveUid: 501, apply: true,
      });
      const linuxManifest = JSON.parse(readFileSync(linux.manifestPath, "utf8"));
      const darwinManifest = JSON.parse(readFileSync(join(roots[1], ".agentos-deploy/launchd/manifest.json"), "utf8"));
      const countPersisted = linuxManifest.entries.filter((entry) => entry.kind === "service")
        .every((entry) => readFileSync(entry.stagedPath, "utf8").includes('Environment=AGENTOS_RUNNER_COUNT="16"'));
      delete process.env.AGENTOS_RUNNER_COUNT;
      process.env.AGENTOS_SERVICE_PLATFORM = "linux";
      const calls = [];
      const installed = installLaunchdServices({
        repositoryRoot: roots[0], serviceUser: "anneal-test", userLookup: () => "anneal-test:x:620:620::/tmp:/bin/bash",
        installUnits: true, apply: false, effectiveUid: 0,
        unitDirectory: join(roots[0], "etc/systemd/system"), sudoersPath: join(roots[0], "etc/sudoers.d/anneal-service-control"),
        systemctlPath: "/usr/bin/true", visudoPath: "/usr/bin/true", execute: (_command, args) => { calls.push(args); return ""; },
      });
      console.log(JSON.stringify({ linux: linuxManifest.entries.length, darwin: darwinManifest.entries.length, linuxResult: linux.entries.length, darwinResult: darwin.entries.length, installedUnits: installed.units.length, countPersisted, enabled: calls.filter((args) => args[0] === "enable").length }));
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: { ...process.env, AGENTOS_RUNNER_COUNT: "16", AGENTOS_SERVICE_PLATFORM: "linux" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { linux: 20, darwin: 20, linuxResult: 20, darwinResult: 20, installedUnits: 19, countPersisted: true, enabled: 19 });
});

test("auto-deploy systemd stage renders a oneshot and timer, enabling only the timer", async () => {
  await withLinux(async () => {
    const root = mkdtempSync(join(tmpdir(), "agentos-auto-systemd-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const options = {
      repositoryRoot: root,
      nodeBinary: "/usr/bin/node",
      gitBinary: "/usr/bin/git",
      npmBinary: "/usr/bin/npm",
      path: "/usr/bin:/bin",
      sourceRemote: "configured-remote",
      backup: { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      unitDirectory,
      sudoersPath,
      systemctlPath: "/usr/bin/true",
      visudoPath: "/usr/bin/true",
    };
    try {
      const plan = planSystemdAutoDeploy(options);
      assert.equal(plan.entries.length, 2);
      assert.match(plan.definitions.service, /^Type=oneshot$/mu);
      assert.match(renderAutoDeploySystemdTimer(), /^OnBootSec=60$/mu);
      const staged = planSystemdAutoDeploy({ ...options, apply: true });
      const calls = [];
      const ownership = [];
      const execute = (_command, args) => { calls.push(args); return ""; };
      const installCode = installLaunchd(["--install-units", "--service-user", "anneal-test"], {
        ...options,
        manifestPath: staged.manifestPath,
        effectiveUid: 0,
        execute,
        chown: (path, uid, gid) => ownership.push({ path, uid, gid }),
        environment: { AGENTOS_SERVICE_PLATFORM: "linux" },
      });
      assert.equal(installCode, 0);
      assert.deepEqual(calls, [["daemon-reload"], ["enable", "--now", "com.agentos.auto-deploy.timer"]]);
      for (const entry of staged.manifest.entries) {
        assert.equal(existsSync(entry.path), true, entry.path);
        assert.equal(statSync(entry.path).mode & 0o777, 0o644, entry.path);
        assert.equal(ownership.some((change) => change.path === entry.path && change.uid === 0 && change.gid === 0), true, entry.path);
      }
      const planRevertCode = installLaunchd(["--revert", "--service-user", "anneal-test"], {
        ...options,
        manifestPath: staged.manifestPath,
        effectiveUid: 501,
        execute,
        environment: { AGENTOS_SERVICE_PLATFORM: "linux" },
      });
      assert.equal(planRevertCode, 0);
      assert.equal(existsSync(join(unitDirectory, "com.agentos.auto-deploy.service")), true);
      const revertCode = installLaunchd(["--revert", "--apply", "--service-user", "anneal-test"], {
        ...options,
        manifestPath: staged.manifestPath,
        effectiveUid: 0,
        execute,
        environment: { AGENTOS_SERVICE_PLATFORM: "linux" },
      });
      assert.equal(revertCode, 0);
      assert.equal(existsSync(join(unitDirectory, "com.agentos.auto-deploy.service")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("privileged auto-deploy install rejects tampered targets and root service content", async () => {
  await withLinux(() => {
    for (const variant of ["target", "root-unit"]) {
      const root = mkdtempSync(join(tmpdir(), `agentos-auto-tamper-${variant}-`));
      const unitDirectory = join(root, "etc/systemd/system");
      const options = {
        repositoryRoot: root,
        nodeBinary: "/usr/bin/node",
        gitBinary: "/usr/bin/git",
        npmBinary: "/usr/bin/npm",
        path: "/usr/bin:/bin",
        sourceRemote: "configured-remote",
        backup: { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        unitDirectory,
        sudoersPath: join(root, "etc/sudoers.d/anneal-service-control"),
        apply: true,
        effectiveUid: 501,
      };
      try {
        const staged = planSystemdAutoDeploy(options);
        const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
        if (variant === "target") manifest.entries[0].path = join(root, "outside-auto-target");
        else {
          const entry = manifest.entries[0];
          const contents = readFileSync(entry.stagedPath, "utf8").replace("User=anneal-test", "User=root");
          writeFileSync(entry.stagedPath, contents);
          entry.installedSha256 = digest(contents);
        }
        writeFileSync(staged.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        assert.throws(() => installStagedSystemdAutoDeploy({
          repositoryRoot: root,
          manifestPath: staged.manifestPath,
          unitDirectory,
          serviceUser: "anneal-test",
          userLookup: accountLookup,
          systemctlPath: "/usr/bin/true",
          execute: () => "",
          effectiveUid: 0,
        }), /systemd-(?:auto-deploy-manifest-invalid|staged-unit-invalid)/u);
        assert.equal(existsSync(join(root, "outside-auto-target")), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
