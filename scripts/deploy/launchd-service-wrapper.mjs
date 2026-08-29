#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_REPOSITORY_ROOT = resolve(SCRIPT_DIR, "../..");

/** The launchd labels are deliberately duplicated here so this file remains a
 * standalone artifact when it is copied outside the source checkout. Keep the
 * list in lockstep with quiet-window-lib.mjs; the wrapper fixture proves that
 * invariant. */
export const SERVICE_LABELS = Object.freeze([
  "com.agentos.api",
  "com.agentos.inbox",
  "com.agentos.runner",
  "com.agentos.runner-2",
  "com.agentos.runner-3",
  "com.agentos.runner-4",
  "com.agentos.runner-5",
  "com.agentos.runner-6",
  "com.agentos.runner-7",
  "com.agentos.runner-8",
  "com.agentos.runner-9",
  "com.agentos.runner-10",
  "com.agentos.web",
]);

const runnerIdForLabel = (label) => label === "com.agentos.runner"
  ? "runner-1"
  : label.startsWith("com.agentos.runner-")
    ? `runner-${label.slice("com.agentos.runner-".length)}`
    : null;

const definition = (label, entrypoint, workingDirectory = ".", args = []) => Object.freeze({
  label,
  entrypoint,
  workingDirectory,
  args: Object.freeze([...args]),
  runnerId: runnerIdForLabel(label),
});

/** Paths are relative to the release selected by the current pointer. The
 * wrapper never starts a process from a resolved releases/ path: keeping the
 * current/ spelling in argv and cwd is what makes the activation boundary
 * visible to launchd and to an operator inspecting a running job. */
export const SERVICE_INVENTORY = Object.freeze(Object.fromEntries([
  definition("com.agentos.api", "packages/api/dist/index.js"),
  definition("com.agentos.inbox", "packages/inbox/dist/index.js"),
  ...SERVICE_LABELS
    .filter((label) => label.startsWith("com.agentos.runner"))
    .map((label) => definition(label, "packages/runner/dist/index.js")),
  definition("com.agentos.web", "node_modules/vite/bin/vite.js", "apps/web", ["preview", "--host", "127.0.0.1"]),
].map((entry) => [entry.label, entry])));

const isInside = (parent, child) => {
  const suffix = relative(parent, child);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix);
};

const requiredPath = (value, name) => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name}-missing`);
  if (!isAbsolute(value)) throw new Error(`${name}-not-absolute`);
  const resolved = resolve(value);
  return resolved;
};

const safePointerName = (value, name) => {
  if (typeof value !== "string" || value === "" || isAbsolute(value) || value.includes("..") || value.includes("/")) {
    throw new Error(`${name}-invalid`);
  }
  return value;
};

const releaseStamp = (releaseRoot) => {
  const path = join(releaseRoot, "packages/api/dist/build-info.json");
  if (!existsSync(path)) return { path, commit: null };
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`release-build-stamp-invalid:${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value?.commit !== "string" || !/^[0-9a-f]{40}$/u.test(value.commit) || value.dirty !== false) {
    throw new Error("release-build-stamp-invalid");
  }
  return { path, commit: value.commit };
};

/** Resolve and validate the one activation pointer. A dangling pointer, a
 * non-symlink current entry, or a target outside releases is a hard startup
 * refusal; a service must never silently fall back to the checkout. */
