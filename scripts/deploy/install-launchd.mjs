#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  chownSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveServicePlatform } from "./service-platform.mjs";

import {
  SERVICE_INVENTORY,
  SERVICE_LABELS,
  resolveCurrentRelease,
} from "./launchd-service-wrapper.mjs";
import {
  DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  deployReleaseArtifactPaths,
  workspaceDependencyPaths,
} from "./release-artifacts.mjs";
import { assembleReleaseDirectory } from "./release-directory.mjs";
import { activateReleasePointer } from "./release-pointer.mjs";
import { DeployFailure } from "./quiet-window-lib.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "../..");
const TEMPLATE = join(SCRIPT_DIR, "com.agentos.auto-deploy.plist.in");
const LABEL = "com.agentos.auto-deploy";
const SERVICE_TEMPLATE = join(SCRIPT_DIR, "com.agentos.service.plist.in");
const SYSTEMD_SERVICE_TEMPLATE = join(SCRIPT_DIR, "com.agentos.service.unit.in");
const SYSTEMD_AUTO_DEPLOY_TEMPLATE = join(SCRIPT_DIR, "com.agentos.auto-deploy.unit.in");
const SYSTEMD_AUTO_DEPLOY_TIMER_TEMPLATE = join(SCRIPT_DIR, "com.agentos.auto-deploy.timer.in");
const SERVICE_WRAPPER_SOURCE = join(SCRIPT_DIR, "launchd-service-wrapper.mjs");
const SERVICE_INSTALL_ROOT = ".agentos-deploy/launchd";
const AUTO_DEPLOY_INSTALL_ROOT = ".agentos-deploy/launchd-auto-deploy";
const SYSTEMD_UNIT_DIRECTORY = "/etc/systemd/system";
const SYSTEMD_SUDOERS_PATH = "/etc/sudoers.d/anneal-service-control";
const SHARED_RUNTIME_DIRECTORIES = Object.freeze([
  "files",
  "runs",
  "dependency-cache",
  "repo-mirrors",
  "state",
]);

const xml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const requiredBinary = (name) => {
  let path;
  try {
    path = execFileSync("/usr/bin/which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error(`required-binary-unavailable:${name}`);
  }
  if (!path.startsWith("/")) throw new Error(`required-binary-not-absolute:${name}`);
  const resolved = realpathSync(path);
  try { accessSync(resolved, fsConstants.X_OK); } catch { throw new Error(`required-binary-not-executable:${name}`); }
  return resolved;
};

const requiredConfiguredBinary = (path, name) => {
  if (!path?.startsWith("/")) throw new Error(`backup-configuration-invalid:${name}-must-be-an-absolute-path`);
  let resolved;
  try { resolved = realpathSync(path); } catch { throw new Error(`backup-configuration-invalid:${name}-missing`); }
  try { accessSync(resolved, fsConstants.X_OK); } catch { throw new Error(`backup-configuration-invalid:${name}-not-executable`); }
  return resolved;
};

export const controlledLaunchdPath = ({ nodeBinary, gitBinary }) =>
  [...new Set([dirname(nodeBinary), dirname(gitBinary), "/usr/local/bin", "/usr/bin", "/bin"])].join(":");

export const verifyRenderedToolchain = (values, execute = execFileSync) => {
  const options = {
    env: { PATH: values.path },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    execute(values.nodeBinary, ["--version"], options);
    execute(values.gitBinary, ["--version"], options);
    execute(values.nodeBinary, [values.npmBinary, "--version"], options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`rendered-toolchain-unexecutable:${detail}`);
  }
};

const optionValue = (args, option) => {
  const indexes = args.flatMap((argument, index) => argument === option ? [index] : []);
  if (indexes.length !== 1 || indexes[0] === args.length - 1 || args[indexes[0] + 1].startsWith("--")) {
    throw new Error(`installer-option-required:${option}`);
  }
  return args[indexes[0] + 1];
};

export const parseInstallerArgs = (args) => {
  const applyCount = args.filter((argument) => argument === "--apply").length;
  if (applyCount > 1) throw new Error("installer-option-repeated:--apply");
  const installUnitsCount = args.filter((argument) => argument === "--install-units").length;
  if (installUnitsCount > 1) throw new Error("installer-option-repeated:--install-units");
  const revertCount = args.filter((argument) => argument === "--revert").length;
  if (revertCount > 1) throw new Error("installer-option-repeated:--revert");
  const hasMode = args.includes("--pg-dump-mode");
  const mode = hasMode ? optionValue(args, "--pg-dump-mode") : null;
  const allowed = new Set(["--apply", "--install-units", "--revert", "--pg-dump-mode", "--service-user"]);
  const backup = mode === null ? null : { mode };
  if (mode === "container") {
    allowed.add("--docker-binary");
    allowed.add("--pg-dump-container");
    allowed.add("--container-pg-dump-binary");
    backup.dockerBinary = optionValue(args, "--docker-binary");
    backup.container = optionValue(args, "--pg-dump-container");
    backup.pgDumpBinary = optionValue(args, "--container-pg-dump-binary");
  } else if (mode === "host") {
    allowed.add("--pg-dump-binary");
    backup.pgDumpBinary = optionValue(args, "--pg-dump-binary");
  } else if (mode !== null) {
    throw new Error("backup-configuration-invalid:pg-dump-mode-must-be-host-or-container");
  }
  const serviceUser = args.includes("--service-user") ? optionValue(args, "--service-user") : undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`installer-option-unexpected-value:${argument}`);
    if (!allowed.has(argument)) throw new Error(`installer-option-unknown:${argument}`);
    if (["--apply", "--install-units", "--revert"].includes(argument)) continue;
    index += 1;
  }
  if (mode === null && !args.includes("--install-units") && !args.includes("--revert")) {
    throw new Error("backup-configuration-invalid:pg-dump-mode-must-be-host-or-container");
  }
  return {
    apply: applyCount === 1,
    installUnits: installUnitsCount === 1,
    revert: revertCount === 1,
    serviceUser,
    backup,
  };
};

export const verifyBackupConfiguration = (backup, execute = execFileSync) => {
  if (backup.mode === "host") {
    return Object.freeze({ mode: "host", pgDumpBinary: requiredConfiguredBinary(backup.pgDumpBinary, "pg-dump-binary") });
  }
  if (backup.mode !== "container") throw new Error("backup-configuration-invalid:unsupported-mode");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(backup.container ?? "")) {
    throw new Error("backup-configuration-invalid:pg-dump-container-invalid");
  }
  if (!backup.pgDumpBinary?.startsWith("/")) {
    throw new Error("backup-configuration-invalid:container-pg-dump-binary-must-be-an-absolute-path");
  }
  const dockerBinary = requiredConfiguredBinary(backup.dockerBinary, "docker-binary");
  let running;
  try {
    running = execute(dockerBinary, ["inspect", "--type", "container", "--format", "{{.State.Running}}", backup.container], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`backup-container-unavailable:${backup.container}`);
  }
  if (running !== "true") throw new Error(`backup-container-not-running:${backup.container}`);
  try {
    execute(dockerBinary, ["exec", backup.container, "test", "-x", backup.pgDumpBinary], { stdio: "ignore" });
  } catch {
    throw new Error(`backup-container-pg-dump-not-executable:${backup.pgDumpBinary}`);
  }
  return Object.freeze({
    mode: "container",
    dockerBinary,
    container: backup.container,
    pgDumpBinary: backup.pgDumpBinary,
  });
};

const backupEnvironment = (backup) => {
  const values = backup.mode === "host"
    ? {
        DEPLOY_PG_DUMP_MODE: "host",
        DEPLOY_PG_DUMP_BINARY: backup.pgDumpBinary,
      }
    : {
        DEPLOY_PG_DUMP_MODE: "container",
        DEPLOY_DOCKER_BINARY: backup.dockerBinary,
        DEPLOY_PG_DUMP_CONTAINER: backup.container,
        DEPLOY_CONTAINER_PG_DUMP_BINARY: backup.pgDumpBinary,
      };
  return Object.entries(values)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
};

export const renderLaunchdPlist = (template, values) => {
  const replacements = {
    __NODE_BINARY__: values.nodeBinary,
    __DEPLOY_SCRIPT__: values.deployScript,
    __REPOSITORY_ROOT__: values.repositoryRoot,
    __STDOUT_PATH__: values.stdoutPath,
    __STDERR_PATH__: values.stderrPath,
    __PATH__: values.path,
    __GIT_BINARY__: values.gitBinary,
    __NPM_BINARY__: values.npmBinary,
    __SOURCE_REMOTE__: values.sourceRemote,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, xml(value));
  }
  rendered = rendered.replaceAll("__BACKUP_ENVIRONMENT__", backupEnvironment(values.backup));
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error("launchd-template-has-unresolved-placeholder");
  return rendered;
};

/** Stable paths and plist rendering for the service side of the wrapper-first
 * migration. The auto-deploy plist above intentionally remains a separate
 * definition: installing or reverting service wrappers must not alter the
 * deployment scheduler. */
export const serviceWrapperPath = (repositoryRoot) =>
  join(resolve(repositoryRoot), "shared", "bin", "agentos-service-wrapper.mjs");

/** Materialize the still-serving checkout as the initial immutable release.
 * Existing service definitions continue to run from the checkout during this
 * step; only after current identifies the same bytes can the independently
 * revertible plist migration point them at the stable wrapper. */
