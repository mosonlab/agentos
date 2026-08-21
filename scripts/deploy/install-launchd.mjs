#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "../..");
const TEMPLATE = join(SCRIPT_DIR, "com.agentos.auto-deploy.plist.in");
const LABEL = "com.agentos.auto-deploy";

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

export const installLaunchd = (args) => {
  const { apply, backup: requestedBackup } = parseInstallerArgs(args);
  if (process.getuid() === 0) throw new Error("launchd-installer-refuses-root");
  const userHome = homedir();
  const launchAgents = join(userHome, "Library/LaunchAgents");
  const logs = join(userHome, "Library/Logs/AgentOS");
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
