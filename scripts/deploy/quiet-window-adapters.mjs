import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { BLOCKING_RUN_STATUSES, DeployFailure, gitPreflightFailure } from "./quiet-window-lib.mjs";

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

export const inspectGitPreflight = ({ git, root, target }) => {
  const text = (...args) => execFileSync(git, ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const head = text("rev-parse", "HEAD");
  const dirty = text("status", "--porcelain").length > 0;
  let fastForward = false;
  try {
    execFileSync(git, ["-C", root, "merge-base", "--is-ancestor", head, target], { stdio: "ignore" });
    fastForward = true;
  } catch { /* a non-zero merge-base verdict is the refusal */ }
  return { head, target, dirty, fastForward, refusal: gitPreflightFailure({ dirty, head, target, fastForward }) };
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
