import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { BLOCKING_RUN_STATUSES, DeployFailure, gitPreflightFailure } from "./quiet-window-lib.mjs";
import { DEPLOYMENT_LEDGER_RETENTION_COUNT, pruneDeploymentLedgers } from "./deployment-ledger.mjs";

export const DEPLOY_PREVIOUS_RETENTION_COUNT = 3;
export const DEPLOY_BACKUP_RETENTION_COUNT = 14;
export const DEPLOY_BACKUP_DAILY_RETENTION_DAYS = 30;
export { DEPLOYMENT_LEDGER_RETENTION_COUNT };

const PREVIOUS_DIRECTORY = /^previous-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BACKUP_FILE = /^(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{12}-[0-9a-f]{12}\.dump$/u;

const assertDirectChild = (root, path, name) => {
  if (dirname(resolve(path)) !== resolve(root)) {
    throw new DeployFailure("deploy-retention-refused", `path-escaped-${name}`);
  }
};

const removableEntries = ({ root, pattern, kind }) => {
  if (!existsSync(root)) return [];
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!pattern.test(entry.name)) continue;
    const path = join(root, entry.name);
    assertDirectChild(root, path, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (kind === "directory" ? !info.isDirectory() : !info.isFile())) {
      throw new DeployFailure("deploy-retention-refused", `unsafe-${kind}-${entry.name}`);
    }
    if (dirname(realpathSync(path)) !== realpathSync(root)) {
      throw new DeployFailure("deploy-retention-refused", `resolved-path-escaped-${entry.name}`);
    }
    entries.push({ name: entry.name, path, modifiedMs: statSync(path).mtimeMs });
  }
  return entries;
};

/**
 * Retains bounded rollback state without touching the live build, active stage,
 * lock, escalation marker, or any unrecognized state-directory entry.
 */
export const pruneDeployHistory = ({
  stateDir,
  now = Date.now(),
  previousLimit = DEPLOY_PREVIOUS_RETENTION_COUNT,
  backupLimit = DEPLOY_BACKUP_RETENTION_COUNT,
  dailyRetentionDays = DEPLOY_BACKUP_DAILY_RETENTION_DAYS,
  ledgerLimit = DEPLOYMENT_LEDGER_RETENTION_COUNT,
} = {}) => {
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new DeployFailure("deploy-retention-refused", "state-directory-missing");
  }
  for (const [name, value] of [
    ["previous-limit", previousLimit],
    ["backup-limit", backupLimit],
    ["daily-retention-days", dailyRetentionDays],
    ["ledger-limit", ledgerLimit],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new DeployFailure("deploy-retention-refused", `${name}-invalid`);
  }

  const previous = removableEntries({ root: stateDir, pattern: PREVIOUS_DIRECTORY, kind: "directory" })
    .sort((left, right) => right.modifiedMs - left.modifiedMs || right.name.localeCompare(left.name));
  const removedPrevious = previous.slice(previousLimit);

  const backupRoot = join(stateDir, "backups");
  const backups = removableEntries({ root: backupRoot, pattern: BACKUP_FILE, kind: "file" })
    .sort((left, right) => right.name.localeCompare(left.name));
  const keptBackupNames = new Set(backups.slice(0, backupLimit).map(({ name }) => name));
  const cutoff = now - dailyRetentionDays * 24 * 60 * 60 * 1_000;
  const daily = new Set();
  for (const backup of backups) {
    if (backup.modifiedMs < cutoff) continue;
    const day = BACKUP_FILE.exec(backup.name)?.[1];
    if (day && !daily.has(day)) {
      daily.add(day);
      keptBackupNames.add(backup.name);
    }
  }
  const removedBackups = backups.filter(({ name }) => !keptBackupNames.has(name));

  for (const entry of removedPrevious) rmSync(entry.path, { recursive: true, force: true });
  for (const entry of removedBackups) rmSync(entry.path, { force: true });
  pruneDeploymentLedgers({ stateDir, limit: ledgerLimit });

  return Object.freeze({
    keptPrevious: previous.length - removedPrevious.length,
    removedPrevious: removedPrevious.length,
    keptBackups: backups.length - removedBackups.length,
    removedBackups: removedBackups.length,
  });
};

export const DEPLOY_REQUIRED_ARTIFACT_PATHS = Object.freeze([
  "packages/github-client/dist",
  "packages/db/dist",
  "packages/api/dist",
  "packages/runner/dist",
  "packages/inbox/dist",
  "packages/merge-executor/dist",
  "apps/web/dist",
  "node_modules",
]);

export const DEPLOY_OPTIONAL_ARTIFACT_PATHS = Object.freeze([
  "packages/cli/dist",
]);

export const workspaceDependencyPaths = (root) => {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (error) {
    throw new DeployFailure("workspace-layout-invalid", error?.code ?? "package-json-unreadable");
  }
  if (!Array.isArray(manifest.workspaces) || manifest.workspaces.length === 0) {
    throw new DeployFailure("workspace-layout-invalid", "workspaces-must-be-a-nonempty-array");
  }
  const paths = [];
  for (const pattern of manifest.workspaces) {
    if (typeof pattern !== "string" || !pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) {
      throw new DeployFailure("workspace-layout-invalid", `unsupported-workspace-pattern-${String(pattern)}`);
    }
    const parent = pattern.slice(0, -2);
    let entries;
    try {
      entries = readdirSync(join(root, parent), { withFileTypes: true });
    } catch (error) {
      throw new DeployFailure("workspace-layout-invalid", `${parent}-${error?.code ?? "unreadable"}`);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json"))) {
        paths.push(`${parent}/${entry.name}/node_modules`);
      }
    }
  }
  return Object.freeze([...new Set(paths)].sort());
};

