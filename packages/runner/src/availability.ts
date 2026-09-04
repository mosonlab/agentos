import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { RUNNER_KINDS } from "./adapters.js";
import type { RunnerConfig, RunnerKind } from "./config.js";

export type CliAvailability = {
  runner: RunnerKind;
  binary: string;
  available: boolean;
  resolvedPath: string | null;
};

type AccessExecutable = (path: string, mode: number) => Promise<void>;

const executable = async (path: string, check: AccessExecutable): Promise<boolean> => {
  try {
    await check(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** Resolve exactly as the configured runner environment will: an explicit path
 * is checked directly, while a bare command is searched in RUNNER_PATH order. */
export const resolveCliExecutable = async (
  binary: string,
  configuredPath: string,
  check: AccessExecutable = access,
): Promise<string | null> => {
  if (binary.includes("/")) {
    const candidate = isAbsolute(binary) ? binary : resolve(binary);
    return await executable(candidate, check) ? candidate : null;
  }
  for (const directory of configuredPath.split(":")) {
    const candidate = resolve(directory || ".", binary);
    if (await executable(candidate, check)) return candidate;
  }
  return null;
};

export const probeCliAvailability = async (
  config: RunnerConfig,
  runner: RunnerKind,
): Promise<CliAvailability> => {
  const binary = config.binaries[runner];
  const resolvedPath = await resolveCliExecutable(binary, config.path);
  return { runner, binary, available: resolvedPath !== null, resolvedPath };
};

export const probeSupportedCliAvailability = async (
  config: RunnerConfig,
): Promise<Partial<Record<RunnerKind, CliAvailability>>> => {
  const entries = await Promise.all((config.servedKinds ?? RUNNER_KINDS).map(async (runner) => [
    runner,
    await probeCliAvailability(config, runner),
  ] as const));
  return Object.fromEntries(entries) as Partial<Record<RunnerKind, CliAvailability>>;
};
