#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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

export const renderLaunchdPlist = (template, values) => {
  const replacements = {
    __NODE_BINARY__: values.nodeBinary,
    __DEPLOY_SCRIPT__: values.deployScript,
    __REPOSITORY_ROOT__: values.repositoryRoot,
    __STDOUT_PATH__: values.stdoutPath,
    __STDERR_PATH__: values.stderrPath,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, xml(value));
  }
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error("launchd-template-has-unresolved-placeholder");
  return rendered;
};

export const installLaunchd = (args) => {
  if (args.some((argument) => argument !== "--apply") || args.filter((argument) => argument === "--apply").length > 1) {
    process.stderr.write("usage: node scripts/deploy/install-launchd.mjs [--apply]\n");
    return 64;
  }
  const apply = args.includes("--apply");
  if (process.getuid() === 0) throw new Error("launchd-installer-refuses-root");
  const userHome = homedir();
  const launchAgents = join(userHome, "Library/LaunchAgents");
  const logs = join(userHome, "Library/Logs/AgentOS");
  const destination = join(launchAgents, `${LABEL}.plist`);
  const values = {
    nodeBinary: realpathSync(process.execPath),
    deployScript: realpathSync(join(SCRIPT_DIR, "quiet-window-deploy.mjs")),
    repositoryRoot: realpathSync(REPOSITORY_ROOT),
    stdoutPath: join(logs, "auto-deploy.log"),
    stderrPath: join(logs, "auto-deploy.error.log"),
  };
  const rendered = renderLaunchdPlist(readFileSync(TEMPLATE, "utf8"), values);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} label=${LABEL}\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} destination=${destination}\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} repository=${values.repositoryRoot}\n`);
  process.stdout.write(`${apply ? "APPLY" : "PLAN"} node=${values.nodeBinary}\n`);

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