export const deployArtifactPaths = (root) => Object.freeze([
  ...DEPLOY_REQUIRED_ARTIFACT_PATHS.slice(0, -1),
  ...DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  ...workspaceDependencyPaths(root),
  "node_modules",
]);

export const blockingRunsStatement = (statuses = BLOCKING_RUN_STATUSES) => {
  const placeholders = statuses.map((_, index) => `$${index + 1}`).join(",");
  return {
    sql: `SELECT "id", "status"::text AS "status" FROM "Run" WHERE "status"::text IN (${placeholders}) ORDER BY "id"`,
    parameters: [...statuses],
  };
};

const inspectCheckout = ({ git, root }) => {
  const text = (...args) => execFileSync(git, ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const head = text("rev-parse", "HEAD");
  let branch = null;
  try { branch = text("symbolic-ref", "--short", "HEAD"); } catch { /* detached HEAD is not the production main branch */ }
  const dirty = text("status", "--porcelain").length > 0;
  return { branch, head, dirty };
};

export const inspectProductionCheckout = ({ git, root }) => {
  const state = inspectCheckout({ git, root });
  return {
    ...state,
    refusal: gitPreflightFailure({ ...state, target: state.head, fastForward: true }),
  };
};

export const inspectGitPreflight = ({ git, root, target }) => {
  const state = inspectCheckout({ git, root });
  let fastForward = false;
  try {
    execFileSync(git, ["-C", root, "merge-base", "--is-ancestor", state.head, target], { stdio: "ignore" });
    fastForward = true;
  } catch { /* a non-zero merge-base verdict is the refusal */ }
  return {
    ...state,
    target,
    fastForward,
    refusal: gitPreflightFailure({ ...state, target, fastForward }),
  };
};

export const processStartIdentity = (pid) => {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
};

const readLock = (path) => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Number.isSafeInteger(value.pid) && typeof value.startedAt === "string" ? value : null;
  } catch {
    return null;
  }
};

/** PID plus process-start identity prevents PID reuse from making a stale lock live. */
export const acquireProcessLock = ({ path, stateDir = dirname(path), pid = process.pid, startIdentity = processStartIdentity }) => {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const startedAt = startIdentity(pid);
  if (!startedAt) throw new DeployFailure("deploy-lock-unavailable", "owner-start-identity-unreadable");
  let recovered = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify({ pid, startedAt })}\n`); } finally { closeSync(fd); }
      let released = false;
      return {
        recovered,
        release: async () => {
          if (released) return;
          const current = readLock(path);
          if (current?.pid === pid && current.startedAt === startedAt) unlinkSync(path);
          released = true;
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw new DeployFailure("deploy-lock-unavailable", error?.code ?? "unknown");
      const owner = readLock(path);
      if (owner && startIdentity(owner.pid) === owner.startedAt) return null;
      const stale = `${path}.stale-${randomUUID()}`;
      try {
        renameSync(path, stale);
        recovered = owner ?? { pid: null, startedAt: "unreadable" };
        rmSync(stale, { force: true });
      } catch (reclaimError) {
        if (reclaimError?.code !== "ENOENT") throw new DeployFailure("deploy-lock-unavailable", "stale-lock-reclaim-failed");
      }
    }
  }
  throw new DeployFailure("deploy-lock-unavailable", "lock-contention-did-not-settle");
};

/** Real dist publication transaction, injectable by root and path list. */
export const publishDirectories = ({ root, stage, previousDirectory, paths, optionalMissingPaths = [] }) => {
  mkdirSync(previousDirectory, { recursive: true, mode: 0o700 });
  const optional = new Set(optionalMissingPaths);
  const moved = [];
  try {
    for (const path of paths) {
      const live = join(root, path);
      const prior = join(previousDirectory, path);
      const staged = join(stage, path);
      mkdirSync(dirname(prior), { recursive: true });
      const entry = { live, prior, staged, hadPrior: existsSync(live), published: false };
      if (entry.hadPrior) renameSync(live, prior);
      moved.push(entry);
      if (existsSync(staged)) {
        renameSync(staged, live);
        entry.published = true;
      } else if (!optional.has(path)) {
        throw Object.assign(new Error(`missing staged artifact: ${path}`), { code: "ENOENT" });
      }
    }
  } catch (error) {
    for (const entry of moved.reverse()) {
      if (entry.published && existsSync(entry.live)) renameSync(entry.live, entry.staged);
      if (entry.hadPrior && existsSync(entry.prior)) renameSync(entry.prior, entry.live);
    }
    throw new DeployFailure("build-swap-failed", error?.code ?? "rename-failed");
  }
  let settled = false;
  return {
    rollback: async () => {
      if (settled) return;
      for (const path of [...paths].reverse()) {
        const live = join(root, path);
        const prior = join(previousDirectory, path);
        if (existsSync(live)) rmSync(live, { recursive: true, force: true });
        if (existsSync(prior)) renameSync(prior, live);
      }
      settled = true;
    },
    commit: async () => { settled = true; },
  };
};
