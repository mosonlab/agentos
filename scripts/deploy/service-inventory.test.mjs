import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_RUNNER_COUNT,
  MAX_RUNNER_COUNT,
  formatServiceInventory,
  generateServiceInventory,
  plistNameForLabel,
  resolveRunnerCount,
  resolveRunnerIdPrefix,
  resolveServiceInventory,
  serviceInventoryEntry,
  serviceWrapperPath,
  unitNameForLabel,
} from "./service-inventory.mjs";

const EMITTER = fileURLToPath(new URL("./service-inventory.mjs", import.meta.url));

const emit = (environment) => spawnSync(process.execPath, [EMITTER], {
  encoding: "utf8",
  env: { ...process.env, AGENTOS_DEPLOY_ROLE: "control-plane", AGENTOS_RUNNER_COUNT: "", AGENTOS_RUNNER_ID_PREFIX: "", ...environment },
});

test("a count and a prefix produce the whole control-plane inventory", () => {
  const inventory = generateServiceInventory({ runnerCount: 3, runnerIdPrefix: "vm-", deployRole: "control-plane" });
  assert.equal(inventory.runnerCount, 3);
  assert.equal(inventory.runnerIdPrefix, "vm-");
  assert.equal(inventory.deployRole, "control-plane");
  assert.deepEqual([...inventory.entries], [
    { label: "com.agentos.api", runnerIndex: null, runnerId: null, unitName: "com.agentos.api.service", plistName: "com.agentos.api.plist" },
    { label: "com.agentos.inbox", runnerIndex: null, runnerId: null, unitName: "com.agentos.inbox.service", plistName: "com.agentos.inbox.plist" },
    { label: "com.agentos.runner", runnerIndex: 1, runnerId: "vm-runner-1", unitName: "com.agentos.runner.service", plistName: "com.agentos.runner.plist" },
    { label: "com.agentos.runner-2", runnerIndex: 2, runnerId: "vm-runner-2", unitName: "com.agentos.runner-2.service", plistName: "com.agentos.runner-2.plist" },
    { label: "com.agentos.runner-3", runnerIndex: 3, runnerId: "vm-runner-3", unitName: "com.agentos.runner-3.service", plistName: "com.agentos.runner-3.plist" },
    { label: "com.agentos.web", runnerIndex: null, runnerId: null, unitName: "com.agentos.web.service", plistName: "com.agentos.web.plist" },
  ]);
  assert.deepEqual([...inventory.labels], inventory.entries.map(({ label }) => label));
});

test("the runner role inventory carries only the namespaced local runners", () => {
  const inventory = generateServiceInventory({ runnerCount: 2, runnerIdPrefix: "mac-", deployRole: "runner" });
  assert.equal(inventory.runnerCount, 2);
  assert.deepEqual([...inventory.labels], ["com.agentos.runner", "com.agentos.runner-2"]);
  assert.deepEqual(inventory.entries.map(({ runnerId }) => runnerId), ["mac-runner-1", "mac-runner-2"]);
  assert.deepEqual(inventory.entries.map(({ unitName }) => unitName), ["com.agentos.runner.service", "com.agentos.runner-2.service"]);
});

test("the runner count is never recoverable from an entry count", () => {
  const controlPlane = generateServiceInventory({ runnerCount: 4, runnerIdPrefix: "", deployRole: "control-plane" });
  const runner = generateServiceInventory({ runnerCount: 4, runnerIdPrefix: "", deployRole: "runner" });
  assert.equal(controlPlane.entries.length, 7);
  assert.equal(runner.entries.length, 4);
  assert.equal(controlPlane.runnerCount, runner.runnerCount);
});

test("service-manager names and the installed wrapper path come from here alone", () => {
  assert.equal(unitNameForLabel("com.agentos.auto-deploy"), "com.agentos.auto-deploy.service");
  assert.equal(plistNameForLabel("com.agentos.auto-deploy"), "com.agentos.auto-deploy.plist");
  assert.equal(serviceWrapperPath("/srv/anneal/"), "/srv/anneal/shared/bin/agentos-service-wrapper.mjs");
});