export const bootstrapCurrentRelease = ({
  repositoryRoot,
  artifactPaths,
  optionalArtifactPaths,
} = {}) => {
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const sharedEnvironment = join(root, "shared", ".env");
  if (!existsSync(sharedEnvironment)) throw new Error("shared-environment-missing");
  if (existsSync(join(root, "current"))) {
    const current = resolveCurrentRelease({ repositoryRoot: root });
    return Object.freeze({
      releaseName: current.releaseIdentity,
      commit: current.releaseCommit,
      releaseDirectory: current.releaseRoot,
      bootstrapped: false,
    });
  }
  let stamp;
  try { stamp = JSON.parse(readFileSync(join(root, "packages/api/dist/build-info.json"), "utf8")); }
  catch { throw new Error("bootstrap-build-stamp-unreadable"); }
  if (typeof stamp?.commit !== "string" || !/^[0-9a-f]{40}$/u.test(stamp.commit) || stamp.dirty !== false) {
    throw new Error("bootstrap-build-stamp-invalid");
  }
  const selected = artifactPaths ?? deployReleaseArtifactPaths(root);
  const optional = optionalArtifactPaths ?? (artifactPaths === undefined ? [
    ...DEPLOY_OPTIONAL_ARTIFACT_PATHS,
    ...workspaceDependencyPaths(root),
  ] : []);
  const release = assembleReleaseDirectory({
    stageRoot: root,
    deployRoot: root,
    revision: stamp.commit,
    artifactPaths: selected,
    optionalArtifactPaths: optional,
    allowDeployRootInsideStage: true,
    retention: false,
    probeImmutability: true,
  });
  activateReleasePointer({ root, release: release.releaseName });
  return Object.freeze({
    releaseName: release.releaseName,
    commit: release.revision,
    releaseDirectory: release.releaseDirectory,
    bootstrapped: true,
  });
};

export const servicePlistValues = ({
  label,
  nodeBinary,
  repositoryRoot,
  sharedRoot = join(repositoryRoot, "shared"),
  stdoutPath,
  stderrPath,
  path,
  wrapperPath = serviceWrapperPath(repositoryRoot),
}) => {
  if (!SERVICE_INVENTORY[label]) throw new Error(`service-label-unknown:${String(label)}`);
  if (!nodeBinary || !repositoryRoot || !stdoutPath || !stderrPath || !path) {
    throw new Error("service-plist-values-incomplete");
  }
  return Object.freeze({
    label,
    nodeBinary,
    repositoryRoot: resolve(repositoryRoot),
    sharedRoot: resolve(sharedRoot),
    sharedEnvironmentPath: join(resolve(sharedRoot), ".env"),
    stdoutPath,
    stderrPath,
    path,
    ...(SERVICE_INVENTORY[label].runnerId
      ? { runnerId: SERVICE_INVENTORY[label].runnerId, runnerPath: path }
      : {}),
    wrapperPath,
  });
};

export const renderServiceLaunchdPlist = (template, values) => {
  const replacements = {
    __LABEL__: values.label,
    __NODE_BINARY__: values.nodeBinary,
    __WRAPPER_PATH__: values.wrapperPath,
    __REPOSITORY_ROOT__: values.repositoryRoot,
    __SHARED_ROOT__: values.sharedRoot,
    __SHARED_ENV_FILE__: values.sharedEnvironmentPath,
    __PATH__: values.path,
    __STDOUT_PATH__: values.stdoutPath,
    __STDERR_PATH__: values.stderrPath,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) rendered = rendered.replaceAll(placeholder, xml(value));
  const runnerEnvironment = values.runnerId
    ? `    <key>RUNNER_ID</key>\n    <string>${xml(values.runnerId)}</string>\n    <key>RUNNER_PATH</key>\n    <string>${xml(values.runnerPath)}</string>`
    : "";
  rendered = rendered.replaceAll("__RUNNER_ENVIRONMENT__", runnerEnvironment);
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error("launchd-service-template-has-unresolved-placeholder");
  return rendered;
};

/**
 * The service unit deliberately receives the same environment dictionary as
 * the LaunchAgent plist.  Keep this conversion in one place so a new
 * environment key cannot silently land in only one platform's definition.
 */
export const serviceEnvironmentValues = (values) => Object.freeze({
  PATH: values.path,
  DEPLOY_NODE_BINARY: values.nodeBinary,
  AGENTOS_REPOSITORY_ROOT: values.repositoryRoot,
  AGENTOS_SHARED_ROOT: values.sharedRoot,
  AGENTOS_SHARED_ENV_FILE: values.sharedEnvironmentPath,
  AGENTOS_CURRENT_POINTER: "current",
  AGENTOS_RELEASES_DIRECTORY: "releases",
  AGENTOS_SERVICE_LABEL: values.label,
  ...(values.runnerId
    ? { RUNNER_ID: values.runnerId, RUNNER_PATH: values.runnerPath }
    : {}),
});

export const autoDeployEnvironmentValues = (values) => Object.freeze({
  AGENTOS_REPOSITORY_ROOT: values.repositoryRoot,
  PATH: values.path,
  QUIET_WINDOW_POLL_SECONDS: "60",
  DEPLOY_NODE_BINARY: values.nodeBinary,
  DEPLOY_GIT_BINARY: values.gitBinary,
  DEPLOY_NPM_BINARY: values.npmBinary,
  DEPLOY_SOURCE_REMOTE: values.sourceRemote,
  ...(values.backup.mode === "host"
    ? {
        DEPLOY_PG_DUMP_MODE: "host",
        DEPLOY_PG_DUMP_BINARY: values.backup.pgDumpBinary,
      }
    : {
        DEPLOY_PG_DUMP_MODE: "container",
        DEPLOY_DOCKER_BINARY: values.backup.dockerBinary,
        DEPLOY_PG_DUMP_CONTAINER: values.backup.container,
        DEPLOY_CONTAINER_PG_DUMP_BINARY: values.backup.pgDumpBinary,
      }),
});

/** Escape a value for systemd's Environment= parser. Quoting every value
 * keeps whitespace data intact; percent is doubled because systemd expands
 * specifiers while loading unit definitions. */
export const systemdEnvironmentEscape = (value, key = "environment") => {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`systemd-environment-value-invalid:${key}`);
  }
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
};

export const renderSystemdEnvironment = (values) => Object.entries(values)
  .map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error(`systemd-environment-key-invalid:${key}`);
    return `Environment=${key}="${systemdEnvironmentEscape(value, key)}"`;
  })
  .join("\n");

const renderSystemdTemplate = (template, replacements, unresolvedReason) => {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error(unresolvedReason);
  return rendered;
};

export const renderServiceSystemdUnit = (
  template = readFileSync(SYSTEMD_SERVICE_TEMPLATE, "utf8"),
  values,
) => {
  if (typeof values?.serviceUser !== "string" || values.serviceUser === "") {
    throw new Error("systemd-service-user-required");
  }
  if (values.serviceUser === "root") throw new Error("systemd-service-user-root");
  return renderSystemdTemplate(template, {
    __LABEL__: values.label,
    __NODE_BINARY__: values.nodeBinary,
    __WRAPPER_PATH__: values.wrapperPath,
    __REPOSITORY_ROOT__: values.repositoryRoot,
    __SERVICE_USER__: values.serviceUser,
    __ENVIRONMENT__: renderSystemdEnvironment(serviceEnvironmentValues(values)),
  }, "systemd-service-template-has-unresolved-placeholder");
};

export const renderAutoDeploySystemdUnit = (
  template = readFileSync(SYSTEMD_AUTO_DEPLOY_TEMPLATE, "utf8"),
  values,
) => {
  if (typeof values?.serviceUser !== "string" || values.serviceUser === "") {
    throw new Error("systemd-service-user-required");
  }
  if (values.serviceUser === "root") throw new Error("systemd-service-user-root");
  return renderSystemdTemplate(template, {
    __NODE_BINARY__: values.nodeBinary,
    __DEPLOY_SCRIPT__: values.deployScript,
    __REPOSITORY_ROOT__: values.repositoryRoot,
    __SERVICE_USER__: values.serviceUser,
    __ENVIRONMENT__: renderSystemdEnvironment(autoDeployEnvironmentValues(values)),
  }, "systemd-auto-deploy-template-has-unresolved-placeholder");
};

export const renderAutoDeploySystemdTimer = (
  template = readFileSync(SYSTEMD_AUTO_DEPLOY_TIMER_TEMPLATE, "utf8"),
) => renderSystemdTemplate(template, {}, "systemd-auto-deploy-timer-has-unresolved-placeholder");

const unitNameForLabel = (label) => `${label}.service`;

