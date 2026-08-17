import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CanonicalWorkspaceRoot {
  configuredPath: string;
  canonicalPath: string;
  device: bigint;
  inode: bigint;
}

export const defaultWorkspaceRoot = (): string => join(homedir(), ".agentos", "runs");

export const canonicalizeWorkspaceRoot = async (
  configured = process.env.RUNNER_WORKSPACE_ROOT ?? defaultWorkspaceRoot(),
): Promise<CanonicalWorkspaceRoot> => {
  const configuredPath = resolve(configured);
  await mkdir(configuredPath, { recursive: true });
  const canonicalPath = await realpath(configuredPath);
  const identity = await lstat(canonicalPath, { bigint: true });
  if (!identity.isDirectory()) throw new Error(`RUNNER_WORKSPACE_ROOT is not a directory: ${configuredPath}`);
  return {
    configuredPath,
    canonicalPath,
    device: identity.dev,
    inode: identity.ino,
  };
};
