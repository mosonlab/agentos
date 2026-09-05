import { DeployFailure } from "./quiet-window-lib.mjs";
import { resolveServicePlatform } from "./service-platform.mjs";

/**
 * The unit name is read out of the inventory this invocation resolved, so a
 * control call cannot name a service the installer did not install and callers
 * get no opportunity to pass a different systemd unit name.
 */
export const serviceUnitName = (label, inventory) => {
  if (typeof label !== "string" || label.length === 0 || /[\s/]/u.test(label)) {
    throw new DeployFailure("service-control-label-invalid", String(label));
  }
  const entry = inventory?.entries?.find((candidate) => candidate.label === label);
  if (!entry) throw new DeployFailure("service-control-label-invalid", String(label));
  return entry.unitName;
};

const uidOf = () => {
  if (typeof process.getuid === "function") return process.getuid();
  return 0;
};

const euidOf = () => {
  if (typeof process.geteuid === "function") return process.geteuid();
  return uidOf();
};

const commandOutput = (result) => `${result?.stdout ?? ""}${result?.stderr ?? ""}`;

const missingExecutable = (errorOrResult) => {
  const code = errorOrResult?.code;
  if (code === "ENOENT") return true;
  return /(?:ENOENT|not found|no such file)/iu.test(commandOutput(errorOrResult));
};

/* DeployFailure intentionally has a small constructor in the existing
 * deployment code.  Keep the useful cause in the detail while retaining the
 * stable public `service-control-denied:<unit>` message. */
const deniedFailure = (unit, cause = "command-refused") => {
  const failure = new DeployFailure("service-control-denied", unit);
  failure.cause = cause;
  return failure;
};

const controlFailure = (verb, unit, result) => {
  const diagnosis = commandOutput(result).trim().replaceAll(/\s+/gu, " ").slice(-2_000);
  return new DeployFailure(`service-control-failed:${verb}:${unit}`, diagnosis || `exit-${result?.code ?? "unknown"}`);
};

const sudoDenied = (result) => /(?:^|\s)sudo:|password is required|not allowed to execute|a password is required/iu
  .test(commandOutput(result));

const unavailableFailure = (binary, cause = "missing") =>
  new DeployFailure(`service-control-${binary}-unavailable`, cause);

const normalizeResult = (result) => {
  if (result && typeof result === "object") return result;
  return { code: 1, stdout: "", stderr: "invalid-command-result" };
};

/**
 * Bind the deployment's three service-control verbs to one operating-system
 * implementation.  `run` is injected by quiet-window-deploy so its command
 * deadlines and interrupt handling remain the deployment's responsibility;
 * tests can inject a recorder without creating a daemon or requiring sudo.
 *
 * The adapter intentionally exposes text for `describe`: the wrapper-boundary
 * proof belongs to the caller that already owns the resolved invocation and
 * can therefore reject a description containing the wrong wrapper or label.
 *
 * The inventory is supplied by the caller that resolved it for this
 * invocation; this module never resolves one of its own.
 */