export const resolveCurrentRelease = ({
  repositoryRoot,
  currentPointer = "current",
  releasesDirectory = "releases",
} = {}) => {
  const root = requiredPath(repositoryRoot ?? SOURCE_REPOSITORY_ROOT, "repository-root");
  const pointerName = safePointerName(currentPointer, "current-pointer");
  const releasesName = safePointerName(releasesDirectory, "releases-directory");
  const currentPath = join(root, pointerName);
  const releasesPath = join(root, releasesName);
  let currentStat;
  try {
    currentStat = lstatSync(currentPath);
  } catch (error) {
    throw new Error(`current-pointer-unavailable:${error?.code ?? "missing"}`);
  }
  if (!currentStat.isSymbolicLink()) throw new Error("current-pointer-not-symlink");
  let releasesRoot;
  let releaseRoot;
  try {
    releasesRoot = realpathSync(releasesPath);
    releaseRoot = realpathSync(currentPath);
  } catch (error) {
    throw new Error(`current-pointer-unavailable:${error?.code ?? "dangling"}`);
  }
  let releaseStat;
  try {
    releaseStat = statSync(releaseRoot);
  } catch (error) {
    throw new Error(`current-release-unavailable:${error?.code ?? "missing"}`);
  }
  if (!releaseStat.isDirectory()) throw new Error("current-release-not-directory");
  if (!isInside(releasesRoot, releaseRoot)) throw new Error("current-pointer-outside-releases");
  const releaseIdentity = releaseRoot.slice(releasesRoot.length + 1).split("/")[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(releaseIdentity)) throw new Error("current-release-identity-invalid");
  const stamp = releaseStamp(releaseRoot);
  const identityCommit = releaseIdentity.split("-", 1)[0];
  if (stamp.commit && identityCommit.length === 40 && stamp.commit !== identityCommit) {
    throw new Error("current-release-build-stamp-mismatch");
  }
  return Object.freeze({
    repositoryRoot: root,
    currentPath,
    releasesRoot,
    releaseRoot,
    releaseIdentity,
    releaseCommit: stamp.commit ?? (identityCommit.length === 40 ? identityCommit : null),
    buildStampPath: stamp.path,
  });
};

const parseQuotedValue = (value) => {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll(/\\([\\"nrt])/gu, (_match, escaped) => ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" }[escaped]));
  }
  return value.replace(/\s+#.*$/u, "").trimEnd();
};

/** Parse only the portable dotenv subset needed by the launchd environment.
 * No expansion is performed: an operator's shared file is data, not a shell
 * program, and inherited launchd variables retain dotenv's non-override rule. */
export const parseSharedEnvironment = (contents) => {
  if (typeof contents !== "string") throw new Error("shared-environment-invalid");
  const values = {};
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(trimmed);
    if (!match) continue;
    values[match[1]] = parseQuotedValue(match[2]);
  }
  return Object.freeze(values);
};

const sharedPaths = (root, environment) => {
  const configured = environment.AGENTOS_SHARED_ROOT ?? environment.DEPLOY_SHARED_ROOT ?? join(root, "shared");
  const sharedRoot = requiredPath(configured, "shared-root");
  let sharedStat;
  try { sharedStat = statSync(sharedRoot); } catch (error) { throw new Error(`shared-root-unavailable:${error?.code ?? "missing"}`); }
  if (!sharedStat.isDirectory()) throw new Error("shared-root-not-directory");
  const sharedEnvironmentPath = requiredPath(
    environment.AGENTOS_SHARED_ENV_FILE ?? join(sharedRoot, ".env"),
    "shared-environment-path",
  );
  if (!isInside(sharedRoot, sharedEnvironmentPath)) throw new Error("shared-environment-outside-root");
  let environmentStat;
  try { environmentStat = statSync(sharedEnvironmentPath); } catch (error) { throw new Error(`shared-environment-unavailable:${error?.code ?? "missing"}`); }
  if (!environmentStat.isFile()) throw new Error("shared-environment-not-file");
  return Object.freeze({
    sharedRoot,
    sharedEnvironmentPath,
    values: parseSharedEnvironment(readFileSync(sharedEnvironmentPath, "utf8")),
  });
};

