import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RunnerConfig } from "../config.js";
import { runCommand } from "../exec.js";
import type { AgentScratch } from "../workspace.js";
import { workspaceEnvironment } from "./environment.js";

export type SessionConfigOptions = { reuse?: boolean };

type SessionConfigSources = {
  label: string;
  authFile: string;
  baselineFile?: string;
};

const command = (
  config: RunnerConfig,
  executable: string,
  args: string[],
  cwd: string,
): Promise<string> => runCommand(config.runAsPrefix, executable, args, cwd, workspaceEnvironment(config));

const sessionConfigOwnerUid = async (config: RunnerConfig, cwd: string): Promise<number> => {
  if (config.runAsPrefix.length > 0) {
    const uidText = await command(config, "/usr/bin/id", ["-u"], cwd);
    const uid = Number(uidText);
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`run-as launcher returned an invalid uid: ${uidText}`);
    return uid;
  }

  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("runner process uid is unavailable");
  return uid;
};

const validateSessionConfigRoot = async (configRoot: string, expectedOwnerUid: number): Promise<void> => {
  const info = await lstat(configRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`created path is not a real directory: ${configRoot}`);
  }
  if (info.uid !== expectedOwnerUid) {
    throw new Error(`created directory ${configRoot} has uid ${info.uid}, expected ${expectedOwnerUid}`);
  }
};

/**
 * The shared mechanics for the two adapters that isolate a CLI config root.
 * Each adapter supplies the complete source policy; this helper never chooses
 * a runner, auth path, or baseline.
 */
export const provisionIsolatedSessionConfig = async (
  config: RunnerConfig,
  scratch: AgentScratch,
  sources: SessionConfigSources,
  options: SessionConfigOptions = {},
): Promise<void> => {
  if (options.reuse) {
    try {
      const info = await lstat(scratch.configRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("existing session config root is not a real directory");
      return;
    } catch (error: unknown) {
      throw new Error(`Unable to reuse ${sources.label} session CLI config root ${scratch.configRoot}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  const configParent = dirname(scratch.configRoot);
  try {
    await mkdir(configParent, { mode: 0o711 });
    await chmod(configParent, 0o711);
    const expectedOwnerUid = await sessionConfigOwnerUid(config, configParent);
    if (config.runAsPrefix.length > 0) {
      // Open the daemon-owned parent only for the one operation that needs it:
      // creation by the target uid. A failed mkdir must stop provisioning, and
      // the parent is made non-writable again before any baseline or auth copy.
      await chmod(configParent, 0o733);
      try {
        await command(config, "/bin/mkdir", ["-m", "700", scratch.configRoot], configParent);
      } finally {
        await chmod(configParent, 0o711);
      }
    } else {
      await mkdir(scratch.configRoot, { mode: 0o700 });
      await chmod(scratch.configRoot, 0o700);
    }

    await validateSessionConfigRoot(scratch.configRoot, expectedOwnerUid);
    if (sources.baselineFile) {
      const destination = join(scratch.configRoot, "config.toml");
      if (config.runAsPrefix.length > 0) {
        await command(config, "/bin/cp", [sources.baselineFile, destination], configParent);
        await command(config, "/bin/chmod", ["600", destination], configParent);
      } else {
        await copyFile(sources.baselineFile, destination);
        await chmod(destination, 0o600);
      }
    }
  } catch (error: unknown) {
    await chmod(configParent, 0o711).catch(() => undefined);
    const sourceDescription = sources.baselineFile ? ` from baseline ${sources.baselineFile}` : "";
    const createFailure = sources.baselineFile
      ? "Unable to create session CLI config root"
      : `Unable to create ${sources.label} session CLI config root`;
    throw new Error(`${createFailure} ${scratch.configRoot}${sourceDescription}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const destination = join(scratch.configRoot, "auth.json");
  try {
    if (config.runAsPrefix.length > 0) {
      await command(config, "/bin/cp", [sources.authFile, destination], configParent);
      await command(config, "/bin/chmod", ["600", destination], configParent);
    } else {
      await copyFile(sources.authFile, destination);
      await chmod(destination, 0o600);
    }
  } catch (error: unknown) {
    throw new Error(`Unable to establish ${sources.label} authentication in ${scratch.configRoot} from ${sources.authFile}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    // The target account needed write access only long enough to create its
    // own 0700 root. Afterwards other runner accounts may traverse the
    // session-specific parent but cannot add, replace, or enumerate entries.
    await chmod(configParent, 0o711);
  }
};