const hasExactDirective = (text, directive, value) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${directive}=${escaped}$`, "mu").test(text);
};

const directiveCount = (text, directive) => (text.match(new RegExp(`^${directive}=`, "gmu")) ?? []).length;

/** Validate the subset of unit syntax that protects the activation boundary.
 * systemd-analyze is an optional stronger parser in the test harness; these
 * checks are always available on both operator platforms. */
export const verifySystemdServiceDefinitions = (definitions, labels = SERVICE_LABELS) => {
  if (!definitions || !Array.isArray(labels) || labels.length !== SERVICE_LABELS.length
      || new Set(labels).size !== labels.length) {
    throw new Error("systemd-service-inventory-invalid");
  }
  for (const label of labels) {
    const rendered = definitions[label];
    if (typeof rendered !== "string") throw new Error(`systemd-service-definition-missing:${label}`);
    if (/__[A-Z_]+__/u.test(rendered)) throw new Error(`systemd-service-definition-unresolved:${label}`);
    if (!hasExactDirective(rendered, "SyslogIdentifier", label)
        || !new RegExp(`^ExecStart=.*(?:^|\\s)${label}(?:\\s|$)`, "mu").test(rendered)) {
      throw new Error(`systemd-service-definition-label-mismatch:${label}`);
    }
    if (!rendered.includes("AGENTOS_CURRENT_POINTER") || !rendered.includes("Environment=AGENTOS_CURRENT_POINTER=\"current\"")) {
      throw new Error(`systemd-service-definition-current-pointer-missing:${label}`);
    }
    if (/^Environment=[^=\s]+=""$/mu.test(rendered)) {
      throw new Error(`systemd-service-definition-empty-assignment:${label}`);
    }
    const required = [
      ["Type", "simple"],
      ["Restart", "always"],
      ["RestartSec", "10"],
      ["StandardOutput", "journal"],
      ["StandardError", "journal"],
      ["After", "network-online.target"],
      ["Wants", "network-online.target"],
      ["WantedBy", "multi-user.target"],
    ];
    for (const [directive, value] of required) {
      if (directiveCount(rendered, directive) !== 1 || !hasExactDirective(rendered, directive, value)) {
        throw new Error(`systemd-service-definition-directive-missing:${label}:${directive}`);
      }
    }
    if (directiveCount(rendered, "User") !== 1 || !/^User=(?!root$)\S+$/mu.test(rendered)) {
      throw new Error(`systemd-service-definition-user-invalid:${label}`);
    }
    for (const directive of ["WorkingDirectory", "ExecStart", "SyslogIdentifier"]) {
      if (directiveCount(rendered, directive) !== 1) {
        throw new Error(`systemd-service-definition-directive-missing:${label}:${directive}`);
      }
    }
    if (/^EnvironmentFile=/mu.test(rendered)) throw new Error(`systemd-service-environment-file-forbidden:${label}`);
  }
  return true;
};

export const verifySystemdAutoDeployDefinitions = ({ service, timer }) => {
  for (const [name, rendered] of [["service", service], ["timer", timer]]) {
    if (typeof rendered !== "string") throw new Error(`systemd-auto-deploy-definition-missing:${name}`);
    if (/__[A-Z_]+__/u.test(rendered)) throw new Error(`systemd-auto-deploy-definition-unresolved:${name}`);
  }
  const required = [
    [service, "Type", "oneshot"],
    [service, "After", "network-online.target"],
    [service, "Wants", "network-online.target"],
    [timer, "OnBootSec", "60"],
    [timer, "OnUnitActiveSec", "300"],
    [timer, "Unit", `${LABEL}.service`],
    [timer, "WantedBy", "timers.target"],
  ];
  for (const [rendered, directive, value] of required) {
    if (directiveCount(rendered, directive) !== 1 || !hasExactDirective(rendered, directive, value)) {
      throw new Error(`systemd-auto-deploy-definition-directive-missing:${directive}`);
    }
  }
  for (const directive of ["User", "WorkingDirectory", "ExecStart"]) {
    if (directiveCount(service, directive) !== 1) {
      throw new Error(`systemd-auto-deploy-definition-directive-missing:${directive}`);
    }
  }
  if (/^EnvironmentFile=/mu.test(service)) throw new Error("systemd-auto-deploy-environment-file-forbidden");
  return true;
};

/** Verify the complete rendered inventory before any LaunchAgent file is
 * touched. The checks intentionally inspect the launchd contract itself, not
 * only the source inputs: a plist that still contains a source checkout path
 * or an unresolved placeholder must never reach launchctl. */
export const verifyServicePlistDefinitions = (definitions, labels = SERVICE_LABELS) => {
  if (!definitions || !Array.isArray(labels) || labels.length !== SERVICE_LABELS.length || new Set(labels).size !== labels.length) {
    throw new Error("launchd-service-inventory-invalid");
  }
  for (const label of labels) {
    const rendered = definitions[label];
    if (typeof rendered !== "string") throw new Error(`launchd-service-definition-missing:${label}`);
    if (/__[A-Z_]+__/u.test(rendered)) throw new Error(`launchd-service-definition-unresolved:${label}`);
    if (!new RegExp(`<key>Label</key>\\s*<string>${xml(label)}</string>`, "u").test(rendered)) {
      throw new Error(`launchd-service-definition-label-mismatch:${label}`);
    }
    if (!rendered.includes("<key>ProgramArguments</key>")) throw new Error(`launchd-service-definition-program-missing:${label}`);
    if (!rendered.includes("AGENTOS_REPOSITORY_ROOT") || !rendered.includes("AGENTOS_SHARED_ROOT")) {
      throw new Error(`launchd-service-definition-path-environment-missing:${label}`);
    }
    if (!rendered.includes("AGENTOS_CURRENT_POINTER") || !rendered.includes("<string>current</string>")) {
      throw new Error(`launchd-service-definition-current-pointer-missing:${label}`);
    }
    if (/<string>\s*<\/string>/u.test(rendered)) throw new Error(`launchd-service-definition-empty-string:${label}`);
  }
  return true;
};

const PLUTIL = "/usr/bin/plutil";
const PYTHON3 = "/usr/bin/python3";

// launchd installation is a macOS operation, but the merge gate exercises the
// migration on Linux. Python's standard plistlib keeps that test on the real
// plist mutation path without adding a production runtime dependency.
const PYTHON_PLISTLIB = String.raw`
import json
import plistlib
import sys

args = sys.argv[1:]
path = args[-1]
with open(path, "rb") as source:
    root = plistlib.load(source)

def parent_for(key_path):
    parts = key_path.split(".")
    parent = root
    for part in parts[:-1]:
        parent = parent[part]
    return parent, parts[-1]

if args[0] == "-convert" and args[1] == "json":
    print(json.dumps(root))
    sys.exit(0)

if args[0] == "-remove":
    parent, key = parent_for(args[1])
    del parent[key]
elif args[0] in ("-replace", "-insert"):
    parent, key = parent_for(args[1])
    value_type = args[2]
    if value_type == "-dictionary":
        value = {}
    elif value_type == "-json":
        value = json.loads(args[3])
    elif value_type == "-string":
        value = args[3]
    else:
        raise ValueError(f"unsupported plist value type: {value_type}")
    parent[key] = value
elif not (args[0] == "-convert" and args[1] == "xml1"):
    raise ValueError(f"unsupported plist operation: {args}")

with open(path, "wb") as destination:
    plistlib.dump(root, destination, fmt=plistlib.FMT_XML, sort_keys=False)