const envWithSharedConfig = (environment, shared) => {
  const values = { ...environment };
  for (const [key, value] of Object.entries(shared.values)) {
    if (values[key] === undefined) values[key] = value;
  }
  values.AGENTOS_SHARED_ROOT = shared.sharedRoot;
  values.DEPLOY_SHARED_ROOT = shared.sharedRoot;
  values.AGENTOS_SHARED_ENV_FILE = shared.sharedEnvironmentPath;
  // Existing service modules load dotenv relative to their module URL. The
  // file is intentionally absent from releases; this path gives the same
  // configuration source to those modules through inherited process.env.
  values.DOTENV_CONFIG_PATH = shared.sharedEnvironmentPath;
  // A launchd environment can outlive the checkout that created it. Preserve
  // an explicit operator path only when it is already below shared/; stale
  // values inherited from an old plist must not send mutable state into a
  // release or back into a home-directory checkout.
  const sharedDefault = (key, suffix) => {
    const configured = values[key];
    if (typeof configured === "string" && configured !== "") {
      if (isInside(shared.sharedRoot, resolve(configured))) return;
      throw new Error(`shared-persistent-path-outside-root:${key}`);
    }
    values[key] = join(shared.sharedRoot, suffix);
  };
  sharedDefault("FILES_ROOT", "files");
  sharedDefault("RUNNER_WORKSPACE_ROOT", "runs");
  sharedDefault("RUNNER_DEPENDENCY_CACHE_ROOT", "dependency-cache");
  sharedDefault("RUNNER_REPO_MIRROR_ROOT", "repo-mirrors");
  sharedDefault("CONTROL_PLANE_STATE_DIR", "state");
  return values;
};

const assertEntryPoint = (path, label) => {
  try {
    const info = statSync(path);
    if (!info.isFile()) throw new Error("not-file");
  } catch (error) {
    throw new Error(`service-entrypoint-unavailable:${label}:${error instanceof Error ? error.message : error?.code ?? String(error)}`);
  }
};

/** Build the exact launch invocation for one service. This is also the seam
 * used by the inventory fixture: every label must expose a current/ argv,
 * shared config path, and the same release identity. */
export const resolveServiceInvocation = ({
  repositoryRoot,
  label,
  environment = process.env,
  nodeBinary = environment.DEPLOY_NODE_BINARY ?? process.execPath,
} = {}) => {
  const service = SERVICE_INVENTORY[label];
  if (!service) throw new Error(`service-label-unknown:${String(label)}`);
  const pointer = resolveCurrentRelease({
    repositoryRoot,
    currentPointer: environment.AGENTOS_CURRENT_POINTER ?? "current",
    releasesDirectory: environment.AGENTOS_RELEASES_DIRECTORY ?? "releases",
  });
  if (existsSync(join(pointer.releaseRoot, ".env"))) throw new Error("release-contains-shared-config");
  const shared = sharedPaths(pointer.repositoryRoot, environment);
  const currentEntrypoint = join(pointer.currentPath, service.entrypoint);
  const currentWorkingDirectory = join(pointer.currentPath, service.workingDirectory);
  assertEntryPoint(currentEntrypoint, label);
  try {
    if (!statSync(currentWorkingDirectory).isDirectory()) throw new Error("not-directory");
  } catch (error) {
    throw new Error(`service-working-directory-unavailable:${label}:${error instanceof Error ? error.message : error?.code ?? String(error)}`);
  }
  if (typeof nodeBinary !== "string" || !isAbsolute(nodeBinary)) throw new Error("service-node-binary-not-absolute");
  const childEnvironment = envWithSharedConfig(environment, shared);
  const releaseCommit = pointer.releaseCommit ?? pointer.releaseIdentity.split("-", 1)[0];
  childEnvironment.AGENTOS_REPOSITORY_ROOT = pointer.repositoryRoot;
  childEnvironment.AGENTOS_CURRENT_PATH = pointer.currentPath;
  childEnvironment.AGENTOS_RELEASE_ROOT = pointer.currentPath;
  childEnvironment.AGENTOS_RELEASE_REALPATH = pointer.releaseRoot;
  childEnvironment.AGENTOS_RELEASE_ID = pointer.releaseIdentity;
  childEnvironment.AGENTOS_TARGET_RELEASE_ID = pointer.releaseIdentity;
  childEnvironment.DEPLOY_RELEASE_ID = pointer.releaseIdentity;
  childEnvironment.ANNEAL_RELEASE_ID = pointer.releaseIdentity;
  childEnvironment.AGENTOS_RELEASE_COMMIT = releaseCommit;
  childEnvironment.DEPLOY_RELEASE_COMMIT = releaseCommit;
  childEnvironment.AGENTOS_BUILD_STAMP_PATH = join(pointer.currentPath, "packages/api/dist/build-info.json");
  childEnvironment.AGENTOS_SERVICE_LABEL = label;
  childEnvironment.NODE_ENV ??= "production";
  childEnvironment.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  if (service.runnerId) {
    childEnvironment.RUNNER_ID ??= service.runnerId;
    childEnvironment.RUNNER_PATH ??= childEnvironment.PATH;
  }
  return Object.freeze({
    label,
    program: nodeBinary,
    args: Object.freeze([currentEntrypoint, ...service.args]),
    cwd: currentWorkingDirectory,
    env: Object.freeze(childEnvironment),
    currentEntrypoint,
    currentWorkingDirectory,
    sharedRoot: shared.sharedRoot,
    sharedEnvironmentPath: shared.sharedEnvironmentPath,
    releaseIdentity: pointer.releaseIdentity,
    releaseCommit,
    releaseRoot: pointer.releaseRoot,
  });
};

