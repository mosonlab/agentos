#!/usr/bin/env node
/**
 * The one place a runner count, a runner-id prefix and a deploy role become
 * the deployed service inventory: labels, runner indexes, runner ids, systemd
 * unit names, launchd plist names, and the installed wrapper path.
 *
 * A resolved inventory carries the inputs it was built from, so no caller ever
 * recovers a runner count from an array length or re-spells a `.service` name.
 * Resolve it once per invocation and pass it down.
 *
 * Run as a program it writes the resolved inventory to stdout, one
 * tab-separated entry per line (label, unit name, plist name, runner index,
 * runner id), which is how the shell entrypoints read the same facts. Run with
 * `--wrapper-path <repositoryRoot>` it writes the installed wrapper path, the
 * other fact a shell entrypoint would otherwise re-spell.
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_DEPLOY_ROLE, DEPLOY_ROLES, resolveDeployRole } from "./deploy-role.mjs";

export const DEFAULT_RUNNER_COUNT = 10;
export const MAX_RUNNER_COUNT = 64;

/** The installed name of the standalone service wrapper. The wrapper is copied
 * to one stable path outside any release so a service definition survives an
 * activation. */
export const SERVICE_WRAPPER_FILE_NAME = "agentos-service-wrapper.mjs";

export const serviceWrapperPath = (repositoryRoot) =>
  join(resolve(repositoryRoot), "shared", "bin", SERVICE_WRAPPER_FILE_NAME);

/** The service-manager names of one label. Both suffixes are spelled here and
 * nowhere else, including for the auto-deploy label, which is installed by the
 * same installer but is not a service inventory entry. */
export const unitNameForLabel = (label) => `${label}.service`;
export const plistNameForLabel = (label) => `${label}.plist`;

export const resolveRunnerIdPrefix = (environment = process.env) => {
  const prefix = environment?.AGENTOS_RUNNER_ID_PREFIX ?? "";
  if (typeof prefix !== "string" || !/^[A-Za-z0-9_.-]*$/u.test(prefix)) {
    throw new Error(`runner-id-prefix-invalid:${String(prefix)}`);
  }
  return prefix;
};

const validatedRunnerCount = (value) => {
  const count = typeof value === "number"
    ? value
    : typeof value === "string" && /^[0-9]+$/u.test(value)
      ? Number(value)
      : NaN;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RUNNER_COUNT) {
    throw new Error(`runner-count-invalid:${String(value)}`);
  }
  return count;
};

/** Resolve the configured number of service runners. An unset value retains
 * the default inventory; a configured value is intentionally strict so every
 * consumer observes the same inventory. */
export const resolveRunnerCount = (environment = process.env) => {
  const configured = environment?.AGENTOS_RUNNER_COUNT;
  return validatedRunnerCount(configured === undefined ? DEFAULT_RUNNER_COUNT : configured);
};

const runnerLabelForIndex = (index) => index === 1
  ? "com.agentos.runner"
  : `com.agentos.runner-${index}`;

const inventoryEntry = (label, runnerIndex, runnerId) => Object.freeze({
  label,
  runnerIndex,
  runnerId,
  unitName: unitNameForLabel(label),
  plistName: plistNameForLabel(label),
});

/** Generate the ordered service inventory. Keep this generator in lockstep
 * with launchd-service-wrapper.mjs, which is copied as a standalone artifact
 * and therefore cannot import this module; the wrapper fixture proves it. */
export const generateServiceInventory = ({ runnerCount, runnerIdPrefix, deployRole }) => {
  const count = validatedRunnerCount(runnerCount);
  const prefix = resolveRunnerIdPrefix({ AGENTOS_RUNNER_ID_PREFIX: runnerIdPrefix });
  if (!DEPLOY_ROLES.includes(deployRole)) throw new Error(`deploy-role-invalid:${String(deployRole)}`);
  const controlPlane = deployRole === DEFAULT_DEPLOY_ROLE;
  const entries = Object.freeze([
    ...(controlPlane
      ? [inventoryEntry("com.agentos.api", null, null), inventoryEntry("com.agentos.inbox", null, null)]
      : []),
    ...Array.from({ length: count }, (_unused, offset) => {
      const index = offset + 1;
      return inventoryEntry(runnerLabelForIndex(index), index, `${prefix}runner-${index}`);
    }),
    ...(controlPlane ? [inventoryEntry("com.agentos.web", null, null)] : []),
  ]);
  return Object.freeze({
    runnerCount: count,
    runnerIdPrefix: prefix,
    deployRole,
    entries,
    labels: Object.freeze(entries.map(({ label }) => label)),
  });
};

/** Resolve the inventory this invocation installs, controls or verifies. */
export const resolveServiceInventory = (
  environment = process.env,
  deployRole = resolveDeployRole(environment),
) => generateServiceInventory({
  runnerCount: resolveRunnerCount(environment),
  runnerIdPrefix: resolveRunnerIdPrefix(environment),
  deployRole,
});

/** True when the argument is exactly what the generator produces for the inputs
 * it claims to carry. The exported verification and sudoers entry points render
 * or approve a privileged grant from an inventory, so an inventory-shaped
 * literal must not be able to drive them. */
export const isGeneratedServiceInventory = (inventory) => {
  if (!inventory || !Array.isArray(inventory.entries) || !Array.isArray(inventory.labels)) return false;
  let regenerated;
  try {
    regenerated = generateServiceInventory({
      runnerCount: inventory.runnerCount,
      runnerIdPrefix: inventory.runnerIdPrefix,
      deployRole: inventory.deployRole,
    });
  } catch {
    return false;
  }
  if (regenerated.entries.length !== inventory.entries.length) return false;
  if (regenerated.labels.length !== inventory.labels.length) return false;
  return regenerated.entries.every((entry, index) => {
    const candidate = inventory.entries[index];
    return inventory.labels[index] === entry.label
      && candidate?.label === entry.label
      && candidate.unitName === entry.unitName
      && candidate.plistName === entry.plistName
      && candidate.runnerIndex === entry.runnerIndex
      && candidate.runnerId === entry.runnerId;
  });
};

/** Look one label up in a resolved inventory. An unknown label is a refusal:
 * no caller may name a service the inventory does not contain. */
export const serviceInventoryEntry = (inventory, label) => {
  const entry = inventory?.entries?.find((candidate) => candidate.label === label);
  if (!entry) throw new Error(`service-label-unknown:${String(label)}`);
  return entry;
};

/** The inventory as the shell entrypoints read it. */
export const formatServiceInventory = (inventory) => inventory.entries
  .map(({ label, unitName, plistName, runnerIndex, runnerId }) =>
    `${label}\t${unitName}\t${plistName}\t${runnerIndex ?? ""}\t${runnerId ?? ""}\n`)
  .join("");

const isEntryPoint = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const [mode, repositoryRoot, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || (mode !== undefined && mode !== "--wrapper-path")
      || (mode === "--wrapper-path" && repositoryRoot === undefined)
      || (mode === undefined && repositoryRoot !== undefined)) {
    process.stderr.write("usage: service-inventory.mjs [--wrapper-path <repository-root>]\n");
    process.exitCode = 64;
  } else {
    try {
      process.stdout.write(mode === "--wrapper-path"
        ? `${serviceWrapperPath(repositoryRoot)}\n`
        : formatServiceInventory(resolveServiceInventory()));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 64;
    }
  }
}
