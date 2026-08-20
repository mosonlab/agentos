import { createRequire } from "node:module";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";

interface NativeDirectoryOperations {
  openDirectory(path: string): number;
  openAt(directoryFd: number, name: string, flags: number, mode: number): number;
  mkdirAt(directoryFd: number, name: string, mode: number): void;
  renameAt(directoryFd: number, source: string, destination: string): void;
  unlinkAt(directoryFd: number, name: string): void;
  listAt(directoryFd: number): string[];
}

const require = createRequire(import.meta.url);
const native = require("../build/Release/control_plane_directory.node") as NativeDirectoryOperations;

const validateName = (name: string): void => {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error("control-state-name-is-not-one-component");
  }
};

const currentUid = (): bigint => {
  if (!process.geteuid) throw new Error("control-state-effective-uid-unavailable");
  return BigInt(process.geteuid());
};

const assertProtectedDirectoryStats = (stats: BigIntStats, label: string): void => {
  if (!stats.isDirectory()) throw new Error(`${label}-not-directory`);
  if (stats.uid !== currentUid()) throw new Error(`${label}-owner-mismatch`);
  if ((Number(stats.mode) & 0o777) !== 0o700) throw new Error(`${label}-mode-mismatch`);
};

export class BoundDirectory {
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: number;
  readonly mode: number;
  private closed = false;

  private constructor(readonly fd: number) {
    const stats = fstatSync(fd, { bigint: true });
    assertProtectedDirectoryStats(stats, "control-state-directory");
    this.device = stats.dev;
    this.inode = stats.ino;
    this.uid = Number(stats.uid);
    this.mode = Number(stats.mode) & 0o777;
  }

  static open(path: string): BoundDirectory {
    const fd = native.openDirectory(path);
    try {
      return new BoundDirectory(fd);
    } catch (error: unknown) {
      closeSync(fd);
      throw error;
    }
  }

  openDirectory(name: string): BoundDirectory {
    validateName(name);
    const fd = native.openAt(this.fd, name, constants.O_RDONLY | constants.O_DIRECTORY, 0);
    try {
      return new BoundDirectory(fd);
    } catch (error: unknown) {
      closeSync(fd);
      throw error;
    }
  }

  mkdir(name: string, mode = 0o700): void {
    validateName(name);
    native.mkdirAt(this.fd, name, mode);
  }

  openFile(name: string, flags: number, mode = 0): number {
    validateName(name);
    return native.openAt(this.fd, name, flags, mode);
  }

  list(): string[] {
    return native.listAt(this.fd);
  }

  rename(source: string, destination: string): void {
    validateName(source);
    validateName(destination);
    native.renameAt(this.fd, source, destination);
  }

  unlink(name: string): void {
    validateName(name);
    native.unlinkAt(this.fd, name);
  }

  sync(): void {
    fsyncSync(this.fd);
  }

  assertPathIdentity(path: string, reason: string): void {
    try {
      const pathStats = lstatSync(path, { bigint: true });
      if (pathStats.isDirectory() && !pathStats.isSymbolicLink()
        && pathStats.dev === this.device && pathStats.ino === this.inode) return;
    } catch {
      // Absence and an unreadable replacement are the same identity failure.
    }
    throw new Error(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

export const openPersistentFile = (directory: BoundDirectory, name: string): { fd: number; device: bigint; inode: bigint } => {
  let fd: number;
  let created = false;
  try {
    fd = directory.openFile(name, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    created = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = directory.openFile(name, constants.O_RDWR);
  }
  try {
    if (created) fchmodSync(fd, 0o600);
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isFile()) throw new Error("control-state-lock-not-regular");
    if (stats.uid !== currentUid() || (Number(stats.mode) & 0o777) !== 0o600) {
      throw new Error("control-state-lock-owner-or-mode-mismatch");
    }
    return { fd, device: stats.dev, inode: stats.ino };
  } catch (error: unknown) {
    closeSync(fd);
    throw error;
  }
};

export const readOptionalFile = (directory: BoundDirectory, name: string): Buffer | null => {
  let fd: number;
  try {
    fd = directory.openFile(name, constants.O_RDONLY);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isFile()) throw new Error("durable-record-not-regular");
    if (stats.uid !== currentUid() || (Number(stats.mode) & 0o777) !== 0o600) {
      throw new Error("durable-record-owner-or-mode-mismatch");
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
};

export type AtomicWritePhase = "before-write" | "before-rename" | "before-directory-sync";

export const atomicWriteJson = (
  directory: BoundDirectory,
  destination: string,
  incarnationId: string,
  value: unknown,
  phaseHook?: (phase: AtomicWritePhase) => void,
): void => {
  validateName(destination);
  const temporary = `.${destination}.tmp-${process.pid}-${incarnationId}`;
  const fd = directory.openFile(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    fchmodSync(fd, 0o600);
    phaseHook?.("before-write");
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  phaseHook?.("before-rename");
  directory.rename(temporary, destination);
  phaseHook?.("before-directory-sync");
  directory.sync();
};

export const assertNamedFileIdentity = (
  directory: BoundDirectory,
  name: string,
  expected: { device: bigint; inode: bigint },
  reason: string,
): void => {
  const fd = directory.openFile(name, constants.O_RDONLY);
  try {
    const stats = fstatSync(fd, { bigint: true });
    if (stats.dev !== expected.device || stats.ino !== expected.inode) throw new Error(reason);
  } finally {
    closeSync(fd);
  }
};
