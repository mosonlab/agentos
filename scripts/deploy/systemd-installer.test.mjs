import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installLaunchdServices,
  installStagedSystemdAutoDeploy,
  installStagedSystemdServices,
  planSystemdAutoDeploy,
  renderAutoDeploySystemdTimer,
  renderServiceSystemdUnit,
  serviceEnvironmentValues,
  servicePlistValues,
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
    assert.deepEqual(new Set(unitEnvironmentKeys(unit)), new Set(Object.keys(serviceEnvironmentValues(value))));
    assert.doesNotMatch(unit, /^EnvironmentFile=/mu);
    assert.match(unit, new RegExp(`^ExecStart=/usr/bin/node .* ${value.label}$`, "mu"));
    assert.match(unit, /PATH=".*%%"/u);
    assert.match(unit, /^User=(?!root$)\S+$/mu);
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
      assert.equal(existsSync(join(root, ".agentos-deploy/launchd/manifest.json")), true);
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
      assert.equal(statSync(sudoersPath).mode & 0o777, 0o440);
      assert.doesNotMatch(readFileSync(sudoersPath, "utf8"), /enable/u);
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
      assert.deepEqual(calls.at(-1), ["daemon-reload"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
