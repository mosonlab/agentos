import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { constants as fsExtConstants, fcntlSync, flock } from "fs-ext";
import { z } from "zod";

import {
  controlPlaneIdFilename,
  controlPlaneLockFilename,
  controlPlaneOwnerFilename,
  openPersistentLockFile,
  prepareControlPlaneState,
  type PrepareControlPlaneStateOptions,
  type SupportedFilesystem,
} from "./control-plane-state.js";
import { canonicalizeWorkspaceRoot, type CanonicalWorkspaceRoot } from "./workspace-root.js";

export const CONTROL_PLANE_OWNERSHIP_EXIT_CODE = 75;

export type OwnershipMarker =
  | "CONTROL_PLANE_OWNERSHIP_ACQUIRED"
  | "CONTROL_PLANE_OWNERSHIP_RECOVERED"
  | "CONTROL_PLANE_OWNERSHIP_CONFLICT"
  | "CONTROL_PLANE_OWNERSHIP_REFUSED"
  | "CONTROL_PLANE_OWNERSHIP_RELEASED";

type MarkerWriter = (line: string) => void | Promise<void>;

const defaultMarkerWriter: MarkerWriter = (line) => new Promise<void>((resolve, reject) => {
  process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolve());
});

const stableRecordSchema = z.object({
  formatVersion: z.literal(1),
  controlPlaneId: z.string().uuid(),
  canonicalWorkspaceRoot: z.string().min(1),
  controlStateDigest: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

const ownerRecordSchema = z.object({
  formatVersion: z.literal(1),
  state: z.enum(["owned", "released"]),
  controlPlaneId: z.string().uuid(),
  incarnationId: z.string().uuid(),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  canonicalWorkspaceRoot: z.string().min(1),
  controlStateDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  workspaceRootDevice: z.string().regex(/^\d+$/u),
  workspaceRootInode: z.string().regex(/^\d+$/u),
  lockDevice: z.string().regex(/^\d+$/u),
  lockInode: z.string().regex(/^\d+$/u),
  acquiredAt: z.string().datetime(),
  releasedAt: z.string().datetime().optional(),
}).strict().superRefine((record, context) => {
  if (record.state === "released" && !record.releasedAt) context.addIssue({ code: "custom", message: "releasedAt required" });
  if (record.state === "owned" && record.releasedAt) context.addIssue({ code: "custom", message: "releasedAt forbidden" });
});

export type StableControlPlaneRecord = z.infer<typeof stableRecordSchema>;
export type ControlPlaneOwnerRecord = z.infer<typeof ownerRecordSchema>;

export class ControlPlaneOwnershipStartupError extends Error {
  readonly exitCode = CONTROL_PLANE_OWNERSHIP_EXIT_CODE;
  constructor(readonly reason: string, readonly marker: "CONTROL_PLANE_OWNERSHIP_CONFLICT" | "CONTROL_PLANE_OWNERSHIP_REFUSED") {
    super(`Control-plane ownership ${marker === "CONTROL_PLANE_OWNERSHIP_CONFLICT" ? "conflict" : "refused"}: ${reason}`);
    this.name = "ControlPlaneOwnershipStartupError";
  }
}

const lockAsync = (fd: number, operation: "exnb" | "un"): Promise<void> => new Promise((resolve, reject) => {
  flock(fd, operation, (error) => error ? reject(error) : resolve());
});

const markerLine = (marker: OwnershipMarker, fields: Record<string, unknown>): string => `${marker} ${JSON.stringify(fields)}`;

const readOptional = async (path: string): Promise<Buffer | null> => {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const [descriptor, authoritative] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    if (!descriptor.isFile() || !authoritative.isFile() || authoritative.isSymbolicLink()) throw new Error("durable-record-not-regular");
    if (descriptor.uid !== BigInt(process.geteuid?.() ?? -1) || (Number(descriptor.mode) & 0o777) !== 0o600) {
      throw new Error("durable-record-owner-or-mode-mismatch");
    }
    if (descriptor.dev !== authoritative.dev || descriptor.ino !== authoritative.ino) throw new Error("durable-record-path-replaced");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const parseRecord = <T>(buffer: Buffer | null, schema: z.ZodType<T>): { absent: true } | { absent: false; value: T } => {
  if (buffer === null) return { absent: true };
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("malformed-json");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error("malformed-record");
  return { absent: false, value: parsed.data };
};

const atomicWriteJson = async (entryPath: string, destination: string, incarnationId: string, value: unknown): Promise<void> => {
  const temporary = join(entryPath, `.${destination}.tmp-${process.pid}-${incarnationId}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, join(entryPath, destination));
  const directory = await open(entryPath, "r");
  try { await directory.sync(); } finally { await directory.close(); }
};

const tempPattern = /^\.(control-plane-id\.json|owner\.json)\.tmp-\d+-[0-9a-f]{8}-[0-9a-f-]{27}$/u;

const inventoryEntry = async (entryPath: string): Promise<string[]> => {
  const safeTemps: string[] = [];
  for (const name of await readdir(entryPath)) {
    if ([controlPlaneLockFilename, controlPlaneIdFilename, controlPlaneOwnerFilename].includes(name)) continue;
    if (!tempPattern.test(name)) throw new Error(`unexpected-control-state-entry:${name}`);
    const path = join(entryPath, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o600) {
      throw new Error(`unsafe-control-state-temp:${name}`);
    }
    safeTemps.push(path);
  }
  return safeTemps;
};

const recordsMatch = (
  stable: StableControlPlaneRecord,
  owner: ControlPlaneOwnerRecord,
  workspace: CanonicalWorkspaceRoot,
  digest: string,
  lockIdentity: { device: bigint; inode: bigint },
): boolean => stable.controlPlaneId === owner.controlPlaneId
  && stable.canonicalWorkspaceRoot === workspace.canonicalPath
  && owner.canonicalWorkspaceRoot === workspace.canonicalPath
  && stable.controlStateDigest === digest
  && owner.controlStateDigest === digest
  && owner.workspaceRootDevice === workspace.device.toString()
  && owner.workspaceRootInode === workspace.inode.toString()
  && owner.lockDevice === lockIdentity.device.toString()
  && owner.lockInode === lockIdentity.inode.toString();

export interface AcquireControlPlaneOwnershipOptions {
  workspaceRoot?: string;
  filesRoot?: string;
  stateDir?: string;
  filesystemTypeProbe?: PrepareControlPlaneStateOptions["filesystemTypeProbe"];
  cloexecProbe?: (fd: number) => boolean;
  livenessProbe?: (pid: number) => void;
  markerWriter?: MarkerWriter;
  now?: () => Date;
  hostname?: string;
}

export interface ControlPlaneOwnership {
  canonicalWorkspaceRoot: string;
  configuredWorkspaceRoot: string;
  workspaceRootDevice: bigint;
  workspaceRootInode: bigint;
  controlPlaneId: string;
  incarnationId: string;
  controlStateDigest: string;
  controlStateEntryPath: string;
  controlStateFilesystem: SupportedFilesystem;
  lockDevice: bigint;
  lockInode: bigint;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export const acquireControlPlaneOwnership = async (
  options: AcquireControlPlaneOwnershipOptions = {},
): Promise<ControlPlaneOwnership> => {
  const writer = options.markerWriter ?? defaultMarkerWriter;
  let workspace: CanonicalWorkspaceRoot | undefined;
  let lock: Awaited<ReturnType<typeof openPersistentLockFile>> | undefined;
  let locked = false;
  let diagnosticOwner: Record<string, string | number> = {};
  const refuse = async (reason: string, marker: "CONTROL_PLANE_OWNERSHIP_CONFLICT" | "CONTROL_PLANE_OWNERSHIP_REFUSED" = "CONTROL_PLANE_OWNERSHIP_REFUSED"): Promise<never> => {
    if (locked && lock) await lockAsync(lock.handle.fd, "un").catch(() => undefined);
    if (lock) await lock.handle.close().catch(() => undefined);
    await writer(markerLine(marker, { reason, canonicalWorkspaceRoot: workspace?.canonicalPath ?? null, pid: process.pid, ...diagnosticOwner }));
    throw new ControlPlaneOwnershipStartupError(reason, marker);
  };

  try {
    workspace = await canonicalizeWorkspaceRoot(options.workspaceRoot);
    const state = await prepareControlPlaneState({
      canonicalWorkspaceRoot: workspace.canonicalPath,
      ...(options.stateDir ? { configuredStateDir: options.stateDir } : {}),
      ...(options.filesRoot ? { filesRoot: options.filesRoot } : {}),
      ...(options.filesystemTypeProbe ? { filesystemTypeProbe: options.filesystemTypeProbe } : {}),
    });
    lock = await openPersistentLockFile(state.entryPath);
    const hasCloseOnExec = options.cloexecProbe
      ? options.cloexecProbe(lock.handle.fd)
      : (fcntlSync(lock.handle.fd, "getfd") & fsExtConstants.FD_CLOEXEC) !== 0;
    if (!hasCloseOnExec) return await refuse("lock-descriptor-missing-cloexec");
    try {
      await lockAsync(lock.handle.fd, "exnb");
      locked = true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EWOULDBLOCK" || code === "EAGAIN") {
        try {
          const diagnostic = parseRecord(await readOptional(join(state.entryPath, controlPlaneOwnerFilename)), ownerRecordSchema);
          if (!diagnostic.absent) diagnosticOwner = {
            ownerControlPlaneId: diagnostic.value.controlPlaneId,
            ownerIncarnationId: diagnostic.value.incarnationId,
            ownerPid: diagnostic.value.pid,
            ownerHostname: diagnostic.value.hostname,
          };
        } catch { /* malformed diagnostics never weaken the held-lock conflict */ }
        return await refuse("ownership-lock-held", "CONTROL_PLANE_OWNERSHIP_CONFLICT");
      }
      return await refuse(`ownership-lock-failure:${code ?? "unknown"}`);
    }

    const safeTemps = await inventoryEntry(state.entryPath).catch(async (error: unknown) => refuse((error as Error).message));
    const stablePath = join(state.entryPath, controlPlaneIdFilename);
    const ownerPath = join(state.entryPath, controlPlaneOwnerFilename);
    const [stableBytes, ownerBytes] = await Promise.all([readOptional(stablePath), readOptional(ownerPath)]);
    let stable: ReturnType<typeof parseRecord<StableControlPlaneRecord>>;
    let priorOwner: ReturnType<typeof parseRecord<ControlPlaneOwnerRecord>>;
    try {
      stable = parseRecord(stableBytes, stableRecordSchema);
      priorOwner = parseRecord(ownerBytes, ownerRecordSchema);
    } catch (error: unknown) {
      return await refuse((error as Error).message);
    }
    if (stable.absent && !priorOwner.absent) return await refuse("owner-record-without-stable-id");

    const incarnationId = randomUUID();
    let stableValue: StableControlPlaneRecord;
    let recoveredFrom: ControlPlaneOwnerRecord | null = null;
    if (stable.absent) {
      stableValue = {
        formatVersion: 1,
        controlPlaneId: randomUUID(),
        canonicalWorkspaceRoot: workspace.canonicalPath,
        controlStateDigest: state.digest,
      };
    } else {
      stableValue = stable.value;
      if (stableValue.canonicalWorkspaceRoot !== workspace.canonicalPath || stableValue.controlStateDigest !== state.digest) {
        return await refuse("stable-id-root-or-digest-mismatch");
      }
    }

    if (!priorOwner.absent) {
      if (!recordsMatch(stableValue, priorOwner.value, workspace, state.digest, lock)) return await refuse("owner-record-identity-mismatch");
      if (priorOwner.value.state === "owned") {
        if (priorOwner.value.hostname !== (options.hostname ?? hostname())) return await refuse("foreign-host-owner");
        let pidPresent = false;
        try {
          (options.livenessProbe ?? ((pid: number) => process.kill(pid, 0)))(priorOwner.value.pid);
          pidPresent = true;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return await refuse(`owner-liveness-ambiguous:${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
          recoveredFrom = priorOwner.value;
        }
        if (pidPresent) return await refuse("pid-present-owner-identity-ambiguous");
      }
    }

    for (const path of safeTemps) await rm(path);
    if (stable.absent) await atomicWriteJson(state.entryPath, controlPlaneIdFilename, incarnationId, stableValue);
    const acquiredAt = (options.now ?? (() => new Date()))().toISOString();
    const ownerValue: ControlPlaneOwnerRecord = {
      formatVersion: 1,
      state: "owned",
      controlPlaneId: stableValue.controlPlaneId,
      incarnationId,
      pid: process.pid,
      hostname: options.hostname ?? hostname(),
      canonicalWorkspaceRoot: workspace.canonicalPath,
      controlStateDigest: state.digest,
      workspaceRootDevice: workspace.device.toString(),
      workspaceRootInode: workspace.inode.toString(),
      lockDevice: lock.device.toString(),
      lockInode: lock.inode.toString(),
      acquiredAt,
    };
    if (recoveredFrom) {
      await writer(markerLine("CONTROL_PLANE_OWNERSHIP_RECOVERED", {
        canonicalWorkspaceRoot: workspace.canonicalPath,
        controlPlaneId: stableValue.controlPlaneId,
        priorIncarnationId: recoveredFrom.incarnationId,
        incarnationId,
        priorPid: recoveredFrom.pid,
        pid: process.pid,
      }));
    }
    await atomicWriteJson(state.entryPath, controlPlaneOwnerFilename, incarnationId, ownerValue);
    await writer(markerLine("CONTROL_PLANE_OWNERSHIP_ACQUIRED", {
      canonicalWorkspaceRoot: workspace.canonicalPath,
      controlPlaneId: stableValue.controlPlaneId,
      incarnationId,
      pid: process.pid,
      hostname: ownerValue.hostname,
      filesystem: state.filesystem,
      stateDevice: state.device.toString(),
      stateUid: state.uid,
      stateMode: state.mode.toString(8),
      lockDevice: lock.device.toString(),
      lockInode: lock.inode.toString(),
    }));

    let poisonedReason: string | null = null;
    let released = false;
    const assertHeld = async (): Promise<void> => {
      if (released) throw new Error("control-plane-ownership-released");
      if (poisonedReason) throw new Error(`control-plane-ownership-poisoned:${poisonedReason}`);
      try {
        const [descriptor, authoritative, configuredCanonical, rootIdentity] = await Promise.all([
          lock!.handle.stat({ bigint: true }),
          lstat(lock!.path, { bigint: true }),
          realpath(workspace!.configuredPath),
          lstat(workspace!.canonicalPath, { bigint: true }),
        ]);
        if (descriptor.dev !== authoritative.dev || descriptor.ino !== authoritative.ino) throw new Error("lock-path-identity-drift");
        if (descriptor.dev !== lock!.device || descriptor.ino !== lock!.inode) throw new Error("lock-descriptor-identity-drift");
        if (configuredCanonical !== workspace!.canonicalPath) throw new Error("workspace-root-retargeted");
        if (rootIdentity.dev !== workspace!.device || rootIdentity.ino !== workspace!.inode) throw new Error("workspace-root-identity-drift");
      } catch (error: unknown) {
        poisonedReason = (error as Error).message;
        throw new Error(`control-plane-ownership-poisoned:${poisonedReason}`);
      }
    };
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      let clean = false;
      if (!poisonedReason) {
        try {
          released = false;
          await assertHeld();
          released = true;
          await atomicWriteJson(state.entryPath, controlPlaneOwnerFilename, incarnationId, {
            ...ownerValue,
            state: "released",
            releasedAt: (options.now ?? (() => new Date()))().toISOString(),
          });
          clean = true;
        } catch (error: unknown) {
          poisonedReason = poisonedReason ?? (error as Error).message;
          released = true;
        }
      }
      await lockAsync(lock!.handle.fd, "un").catch(() => undefined);
      await lock!.handle.close().catch(() => undefined);
      if (clean) {
        await writer(markerLine("CONTROL_PLANE_OWNERSHIP_RELEASED", {
          canonicalWorkspaceRoot: workspace!.canonicalPath,
          controlPlaneId: stableValue.controlPlaneId,
          incarnationId,
          pid: process.pid,
        }));
      } else {
        await writer(markerLine("CONTROL_PLANE_OWNERSHIP_REFUSED", {
          reason: `unclean-release:${poisonedReason ?? "integrity-unknown"}`,
          canonicalWorkspaceRoot: workspace!.canonicalPath,
          controlPlaneId: stableValue.controlPlaneId,
          incarnationId,
          pid: process.pid,
        }));
      }
    };

    return {
      canonicalWorkspaceRoot: workspace.canonicalPath,
      configuredWorkspaceRoot: workspace.configuredPath,
      workspaceRootDevice: workspace.device,
      workspaceRootInode: workspace.inode,
      controlPlaneId: stableValue.controlPlaneId,
      incarnationId,
      controlStateDigest: state.digest,
      controlStateEntryPath: state.entryPath,
      controlStateFilesystem: state.filesystem,
      lockDevice: lock.device,
      lockInode: lock.inode,
      assertHeld,
      release,
    };
  } catch (error: unknown) {
    if (error instanceof ControlPlaneOwnershipStartupError) throw error;
    return await refuse((error as NodeJS.ErrnoException).code
      ? `${(error as NodeJS.ErrnoException).code}:${(error as Error).message}`
      : (error as Error).message);
  }
};
