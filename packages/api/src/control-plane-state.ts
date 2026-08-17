import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const controlPlaneLockFilename = "ownership.lock";
export const controlPlaneIdFilename = "control-plane-id.json";
export const controlPlaneOwnerFilename = "owner.json";

export type SupportedFilesystem = "apfs" | "hfs" | "ext" | "xfs" | "btrfs" | "tmpfs" | "overlay";

const filesystemTypes = new Map<bigint, SupportedFilesystem>([
  [0x1an, "apfs"],
  [0x4244n, "hfs"],
  [0xef53n, "ext"],
  [0x58465342n, "xfs"],
  [0x9123683en, "btrfs"],
  [0x01021994n, "tmpfs"],
  [0x794c7630n, "overlay"],
]);

const refusedFilesystemTypes = new Map<bigint, string>([
  [0x6969n, "nfs"],
  [0x517bn, "smb"],
  [0xff534d42n, "cifs"],
  [0x65735546n, "fuse"],
]);

export const classifyControlStateFilesystem = (rawType: bigint | number): SupportedFilesystem => {
  const type = BigInt.asUintN(64, BigInt(rawType));
  const supported = filesystemTypes.get(type);
  if (supported) return supported;
  const refused = refusedFilesystemTypes.get(type);
  throw new Error(`control-state-filesystem-${refused ? `unsupported-${refused}` : `unknown-0x${type.toString(16)}`}`);
};

export const defaultControlPlaneStateDir = (): string => join(homedir(), ".agentos", "control-plane");

export const controlStateDigest = (canonicalWorkspaceRoot: string): string => (
  createHash("sha256").update(canonicalWorkspaceRoot).digest("hex")
);

const modeBits = (mode: number): number => mode & 0o777;
const currentUid = (): number => {
  if (!process.geteuid) throw new Error("control-state-effective-uid-unavailable");
  return process.geteuid();
};

const pathsOverlap = (left: string, right: string): boolean => (
  left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)
);

const assertProtectedDirectory = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`control-state-directory-invalid:${path}`);
  if (info.uid !== currentUid()) throw new Error(`control-state-directory-owner-mismatch:${path}`);
  if (modeBits(info.mode) !== 0o700) throw new Error(`control-state-directory-mode-mismatch:${path}`);
};

const assertNoSymlinkComponents = async (path: string): Promise<void> => {
  let cursor = resolve(path);
  const components: string[] = [];
  while (dirname(cursor) !== cursor) {
    components.push(cursor);
    cursor = dirname(cursor);
  }
  for (const component of components.reverse()) {
    const info = await lstat(component);
    if (info.isSymbolicLink()) throw new Error(`control-state-symlink-component:${component}`);
  }
};

export interface PreparedControlPlaneState {
  basePath: string;
  entryPath: string;
  digest: string;
  filesystem: SupportedFilesystem;
  device: bigint;
  uid: number;
  mode: number;
}

export interface CanonicalFilesRoot {
  configuredPath: string;
  canonicalPath: string;
  device: bigint;
  inode: bigint;
}

export const canonicalizeFilesRoot = async (configured: string): Promise<CanonicalFilesRoot> => {
  const configuredPath = resolve(configured);
  await mkdir(configuredPath, { recursive: true, mode: 0o750 });
  const canonicalPath = await realpath(configuredPath);
  const identity = await lstat(canonicalPath, { bigint: true });
  if (!identity.isDirectory()) throw new Error(`FILES_ROOT is not a directory: ${configuredPath}`);
  return { configuredPath, canonicalPath, device: identity.dev, inode: identity.ino };
};

export interface PrepareControlPlaneStateOptions {
  canonicalWorkspaceRoot: string;
  canonicalFilesRoot?: string;
  configuredStateDir?: string;
  filesystemTypeProbe?: (path: string) => Promise<bigint | number>;
}

export const prepareControlPlaneState = async (
  options: PrepareControlPlaneStateOptions,
): Promise<PreparedControlPlaneState> => {
  const requestedBase = resolve(options.configuredStateDir ?? process.env.CONTROL_PLANE_STATE_DIR ?? defaultControlPlaneStateDir());
  await mkdir(requestedBase, { recursive: true, mode: 0o700 });
  const basePath = await realpath(requestedBase);
  if (basePath !== requestedBase) throw new Error("control-state-path-is-aliased");
  await assertNoSymlinkComponents(basePath);
  await assertProtectedDirectory(basePath);
  const resolvedWorkspace = resolve(options.canonicalWorkspaceRoot);
  if (pathsOverlap(basePath, resolvedWorkspace)) throw new Error("control-state-overlaps-workspace-root");
  if (options.canonicalFilesRoot && pathsOverlap(basePath, options.canonicalFilesRoot)) {
    throw new Error("control-state-overlaps-files-root");
  }

  const rawType = options.filesystemTypeProbe
    ? await options.filesystemTypeProbe(basePath)
    : (await statfs(basePath, { bigint: true })).type;
  const filesystem = classifyControlStateFilesystem(rawType);
  const digest = controlStateDigest(options.canonicalWorkspaceRoot);
  const entryPath = join(basePath, digest);
  let created = false;
  try {
    await mkdir(entryPath, { mode: 0o700 });
    created = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (created) await chmod(entryPath, 0o700);
  await assertProtectedDirectory(entryPath);
  const info = await lstat(basePath, { bigint: true });
  return { basePath, entryPath, digest, filesystem, device: info.dev, uid: currentUid(), mode: modeBits(Number(info.mode)) };
};

export const openPersistentLockFile = async (entryPath: string) => {
  const path = join(entryPath, controlPlaneLockFilename);
  let existed = true;
  try {
    await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
  }
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  if (!existed) await handle.chmod(0o600);
  const [descriptor, authoritative] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
  if (!descriptor.isFile() || !authoritative.isFile() || authoritative.isSymbolicLink()) {
    await handle.close();
    throw new Error("control-state-lock-not-regular");
  }
  if (descriptor.uid !== BigInt(currentUid()) || (Number(descriptor.mode) & 0o777) !== 0o600) {
    await handle.close();
    throw new Error("control-state-lock-owner-or-mode-mismatch");
  }
  if (descriptor.dev !== authoritative.dev || descriptor.ino !== authoritative.ino) {
    await handle.close();
    throw new Error("control-state-lock-path-replaced");
  }
  return { handle, path, device: descriptor.dev, inode: descriptor.ino };
};