`;

const execPlist = (args, options) => {
  if (existsSync(PLUTIL)) return execFileSync(PLUTIL, args, options);
  if (!existsSync(PYTHON3)) throw new Error(`plist-tool-unavailable:${PLUTIL}:${PYTHON3}`);
  return execFileSync(PYTHON3, ["-c", PYTHON_PLISTLIB, ...args], options);
};

const plistObject = (path) => {
  try {
    return JSON.parse(execPlist(["-convert", "json", "-o", "-", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (error) {
    throw new DeployFailure("launchd-service-definition-invalid", `${path}:${error instanceof Error ? error.message : String(error)}`);
  }
};

const setPlistValue = (path, existing, keyPath, type, value) => {
  const action = existing ? "-replace" : "-insert";
  const args = [action, keyPath, type];
  if (value !== undefined) args.push(value);
  args.push(path);
  execPlist(args, { stdio: ["ignore", "ignore", "pipe"] });
};

/** Patch only the stable wrapper boundary into an existing definition. plutil
 * performs the mutation so unknown launchd value types and lifecycle keys stay
 * byte-for-byte meaningful instead of being reinterpreted by this installer. */
const renderMigratedServicePlist = ({ sourcePath, values }) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agentos-launchd-plist-"));
  const temporary = join(temporaryRoot, "service.plist");
  try {
    copyFileSync(sourcePath, temporary);
    const original = plistObject(temporary);
    if (original.Label !== values.label) throw new DeployFailure("launchd-service-definition-label-mismatch", values.label);
    const environment = original.EnvironmentVariables && typeof original.EnvironmentVariables === "object"
      && !Array.isArray(original.EnvironmentVariables)
      ? original.EnvironmentVariables
      : {};
    setPlistValue(temporary, Object.hasOwn(original, "ProgramArguments"), "ProgramArguments", "-json", JSON.stringify([
      values.nodeBinary,
      values.wrapperPath,
      values.label,
    ]));
    setPlistValue(temporary, Object.hasOwn(original, "WorkingDirectory"), "WorkingDirectory", "-string", values.repositoryRoot);
    if (!Object.hasOwn(original, "EnvironmentVariables")) {
      setPlistValue(temporary, false, "EnvironmentVariables", "-dictionary");
    }
    const controlled = {
      DEPLOY_NODE_BINARY: values.nodeBinary,
      AGENTOS_REPOSITORY_ROOT: values.repositoryRoot,
      AGENTOS_SHARED_ROOT: values.sharedRoot,
      AGENTOS_SHARED_ENV_FILE: values.sharedEnvironmentPath,
      AGENTOS_CURRENT_POINTER: "current",
      AGENTOS_RELEASES_DIRECTORY: "releases",
      AGENTOS_SERVICE_LABEL: values.label,
    };
    if (!Object.hasOwn(environment, "PATH")) controlled.PATH = values.path;
    if (values.runnerId) {
      controlled.RUNNER_ID = values.runnerId;
      if (typeof environment.RUNNER_PATH !== "string" || environment.RUNNER_PATH === "") {
        controlled.RUNNER_PATH = values.runnerPath;
      }
    }
    for (const [key, value] of Object.entries(controlled)) {
      setPlistValue(temporary, Object.hasOwn(environment, key), `EnvironmentVariables.${key}`, "-string", value);
    }
    for (const key of values.runnerId ? [] : ["RUNNER_ID", "RUNNER_PATH"]) {
      if (environment[key] === "") execPlist(["-remove", `EnvironmentVariables.${key}`, temporary], { stdio: "ignore" });
    }
    execPlist(["-convert", "xml1", temporary], { stdio: ["ignore", "ignore", "pipe"] });
    return readFileSync(temporary, "utf8");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

export const renderServicePlists = ({
  template = readFileSync(SERVICE_TEMPLATE, "utf8"),
  labels = SERVICE_LABELS,
  ...values
} = {}) => {
  const rendered = Object.fromEntries(labels.map((label) => {
    const serviceValues = servicePlistValues({ label, ...values });
    return [label, renderServiceLaunchdPlist(template, serviceValues)];
  }));
  verifyServicePlistDefinitions(rendered, labels);
  return Object.freeze(rendered);
};

const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

const writeAtomic = (destination, contents, mode) => {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, contents, { flag: "wx", mode });
  chmodSync(temporary, mode);
  try { renameSync(temporary, destination); } finally { rmSync(temporary, { force: true }); }
};

const safeServiceFileName = (label) => label.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

const serviceManifestPath = (repositoryRoot) => join(resolve(repositoryRoot), SERVICE_INSTALL_ROOT, "manifest.json");
const autoDeployManifestPath = (repositoryRoot) => join(resolve(repositoryRoot), AUTO_DEPLOY_INSTALL_ROOT, "manifest.json");

export const serviceUnitName = (label) => unitNameForLabel(label);

const validAccountName = (value) => typeof value === "string"
  && /^[A-Za-z_][A-Za-z0-9_.-]*[$]?$/u.test(value);

/** Resolve the account used by system-level units. The lookup is injectable so
 * the unprivileged renderer can be exercised with a deterministic getent
 * recorder on hosts without Linux account tooling. */
export const resolveSystemdServiceUser = ({
  serviceUser,
  platform = resolveServicePlatform(),
  lookup = null,
  execute = execFileSync,
} = {}) => {
  if (platform === "darwin") {
    if (serviceUser !== undefined && serviceUser !== null) throw new Error("systemd-service-user-not-supported-on-darwin");
    return null;
  }
  if (platform !== "linux") throw new Error(`service-platform-unsupported:${platform}`);
  if (!validAccountName(serviceUser)) throw new Error("systemd-service-user-required");
  if (serviceUser === "root") throw new Error("systemd-service-user-root");
  let record;
  try {
    record = lookup
      ? lookup(serviceUser)
      : execute("getent", ["passwd", serviceUser], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`systemd-service-user-unknown:${serviceUser}`);
  }
  const line = String(record ?? "").trim().split("\n", 1)[0];
  const fields = line.split(":");
  if (fields[0] !== serviceUser || !/^\d+$/u.test(fields[2] ?? "") || Number(fields[2]) === 0) {
    throw new Error(`systemd-service-user-unknown:${serviceUser}`);
  }
  return serviceUser;
};

const systemdCommandPath = (name, configured, execute = execFileSync) => {
  if (configured) {
    if (!configured.startsWith("/")) throw new Error(`systemd-command-not-absolute:${name}`);
    try { accessSync(configured, fsConstants.X_OK); } catch { throw new Error(`systemd-command-unavailable:${name}`); }
    return configured;
  }
  try {
    return requiredBinary(name);
  } catch {
    throw new Error(`systemd-command-unavailable:${name}`);
  }
};

export const renderSystemdSudoers = ({ serviceUser, labels = SERVICE_LABELS, systemctlPath = "/bin/systemctl" } = {}) => {
  if (!validAccountName(serviceUser) || serviceUser === "root") throw new Error("systemd-service-user-invalid");
  if (!Array.isArray(labels) || labels.length !== SERVICE_LABELS.length || new Set(labels).size !== labels.length) {
    throw new Error("systemd-service-inventory-invalid");
  }
  if (typeof systemctlPath !== "string" || systemctlPath === "" || !systemctlPath.startsWith("/")) {
    throw new Error("systemd-command-not-absolute:systemctl");
  }
  const rules = [];
  for (const label of labels) {
    const unit = unitNameForLabel(label);
    rules.push(`${systemctlPath} restart ${unit}`);
    rules.push(`${systemctlPath} show -p ExecStart --value ${unit}`);
    rules.push(`${systemctlPath} is-active ${unit}`);
  }
  return `${serviceUser} ALL=(root) NOPASSWD: ${rules.join(", ")}\n`;
};

const validateSudoers = ({ path, visudoPath, execute = execFileSync }) => {
  try {
    execute(visudoPath, ["-c", "-f", path], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`systemd-sudoers-invalid:${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
};

const fileDigest = (path) => existsSync(path) ? sha256(readFileSync(path)) : null;

const makeSystemdManifestEntry = ({ path, stagedPath, backupPath = null, mode = 0o644 }) => ({
  path,
  stagedPath,
  existed: existsSync(path),
  mode: existsSync(path) ? statSync(path).mode & 0o777 : mode,
  backupPath: existsSync(path) ? backupPath : null,
  originalSha256: fileDigest(path),
  installedSha256: fileDigest(stagedPath),
});

const assertTargetPathSafe = (path, allowedRoot) => {
  const root = resolve(allowedRoot);
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error(`systemd-target-outside-directory:${path}`);
};

const stageFileEntry = ({ entry, replaceExisting = false }) => {
  if (!existsSync(entry.path)) return;
  const current = fileDigest(entry.path);
  if (current !== entry.originalSha256) throw new Error(`systemd-target-read-failed:${entry.path}`);
  if (current !== entry.installedSha256 && !replaceExisting) {
    throw new Error(`systemd-definition-conflict:${entry.path}`);
  }
};

const readStageEntries = (manifest, root) => {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.platform !== "linux"
      || manifest.repositoryRoot !== resolve(root) || !Array.isArray(manifest.entries)
      || manifest.entries.length !== SERVICE_LABELS.length + 1) {
    throw new Error("systemd-service-manifest-invalid");
  }
  const auxiliaryEntries = Array.isArray(manifest.auxiliaryEntries) ? manifest.auxiliaryEntries : [];
  return [...manifest.entries, ...auxiliaryEntries];
};

const copyStagedEntry = ({ entry, unitDirectory, sudoersPath, strictOwner = true }) => {
  if (!entry.stagedPath || !existsSync(entry.stagedPath)) throw new Error(`systemd-staged-file-missing:${entry.stagedPath ?? entry.path}`);
  if (fileDigest(entry.stagedPath) !== entry.installedSha256) throw new Error(`systemd-staged-file-drift:${entry.stagedPath}`);
  if (entry.path.startsWith(`${unitDirectory}/`)) assertTargetPathSafe(entry.path, unitDirectory);
  if (entry.path === sudoersPath) assertTargetPathSafe(entry.path, dirname(sudoersPath));
  const parent = dirname(entry.path);
  const parentExisted = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  copyFileSync(entry.stagedPath, entry.path);
  chmodSync(entry.path, entry.path.endsWith("agentos-service-wrapper.mjs") ? 0o755 : entry.kind === "sudoers" ? 0o440 : 0o644);
  const ownerUid = entry.kind === "wrapper" ? entry.stagedUid : 0;
  const ownerGid = entry.kind === "wrapper" ? entry.stagedGid : 0;
  try {
    chownSync(entry.path, ownerUid, ownerGid);
    if (entry.kind === "wrapper" && !parentExisted) chownSync(parent, ownerUid, ownerGid);
  } catch (error) {
    if (strictOwner) throw new Error(`systemd-install-owner-failed:${entry.path}:${error instanceof Error ? error.message : String(error)}`);
  }
};

