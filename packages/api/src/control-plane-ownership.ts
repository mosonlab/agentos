import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { hostname } from "node:os";

import { constants as fsExtConstants, fcntlSync, flock } from "fs-ext";
import { z } from "zod";

import {
  canonicalizeFilesRoot,
  controlPlaneIdFilename,
  controlPlaneLockFilename,
  controlPlaneOwnerFilename,
  openPersistentLockFile,
  prepareControlPlaneState,
  type PreparedControlPlaneState,
  type PrepareControlPlaneStateOptions,
  type SupportedFilesystem,
} from "./control-plane-state.js";
import {
  assertNamedFileIdentity,
  type AtomicWritePhase,
  atomicWriteJson,
  type BoundDirectory,
  readOptionalFile,
} from "./control-plane-directory.js";
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

const ownerRecordFields = {
  state: z.enum(["owned", "released"]),
  controlPlaneId: z.string().uuid(),
  incarnationId: z.string().uuid(),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  canonicalWorkspaceRoot: z.string().min(1),
  controlStateDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  workspaceRootInode: z.string().regex(/^\d+$/u),
  lockInode: z.string().regex(/^\d+$/u),
  acquiredAt: z.string().datetime(),
  releasedAt: z.string().datetime().optional(),
} as const;

const refineOwnerRecord = (
  record: { state: "owned" | "released"; releasedAt?: string | undefined },
  context: z.RefinementCtx,
) => {
  if (record.state === "released" && !record.releasedAt) context.addIssue({ code: "custom", message: "releasedAt required" });
  if (record.state === "owned" && record.releasedAt) context.addIssue({ code: "custom", message: "releasedAt forbidden" });
};

// v1 persisted device numbers. A mount can receive a different device number
// after reboot, so v1 remains readable for one safe upgrade but those fields
// are deliberately excluded from cross-incarnation identity checks.
const legacyOwnerRecordSchema = z.object({
  formatVersion: z.literal(1),
  ...ownerRecordFields,
  workspaceRootDevice: z.string().regex(/^\d+$/u),
  lockDevice: z.string().regex(/^\d+$/u),
}).strict().superRefine(refineOwnerRecord);

const currentOwnerRecordSchema = z.object({
  formatVersion: z.literal(2),
  ...ownerRecordFields,
}).strict().superRefine(refineOwnerRecord);

const ownerRecordSchema = z.union([legacyOwnerRecordSchema, currentOwnerRecordSchema]);

export type StableControlPlaneRecord = z.infer<typeof stableRecordSchema>;
export type ControlPlaneOwnerRecord = z.infer<typeof ownerRecordSchema>;

export class ControlPlaneOwnershipStartupError extends Error {
  readonly exitCode = CONTROL_PLANE_OWNERSHIP_EXIT_CODE;
  constructor(
    readonly reason: string,
    readonly marker: "CONTROL_PLANE_OWNERSHIP_CONFLICT" | "CONTROL_PLANE_OWNERSHIP_REFUSED",
    readonly secondaryFailures: readonly unknown[] = [],
  ) {
    super(`Control-plane ownership ${marker === "CONTROL_PLANE_OWNERSHIP_CONFLICT" ? "conflict" : "refused"}: ${reason}`);
    this.name = "ControlPlaneOwnershipStartupError";
  }
}

const lockAsync = (fd: number, operation: "exnb" | "un"): Promise<void> => new Promise((resolve, reject) => {
  flock(fd, operation, (error) => error ? reject(error) : resolve());
});

const markerLine = (marker: OwnershipMarker, fields: Record<string, unknown>): string => `${marker} ${JSON.stringify(fields)}`;

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

const tempPattern = /^\.(control-plane-id\.json|owner\.json)\.tmp-\d+-[0-9a-f]{8}-[0-9a-f-]{27}$/u;

const inventoryEntry = (entryDirectory: BoundDirectory): string[] => {
  const safeTemps: string[] = [];
  for (const name of entryDirectory.list()) {
    if ([controlPlaneLockFilename, controlPlaneIdFilename, controlPlaneOwnerFilename].includes(name)) continue;
    if (!tempPattern.test(name)) throw new Error(`unexpected-control-state-entry:${name}`);
    const fd = entryDirectory.openFile(name, fsConstants.O_RDONLY);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o600) {
        throw new Error(`unsafe-control-state-temp:${name}`);
      }
    } finally {
      closeSync(fd);
    }
    safeTemps.push(name);
  }
  return safeTemps;
};

