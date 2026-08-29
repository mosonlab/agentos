import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { DeployFailure } from "./quiet-window-lib.mjs";

export const DEPLOYMENT_LEDGER_SCHEMA_VERSION = 1;
export const DEPLOYMENT_LEDGER_RETENTION_COUNT = 14;
export const DEPLOYMENT_LEDGER_STATES = Object.freeze([
  "STARTED",
  "BACKED_UP",
  "SCHEMA_ADVANCED",
  "ACTIVATED",
  "VERIFIED",
  "SUCCEEDED",
  "FAILED",
  "MANUAL_RECOVERY",
]);

const LEDGER_STATE_SET = new Set(DEPLOYMENT_LEDGER_STATES);
const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "MANUAL_RECOVERY"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SECRET_TEXT = /(DATABASE_URL|(?:API|AUTH|ACCESS|REFRESH|PRIVATE)[_-]?(?:KEY|TOKEN|SECRET)|PASSWORD|\.env|(?:gh[pousr]_\w+)|(?:xox[bap]-[A-Za-z0-9-]+)|(?:sk-[A-Za-z0-9_-]+)|(?:Bearer\s+\S+)|(?:postgres(?:ql)?:\/\/)|(?:https?:\/\/[^/\s]+:[^@\s]+@))/iu;

const invalid = (detail) => {
  throw new DeployFailure("deployment-ledger-invalid", detail);
};

const safeText = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  const text = [...String(value)]
    .filter((character) => {
      const code = character.codePointAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  if (text.length === 0) return fallback;
  if (SECRET_TEXT.test(text)) return "[redacted]";
  return text.slice(0, 512);
};

const safeTargetCommit = (value, fallback = "unknown") => safeText(value, fallback);

const safeBackupIdentity = (value) => {
  if (value === null || value === undefined) return null;
  const candidate = typeof value === "object" && value !== null
    ? value.identity ?? value.backupIdentity ?? value.backup_id
    : value;
  const text = safeText(candidate);
  if (!text) return null;
  const name = basename(text);
  return name === "." || name === ".." || name.includes("/") ? null : name;
};

const safeMigrationTail = (value) => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value
      .map((entry) => safeText(entry))
      .filter((entry) => entry !== null)
      .slice(-100);
  }
  if (typeof value === "object") {
    const name = safeText(value.name ?? value.migrationName ?? value.migration_name);
    return name ?? null;
  }
  return safeText(value);
};

const safeBuildStamp = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const packageName = safeText(value.packageName ?? value.package_name);
  const commit = safeText(value.commit);
  const dirty = value.dirty === true ? true : value.dirty === false ? false : null;
  if (packageName === null && commit === null && dirty === null) return null;
  return { packageName, commit, dirty };
};

const safeReasonCode = (value) => safeText(value, "unknown-failure");

const getMetadata = (metadata, camel, snake) => metadata?.[camel] ?? metadata?.[snake] ?? null;

const ledgerWriteDetail = (error) => {
  const code = safeText(error?.code, null);
  if (code) return code;
  const name = safeText(error?.name, null);
  return name ?? "filesystem-write-failed";
};

/** Raised when a record-only write cannot be persisted. The deploy pipeline
 * treats this as a deploy failure instead of silently dropping evidence. */
export class DeploymentLedgerError extends Error {
  constructor(operation, cause) {
    const detail = `${operation}-${ledgerWriteDetail(cause)}`;
    super(`deployment-ledger-write-failed: ${detail}`);
    this.name = "DeploymentLedgerError";
    this.reason = "deployment-ledger-write-failed";
    this.detail = detail;
    this.cause = cause;
  }
}

const assertDirectory = (path, label) => {
  if (!existsSync(path)) return;
  let status;
  try { status = lstatSync(path); } catch (error) { throw new DeploymentLedgerError(`${label}-inspect`, error); }
  if (status.isSymbolicLink() || !status.isDirectory()) invalid(`${label}-not-a-directory`);
};

const assertSafeLedgerId = (deploymentId) => {
  if (typeof deploymentId !== "string" || !SAFE_ID.test(deploymentId)) invalid("deployment-id-invalid");
  return deploymentId;
};

