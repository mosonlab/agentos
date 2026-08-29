#!/usr/bin/env node
import { installLaunchdServices } from "./install-launchd.mjs";

const usage = () => {
  process.stdout.write(`usage: node scripts/deploy/install-launchd-services.mjs [--apply] [--replace-existing] [--revert]\n\n`);
  process.stdout.write("Plans the 13 service plists by default. --apply writes the stable shared wrapper and definitions; --replace-existing performs the explicit wrapper migration and records backups; --revert --apply restores the recorded files.\n");
};

const parseArgs = (args) => {
  if (args.includes("--help") || args.includes("-h")) return { help: true, apply: false, revert: false, replaceExisting: false };
  const allowed = new Set(["--apply", "--revert", "--replace-existing"]);
  for (const argument of args) if (!allowed.has(argument)) throw new Error(`installer-option-unknown:${argument}`);
  if (args.filter((argument) => argument === "--apply").length > 1) throw new Error("installer-option-repeated:--apply");
  if (args.filter((argument) => argument === "--revert").length > 1) throw new Error("installer-option-repeated:--revert");
  if (args.filter((argument) => argument === "--replace-existing").length > 1) throw new Error("installer-option-repeated:--replace-existing");
  if (args.includes("--replace-existing") && args.includes("--revert")) {
    throw new Error("installer-option-invalid:--replace-existing-with-revert");
  }
  return {
    help: false,
    apply: args.includes("--apply"),
    revert: args.includes("--revert"),
    replaceExisting: args.includes("--replace-existing"),
  };
};

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exitCode = 0;
  } else {
    if (process.getuid() === 0) throw new Error("launchd-installer-refuses-root");
    const result = installLaunchdServices({
      apply: options.apply,
      revert: options.revert,
      replaceExisting: options.replaceExisting,
    });
    process.stdout.write(`${options.revert ? "REVERT" : options.apply ? "APPLY" : "PLAN"} service-wrapper=${result.wrapper ?? "recorded"}\n`);
    process.stdout.write(`${options.revert ? "REVERT" : options.apply ? "APPLY" : "PLAN"} service-definitions=${result.entries.length}\n`);
    if (options.apply && !options.revert) {
      process.stdout.write("NEXT reload each service plist with launchctl, then run the wrapper inventory readiness check\n");
    } else if (!options.apply) {
      process.stdout.write("PLAN no files or launchd state changed\n");
    }
  }
} catch (error) {
  process.stderr.write(`STOP ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
