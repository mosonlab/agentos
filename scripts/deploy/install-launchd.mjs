#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERVICE_INVENTORY,
  SERVICE_LABELS,
  resolveCurrentRelease,
} from "./launchd-service-wrapper.mjs";
import {
  DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  deployReleaseArtifactPaths,
  workspaceDependencyPaths,
} from "./quiet-window-adapters.mjs";
import { assembleReleaseDirectory } from "./release-directory.mjs";
import { activateReleasePointer } from "./release-pointer.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "../..");
const TEMPLATE = join(SCRIPT_DIR, "com.agentos.auto-deploy.plist.in");
const LABEL = "com.agentos.auto-deploy";
const SERVICE_TEMPLATE = join(SCRIPT_DIR, "com.agentos.service.plist.in");
const SERVICE_WRAPPER_SOURCE = join(SCRIPT_DIR, "launchd-service-wrapper.mjs");
const SERVICE_INSTALL_ROOT = ".agentos-deploy/launchd";
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
  const mode = optionValue(args, "--pg-dump-mode");
  const allowed = new Set(["--apply", "--pg-dump-mode"]);
  const backup = { mode };
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
  } else {
    throw new Error("backup-configuration-invalid:pg-dump-mode-must-be-host-or-container");
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`installer-option-unexpected-value:${argument}`);
    if (!allowed.has(argument)) throw new Error(`installer-option-unknown:${argument}`);
    if (argument !== "--apply") index += 1;
  }
  return { apply: applyCount === 1, backup };
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
    runnerId: SERVICE_INVENTORY[label].runnerId ?? "",
    runnerPath: SERVICE_INVENTORY[label].runnerId ? path : "",
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
    __RUNNER_ID__: values.runnerId,
    __RUNNER_PATH__: values.runnerPath,
    __STDOUT_PATH__: values.stdoutPath,
    __STDERR_PATH__: values.stderrPath,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) rendered = rendered.replaceAll(placeholder, xml(value));
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error("launchd-service-template-has-unresolved-placeholder");
  return rendered;
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
    if (!rendered.includes(`<key>Label</key>\n  <string>${xml(label)}</string>`)) {
      throw new Error(`launchd-service-definition-label-mismatch:${label}`);
    }
    if (!rendered.includes("<key>ProgramArguments</key>")) throw new Error(`launchd-service-definition-program-missing:${label}`);
    if (!rendered.includes("AGENTOS_REPOSITORY_ROOT") || !rendered.includes("AGENTOS_SHARED_ROOT")) {
      throw new Error(`launchd-service-definition-path-environment-missing:${label}`);
    }
    if (!rendered.includes("AGENTOS_CURRENT_POINTER") || !rendered.includes("<string>current</string>")) {
      throw new Error(`launchd-service-definition-current-pointer-missing:${label}`);
    }
  }
  return true;
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
} = {}) => {
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
    for (const entry of manifest.entries) {
      const current = existsSync(entry.path) ? readFileSync(entry.path) : null;
      const currentSha = current === null ? null : sha256(current);
      const recognized = currentSha === entry.installedSha256
        || (entry.existed && currentSha === entry.originalSha256)
        || (!entry.existed && currentSha === null);
      if (!recognized) {
        throw new Error(`launchd-service-definition-drift:${entry.path}`);
      }
    }
    if (!apply) return { applied: false, reverted: false, entries: manifest.entries.map((entry) => entry.path) };
    for (const entry of manifest.entries) {
      if (entry.existed) {
        const backup = readFileSync(entry.backupPath);
        writeAtomic(entry.path, backup, entry.mode ?? 0o600);
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
    return [label, renderServiceLaunchdPlist(readFileSync(SERVICE_TEMPLATE, "utf8"), values)];
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
    if (entry.existed) writeFileSync(entry.backupPath, readFileSync(entry.path), { flag: "wx", mode: 0o600 });
  }
  const manifest = {
    schemaVersion: 1,
    repositoryRoot: root,
    entries: entries.map(({ contents: _contents, ...entry }) => entry),
  };
  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n", 0o600);
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

export const installLaunchd = (args) => {
  const { apply, backup: requestedBackup } = parseInstallerArgs(args);
  if (process.getuid() === 0) throw new Error("launchd-installer-refuses-root");
  const userHome = homedir();
  const launchAgents = join(userHome, "Library/LaunchAgents");
  const logs = join(userHome, "Library/Logs/Anneal");
  const destination = join(launchAgents, `${LABEL}.plist`);
  const nodeBinary = realpathSync(process.execPath);
  const gitBinary = requiredBinary("git");
  const npmBinary = requiredBinary("npm");
  const values = {
    nodeBinary,
    deployScript: realpathSync(join(SCRIPT_DIR, "quiet-window-deploy.mjs")),
    repositoryRoot: realpathSync(REPOSITORY_ROOT),
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