const runSystemctl = ({ systemctlPath, args, unit = "", execute = execFileSync }) => {
  try {
    execute(systemctlPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("systemd-systemctl-unavailable");
    const verb = args[0] ?? "command";
    throw new Error(`systemd-control-failed:${verb}${unit ? `:${unit}` : ""}`);
  }
};

const systemdManifestPath = serviceManifestPath;

const stagingFile = (stagingRoot, relativePath) => join(stagingRoot, relativePath);

const stageSystemdDefinition = ({ stagingRoot, relativePath, contents, mode = 0o644 }) => {
  const path = stagingFile(stagingRoot, relativePath);
  writeAtomic(path, contents, mode);
  return path;
};

const backupSystemdTarget = ({ stagingRoot, entry }) => {
  if (!entry.existed) return;
  const backup = entry.backupPath;
  if (!backup) throw new Error(`systemd-backup-path-missing:${entry.path}`);
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
  if (existsSync(backup)) {
    if (fileDigest(backup) !== entry.originalSha256) throw new Error(`systemd-backup-conflict:${backup}`);
    return;
  }
  writeFileSync(backup, readFileSync(entry.path), { flag: "wx", mode: 0o600 });
};

const serviceUnitEntry = ({ label, stagedPath, targetPath, stagingRoot }) => {
  const existed = existsSync(targetPath);
  const entry = {
    kind: "service",
    label,
    unit: unitNameForLabel(label),
    path: targetPath,
    stagedPath,
    existed,
    mode: existed ? statSync(targetPath).mode & 0o777 : 0o644,
    backupPath: existed ? join(stagingRoot, "backups", `${safeServiceFileName(label)}.service`) : null,
    originalSha256: existed ? sha256(readFileSync(targetPath)) : null,
    installedSha256: sha256(readFileSync(stagedPath)),
  };
  if (existed && fileDigest(targetPath) !== entry.installedSha256) {
    // A stage can be inspected repeatedly, but replacing a definition which
    // was not explicitly requested would overwrite operator state.
    throw new Error(`systemd-definition-conflict:${targetPath}`);
  }
  return entry;
};

const wrapperEntry = ({ wrapperPath, stagedPath, stagingRoot }) => {
  const existed = existsSync(wrapperPath);
  const stagedStatus = statSync(stagedPath);
  const originalStatus = existed ? statSync(wrapperPath) : null;
  return {
    kind: "wrapper",
    path: wrapperPath,
    stagedPath,
    existed,
    mode: existed ? statSync(wrapperPath).mode & 0o777 : 0o755,
    originalUid: originalStatus?.uid ?? null,
    originalGid: originalStatus?.gid ?? null,
    stagedUid: stagedStatus.uid,
    stagedGid: stagedStatus.gid,
    backupPath: existed ? join(stagingRoot, "backups", "agentos-service-wrapper.mjs") : null,
    originalSha256: existed ? sha256(readFileSync(wrapperPath)) : null,
    installedSha256: sha256(readFileSync(stagedPath)),
  };
};

const auxiliarySystemdEntries = ({ stagingRoot, unitDirectory, sudoersPath }) => {
  const entries = [];
  const unitsRoot = stagingFile(stagingRoot, "units");
  if (existsSync(unitsRoot)) {
    const visit = (path) => {
      for (const name of readdirSync(path)) {
        const child = join(path, name);
        const status = statSync(child);
        if (status.isDirectory()) visit(child);
        else if (name === "os-isolation.conf" && child.includes(".service.d")) {
          const relativePath = child.slice(unitsRoot.length + 1);
          const targetPath = join(unitDirectory, relativePath);
          const existed = existsSync(targetPath);
          entries.push({
            kind: "drop-in",
            path: targetPath,
            stagedPath: child,
            existed,
            mode: existed ? status.mode & 0o777 : 0o644,
            backupPath: existed ? join(stagingRoot, "backups", safeServiceFileName(relativePath)) : null,
            originalSha256: existed ? sha256(readFileSync(targetPath)) : null,
            installedSha256: sha256(readFileSync(child)),
          });
        }
      }
    };
    visit(unitsRoot);
  }
  const stagedSudoers = stagingFile(stagingRoot, "sudoers/anneal-service-control");
  if (existsSync(stagedSudoers)) {
    const existed = existsSync(sudoersPath);
    entries.push({
      kind: "sudoers",
      path: sudoersPath,
      stagedPath: stagedSudoers,
      existed,
      mode: existed ? statSync(sudoersPath).mode & 0o777 : 0o440,
      backupPath: existed ? join(stagingRoot, "backups", "anneal-service-control") : null,
      originalSha256: existed ? sha256(readFileSync(sudoersPath)) : null,
      installedSha256: sha256(readFileSync(stagedSudoers)),
    });
  }
  return entries;
};

const linuxServiceValues = ({ root, labels, nodeBinary, path, serviceUser, wrapper }) => Object.freeze(Object.fromEntries(
  labels.map((label) => {
    const values = servicePlistValues({
      label,
      nodeBinary,
      repositoryRoot: root,
      sharedRoot: join(root, "shared"),
      stdoutPath: join(root, "shared", "logs", `${safeServiceFileName(label)}.stdout.log`),
      stderrPath: join(root, "shared", "logs", `${safeServiceFileName(label)}.stderr.log`),
      path,
      wrapperPath: wrapper,
    });
    return [label, Object.freeze({ ...values, serviceUser })];
  }),
));

const systemdStagePlan = ({
  repositoryRoot,
  nodeBinary = process.execPath,
  gitBinary = null,
  path = null,
  serviceUser,
  labels = SERVICE_LABELS,
  stagingRoot,
  unitDirectory = SYSTEMD_UNIT_DIRECTORY,
  sudoersPath = SYSTEMD_SUDOERS_PATH,
  systemctlPath = "/bin/systemctl",
  visudoPath = null,
  userLookup = null,
  execute = execFileSync,
  apply,
  replaceExisting = false,
} = {}) => {
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const resolvedNode = resolve(nodeBinary);
  const resolvedGit = gitBinary ? resolve(gitBinary) : resolvedNode;
  const controlledPath = path ?? controlledLaunchdPath({ nodeBinary: resolvedNode, gitBinary: resolvedGit });
  const account = resolveSystemdServiceUser({ serviceUser, platform: "linux", lookup: userLookup, execute });
  const wrapper = serviceWrapperPath(root);
  const stageRoot = resolve(stagingRoot ?? join(root, SERVICE_INSTALL_ROOT, "staging"));
  const resolvedUnitDirectory = resolve(unitDirectory);
  const resolvedSudoersPath = resolve(sudoersPath);
  const rendered = linuxServiceValues({
    root,
    labels,
    nodeBinary: resolvedNode,
    path: controlledPath,
    serviceUser: account,
    wrapper,
  });
  const unitDefinitions = Object.freeze(Object.fromEntries(labels.map((label) => [
    label,
    renderServiceSystemdUnit(readFileSync(SYSTEMD_SERVICE_TEMPLATE, "utf8"), rendered[label]),
  ])));
  verifySystemdServiceDefinitions(unitDefinitions, labels);
  if (!apply) return Object.freeze({
    applied: false,
    reverted: false,
    platform: "linux",
    staging: stageRoot,
    unitDirectory: resolvedUnitDirectory,
    serviceUser: account,
    units: labels.map((label) => join(resolvedUnitDirectory, unitNameForLabel(label))),
    wrapper,
    entries: [wrapper, ...labels.map((label) => join(resolvedUnitDirectory, unitNameForLabel(label)))],
    rendered: unitDefinitions,
  });
  const unitEntries = labels.map((label) => {
    const staged = stageSystemdDefinition({
      stagingRoot: stageRoot,
      relativePath: `units/${unitNameForLabel(label)}`,
      contents: unitDefinitions[label],
    });
    const target = join(resolvedUnitDirectory, unitNameForLabel(label));
    return serviceUnitEntry({ label, stagedPath: staged, targetPath: target, stagingRoot: stageRoot });
  });
  // Stage the wrapper alongside units so a root stage can install the complete
  // manifest atomically. The target is intentionally outside /etc and remains
  // an explicit manifest entry, matching the LaunchAgent installer.
  const wrapperContents = readFileSync(SERVICE_WRAPPER_SOURCE);
  const wrapperTargetExists = existsSync(wrapper);
  const wrapperStagedPath = stageSystemdDefinition({
    stagingRoot: stageRoot,
    relativePath: "wrapper/agentos-service-wrapper.mjs",
    contents: wrapperContents,
    mode: 0o755,
  });
  const wrapperManifestEntry = wrapperEntry({ wrapperPath: wrapper, stagedPath: wrapperStagedPath, stagingRoot: stageRoot });
  if (wrapperTargetExists && fileDigest(wrapper) !== wrapperManifestEntry.installedSha256 && !replaceExisting) {
    throw new Error(`launchd-service-wrapper-conflict:${wrapper}`);
  }
  const sudoers = renderSystemdSudoers({ serviceUser: account, labels, systemctlPath });
  const sudoersStaged = stageSystemdDefinition({
    stagingRoot: stageRoot,
    relativePath: "sudoers/anneal-service-control",
    contents: sudoers,
    mode: 0o440,
  });
  const effectiveVisudo = visudoPath ?? (apply ? systemdCommandPath("visudo", null, execute) : null);
  if (apply && effectiveVisudo) validateSudoers({ path: sudoersStaged, visudoPath: effectiveVisudo, execute });
  const auxiliaryEntries = auxiliarySystemdEntries({
    stagingRoot: stageRoot,
    unitDirectory: resolvedUnitDirectory,
    sudoersPath: resolvedSudoersPath,
  });
  // The generated sudoers was written above and is included by the discovery
  // pass. Do not count it in the primary entries: the service manifest's
  // stable shape is wrapper + one entry per service definition.
  const manifest = {
    schemaVersion: 1,
    platform: "linux",
    repositoryRoot: root,
    serviceUser: account,
    stagingRoot: stageRoot,
    unitDirectory: resolvedUnitDirectory,
    sudoersPath: resolvedSudoersPath,
    entries: [wrapperManifestEntry, ...unitEntries],
    auxiliaryEntries,
  };
  // A stale manifest indicates an active install. Never replace it while a
  // root stage may still be using its recorded files.
  const manifestPath = systemdManifestPath(root);
  if (existsSync(manifestPath)) throw new Error("launchd-service-install-active");
  for (const entry of [...manifest.entries, ...auxiliaryEntries]) {
    stageFileEntry({ entry, replaceExisting });
    backupSystemdTarget({ stagingRoot: stageRoot, entry });
  }
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return Object.freeze({
    applied: true,
    reverted: false,
    platform: "linux",
    staging: stageRoot,
    unitDirectory: resolvedUnitDirectory,
    serviceUser: account,
    units: unitEntries.map((entry) => entry.path),
    wrapper,
    entries: manifest.entries.map((entry) => entry.path),
    manifest,
    manifestPath,
  });
};

export const installStagedSystemdServices = ({
  repositoryRoot,
  manifestPath,
  unitDirectory = SYSTEMD_UNIT_DIRECTORY,
  sudoersPath = SYSTEMD_SUDOERS_PATH,
  systemctlPath = null,
  execute = execFileSync,
  effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : process.getuid(),
  revert = false,
  apply = true,
  } = {}) => {
  const platform = resolveServicePlatform();
  if (platform !== "linux") throw new Error("systemd-installer-unsupported:darwin");
  if (effectiveUid !== 0) throw new Error("systemd-installer-requires-root");
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const path = manifestPath ?? systemdManifestPath(root);
  if (!existsSync(path)) throw new Error("systemd-service-manifest-missing");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const entries = readStageEntries(manifest, root);
  const resolvedUnitDirectory = resolve(unitDirectory ?? manifest.unitDirectory ?? SYSTEMD_UNIT_DIRECTORY);
  const resolvedSudoersPath = resolve(sudoersPath ?? manifest.sudoersPath ?? SYSTEMD_SUDOERS_PATH);
  const systemctl = systemctlPath ?? systemdCommandPath("systemctl", null, execute);
  if (!apply) return Object.freeze({ applied: false, reverted: false, entries: entries.map((entry) => entry.path) });
  for (const entry of entries) {
    const currentSha = fileDigest(entry.path);
    const recognized = currentSha === entry.installedSha256
      || (entry.existed && currentSha === entry.originalSha256)
      || (!entry.existed && currentSha === null);
    if (!recognized) throw new Error(`systemd-service-definition-drift:${entry.path}`);
    if (entry.existed && currentSha === entry.installedSha256) {
      if (!entry.backupPath || !existsSync(entry.backupPath) || fileDigest(entry.backupPath) !== entry.originalSha256) {
        throw new Error(`systemd-service-backup-missing:${entry.path}`);
      }
    }
    if (!revert && fileDigest(entry.stagedPath) !== entry.installedSha256) {
      throw new Error(`systemd-staged-file-drift:${entry.stagedPath}`);
    }
  }
  if (!revert) {
    for (const entry of entries) copyStagedEntry({
      entry,
      unitDirectory: resolvedUnitDirectory,
      sudoersPath: resolvedSudoersPath,
      strictOwner: typeof process.geteuid !== "function" || process.geteuid() === 0,
    });
    runSystemctl({ systemctlPath: systemctl, args: ["daemon-reload"], execute });
    for (const entry of manifest.entries.filter((item) => item.kind === "service")) {
      runSystemctl({ systemctlPath: systemctl, args: ["enable", "--now", entry.unit], unit: entry.unit, execute });
    }
    return Object.freeze({ applied: true, reverted: false, entries: entries.map((entry) => entry.path) });
  }
  const serviceEntries = manifest.entries.filter((entry) => entry.kind === "service");
  for (const entry of serviceEntries) runSystemctl({
    systemctlPath: systemctl,
    args: ["disable", "--now", entry.unit],
    unit: entry.unit,
    execute,
  });
  for (const entry of entries) {
    if (entry.existed) {
      if (fileDigest(entry.path) !== entry.originalSha256) copyFileSync(entry.backupPath, entry.path);
      chmodSync(entry.path, entry.mode ?? 0o644);
      if (entry.kind === "wrapper" && entry.originalUid !== null && entry.originalGid !== null) {
        chownSync(entry.path, entry.originalUid, entry.originalGid);
      }
    } else rmSync(entry.path, { force: true });
    if (entry.backupPath) rmSync(entry.backupPath, { force: true });
  }
  runSystemctl({ systemctlPath: systemctl, args: ["daemon-reload"], execute });
  rmSync(path, { force: true });
  if (manifest.stagingRoot) rmSync(manifest.stagingRoot, { recursive: true, force: true });
  return Object.freeze({ applied: true, reverted: true, entries: entries.map((entry) => entry.path) });
};

const installLinuxServices = (options = {}) => {
  const platform = resolveServicePlatform();
  if (platform !== "linux") throw new Error("systemd-installer-unsupported:darwin");
  const { installUnits = false, revert = false, apply = false } = options;
  if (installUnits) return installStagedSystemdServices(options);
  if (revert) {
    if (apply) return installStagedSystemdServices({ ...options, revert: true, apply: true });
    const root = realpathSync(resolve(options.repositoryRoot ?? REPOSITORY_ROOT));
    const path = options.manifestPath ?? systemdManifestPath(root);
    if (!existsSync(path)) throw new Error("systemd-service-manifest-missing");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const entries = readStageEntries(manifest, root);
    return Object.freeze({ applied: false, reverted: false, entries: entries.map((entry) => entry.path) });
  }
  const callerUid = options.effectiveUid
    ?? (typeof process.geteuid === "function" ? process.geteuid() : process.getuid());
  if (callerUid === 0) throw new Error("launchd-installer-refuses-root");
  return systemdStagePlan(options);
};

const validateServiceManifest = (manifest, repositoryRoot) => {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.repositoryRoot !== resolve(repositoryRoot)) {
    throw new Error("launchd-service-manifest-invalid");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== SERVICE_LABELS.length + 1) {
    throw new Error("launchd-service-manifest-invalid");
  }
  return manifest;
};

