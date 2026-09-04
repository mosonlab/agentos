import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  autoDeployEnvironmentValues,
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
    assert.match(unit, new RegExp(`^ExecStart=/usr/bin/node .* ${value.label}$`, "mu"));
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
        env: { ...process.env, SYSTEMD_UNIT_PATH: root },
      });
      const output = `${verified.stdout ?? ""}${verified.stderr ?? ""}`;
      assert.equal(verified.status, 0, output);
      assert.doesNotMatch(output, /Unknown|Failed to parse/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux service stage is unprivileged and the root stage has an ordered activation plan", async () => {
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
      writeFileSync(stagedDropIn, "[Service]\nEnvironment=UNRECORDED=\"preserved\"\n");
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
      assert.throws(
        () => installStagedSystemdServices({
          repositoryRoot: root,
          unitDirectory,
          sudoersPath,
          systemctlPath: "/usr/bin/false",
          effectiveUid: 0,
          execute: () => { throw new Error("recorder refusal"); },
        }),
        /systemd-control-failed:daemon-reload/u,
      );
      // The recorder test runs without root; make the root-owned production
      // mode writable again before exercising the successful retry.
      chmodSync(sudoersPath, 0o600);
      const calls = [];
      const execute = (_command, args) => { calls.push(args); return ""; };
      const installed = installStagedSystemdServices({
        repositoryRoot: root,
        unitDirectory,
        sudoersPath,
        systemctlPath: "/usr/bin/true",
        effectiveUid: 0,
        execute,
      });
      assert.equal(installed.applied, true);
      assert.deepEqual(calls.slice(0, 2), [["daemon-reload"], ["enable", "--now", `${SERVICE_LABELS[0]}.service`]]);
      assert.equal(calls.length, SERVICE_LABELS.length + 1);
      assert.equal(existsSync(join(unitDirectory, "com.agentos.api.service")), true);
      assert.equal(statSync(join(unitDirectory, "com.agentos.api.service")).mode & 0o777, 0o644);
      assert.equal(statSync(join(unitDirectory, "com.agentos.api.service.d/os-isolation.conf")).mode & 0o777, 0o644);
      assert.equal(statSync(sudoersPath).mode & 0o777, 0o440);
      const sudoers = readFileSync(sudoersPath, "utf8");
      assert.equal(sudoers, renderSystemdSudoers({
        serviceUser: "anneal-test",
        systemctlPath: "/bin/systemctl",
      }));
      assert.match(sudoers, /systemctl show -p ExecStart --value com\.agentos\.api\.service/u);
      assert.doesNotMatch(sudoers, /\b(?:enable|disable|daemon-reload)\b/u);

      const apiUnit = join(unitDirectory, "com.agentos.api.service");
      const installedApi = readFileSync(apiUnit, "utf8");
      writeFileSync(apiUnit, "operator mutation\n");
      const callsBeforeDrift = calls.length;
      assert.throws(
        () => installStagedSystemdServices({
          repositoryRoot: root,
          unitDirectory,
          sudoersPath,
          systemctlPath: "/usr/bin/true",
          effectiveUid: 0,
          execute,
          revert: true,
        }),
        /systemd-service-definition-drift/u,
      );
      assert.equal(calls.length, callsBeforeDrift);
      assert.equal(readFileSync(apiUnit, "utf8"), "operator mutation\n");
      writeFileSync(apiUnit, installedApi);
      const reverted = installStagedSystemdServices({
        repositoryRoot: root,
        unitDirectory,
        sudoersPath,
        systemctlPath: "/usr/bin/true",
        effectiveUid: 0,
        execute,
        revert: true,
      });
      assert.equal(reverted.reverted, true);
      assert.equal(existsSync(join(unitDirectory, "com.agentos.api.service")), false);
      assert.deepEqual(
        calls.slice(-(SERVICE_LABELS.length + 1)),
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
      console.log(JSON.stringify({ linux: linuxManifest.entries.length, darwin: darwinManifest.entries.length, linuxResult: linux.entries.length, darwinResult: darwin.entries.length }));
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
  assert.deepEqual(JSON.parse(result.stdout), { linux: 20, darwin: 20, linuxResult: 20, darwinResult: 20 });
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
      const execute = (_command, args) => { calls.push(args); return ""; };
      const installed = installStagedSystemdAutoDeploy({
        ...options,
        manifestPath: staged.manifestPath,
        effectiveUid: 0,
        execute,
      });
      assert.equal(installed.applied, true);
      assert.deepEqual(calls, [["daemon-reload"], ["enable", "--now", "com.agentos.auto-deploy.timer"]]);
      assert.equal(existsSync(join(unitDirectory, "com.agentos.auto-deploy.service")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
