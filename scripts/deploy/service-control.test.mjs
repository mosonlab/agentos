import assert from "node:assert/strict";
import test from "node:test";

import { renderSystemdSudoers } from "./install-launchd.mjs";
import { DeployFailure } from "./quiet-window-lib.mjs";
import { generateServiceInventory, resolveServiceInventory } from "./service-inventory.mjs";
import {
  createServiceControl,
  describesStableWrapper,
  serviceUnitName,
} from "./service-control.mjs";

const DEFAULT_INVENTORY = resolveServiceInventory({});
const SERVICE_LABELS = DEFAULT_INVENTORY.labels;

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

test("service unit names are read out of the inventory the caller resolved", () => {
  assert.equal(serviceUnitName("com.agentos.api", DEFAULT_INVENTORY), "com.agentos.api.service");
  assert.throws(
    () => serviceUnitName("com.agentos.api", generateServiceInventory({
      runnerCount: 2,
      runnerIdPrefix: "",
      deployRole: "runner",
    })),
    (error) => error instanceof DeployFailure && error.reason === "service-control-label-invalid",
  );
  assert.throws(
    () => serviceUnitName("com.agentos/api", DEFAULT_INVENTORY),
    (error) => error instanceof DeployFailure
      && error.reason === "service-control-label-invalid"
      && error.detail === "com.agentos/api",
  );
});

test("runner role service control accepts only the local runner inventory", async () => {
  const recorder = runRecorder();
  const control = createServiceControl({
    platform: "linux",
    euid: 0,
    run: recorder.run,
    inventory: generateServiceInventory({
      runnerCount: 2,
      runnerIdPrefix: "mac-",
      deployRole: "runner",
    }),
  });
  await control.restart("com.agentos.runner-2");
  assert.deepEqual(recorder.calls.map(({ program, args }) => [program, args]), [
    ["/bin/systemctl", ["restart", "com.agentos.runner-2.service"]],
  ]);
  await assert.rejects(control.restart("com.agentos.api"), /service-control-label-invalid/u);
});

test("Linux root control runs the granted systemctl program and the stable ExecStart query", async () => {
  const recorder = runRecorder({
    "/bin/systemctl is-active com.agentos.api.service": { code: 0, stdout: "active\n", stderr: "" },
    "/bin/systemctl show -p ExecStart --value com.agentos.api.service": {
      code: 0,
      stdout: "/usr/bin/node /srv/shared/bin/agentos-service-wrapper.mjs com.agentos.api\n",
      stderr: "",
    },
  });
  const control = createServiceControl({ inventory: DEFAULT_INVENTORY, platform: "linux", euid: 0, run: recorder.run });

  await control.restart("com.agentos.api");
  assert.equal(await control.isRunning("com.agentos.api"), true);
  assert.match(await control.describe("com.agentos.api"), /agentos-service-wrapper\.mjs/u);
  assert.deepEqual(recorder.calls.map(({ program, args }) => [program, args]), [
    ["/bin/systemctl", ["restart", "com.agentos.api.service"]],
    ["/bin/systemctl", ["is-active", "com.agentos.api.service"]],
    ["/bin/systemctl", ["show", "-p", "ExecStart", "--value", "com.agentos.api.service"]],
  ]);
});
test("Linux non-root control prefixes sudo -n and an inactive unit is not running", async () => {
  const recorder = runRecorder({
    "sudo -n /bin/systemctl is-active com.agentos.web.service": { code: 3, stdout: "inactive\n", stderr: "" },
  });
  const control = createServiceControl({ inventory: DEFAULT_INVENTORY, platform: "linux", euid: 1000, run: recorder.run });

  assert.equal(await control.isRunning("com.agentos.web"), false);
  assert.deepEqual(recorder.calls.map(({ program, args }) => [program, args]), [
    ["sudo", ["-n", "/bin/systemctl", "is-active", "com.agentos.web.service"]],
  ]);
});

test("a denied Linux control command fails with the unit named", async () => {
  const recorder = runRecorder({
    "sudo -n /bin/systemctl restart com.agentos.api.service": {
      code: 1,
      stdout: "",
      stderr: "sudo: a password is required\n",
    },
  });
  const control = createServiceControl({ inventory: DEFAULT_INVENTORY, platform: "linux", euid: 1000, run: recorder.run });

  await assert.rejects(
    control.restart("com.agentos.api"),
    (error) => error instanceof DeployFailure
      && error.reason === "service-control-denied"
      && error.detail === "com.agentos.api.service"
      && error.message === "service-control-denied: com.agentos.api.service",
  );
});