const assertBoundState = (state: PreparedControlPlaneState): void => {
  state.baseDirectory.assertPathIdentity(state.basePath, "control-state-base-path-replaced");
  let currentEntry: BoundDirectory;
  try {
    currentEntry = state.baseDirectory.openDirectory(state.digest);
  } catch {
    throw new Error("control-state-entry-path-replaced");
  }
  try {
    if (currentEntry.device !== state.entryDirectory.device || currentEntry.inode !== state.entryDirectory.inode) {
      throw new Error("control-state-entry-path-replaced");
    }
  } finally {
    currentEntry.close();
  }
};

class MarkerTransportFailure extends Error {
  constructor(readonly failure: unknown) {
    super("marker-transport-failure");
    this.name = "MarkerTransportFailure";
  }
}

const recordsMatch = (
  stable: StableControlPlaneRecord,
  owner: ControlPlaneOwnerRecord,
  workspace: CanonicalWorkspaceRoot,
  digest: string,
  lockIdentity: { inode: bigint },
): boolean => stable.controlPlaneId === owner.controlPlaneId
  && stable.canonicalWorkspaceRoot === workspace.canonicalPath
  && owner.canonicalWorkspaceRoot === workspace.canonicalPath
  && stable.controlStateDigest === digest
  && owner.controlStateDigest === digest
  && owner.workspaceRootInode === workspace.inode.toString()
  && owner.lockInode === lockIdentity.inode.toString();

export interface AcquireControlPlaneOwnershipOptions {
  workspaceRoot?: string;
  filesRoot?: string;
  stateDir?: string;
  filesystemTypeProbe?: PrepareControlPlaneStateOptions["filesystemTypeProbe"];
  cloexecProbe?: (fd: number) => boolean;
  markerWriter?: MarkerWriter;
  now?: () => Date;
  hostname?: string;
  stateOperationHook?: (operation: string, entryPath: string) => void | Promise<void>;
  stateMutationHook?: (operation: "write-stable" | "write-owner" | "release-owner", phase: AtomicWritePhase) => void;
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
  let state: PreparedControlPlaneState | undefined;
  let lock: Awaited<ReturnType<typeof openPersistentLockFile>> | undefined;
  let locked = false;
  let lockClosed = false;
  let directoriesClosed = false;
  let diagnosticOwner: Record<string, string | number> = {};
  const closeResources = async (): Promise<unknown[]> => {
    const failures: unknown[] = [];
    if (locked && lock) {
      locked = false;
      try { await lockAsync(lock.fd, "un"); } catch (error: unknown) { failures.push(error); }
    }
    if (lock && !lockClosed) {
      lockClosed = true;
      try { closeSync(lock.fd); } catch (error: unknown) { failures.push(error); }
    }
    if (state && !directoriesClosed) {
      directoriesClosed = true;
      try { state.entryDirectory.close(); } catch (error: unknown) { failures.push(error); }
      try { state.baseDirectory.close(); } catch (error: unknown) { failures.push(error); }
    }
    return failures;
  };
  const refuse = async (
    reason: string,
    marker: "CONTROL_PLANE_OWNERSHIP_CONFLICT" | "CONTROL_PLANE_OWNERSHIP_REFUSED" = "CONTROL_PLANE_OWNERSHIP_REFUSED",
    markerFailure?: unknown,
  ): Promise<never> => {
    const secondaryFailures = await closeResources();
    if (markerFailure !== undefined) {
      secondaryFailures.push(markerFailure);
    } else {
      try {
        await writer(markerLine(marker, { reason, canonicalWorkspaceRoot: workspace?.canonicalPath ?? null, pid: process.pid, ...diagnosticOwner }));
      } catch (error: unknown) {
        secondaryFailures.push(error);
      }
    }
    throw new ControlPlaneOwnershipStartupError(reason, marker, secondaryFailures);
  };
  const emitMarker = async (line: string): Promise<void> => {
    try { await writer(line); } catch (error: unknown) { throw new MarkerTransportFailure(error); }
  };
  const stateOperation = async <T>(operation: string, action: () => T | Promise<T>): Promise<T> => {
    if (!state) throw new Error("control-state-not-bound");
    await options.stateOperationHook?.(operation, state.entryPath);
    assertBoundState(state);
    const result = await action();
    assertBoundState(state);
    return result;
  };
  const writeStateJson = (
    operation: "write-stable" | "write-owner" | "release-owner",
    destination: string,
    incarnationId: string,
    value: unknown,
  ): void => {
    atomicWriteJson(
      state!.entryDirectory,
      destination,
      incarnationId,
      value,
      (phase) => options.stateMutationHook?.(operation, phase),
    );
  };