/** Install all service plists and one standalone wrapper. No launchctl command
 * or pointer operation is performed here; the caller can load/reload the
 * definitions and verify readiness as a separately revertible rollout step. */
export const installLaunchdServices = ({
  repositoryRoot,
  userHome,
  nodeBinary = process.execPath,
  gitBinary = null,
  path = null,
  apply = false,
  revert = false,
  replaceExisting = false,
  installUnits = false,
  serviceUser,
  stagingRoot,
  unitDirectory,
  sudoersPath,
  systemctlPath,
  visudoPath,
  userLookup,
  effectiveUid,
  execute = execFileSync,
} = {}) => {
  const platform = resolveServicePlatform();
  if (platform === "linux") return installLinuxServices({
    repositoryRoot,
    nodeBinary,
    gitBinary,
    path,
    apply,
    revert,
    replaceExisting,
    installUnits,
    serviceUser,
    stagingRoot,
    unitDirectory,
    sudoersPath,
    systemctlPath,
    visudoPath,
    userLookup,
    effectiveUid,
    execute,
  });
  const callerUid = effectiveUid
    ?? (typeof process.geteuid === "function" ? process.geteuid() : process.getuid());
  if (callerUid === 0) {
    throw new Error("launchd-installer-refuses-root");
  }
  if (installUnits) throw new Error("systemd-installer-unsupported:darwin");
  if (serviceUser !== undefined && serviceUser !== null) throw new Error("systemd-service-user-not-supported-on-darwin");
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const home = resolve(userHome ?? homedir());
  const launchAgents = join(home, "Library/LaunchAgents");
  const logs = join(home, "Library/Logs/Anneal");
  const sharedRoot = join(root, "shared");
  const wrapper = serviceWrapperPath(root);
  const manifestPath = serviceManifestPath(root);
  if (revert) {
    if (!existsSync(manifestPath)) throw new Error("launchd-service-manifest-missing");
    const manifest = validateServiceManifest(JSON.parse(readFileSync(manifestPath, "utf8")), root);
    const observed = new Map();
    for (const entry of manifest.entries) {
      const current = existsSync(entry.path) ? readFileSync(entry.path) : null;
      const currentSha = current === null ? null : sha256(current);
      observed.set(entry.path, currentSha);
      const recognized = currentSha === entry.installedSha256
        || (entry.existed && currentSha === entry.originalSha256)
        || (!entry.existed && currentSha === null);
      if (!recognized) {
        throw new Error(`launchd-service-definition-drift:${entry.path}`);
      }
      if (entry.existed && currentSha === entry.installedSha256) {
        if (!entry.backupPath || !existsSync(entry.backupPath) || sha256(readFileSync(entry.backupPath)) !== entry.originalSha256) {
          throw new DeployFailure("launchd-service-backup-missing", entry.backupPath ?? entry.path);
        }
      }
    }
    if (!apply) return { applied: false, reverted: false, entries: manifest.entries.map((entry) => entry.path) };
    for (const entry of manifest.entries) {
      if (entry.existed) {
        if (observed.get(entry.path) !== entry.originalSha256) {
          const backup = readFileSync(entry.backupPath);
          writeAtomic(entry.path, backup, entry.mode ?? 0o600);
        }
      } else rmSync(entry.path, { force: true });
      if (entry.backupPath) rmSync(entry.backupPath, { force: true });
    }
    rmSync(manifestPath, { force: true });
    return { applied: true, reverted: true, entries: manifest.entries.map((entry) => entry.path) };
  }
  if (existsSync(manifestPath)) throw new Error("launchd-service-install-active");
  const resolvedNode = resolve(nodeBinary);
  const resolvedGit = gitBinary ? resolve(gitBinary) : resolvedNode;
  const controlledPath = path ?? controlledLaunchdPath({ nodeBinary: resolvedNode, gitBinary: resolvedGit });
  const logPath = (label, stream) => join(logs, `${safeServiceFileName(label)}.${stream}.log`);
  const rendered = Object.freeze(Object.fromEntries(SERVICE_LABELS.map((label) => {
    const values = servicePlistValues({
      label,
      nodeBinary: resolvedNode,
      repositoryRoot: root,
      sharedRoot,
      stdoutPath: logPath(label, "stdout"),
      stderrPath: logPath(label, "stderr"),
      path: controlledPath,
      wrapperPath: wrapper,
    });
    const destination = join(launchAgents, `${label}.plist`);
    return [label, existsSync(destination) && replaceExisting
      ? renderMigratedServicePlist({ sourcePath: destination, values })
      : renderServiceLaunchdPlist(readFileSync(SERVICE_TEMPLATE, "utf8"), values)];
  })));
  verifyServicePlistDefinitions(rendered);
  const entries = [{
    path: wrapper,
    existed: existsSync(wrapper),
    mode: existsSync(wrapper) ? statSync(wrapper).mode & 0o777 : 0o755,
    backupPath: existsSync(wrapper)
      ? join(root, SERVICE_INSTALL_ROOT, "backups", "agentos-service-wrapper.mjs")
      : null,
    originalSha256: existsSync(wrapper) ? sha256(readFileSync(wrapper)) : null,
    installedSha256: sha256(readFileSync(SERVICE_WRAPPER_SOURCE)),
  }];
  for (const label of SERVICE_LABELS) {
    const destination = join(launchAgents, `${label}.plist`);
    const contents = rendered[label];
    if (existsSync(destination) && readFileSync(destination, "utf8") !== contents && !replaceExisting) {
      throw new Error(`launchd-service-definition-conflict:${destination}`);
    }
    entries.push({
      path: destination,
      existed: existsSync(destination),
      mode: existsSync(destination) ? statSync(destination).mode & 0o777 : 0o600,
      backupPath: existsSync(destination)
        ? join(root, SERVICE_INSTALL_ROOT, "backups", `${safeServiceFileName(label)}.plist`)
        : null,
      originalSha256: existsSync(destination) ? sha256(readFileSync(destination)) : null,
      installedSha256: sha256(contents),
      contents,
    });
  }
  if (!apply) return {
    applied: false,
    reverted: false,
    wrapper,
    entries: entries.map(({ path: entryPath }) => entryPath),
    rendered,
  };
  if (!existsSync(join(sharedRoot, ".env"))) throw new Error("shared-environment-missing");
  for (const directory of SHARED_RUNTIME_DIRECTORIES) {
    mkdirSync(join(sharedRoot, directory), { recursive: true, mode: 0o700 });
  }
  const bootstrap = bootstrapCurrentRelease({ repositoryRoot: root });
  if (entries[0].existed && readFileSync(wrapper, "utf8") !== readFileSync(SERVICE_WRAPPER_SOURCE, "utf8") && !replaceExisting) {
    throw new Error(`launchd-service-wrapper-conflict:${wrapper}`);
  }
  mkdirSync(join(root, SERVICE_INSTALL_ROOT, "backups"), { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (!entry.existed || !existsSync(entry.backupPath)) continue;
    if (sha256(readFileSync(entry.backupPath)) !== entry.originalSha256) {
      throw new DeployFailure("launchd-service-backup-conflict", `remove-or-recover:${entry.backupPath}`);
    }
  }
  const manifest = {
    schemaVersion: 1,
    repositoryRoot: root,
    entries: entries.map(({ contents: _contents, ...entry }) => entry),
  };
  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n", 0o600);
  for (const entry of entries) {
    if (entry.existed && !existsSync(entry.backupPath)) {
      writeFileSync(entry.backupPath, readFileSync(entry.path), { flag: "wx", mode: 0o600 });
    }
  }
  writeAtomic(wrapper, readFileSync(SERVICE_WRAPPER_SOURCE), 0o755);
  for (const entry of entries.slice(1)) {
    writeAtomic(entry.path, entry.contents, 0o600);
  }
  return {
    applied: true,
    reverted: false,
    wrapper,
    bootstrap,
    entries: entries.map(({ path: entryPath }) => entryPath),
  };
};

export const installLaunchd = (args, context = {}) => {
  const {
    apply,
    installUnits,
    revert,
    serviceUser,
    backup: requestedBackup,
  } = parseInstallerArgs(args);
  const platform = resolveServicePlatform({
    platform: context.platform,
    environment: context.environment ?? process.env,
  });
  if (platform === "linux") {
    if (serviceUser !== undefined && serviceUser !== null) {
      resolveSystemdServiceUser({ serviceUser, platform, lookup: context.userLookup, execute: context.execute ?? execFileSync });
    }
    if (installUnits) {
      installStagedSystemdAutoDeploy({
        repositoryRoot: context.repositoryRoot,
        manifestPath: context.manifestPath,
        unitDirectory: context.unitDirectory,
        sudoersPath: context.sudoersPath,
        systemctlPath: context.systemctlPath,
        execute: context.execute ?? execFileSync,
        effectiveUid: context.effectiveUid,
        revert,
        apply: true,
      });
      const phase = revert ? "REVERT" : "APPLY";
      process.stdout.write(`${phase} platform=linux\n`);
      process.stdout.write(`${phase} unit-directory=${context.unitDirectory ?? SYSTEMD_UNIT_DIRECTORY}\n`);
      process.stdout.write(`${phase} units=2\n`);
      process.stdout.write(`${phase} staging=${context.stagingRoot ?? "recorded"}\n`);
      return 0;
    }
    if (revert) {
      installStagedSystemdAutoDeploy({
        repositoryRoot: context.repositoryRoot,
        manifestPath: context.manifestPath,
        unitDirectory: context.unitDirectory,
        sudoersPath: context.sudoersPath,
        systemctlPath: context.systemctlPath,
        execute: context.execute ?? execFileSync,
        effectiveUid: context.effectiveUid,
        revert: true,
        apply,
      });
      process.stdout.write(`${apply ? "REVERT" : "PLAN"} platform=linux\n`);
      process.stdout.write(`${apply ? "REVERT" : "PLAN"} unit-directory=${context.unitDirectory ?? SYSTEMD_UNIT_DIRECTORY}\n`);
      process.stdout.write(`${apply ? "REVERT" : "PLAN"} units=2\n`);
      process.stdout.write(`${apply ? "REVERT" : "PLAN"} staging=${context.stagingRoot ?? "recorded"}\n`);
      if (!apply) process.stdout.write("PLAN no files or systemd state changed\n");
      return 0;
    }
    const callerUid = context.effectiveUid
      ?? (typeof process.geteuid === "function" ? process.geteuid() : process.getuid());
    if (callerUid === 0) throw new Error("launchd-installer-refuses-root");
    const root = realpathSync(resolve(context.repositoryRoot ?? REPOSITORY_ROOT));
    const nodeBinary = realpathSync(context.nodeBinary ?? process.execPath);
    const gitBinary = context.gitBinary ? realpathSync(context.gitBinary) : requiredBinary("git");
    const npmBinary = context.npmBinary ? realpathSync(context.npmBinary) : requiredBinary("npm");
    const values = {
      nodeBinary,
      deployScript: join(root, "current/scripts/deploy/quiet-window-deploy.mjs"),
      repositoryRoot: root,
      sourceRemote: context.sourceRemote ?? execFileSync(gitBinary, ["-C", root, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
      path: context.path ?? controlledLaunchdPath({ nodeBinary, gitBinary }),
      gitBinary,
      npmBinary,
      backup: requestedBackup ? verifyBackupConfiguration(requestedBackup, context.execute ?? execFileSync) : null,
    };
    if (!values.backup) throw new Error("backup-configuration-invalid:pg-dump-mode-must-be-host-or-container");
    verifyRenderedToolchain(values, context.execute ?? execFileSync);
    const result = planSystemdAutoDeploy({
      ...values,
      serviceUser,
      repositoryRoot: root,
      stagingRoot: context.stagingRoot,
      unitDirectory: context.unitDirectory,
      sudoersPath: context.sudoersPath,
      apply,
      effectiveUid: context.effectiveUid,
      userLookup: context.userLookup,
      execute: context.execute ?? execFileSync,
    });
    process.stdout.write(`${apply ? "APPLY" : "PLAN"} platform=linux\n`);
    process.stdout.write(`${apply ? "APPLY" : "PLAN"} unit-directory=${context.unitDirectory ?? SYSTEMD_UNIT_DIRECTORY}\n`);
    process.stdout.write(`${apply ? "APPLY" : "PLAN"} units=2\n`);
    process.stdout.write(`${apply ? "APPLY" : "PLAN"} staging=${result.staging}\n`);
    if (!apply) process.stdout.write("PLAN no files or systemd state changed\n");
    else process.stdout.write(`NEXT sudo node ${process.argv[1]} --install-units --service-user ${serviceUser}\n`);
    return 0;
  }
  if (installUnits) throw new Error("systemd-installer-unsupported:darwin");
  if (revert) throw new Error("launchd-auto-deploy-revert-unsupported");
  if (serviceUser !== undefined && serviceUser !== null) throw new Error("systemd-service-user-not-supported-on-darwin");
  if (typeof process.geteuid === "function" ? process.geteuid() === 0 : process.getuid() === 0) {
    throw new Error("launchd-installer-refuses-root");
  }
  const userHome = homedir();
  const launchAgents = join(userHome, "Library/LaunchAgents");
  const logs = join(userHome, "Library/Logs/Anneal");
  const destination = join(launchAgents, `${LABEL}.plist`);
  const nodeBinary = realpathSync(process.execPath);
  const gitBinary = requiredBinary("git");
  const npmBinary = requiredBinary("npm");
  const values = {
    nodeBinary,
    deployScript: join(realpathSync(REPOSITORY_ROOT), "current/scripts/deploy/quiet-window-deploy.mjs"),
    repositoryRoot: realpathSync(REPOSITORY_ROOT),
    sourceRemote: execFileSync(gitBinary, ["-C", REPOSITORY_ROOT, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
    stdoutPath: join(logs, "auto-deploy.log"),
    stderrPath: join(logs, "auto-deploy.error.log"),
    path: controlledLaunchdPath({ nodeBinary, gitBinary }),
    gitBinary,
    npmBinary,
    backup: verifyBackupConfiguration(requestedBackup),
  };
  verifyRenderedToolchain(values);
  const rendered = renderLaunchdPlist(readFileSync(TEMPLATE, "utf8"), values);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} label=${LABEL}\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} destination=${destination}\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} repository=${values.repositoryRoot}\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} node=${values.nodeBinary}\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} path=${values.path}\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} git=${values.gitBinary}\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} npm=${values.npmBinary}\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} rendered_toolchain=verified\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} pg_dump_mode=${values.backup.mode}\n`);
  if (values.backup.mode === "host") {
    process.stdout.write(`${apply ? "APPLY" : "PLAN"} pg_dump=${values.backup.pgDumpBinary}\n`);
  } else {
    process.stdout.write(`${apply ? "APPLY" : "PLAN"} docker=${values.backup.dockerBinary}\n`);
    process.stdout.write(`${apply ? "APPLY" : "PLAN"} pg_dump_container=${values.backup.container}\n`);
    process.stdout.write(`${apply ? "APPLY" : "PLAN"} container_pg_dump=${values.backup.pgDumpBinary}\n`);
  }

  if (!apply) {
    process.stdout.write("PLAN no files or launchd state changed\n");
    return 0;
  } else {
    mkdirSync(launchAgents, { recursive: true, mode: 0o755 });
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    if (existsSync(destination)) {
      if (readFileSync(destination, "utf8") !== rendered) throw new Error(`launchd-definition-conflict:${destination}`);
      process.stdout.write("OK definition already matches\n");
    } else {
      const temporary = `${destination}.${process.pid}.tmp`;
      writeFileSync(temporary, rendered, { flag: "wx", mode: 0o600 });
      chmodSync(temporary, 0o600);
      try {
        execFileSync("/usr/bin/plutil", ["-lint", temporary], { stdio: "inherit" });
        // link(2), not rename-over-existing: a concurrent installer cannot
        // replace an operator-owned definition after this process inspected it.
        linkSync(temporary, destination);
      } finally {
        rmSync(temporary, { force: true });
      }
      process.stdout.write("OK definition installed\n");
    }
    const target = `gui/${process.getuid()}`;
    try {
      execFileSync("/bin/launchctl", ["print", `${target}/${LABEL}`], { stdio: "ignore" });
      execFileSync("/bin/launchctl", ["kickstart", "-k", `${target}/${LABEL}`], { stdio: "inherit" });
      process.stdout.write("OK loaded job restarted\n");
    } catch {
      execFileSync("/bin/launchctl", ["bootstrap", target, destination], { stdio: "inherit" });
      process.stdout.write("OK job bootstrapped\n");
    }
    return 0;
  }
};

const autoDeployStageEntry = ({ path, stagedPath, backupPath = null, mode = 0o644, kind = "auto-deploy" }) => {
  const existed = existsSync(path);
  return {
    kind,
    path,
    stagedPath,
    existed,
    mode: existed ? statSync(path).mode & 0o777 : mode,
    backupPath: existed ? backupPath : null,
    originalSha256: existed ? sha256(readFileSync(path)) : null,
    installedSha256: sha256(readFileSync(stagedPath)),
  };
};

const autoDeployDefinitionValues = ({
  root,
  nodeBinary,
  gitBinary,
  npmBinary,
  path,
  sourceRemote,
  backup,
  serviceUser,
}) => Object.freeze({
  nodeBinary,
  gitBinary,
  npmBinary,
  path,
  sourceRemote,
  backup,
  serviceUser,
  repositoryRoot: root,
  deployScript: join(root, "current/scripts/deploy/quiet-window-deploy.mjs"),
});

export const planSystemdAutoDeploy = ({
  repositoryRoot,
  nodeBinary,
  gitBinary,
  npmBinary,
  path,
  sourceRemote,
  backup,
  serviceUser,
  stagingRoot,
  unitDirectory = SYSTEMD_UNIT_DIRECTORY,
  sudoersPath = SYSTEMD_SUDOERS_PATH,
  apply = false,
  effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : process.getuid(),
  userLookup = null,
  execute = execFileSync,
} = {}) => {
  const platform = resolveServicePlatform();
  if (platform !== "linux") throw new Error("systemd-installer-unsupported:darwin");
  if (effectiveUid === 0) throw new Error("launchd-installer-refuses-root");
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const account = resolveSystemdServiceUser({ serviceUser, platform: "linux", lookup: userLookup, execute });
  const values = autoDeployDefinitionValues({
    root,
    nodeBinary,
    gitBinary,
    npmBinary,
    path,
    sourceRemote,
    backup,
    serviceUser: account,
  });
  const service = renderAutoDeploySystemdUnit(readFileSync(SYSTEMD_AUTO_DEPLOY_TEMPLATE, "utf8"), values);
  const timer = renderAutoDeploySystemdTimer(readFileSync(SYSTEMD_AUTO_DEPLOY_TIMER_TEMPLATE, "utf8"));
  verifySystemdAutoDeployDefinitions({ service, timer });
  const stage = resolve(stagingRoot ?? join(root, AUTO_DEPLOY_INSTALL_ROOT, "staging"));
  const targetRoot = resolve(unitDirectory);
  const servicePath = join(targetRoot, `${LABEL}.service`);
  const timerPath = join(targetRoot, `${LABEL}.timer`);
  if (!apply) return Object.freeze({
    applied: false,
    reverted: false,
    platform: "linux",
    staging: stage,
    unitDirectory: targetRoot,
    serviceUser: account,
    entries: [servicePath, timerPath],
    definitions: { service, timer },
    values,
  });
  const manifestPath = autoDeployManifestPath(root);
  if (existsSync(manifestPath)) throw new Error("systemd-auto-deploy-install-active");
  stageSystemdDefinition({ stagingRoot: stage, relativePath: `${LABEL}.service`, contents: service });
  stageSystemdDefinition({ stagingRoot: stage, relativePath: `${LABEL}.timer`, contents: timer });
  const entries = [
    {
      ...autoDeployStageEntry({
        path: servicePath,
        stagedPath: stagingFile(stage, `${LABEL}.service`),
        backupPath: join(stage, "backups", `${LABEL}.service`),
      }),
      unit: `${LABEL}.service`,
    },
    {
      ...autoDeployStageEntry({
        path: timerPath,
        stagedPath: stagingFile(stage, `${LABEL}.timer`),
        backupPath: join(stage, "backups", `${LABEL}.timer`),
      }),
      unit: `${LABEL}.timer`,
    },
  ];
  for (const entry of entries) {
    entry.installedSha256 = fileDigest(entry.stagedPath);
    stageFileEntry({ entry });
    backupSystemdTarget({ stagingRoot: stage, entry });
  }
  const manifest = {
    schemaVersion: 1,
    platform: "linux",
    repositoryRoot: root,
    serviceUser: account,
    stagingRoot: stage,
    unitDirectory: targetRoot,
    sudoersPath: resolve(sudoersPath),
    entries,
    auxiliaryEntries: [],
  };
  writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return Object.freeze({
    applied: true,
    reverted: false,
    platform: "linux",
    staging: stage,
    unitDirectory: targetRoot,
    serviceUser: account,
    entries: entries.map((entry) => entry.path),
    manifest,
    manifestPath,
  });
};

export const installStagedSystemdAutoDeploy = ({
  repositoryRoot,
  manifestPath,
  unitDirectory = SYSTEMD_UNIT_DIRECTORY,
  sudoersPath = SYSTEMD_SUDOERS_PATH,
  systemctlPath = null,
  execute = execFileSync,
  effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : process.getuid(),
  revert = false,
  apply = true,
} = {}) => {
  const platform = resolveServicePlatform();
  if (platform !== "linux") throw new Error("systemd-installer-unsupported:darwin");
  if (apply && effectiveUid !== 0) throw new Error("systemd-installer-requires-root");
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const path = manifestPath ?? autoDeployManifestPath(root);
  if (!existsSync(path)) throw new Error("systemd-auto-deploy-manifest-missing");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.platform !== "linux" || manifest.repositoryRoot !== root
      || !Array.isArray(manifest.entries) || manifest.entries.length !== 2) {
    throw new Error("systemd-auto-deploy-manifest-invalid");
  }
  const entries = [...manifest.entries, ...(Array.isArray(manifest.auxiliaryEntries) ? manifest.auxiliaryEntries : [])];
  const targetRoot = resolve(unitDirectory ?? manifest.unitDirectory ?? SYSTEMD_UNIT_DIRECTORY);
  const targetSudoers = resolve(sudoersPath ?? manifest.sudoersPath ?? SYSTEMD_SUDOERS_PATH);
  if (!apply) return Object.freeze({ applied: false, reverted: false, entries: entries.map((entry) => entry.path) });
  const systemctl = systemctlPath ?? systemdCommandPath("systemctl", null, execute);
  for (const entry of entries) {
    const current = fileDigest(entry.path);
    const recognized = current === entry.installedSha256
      || (entry.existed && current === entry.originalSha256)
      || (!entry.existed && current === null);
    if (!recognized) throw new Error(`systemd-auto-deploy-definition-drift:${entry.path}`);
    if (entry.existed && current === entry.installedSha256
        && (!entry.backupPath || !existsSync(entry.backupPath) || fileDigest(entry.backupPath) !== entry.originalSha256)) {
      throw new Error(`systemd-auto-deploy-backup-missing:${entry.path}`);
    }
    if (!revert && fileDigest(entry.stagedPath) !== entry.installedSha256) {
      throw new Error(`systemd-staged-file-drift:${entry.stagedPath}`);
    }
  }
  if (!revert) {
    for (const entry of entries) copyStagedEntry({
      entry,
      unitDirectory: targetRoot,
      sudoersPath: targetSudoers,
      strictOwner: typeof process.geteuid !== "function" || process.geteuid() === 0,
    });
    runSystemctl({ systemctlPath: systemctl, args: ["daemon-reload"], execute });
    runSystemctl({ systemctlPath: systemctl, args: ["enable", "--now", `${LABEL}.timer`], unit: `${LABEL}.timer`, execute });
    return Object.freeze({ applied: true, reverted: false, entries: entries.map((entry) => entry.path) });
  }
  for (const entry of manifest.entries) runSystemctl({
    systemctlPath: systemctl,
    args: ["disable", "--now", entry.unit],
    unit: entry.unit,
    execute,
  });
  for (const entry of entries) {
    if (entry.existed) {
      if (fileDigest(entry.path) !== entry.originalSha256) copyFileSync(entry.backupPath, entry.path);
      chmodSync(entry.path, entry.mode ?? 0o644);
    } else rmSync(entry.path, { force: true });
    if (entry.backupPath) rmSync(entry.backupPath, { force: true });
  }
  runSystemctl({ systemctlPath: systemctl, args: ["daemon-reload"], execute });
  rmSync(path, { force: true });
  if (manifest.stagingRoot) rmSync(manifest.stagingRoot, { recursive: true, force: true });
  return Object.freeze({ applied: true, reverted: true, entries: entries.map((entry) => entry.path) });
};

const isEntryPoint = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  try {
    process.exitCode = installLaunchd(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`STOP ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