test("a systemctl failure is distinct from sudo denial and retains diagnostics", async () => {
  const recorder = runRecorder({
    "sudo -n /bin/systemctl restart com.agentos.api.service": {
      code: 1,
      stdout: "",
      stderr: "Job for com.agentos.api.service failed; inspect the journal\n",
    },
  });
  const control = createServiceControl({ inventory: DEFAULT_INVENTORY, platform: "linux", euid: 1000, run: recorder.run });
  await assert.rejects(
    control.restart("com.agentos.api"),
    (error) => error instanceof DeployFailure
      && error.reason === "service-control-failed:restart:com.agentos.api.service"
      && /inspect the journal/u.test(error.detail),
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
  const control = createServiceControl({ inventory: DEFAULT_INVENTORY, platform: "darwin", uid: 501, run: recorder.run });

  await control.restart("com.agentos.api");
  assert.equal(await control.isRunning("com.agentos.api"), true);
  await control.describe("com.agentos.api");
  assert.deepEqual(recorder.calls.map(({ program, args }) => [program, args]), [
    ["/bin/launchctl", ["kickstart", "-k", "gui/501/com.agentos.api"]],
    ["/bin/launchctl", ["print", "gui/501/com.agentos.api"]],
    ["/bin/launchctl", ["print", "gui/501/com.agentos.api"]],
  ]);
});

test("every Linux inventory label uses the restart, liveness, and boundary argv", async () => {
  const calls = [];
  const run = async (program, args) => {
    calls.push({ program, args });
    const label = args.at(-1).replace(/\.service$/u, "");
    if (args[0] === "is-active") return { code: 0, stdout: "active\n", stderr: "" };
    if (args[0] === "show") return {
      code: 0,
      stdout: `/usr/bin/node /srv/shared/bin/agentos-service-wrapper.mjs ${label}\n`,
      stderr: "",
    };
    return { code: 0, stdout: "", stderr: "" };
  };
  const control = createServiceControl({ inventory: DEFAULT_INVENTORY, platform: "linux", euid: 0, run });

  for (const label of SERVICE_LABELS) {
    await control.restart(label);
    assert.equal(await control.isRunning(label), true);
    assert.match(await control.describe(label), new RegExp(`${label}$`, "mu"));
  }

  assert.deepEqual(calls.map(({ program, args }) => [program, args]), SERVICE_LABELS.flatMap((label) => [
    ["/bin/systemctl", ["restart", `${label}.service`]],
    ["/bin/systemctl", ["is-active", `${label}.service`]],
    ["/bin/systemctl", ["show", "-p", "ExecStart", "--value", `${label}.service`]],
  ]));
});

test("every Darwin inventory label keeps the launchctl command sequence", async () => {
  const calls = [];
  const run = async (program, args) => {
    calls.push({ program, args });
    if (args[0] === "print") {
      const label = args[1].split("/").at(-1);
      return {
        code: 0,
        stdout: `state = running\nprogram = /srv/shared/bin/agentos-service-wrapper.mjs ${label}\n`,
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const control = createServiceControl({ inventory: DEFAULT_INVENTORY, platform: "darwin", uid: 501, run });

  for (const label of SERVICE_LABELS) {
    await control.restart(label);
    assert.equal(await control.isRunning(label), true);
    assert.match(await control.describe(label), new RegExp(`${label}$`, "mu"));
  }

  assert.deepEqual(calls.map(({ program, args }) => [program, args]), SERVICE_LABELS.flatMap((label) => [
    ["/bin/launchctl", ["kickstart", "-k", `gui/501/${label}`]],
    ["/bin/launchctl", ["print", `gui/501/${label}`]],
    ["/bin/launchctl", ["print", `gui/501/${label}`]],
  ]));
});

test("the sudoers grant is exactly the set of commands service control can issue", async () => {
  const serviceUser = "anneal-test";
  const issueEveryCommand = async (euid) => {
    const issued = [];
    const run = async (program, args) => {
      issued.push([program, ...args].join(" "));
      return { code: 0, stdout: "active\n", stderr: "" };
    };
    const control = createServiceControl({ inventory: DEFAULT_INVENTORY, platform: "linux", euid, run });
    for (const label of SERVICE_LABELS) {
      await control.restart(label);
      assert.equal(await control.isRunning(label), true);
      await control.describe(label);
    }
    return issued;
  };

  const asRoot = await issueEveryCommand(0);
  const asServiceUser = (await issueEveryCommand(1000)).map((command) => {
    assert.equal(command.startsWith("sudo -n "), true, command);
    return command.slice("sudo -n ".length);
  });
  assert.deepEqual(asServiceUser, asRoot);
  assert.equal(asRoot.length, SERVICE_LABELS.length * 3);

  const prefix = `${serviceUser} ALL=(root) NOPASSWD: `;
  const grant = renderSystemdSudoers({ serviceUser, inventory: DEFAULT_INVENTORY }).trim();
  assert.equal(grant.startsWith(prefix), true, grant);
  const granted = grant.slice(prefix.length).split(", ");
  assert.equal(granted.length, new Set(granted).size, "the grant repeats a command");
  assert.deepEqual([...new Set(granted)].sort(), [...new Set(asServiceUser)].sort());
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