const atomicWriteJson = (path, value) => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
};

const appendJsonLine = (path, value) => {
  const descriptor = openSync(
    path,
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    writeSync(descriptor, bytes, 0, bytes.byteLength);
  } finally {
    closeSync(descriptor);
  }
};

const assertLedgerDirectory = (path, root) => {
  if (dirname(resolve(path)) !== resolve(root)) {
    throw new DeployFailure("deployment-ledger-retention-refused", "path-escaped-deployment");
  }
  const lexical = lstatSync(path);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new DeployFailure("deployment-ledger-retention-refused", "unsafe-deployment-directory");
  }
  if (dirname(realpathSync(path)) !== realpathSync(root)) {
    throw new DeployFailure("deployment-ledger-retention-refused", "resolved-path-escaped-deployment");
  }
};

/** Remove old per-deployment directories while leaving every unrecognised state
 * entry alone. The newest bounded set is retained, including the current run. */
export const pruneDeploymentLedgers = ({
  stateDir,
  limit = DEPLOYMENT_LEDGER_RETENTION_COUNT,
} = {}) => {
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new DeployFailure("deployment-ledger-retention-refused", "state-directory-missing");
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new DeployFailure("deployment-ledger-retention-refused", "ledger-limit-invalid");
  }
  const root = join(resolve(stateDir), "deployments");
  if (!existsSync(root)) return Object.freeze({ kept: 0, removed: 0 });
  assertDirectory(root, "deployment-directory");
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!UUID.test(entry.name)) continue;
    const path = join(root, entry.name);
    assertLedgerDirectory(path, root);
    entries.push({ name: entry.name, path, modifiedMs: statSync(path).mtimeMs });
  }
  entries.sort((left, right) => right.modifiedMs - left.modifiedMs || right.name.localeCompare(left.name));
  const removed = entries.slice(limit);
  for (const entry of removed) rmSync(entry.path, { recursive: true, force: true });
  return Object.freeze({ kept: entries.length - removed.length, removed: removed.length });
};

/**
 * Construct the durable, record-only ledger for one deploy transaction. The
 * constructor allocates the identity and directory; callers explicitly record
 * STARTED so a failed allocation remains a loud deploy failure.
 */
