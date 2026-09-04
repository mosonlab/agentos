import assert from "node:assert/strict";
import test from "node:test";

import { DeployFailure } from "./quiet-window-lib.mjs";
import {
  createServiceControl,
  describesStableWrapper,
  serviceUnitName,
} from "./service-control.mjs";

const runRecorder = (responses = {}) => {
  const calls = [];
  const run = async (program, args, options) => {
    calls.push({ program, args, options });
    const key = `${program} ${args.join(" ")}`;
    const response = responses[key];
    return typeof response === "function" ? response() : response ?? { code: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
};

test("service unit names are derived from labels", () => {
  assert.equal(serviceUnitName("com.agentos.api"), "com.agentos.api.service");
  assert.throws(
    () => serviceUnitName("com.agentos/api"),
    (error) => error instanceof DeployFailure
      && error.reason === "service-control-label-invalid"
      && error.detail === "com.agentos/api",
  );
});

test("Linux root control uses bare systemctl verbs and the stable ExecStart query", async () => {
  const recorder = runRecorder({
    "systemctl is-active com.agentos.api.service": { code: 0, stdout: "active\n", stderr: "" },
    "systemctl show -p ExecStart --value com.agentos.api.service": {
      code: 0,
      stdout: "/usr/bin/node /srv/shared/bin/agentos-service-wrapper.mjs com.agentos.api\n",
      stderr: "",
    },
  });
  const control = createServiceControl({ platform: "linux", euid: 0, run: recorder.run });

  await control.restart("com.agentos.api");
  assert.equal(await control.isRunning("com.agentos.api"), true);
  assert.match(await control.describe("com.agentos.api"), /agentos-service-wrapper\.mjs/u);
  assert.deepEqual(recorder.calls.map(({ program, args }) => [program, args]), [
    ["systemctl", ["restart", "com.agentos.api.service"]],
    ["systemctl", ["is-active", "com.agentos.api.service"]],
    ["systemctl", ["show", "-p", "ExecStart", "--value", "com.agentos.api.service"]],
  ]);
});
test("Linux non-root control prefixes sudo -n and an inactive unit is not running", async () => {
  const recorder = runRecorder({
    "sudo -n systemctl is-active com.agentos.web.service": { code: 3, stdout: "inactive\n", stderr: "" },
  });
  const control = createServiceControl({ platform: "linux", euid: 1000, run: recorder.run });

  assert.equal(await control.isRunning("com.agentos.web"), false);
  assert.deepEqual(recorder.calls.map(({ program, args }) => [program, args]), [
    ["sudo", ["-n", "systemctl", "is-active", "com.agentos.web.service"]],
  ]);
});

test("a denied Linux control command fails with the unit named", async () => {
  const recorder = runRecorder({
    "sudo -n systemctl restart com.agentos.api.service": {
      code: 1,
      stdout: "",
      stderr: "sudo: a password is required\n",
    },
  });
  const control = createServiceControl({ platform: "linux", euid: 1000, run: recorder.run });

  await assert.rejects(
    control.restart("com.agentos.api"),
    (error) => error instanceof DeployFailure
      && error.reason === "service-control-denied"
      && error.detail === "com.agentos.api.service"
      && error.message === "service-control-denied: com.agentos.api.service",
  );
});

test("Darwin control preserves launchctl argv and GUI domain", async () => {
  const recorder = runRecorder({
    "/bin/launchctl print gui/501/com.agentos.api": {
      code: 0,
      stdout: "state = running\nprogram = /srv/shared/bin/agentos-service-wrapper.mjs com.agentos.api\n",
      stderr: "",
    },
  });
  const control = createServiceControl({ platform: "darwin", uid: 501, run: recorder.run });

  await control.restart("com.agentos.api");
  assert.equal(await control.isRunning("com.agentos.api"), true);
  await control.describe("com.agentos.api");
  assert.deepEqual(recorder.calls.map(({ program, args }) => [program, args]), [
    ["/bin/launchctl", ["kickstart", "-k", "gui/501/com.agentos.api"]],
    ["/bin/launchctl", ["print", "gui/501/com.agentos.api"]],
    ["/bin/launchctl", ["print", "gui/501/com.agentos.api"]],
  ]);
});

test("wrapper-boundary proof requires both the stable wrapper and label", () => {
  const wrapperPath = "/srv/shared/bin/agentos-service-wrapper.mjs";
  assert.equal(describesStableWrapper({
    description: `/usr/bin/node ${wrapperPath} com.agentos.api`,
    label: "com.agentos.api",
    wrapperPath,
  }), true);
  assert.equal(describesStableWrapper({
    description: "/usr/bin/node /wrong-wrapper com.agentos.api",
    label: "com.agentos.api",
    wrapperPath,
  }), false);
  assert.equal(describesStableWrapper({
    description: `/usr/bin/node ${wrapperPath} com.agentos.web`,
    label: "com.agentos.api",
    wrapperPath,
  }), false);
});