export const createServiceControl = ({
  platform = resolveServicePlatform(),
  inventory,
  run,
  checked,
  wrapperPath = "",
  uid = uidOf(),
  euid = euidOf(),
  systemctlBinary = "systemctl",
  sudoBinary = "sudo",
  launchctlBinary = "/bin/launchctl",
  timeoutMs = Object.freeze({
    restart: 30_000,
    inspect: 15_000,
  }),
} = {}) => {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`service-platform-unsupported:${String(platform)}`);
  }
  if (typeof run !== "function") throw new TypeError("service-control-run-required");
  if (typeof wrapperPath !== "string") throw new TypeError("service-control-wrapper-path-invalid");
  if (!Array.isArray(inventory?.entries) || inventory.entries.length === 0
      || inventory.entries.some((entry) => typeof entry?.label !== "string" || typeof entry?.unitName !== "string")) {
    throw new Error("service-control-inventory-invalid");
  }
  const restartTimeoutMs = timeoutMs?.restart ?? 30_000;
  const inspectTimeoutMs = timeoutMs?.inspect ?? 15_000;

  const invoke = async ({
    label,
    verb,
    args,
    options = {},
    inactiveExit = false,
    failureReason = "service-control-failed",
    useChecked = false,
  }) => {
    const unit = serviceUnitName(label, inventory);
    const program = platform === "darwin"
      ? launchctlBinary
      : euid === 0 ? systemctlBinary : sudoBinary;
    const commandArgs = platform === "darwin"
      ? args
      : euid === 0
        ? args
        : ["-n", systemctlBinary, ...args];
    const binaryName = platform === "darwin" ? "launchctl" : euid === 0 ? "systemctl" : "sudo";
    let result;
    try {
      const runOptions = {
        capture: true,
        ...options,
      };
      result = normalizeResult(await (useChecked && typeof checked === "function"
        ? checked(failureReason, program, commandArgs, runOptions)
        : run(program, commandArgs, runOptions)));
    } catch (error) {
      if (missingExecutable(error)) throw unavailableFailure(binaryName, "missing");
      if (error instanceof DeployFailure) {
        // Deadline and interruption failures are already named at the command
        // boundary and must not be disguised as an authorization refusal.
        if (platform === "darwin" || /timeout|interrupted/u.test(error.reason)) throw error;
      }
      const errorResult = { code: error?.code ?? 1, stdout: error?.stdout ?? "", stderr: error?.stderr ?? error?.message ?? String(error) };
      if (platform === "linux" && euid !== 0 && sudoDenied(errorResult)) throw deniedFailure(unit, `${verb}-refused`);
      throw controlFailure(verb, unit, errorResult);
    }

    if (result.code !== 0) {
      if (inactiveExit && platform === "darwin") return result;
      if (inactiveExit) {
        // systemctl is-active uses exit status 3 for an inactive/failed unit.
        // A recorder may return a zero status with a non-active word, so the
        // caller also receives the normalized text below.
        if (platform === "linux" && result.code === 3) return result;
      }
      if (missingExecutable(result)) {
        const targetBinary = platform === "linux" && euid !== 0 ? "systemctl" : binaryName;
        throw unavailableFailure(targetBinary, "missing");
      }
      if (platform === "darwin") {
        const diagnosis = commandOutput(result).trim().replaceAll(/\s+/gu, " ").slice(-2_000);
        throw new DeployFailure(failureReason, `exit-${result.code}${diagnosis ? `: ${diagnosis}` : ""}`);
      }
      if (euid !== 0 && sudoDenied(result)) throw deniedFailure(unit, `${verb}-exit-${result.code}`);
      throw controlFailure(verb, unit, result);
    }
    return result;
  };

  const restart = (label, options = {}) => {
    const reason = options.reason ?? "service-restart-failed";
    const {
      timeoutMs: requestedTimeout,
      timeoutReason,
      ...runOptions
    } = options;
    delete runOptions.reason;
    const timeout = requestedTimeout ?? restartTimeoutMs;
    return invoke({
      label,
      verb: "restart",
      failureReason: reason,
      useChecked: platform === "darwin",
      args: platform === "darwin"
        ? ["kickstart", "-k", `gui/${uid}/${label}`]
        : ["restart", serviceUnitName(label, inventory)],
      options: {
        timeoutMs: timeout,
        timeoutReason: timeoutReason ?? `${reason}-timeout`,
        ...runOptions,
      },
    });
  };

  const isRunning = async (label, options = {}) => {
    const result = await invoke({
      label,
      verb: "is-active",
      inactiveExit: true,
      args: platform === "darwin"
        ? ["print", `gui/${uid}/${label}`]
        : ["is-active", serviceUnitName(label, inventory)],
      options: {
        ...options,
        timeoutMs: options.timeoutMs ?? inspectTimeoutMs,
        timeoutReason: options.timeoutReason ?? "service-inspection-timeout",
      },
    });
    if (platform === "darwin") return /^\s*state = running\s*$/mu.test(result.stdout ?? "");
    return String(result.stdout ?? "").trim() === "active";
  };

  const describe = async (label, options = {}) => {
    const result = await invoke({
      label,
      verb: "show",
      inactiveExit: platform === "darwin",
      args: platform === "darwin"
        ? ["print", `gui/${uid}/${label}`]
        : ["show", "-p", "ExecStart", "--value", serviceUnitName(label, inventory)],
      options: {
        ...options,
        timeoutMs: options.timeoutMs ?? inspectTimeoutMs,
        timeoutReason: options.timeoutReason ?? "service-inspection-timeout",
      },
    });
    return String(result.stdout ?? "");
  };

  return Object.freeze({
    platform,
    wrapperPath,
    restart,
    isRunning,
    describe,
  });
};

/**
 * A shared wrapper-boundary predicate for both launchd's print output and
 * systemd's ExecStart value.  It is exported so tests can exercise the
 * security check without invoking either service manager.
 */
export const describesStableWrapper = ({ description, label, wrapperPath }) =>
  typeof description === "string"
  && typeof wrapperPath === "string"
  && wrapperPath.length > 0
  && typeof label === "string"
  && label.length > 0
  && description.includes(wrapperPath)
  && description.includes(label);