/** Verify a complete service inventory through injectable launch and readiness
 * adapters. Production callers can bind these to launchctl and /version; unit
 * fixtures bind them to a deterministic fake so no daemon or network is needed.
 * Both adapters receive the resolved current/ invocation and release identity. */
export const verifyServiceInventory = async ({
  repositoryRoot,
  labels = SERVICE_LABELS,
  environment = process.env,
  start = async () => ({ ok: true }),
  readiness = async () => ({ ok: true }),
} = {}) => {
  if (!Array.isArray(labels) || labels.length !== SERVICE_LABELS.length || new Set(labels).size !== labels.length) {
    throw new Error("service-inventory-invalid");
  }
  const verified = [];
  for (const label of labels) {
    const invocation = resolveServiceInvocation({ repositoryRoot, label, environment });
    const started = await start(invocation);
    if (started === false || started?.ok === false) throw new Error(`service-start-failed:${label}`);
    const startedIdentity = started?.targetReleaseId ?? started?.releaseIdentity;
    if (startedIdentity !== undefined && startedIdentity !== invocation.releaseIdentity) {
      throw new Error(`service-release-mismatch:${label}`);
    }
    const health = await readiness({ label, invocation, started, releaseIdentity: invocation.releaseIdentity });
    const ready = typeof health === "boolean" ? health : health?.ok !== false;
    if (!ready) throw new Error(`service-readiness-failed:${label}`);
    const reportedIdentity = health?.releaseIdentity ?? health?.targetReleaseId;
    if (reportedIdentity !== undefined && reportedIdentity !== invocation.releaseIdentity) {
      throw new Error(`service-version-mismatch:${label}`);
    }
    verified.push(Object.freeze({
      label,
      releaseIdentity: invocation.releaseIdentity,
      releaseCommit: invocation.releaseCommit,
      currentEntrypoint: invocation.currentEntrypoint,
      sharedRoot: invocation.sharedRoot,
      sharedEnvironmentPath: invocation.sharedEnvironmentPath,
    }));
  }
  return Object.freeze(verified);
};

const waitForChild = (child) => new Promise((resolveChild) => {
  child.once("error", () => resolveChild(1));
  child.once("exit", (code, signal) => resolveChild(typeof code === "number" ? code : signal ? 1 : 0));
});

/** Entrypoint used by every service plist. It emits a non-secret, parseable
 * identity line before handing off to the release process. */
export const runLaunchdService = async ({
  args = process.argv.slice(2),
  environment = process.env,
  spawnProcess = spawn,
  output = process.stdout,
} = {}) => {
  if (args.length !== 1 || !SERVICE_INVENTORY[args[0]]) throw new Error("usage: launchd-service-wrapper.mjs <service-label>");
  const label = args[0];
  const invocation = resolveServiceInvocation({
    repositoryRoot: environment.AGENTOS_REPOSITORY_ROOT ?? environment.DEPLOY_REPOSITORY_ROOT ?? SOURCE_REPOSITORY_ROOT,
    label,
    environment,
  });
  output.write(`SERVICE-WRAPPER service=${label} release=${invocation.releaseIdentity} entrypoint=${invocation.currentEntrypoint}\n`);
  const child = spawnProcess(invocation.program, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: "inherit",
  });
  const forwardSignal = (signal) => { try { child.kill(signal); } catch { /* child already exited */ } };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  try {
    return await waitForChild(child);
  } finally {
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
  }
};

const isEntryPoint = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  runLaunchdService().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`STOP ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