export const createDeploymentLedger = ({
  stateDir,
  deploymentId = randomUUID(),
  targetCommit = "unknown",
  now = () => new Date(),
} = {}) => {
  if (typeof stateDir !== "string" || stateDir.length === 0) invalid("state-directory-missing");
  if (typeof now !== "function") invalid("clock-invalid");
  const id = assertSafeLedgerId(deploymentId);
  const root = resolve(stateDir);
  const deploymentsRoot = join(root, "deployments");
  const directory = join(deploymentsRoot, id);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertDirectory(root, "state-directory");
    mkdirSync(deploymentsRoot, { recursive: true, mode: 0o700 });
    assertDirectory(deploymentsRoot, "deployment-directory");
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    assertDirectory(directory, "ledger-directory");
  } catch (error) {
    if (error instanceof DeployFailure || error instanceof DeploymentLedgerError) throw error;
    throw new DeploymentLedgerError("allocate", error);
  }

  const statePath = join(directory, "state.json");
  const eventsPath = join(directory, "events.jsonl");
  let currentState = null;
  let eventCount = 0;
  let startedAt = null;
  let updatedAt = null;
  let currentTargetCommit = safeTargetCommit(targetCommit);
  let context = {
    backupIdentity: null,
    migrationTailBefore: null,
    migrationTailAfter: null,
    activatedBuildStamp: null,
    reasonCode: null,
  };

  const timestamp = () => {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new DeploymentLedgerError("timestamp", new Error("invalid-clock"));
    return date.toISOString();
  };

  const record = (state, metadata = {}) => {
    if (!LEDGER_STATE_SET.has(state)) invalid(`state-invalid-${String(state)}`);
    const recordedAt = timestamp();
    const target = getMetadata(metadata, "targetCommit", "target_commit");
    if (target !== null && target !== undefined) currentTargetCommit = safeTargetCommit(target, currentTargetCommit);
    const nextContext = {
      backupIdentity: safeBackupIdentity(getMetadata(metadata, "backupIdentity", "backup_identity")) ?? context.backupIdentity,
      migrationTailBefore: safeMigrationTail(getMetadata(metadata, "migrationTailBefore", "migration_tail_before")) ?? context.migrationTailBefore,
      migrationTailAfter: safeMigrationTail(getMetadata(metadata, "migrationTailAfter", "migration_tail_after")) ?? context.migrationTailAfter,
      activatedBuildStamp: safeBuildStamp(getMetadata(metadata, "activatedBuildStamp", "activated_build_stamp")) ?? context.activatedBuildStamp,
      reasonCode: state === "FAILED" || state === "MANUAL_RECOVERY"
        ? safeReasonCode(getMetadata(metadata, "reasonCode", "reason_code"))
        : null,
    };
    if (startedAt === null) startedAt = recordedAt;
    const event = {
      schemaVersion: DEPLOYMENT_LEDGER_SCHEMA_VERSION,
      deployment_id: id,
      deploymentId: id,
      phase: state,
      state,
      timestamp: recordedAt,
      recorded_at: recordedAt,
      recordedAt,
      started_at: startedAt,
      startedAt,
      ended_at: recordedAt,
      endedAt: recordedAt,
      target_commit: currentTargetCommit,
      targetCommit: currentTargetCommit,
      backup_identity: nextContext.backupIdentity,
      backupIdentity: nextContext.backupIdentity,
      migration_tail_before: nextContext.migrationTailBefore,
      migrationTailBefore: nextContext.migrationTailBefore,
      migration_tail_after: nextContext.migrationTailAfter,
      migrationTailAfter: nextContext.migrationTailAfter,
      activated_build_stamp: nextContext.activatedBuildStamp,
      activatedBuildStamp: nextContext.activatedBuildStamp,
      reason_code: nextContext.reasonCode,
      reasonCode: nextContext.reasonCode,
    };
    const nextEventCount = eventCount + 1;
    const snapshot = {
      schemaVersion: DEPLOYMENT_LEDGER_SCHEMA_VERSION,
      deployment_id: id,
      deploymentId: id,
      state,
      status: state,
      terminal: TERMINAL_STATES.has(state),
      started_at: startedAt,
      startedAt,
      updated_at: recordedAt,
      updatedAt: recordedAt,
      target_commit: currentTargetCommit,
      targetCommit: currentTargetCommit,
      backup_identity: nextContext.backupIdentity,
      backupIdentity: nextContext.backupIdentity,
      migration_tail_before: nextContext.migrationTailBefore,
      migrationTailBefore: nextContext.migrationTailBefore,
      migration_tail_after: nextContext.migrationTailAfter,
      migrationTailAfter: nextContext.migrationTailAfter,
      activated_build_stamp: nextContext.activatedBuildStamp,
      activatedBuildStamp: nextContext.activatedBuildStamp,
      reason_code: nextContext.reasonCode,
      reasonCode: nextContext.reasonCode,
      event_count: nextEventCount,
      eventCount: nextEventCount,
    };
    try {
      appendJsonLine(eventsPath, event);
      atomicWriteJson(statePath, snapshot);
    } catch (error) {
      throw error instanceof DeploymentLedgerError ? error : new DeploymentLedgerError("record", error);
    }
    context = nextContext;
    currentState = state;
    updatedAt = recordedAt;
    eventCount = nextEventCount;
    return Object.freeze(event);
  };

  const start = (metadata = {}) => {
    if (currentState !== null) return null;
    return record("STARTED", metadata);
  };

  const ledger = {
    deploymentId: id,
    deployment_id: id,
    directory,
    statePath,
    eventsPath,
    record,
    start,
    get state() { return currentState; },
    get currentState() { return currentState; },
    get started() { return currentState !== null; },
    get startedAt() { return startedAt; },
    get updatedAt() { return updatedAt; },
    get eventCount() { return eventCount; },
  };
  return Object.freeze(ledger);
};