test("resolution reads the invocation environment and refuses invalid inputs", () => {
  assert.equal(resolveRunnerCount({}), DEFAULT_RUNNER_COUNT);
  assert.equal(resolveRunnerCount({ AGENTOS_RUNNER_COUNT: String(MAX_RUNNER_COUNT) }), MAX_RUNNER_COUNT);
  assert.equal(resolveRunnerIdPrefix({}), "");
  for (const value of ["0", "65", "", "3.5", "abc"]) {
    assert.throws(() => resolveRunnerCount({ AGENTOS_RUNNER_COUNT: value }), new RegExp(`runner-count-invalid:${value}$`, "u"));
  }
  assert.throws(() => resolveRunnerIdPrefix({ AGENTOS_RUNNER_ID_PREFIX: "bad/prefix" }), /runner-id-prefix-invalid:bad\/prefix/u);
  assert.throws(
    () => generateServiceInventory({ runnerCount: 1, runnerIdPrefix: "", deployRole: "builder" }),
    /deploy-role-invalid:builder/u,
  );
  const resolved = resolveServiceInventory({ AGENTOS_RUNNER_COUNT: "2", AGENTOS_RUNNER_ID_PREFIX: "vm-", AGENTOS_DEPLOY_ROLE: "runner" });
  assert.deepEqual([...resolved.labels], ["com.agentos.runner", "com.agentos.runner-2"]);
});

test("a label outside the resolved inventory is a refusal, not a miss", () => {
  const inventory = generateServiceInventory({ runnerCount: 1, runnerIdPrefix: "", deployRole: "runner" });
  assert.equal(serviceInventoryEntry(inventory, "com.agentos.runner").runnerId, "runner-1");
  assert.throws(() => serviceInventoryEntry(inventory, "com.agentos.api"), /service-label-unknown:com\.agentos\.api/u);
});

test("the shell listing is one tab-separated line per entry in inventory order", () => {
  const inventory = generateServiceInventory({ runnerCount: 1, runnerIdPrefix: "vm-", deployRole: "control-plane" });
  assert.equal(formatServiceInventory(inventory), [
    "com.agentos.api\tcom.agentos.api.service\tcom.agentos.api.plist\t\t",
    "com.agentos.inbox\tcom.agentos.inbox.service\tcom.agentos.inbox.plist\t\t",
    "com.agentos.runner\tcom.agentos.runner.service\tcom.agentos.runner.plist\t1\tvm-runner-1",
    "com.agentos.web\tcom.agentos.web.service\tcom.agentos.web.plist\t\t",
    "",
  ].join("\n"));
});

test("the emitter writes the resolved listing and reports an invalid count on exit 64", () => {
  const emitted = emit({ AGENTOS_RUNNER_COUNT: "2", AGENTOS_RUNNER_ID_PREFIX: "vm-", AGENTOS_DEPLOY_ROLE: "runner" });
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.equal(emitted.stdout, formatServiceInventory(
    generateServiceInventory({ runnerCount: 2, runnerIdPrefix: "vm-", deployRole: "runner" }),
  ));
  const refused = emit({ AGENTOS_RUNNER_COUNT: "abc" });
  assert.equal(refused.status, 64);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /^runner-count-invalid:abc$/mu);
});

test("the emitter is also where a shell entrypoint reads the installed wrapper path", () => {
  const emitted = spawnSync(process.execPath, [EMITTER, "--wrapper-path", "/srv/anneal"], { encoding: "utf8" });
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.equal(emitted.stdout, `${serviceWrapperPath("/srv/anneal")}\n`);
  for (const argv of [["--wrapper-path"], ["/srv/anneal"], ["--wrapper-path", "/srv/anneal", "extra"]]) {
    const refused = spawnSync(process.execPath, [EMITTER, ...argv], { encoding: "utf8" });
    assert.equal(refused.status, 64, argv.join(" "));
    assert.match(refused.stderr, /^usage: service-inventory\.mjs/mu);
  }
});
