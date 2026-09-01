import { chmod, chown, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { RunnerConfig } from "./config.js";

const SLOT_DIRECTORY_NAME = ".host-proof-slots";
const DIRECTORY_MODE = 0o755;
const SLOT_MODE = 0o666;

type HostProofSlotConfig = Pick<RunnerConfig, "workspaceRoot" | "hostProofSlots">;
type Owner = { uid: number; gid: number };

export const hostProofSlotDirectory = (config: Pick<RunnerConfig, "workspaceRoot">): string =>
  join(config.workspaceRoot, SLOT_DIRECTORY_NAME);

const filesystemMode = (value: number): number => value & 0o7777;
const octal = (value: number): string => filesystemMode(value).toString(8).padStart(4, "0");

const daemonOwner = (): Owner => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("Host proof slots require POSIX process ownership");
  return { uid, gid };
};

const assertOwner = (path: string, uid: number, gid: number, owner: Owner): void => {
  if (uid !== owner.uid || gid !== owner.gid) {
    throw new Error(`Host proof slot path ${path} has owner ${uid}:${gid}; expected ${owner.uid}:${owner.gid}`);
  }
};

const validateDirectory = async (path: string, owner: Owner): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Host proof slot path ${path} is not a non-symlink directory`);
  }
  if (filesystemMode(info.mode) !== DIRECTORY_MODE) {
    throw new Error(`Host proof slot directory ${path} has mode ${octal(info.mode)}; expected 0755`);
  }
  assertOwner(path, info.uid, info.gid, owner);
};

const validateSlotFile = async (path: string, owner: Owner): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Host proof slot path ${path} is not a non-symlink regular file`);
  }
  if (filesystemMode(info.mode) !== SLOT_MODE) {
    throw new Error(`Host proof slot file ${path} has mode ${octal(info.mode)}; expected 0666`);
  }
  assertOwner(path, info.uid, info.gid, owner);
};

const isAlreadyPresent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "EEXIST";

const ensureDirectory = async (path: string, owner: Owner): Promise<void> => {
  let created = false;
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error: unknown) {
    if (!isAlreadyPresent(error)) throw error;
  }
  if (created) {
    await chmod(path, DIRECTORY_MODE);
    await chown(path, owner.uid, owner.gid);
  }
  // A concurrent daemon can win mkdir while it is still applying exact mode
  // and ownership. Give that creator a short bounded publication window; an
  // established mismatch remains a startup failure.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await validateDirectory(path, owner);
      return;
    } catch (error: unknown) {
      if (created || attempt === 9) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
};

/**
 * Publish a fully permissioned inode with link(2), so another runner daemon
 * can never observe the target name between creation and fchmod.
 */
const ensureSlotFile = async (directory: string, path: string, owner: Owner): Promise<void> => {
  const temporary = join(directory, `.creating-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.chmod(SLOT_MODE);
    await handle.chown(owner.uid, owner.gid);
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, path);
    } catch (error: unknown) {
      if (!isAlreadyPresent(error)) throw error;
    }
  } finally {
    await unlink(temporary);
  }
  await validateSlotFile(path, owner);
};

/** Prepare the daemon-owned, host-shared files before the runner begins polling. */
export const prepareHostProofSlots = async (config: HostProofSlotConfig): Promise<void> => {
  const directory = hostProofSlotDirectory(config);
  const owner = daemonOwner();
  await ensureDirectory(directory, owner);
  await Promise.all(Array.from({ length: config.hostProofSlots }, async (_, index) =>
    ensureSlotFile(directory, join(directory, `slot-${index + 1}.lock`), owner)));
};
