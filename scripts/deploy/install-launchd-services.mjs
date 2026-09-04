#!/usr/bin/env node
import { installLaunchdServices } from "./install-launchd.mjs";

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

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exitCode = 0;
  } else {
    const result = installLaunchdServices({
      apply: options.apply,
      revert: options.revert,
      replaceExisting: options.replaceExisting,
      installUnits: options.installUnits,
      serviceUser: options.serviceUser,
    });
    if (result.platform === "linux") {
      const phase = options.revert ? "REVERT" : options.apply ? "APPLY" : "PLAN";
      process.stdout.write(`${phase} platform=linux\n`);
      process.stdout.write(`${phase} unit-directory=${result.unitDirectory ?? "/etc/systemd/system"}\n`);
      process.stdout.write(`${phase} units=${result.units?.length ?? Math.max(0, result.entries.length - 1)}\n`);
      process.stdout.write(`${phase} staging=${result.staging ?? "recorded"}\n`);
      if (!options.apply && !options.installUnits) process.stdout.write("PLAN no files or systemd state changed\n");
      else if (options.apply && !options.installUnits && !options.revert) {
        process.stdout.write(`NEXT sudo node ${process.argv[1]} --install-units --service-user ${options.serviceUser}\n`);
      }
    } else {
      process.stdout.write(`${options.revert ? "REVERT" : options.apply ? "APPLY" : "PLAN"} service-wrapper=${result.wrapper ?? "recorded"}\n`);
      process.stdout.write(`${options.revert ? "REVERT" : options.apply ? "APPLY" : "PLAN"} service-definitions=${result.entries.length}\n`);
      if (options.apply && !options.revert) {
        process.stdout.write("NEXT reload each service plist with launchctl, then run the wrapper inventory readiness check\n");
      } else if (!options.apply) {
        process.stdout.write("PLAN no files or launchd state changed\n");
      }
    }
  }
} catch (error) {
  process.stderr.write(`STOP ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
