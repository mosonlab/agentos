#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { installLaunchdServices } from "./install-launchd.mjs";

const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;

const usage = () => {
  process.stdout.write(`usage: node scripts/deploy/install-launchd-services.mjs [--apply] [--replace-existing] [--revert] [--install-units] [--service-user <account>]\n\n`);
  process.stdout.write("Plans the generated service definitions by default. On Linux, --apply stages units and the sudoers grant; --install-units performs the privileged systemd stage. On macOS, --apply writes the stable shared wrapper and LaunchAgent definitions; --replace-existing performs the explicit wrapper migration and records backups.\n");
};

const parseArgs = (args) => {
  if (args.includes("--help") || args.includes("-h")) return { help: true, apply: false, revert: false, replaceExisting: false };
  const allowed = new Set(["--apply", "--revert", "--replace-existing", "--install-units", "--service-user"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument)) throw new Error(`installer-option-unknown:${argument}`);
    if (argument === "--service-user") {
      if (index === args.length - 1 || args[index + 1].startsWith("--")) throw new Error("installer-option-required:--service-user");
      index += 1;
    }
  }
  if (args.filter((argument) => argument === "--apply").length > 1) throw new Error("installer-option-repeated:--apply");
  if (args.filter((argument) => argument === "--revert").length > 1) throw new Error("installer-option-repeated:--revert");
  if (args.filter((argument) => argument === "--replace-existing").length > 1) throw new Error("installer-option-repeated:--replace-existing");
  if (args.filter((argument) => argument === "--install-units").length > 1) throw new Error("installer-option-repeated:--install-units");
  if (args.filter((argument) => argument === "--service-user").length > 1) throw new Error("installer-option-repeated:--service-user");
  if (args.includes("--replace-existing") && args.includes("--revert")) {
    throw new Error("installer-option-invalid:--replace-existing-with-revert");
  }
  const userIndex = args.indexOf("--service-user");
  return {
    help: false,
    apply: args.includes("--apply"),
    revert: args.includes("--revert"),
    replaceExisting: args.includes("--replace-existing"),
    installUnits: args.includes("--install-units"),
    serviceUser: userIndex === -1 ? undefined : args[userIndex + 1],
  };
};

export const runServiceInstaller = (args, context = {}) => {
  try {
    const options = parseArgs(args);
    if (options.help) {
      usage();
      return 0;
    }
    const result = installLaunchdServices({
      ...context,
      apply: options.apply,
      revert: options.revert,
      replaceExisting: options.replaceExisting,
      installUnits: options.installUnits,
      serviceUser: options.serviceUser,
    });
    for (const [key, value] of result.report) process.stdout.write(`${result.phase} ${key}=${value}\n`);
    if (result.notice) process.stdout.write(`${result.notice}\n`);
    if (result.remaining) {
      process.stdout.write(`NEXT sudo ${result.remaining.environment}node ${shellQuote(process.argv[1])} ${result.remaining.options}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`STOP ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

const isEntryPoint = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) process.exitCode = runServiceInstaller(process.argv.slice(2));