  try {
    workspace = await canonicalizeWorkspaceRoot(options.workspaceRoot);
    const filesRoot = options.filesRoot ? await canonicalizeFilesRoot(options.filesRoot) : undefined;
    state = await prepareControlPlaneState({
      canonicalWorkspaceRoot: workspace.canonicalPath,
      ...(options.stateDir ? { configuredStateDir: options.stateDir } : {}),
      ...(filesRoot ? { canonicalFilesRoot: filesRoot.canonicalPath } : {}),
      ...(options.filesystemTypeProbe ? { filesystemTypeProbe: options.filesystemTypeProbe } : {}),
    });
    await stateOperation("open-lock", () => { lock = openPersistentLockFile(state!.entryDirectory); });
    if (!lock) throw new Error("control-state-lock-not-opened");
    const activeLock = lock;
    const hasCloseOnExec = options.cloexecProbe
      ? options.cloexecProbe(activeLock.fd)
      : (fcntlSync(activeLock.fd, "getfd") & fsExtConstants.FD_CLOEXEC) !== 0;
    if (!hasCloseOnExec) return await refuse("lock-descriptor-missing-cloexec");
    try {
      await lockAsync(activeLock.fd, "exnb");
      locked = true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EWOULDBLOCK" || code === "EAGAIN") {
        try {
          const diagnostic = parseRecord(await stateOperation("read-conflict-owner", () => (
            readOptionalFile(state!.entryDirectory, controlPlaneOwnerFilename)
          )), ownerRecordSchema);
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

    const safeTemps = await stateOperation("inventory", () => inventoryEntry(state!.entryDirectory))
      .catch(async (error: unknown) => refuse((error as Error).message));
    const [stableBytes, ownerBytes] = await stateOperation("read-records", () => ([
      readOptionalFile(state!.entryDirectory, controlPlaneIdFilename),
      readOptionalFile(state!.entryDirectory, controlPlaneOwnerFilename),
    ] as const));
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
      if (!recordsMatch(stableValue, priorOwner.value, workspace, state.digest, activeLock)) return await refuse("owner-record-identity-mismatch");
      if (priorOwner.value.state === "owned") {
        // The exclusive lock is the liveness authority. Once this process holds
        // the same inode recorded by the prior owner, neither a mutable hostname
        // nor a reused PID can prove that the prior incarnation is still alive.
        recoveredFrom = priorOwner.value;
      }
    }

    for (const name of safeTemps) await stateOperation(`remove-temp:${name}`, () => state!.entryDirectory.unlink(name));
    if (stable.absent) await stateOperation("write-stable", () => (
      writeStateJson("write-stable", controlPlaneIdFilename, incarnationId, stableValue)
    ));
    const acquiredAt = (options.now ?? (() => new Date()))().toISOString();
    const ownerValue: ControlPlaneOwnerRecord = {
      formatVersion: 2,
      state: "owned",
      controlPlaneId: stableValue.controlPlaneId,
      incarnationId,
      pid: process.pid,
      hostname: options.hostname ?? hostname(),
      canonicalWorkspaceRoot: workspace.canonicalPath,
      controlStateDigest: state.digest,
      workspaceRootInode: workspace.inode.toString(),
      lockInode: activeLock.inode.toString(),
      acquiredAt,
    };
    await stateOperation("write-owner", () => (
      writeStateJson("write-owner", controlPlaneOwnerFilename, incarnationId, ownerValue)
    ));
    if (recoveredFrom) {
      await emitMarker(markerLine("CONTROL_PLANE_OWNERSHIP_RECOVERED", {
        canonicalWorkspaceRoot: workspace.canonicalPath,
        controlPlaneId: stableValue.controlPlaneId,
        priorIncarnationId: recoveredFrom.incarnationId,
        incarnationId,
        priorPid: recoveredFrom.pid,
        pid: process.pid,
      }));
    }
    await emitMarker(markerLine("CONTROL_PLANE_OWNERSHIP_ACQUIRED", {
      canonicalWorkspaceRoot: workspace.canonicalPath,
      controlPlaneId: stableValue.controlPlaneId,
      incarnationId,
      pid: process.pid,
      hostname: ownerValue.hostname,
      filesystem: state.filesystem,
      stateDevice: state.device.toString(),
      stateUid: state.uid,
      stateMode: state.mode.toString(8),
      lockDevice: activeLock.device.toString(),
      lockInode: activeLock.inode.toString(),
    }));

    let poisonedReason: string | null = null;
    let released = false;
    const assertHeld = async (): Promise<void> => {
      if (released) throw new Error("control-plane-ownership-released");
      if (poisonedReason) throw new Error(`control-plane-ownership-poisoned:${poisonedReason}`);
      try {
        const [descriptor, configuredCanonical, rootIdentity, configuredFilesCanonical, filesIdentity] = await Promise.all([
          Promise.resolve(fstatSync(activeLock.fd, { bigint: true })),
          realpath(workspace!.configuredPath),
          lstat(workspace!.canonicalPath, { bigint: true }),
          filesRoot ? realpath(filesRoot.configuredPath) : Promise.resolve(undefined),
          filesRoot ? lstat(filesRoot.canonicalPath, { bigint: true }) : Promise.resolve(undefined),
        ]);
        if (descriptor.dev !== activeLock.device || descriptor.ino !== activeLock.inode) throw new Error("lock-descriptor-identity-drift");
        assertBoundState(state!);
        assertNamedFileIdentity(state!.entryDirectory, controlPlaneLockFilename, activeLock, "lock-path-identity-drift");
        if (configuredCanonical !== workspace!.canonicalPath) throw new Error("workspace-root-retargeted");
        if (rootIdentity.dev !== workspace!.device || rootIdentity.ino !== workspace!.inode) throw new Error("workspace-root-identity-drift");
        if (filesRoot && configuredFilesCanonical !== filesRoot.canonicalPath) throw new Error("files-root-retargeted");
        if (filesRoot && filesIdentity && (filesIdentity.dev !== filesRoot.device || filesIdentity.ino !== filesRoot.inode)) {
          throw new Error("files-root-identity-drift");
        }
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
          await stateOperation("release-owner", () => writeStateJson("release-owner", controlPlaneOwnerFilename, incarnationId, {
            ...ownerValue,
            state: "released",
            releasedAt: (options.now ?? (() => new Date()))().toISOString(),
          }));
          clean = true;
        } catch (error: unknown) {
          poisonedReason = poisonedReason ?? (error as Error).message;
          released = true;
        }
      }
      const cleanupFailures = await closeResources();
      if (cleanupFailures.length > 0) {
        poisonedReason = poisonedReason ?? "ownership-resource-cleanup-failed";
        clean = false;
      }
      if (clean) {
        await emitMarker(markerLine("CONTROL_PLANE_OWNERSHIP_RELEASED", {
          canonicalWorkspaceRoot: workspace!.canonicalPath,
          controlPlaneId: stableValue.controlPlaneId,
          incarnationId,
          pid: process.pid,
        }));
      } else {
        await emitMarker(markerLine("CONTROL_PLANE_OWNERSHIP_REFUSED", {
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
      lockDevice: activeLock.device,
      lockInode: activeLock.inode,
      assertHeld,
      release,
    };
  } catch (error: unknown) {
    if (error instanceof ControlPlaneOwnershipStartupError) throw error;
    if (error instanceof MarkerTransportFailure) return await refuse("marker-transport-failure", "CONTROL_PLANE_OWNERSHIP_REFUSED", error.failure);
    return await refuse((error as NodeJS.ErrnoException).code
      ? `${(error as NodeJS.ErrnoException).code}:${(error as Error).message}`
      : (error as Error).message);
  }
};
