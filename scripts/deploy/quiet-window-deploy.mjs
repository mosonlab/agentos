#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeployFailure,
  SERVICE_LABELS,
  deployedBuildStampRefusal,
  dryRunDecision,
  executeUpgrade,
  failureOf,
  runLocked,
  shouldPersistFailure,
} from "./quiet-window-lib.mjs";
import {
  acquireProcessLock,
  blockingRunsStatement,
  pruneDeployHistory,
} from "./quiet-window-adapters.mjs";
import { createProductionHost } from "./quiet-window-host.mjs";
import { runCommandWithRetry } from "./quiet-window-retry.mjs";
import { verifyBackupConfiguration } from "./install-launchd.mjs";
import { backupConfigurationFromEnvironment, writePgDumpBackup } from "./quiet-window-backup.mjs";
import { createDeployInterruption } from "./quiet-window-interrupt.mjs";
import { createDeploymentLedger } from "./deployment-ledger.mjs";
import {
  pruneReleaseDirectories,
} from "./release-directory.mjs";
import { findReleaseArtifact, verifyReleaseArtifact } from "./release-artifact.mjs";
import { activateReleasePointer, rollbackReleasePointer } from "./release-pointer.mjs";
import { verifyServiceInventory } from "./launchd-service-wrapper.mjs";
import { serviceWrapperPath } from "./install-launchd.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(process.env.AGENTOS_REPOSITORY_ROOT ?? resolve(SCRIPT_DIR, "../.."));
const STATE_DIR = join(REPOSITORY_ROOT, ".agentos-deploy");
const LOCK_PATH = join(STATE_DIR, "lock");
const ESCALATION_PATH = join(STATE_DIR, "escalated.json");
const CURRENT_PATH = join(REPOSITORY_ROOT, "current");
const CURRENT_API_BUILD_STAMP = join(CURRENT_PATH, "packages/api/dist/build-info.json");
const RELEASES_PATH = join(REPOSITORY_ROOT, "releases");
const SHARED_PATH = join(REPOSITORY_ROOT, "shared");
const POLL_SECONDS_TEXT = process.env.QUIET_WINDOW_POLL_SECONDS ?? "60";
const POLL_SECONDS = /^\d+$/u.test(POLL_SECONDS_TEXT) ? Number(POLL_SECONDS_TEXT) : Number.NaN;
const POLL_MS = POLL_SECONDS * 1_000;
const SHA = /^[0-9a-f]{40}$/u;
const DEPLOY_BARRIER_CLASS = 0x41_47_44_50; // Must match @anneal/db deploy-barrier.ts ("AGDP").
const DEPLOY_BARRIER_KEY = 1;

const generatedPrismaClientIsComplete = (root) =>
  existsSync(join(root, "node_modules/.prisma/client/index.js"))
  && existsSync(join(root, "node_modules/.prisma/client/schema.prisma"));

const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };
const activeResources = new Set();
const interruption = createDeployInterruption();
const interruptController = { signal: interruption.signal };
const interruptFailure = interruption.failure;
const throwIfInterrupted = interruption.throwIfInterrupted;
const trackResource = (resource) => {
  const release = resource.release.bind(resource);
  resource.release = async () => {
    try { await release(); } finally { activeResources.delete(resource); }
  };
  activeResources.add(resource);
  return resource;
};

const command = (program, args, {
  cwd = REPOSITORY_ROOT,
  env = process.env,
  capture = false,
  allowAfterInterrupt = false,
} = {}) => {
  if (!allowAfterInterrupt) throwIfInterrupted();
  return new Promise((accept, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    const cleanUp = () => interruptController.signal.removeEventListener("abort", onAbort);
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanUp();
      reject(error);
    };
    const acceptOnce = (result) => {
      if (settled) return;
      settled = true;
      cleanUp();
      accept(result);
    };
    const onAbort = () => {
      child.kill(interruption.receivedSignal() === "SIGINT" ? "SIGINT" : "SIGTERM");
      rejectOnce(interruptFailure());
    };
    if (!allowAfterInterrupt) interruptController.signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", rejectOnce);
    child.once("exit", (code, signal) => acceptOnce({ code: code ?? 1, signal, stdout, stderr }));
  });
};

const checkedResult = async (reason, run) => {
  log(`START ${reason}`);
  const result = await run().catch((error) => {
    if (error instanceof DeployFailure) throw error;
    return { code: 1, stderr: String(error), stdout: "" };
  });
  if (result.code !== 0) {
    const diagnosis = (result.stderr || result.stdout || "").trim().slice(-2_000).replaceAll(/\s+/gu, " ");
    fail(reason, `exit-${result.code}${diagnosis ? `: ${diagnosis}` : ""}`);
  }
  log(`PASS ${reason}`);
  return result;
};

const checked = (reason, program, args, options) => checkedResult(
  reason,
  () => command(program, args, options),
);

const retryingGitCommand = (operation, args, options) => runCommandWithRetry(
  () => command(loadBinaries().git, args, options).catch((error) => {
    if (error instanceof DeployFailure) throw error;
    return { code: 1, stderr: String(error), stdout: "" };
  }),
  {
    onRetry: ({ attempt, nextAttempt, waitMs }) => log(
      `RETRY git-network operation=${operation} attempt=${attempt} next-attempt=${nextAttempt} wait-ms=${waitMs}`,
    ),
  },
);

const readJson = (path, reason) => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail(reason, "json-root-is-not-an-object");
    return value;
  } catch {
    fail(reason, "unreadable-or-invalid-json");
  }
};

const readDeployedRevision = () => {
  let stampPath = CURRENT_API_BUILD_STAMP;
  try {
    const current = lstatSync(CURRENT_PATH);
    if (!current.isSymbolicLink()) fail("deployed-revision-unreadable", "current-is-not-a-symlink");
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail("deployed-revision-unreadable", `current-pointer-${error?.code ?? "unreadable"}`);
  }
  const stamp = readJson(stampPath, "deployed-revision-unreadable");
  const refusal = deployedBuildStampRefusal(stamp);
  if (refusal) {
    fail("deployed-revision-unreadable", `api-dist-stamp-${refusal}`);
  }
  return stamp.commit;
};

const environmentFilePath = () => join(SHARED_PATH, ".env");

const remoteMainRevision = async () => {
  const sourceRemote = process.env.DEPLOY_SOURCE_REMOTE;
  if (!sourceRemote) fail("environment-unreadable", "DEPLOY_SOURCE_REMOTE-missing");
  const result = await retryingGitCommand(
    "ls-remote-main",
    ["ls-remote", "--exit-code", sourceRemote, "refs/heads/main"],
    { capture: true },
  );
  const revision = result.stdout.trim().split(/\s+/u)[0] ?? "";
  if (result.code !== 0 || !SHA.test(revision)) fail("remote-main-unreadable", `exit-${result.code}`);
  return revision;
};

const loadEnvironment = async () => {
  const envPath = environmentFilePath();
  if (!existsSync(envPath) || !statSync(envPath).isFile()) fail("environment-unreadable", ".env-missing-or-not-a-file");
  if ((statSync(envPath).mode & 0o777) !== 0o600) fail("environment-unreadable", ".env-mode-must-be-0600");
  const { config } = await import("dotenv").catch(() => fail("environment-unreadable", "dotenv-module-unavailable"));
  const loaded = config({ path: envPath, override: false, quiet: true });
  if (loaded.error || !process.env.DATABASE_URL) fail("environment-unreadable", "DATABASE_URL-missing");
  if (!process.env.FEISHU_DEFAULT_CHAT_ID) fail("environment-unreadable", "FEISHU_DEFAULT_CHAT_ID-missing");
};

const resolveExecutable = (variable, fallback) => {
  const configured = process.env[variable];
  let path = configured;
  if (!path) {
    try { path = execFileSync("/usr/bin/which", [fallback], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { path = ""; }
  }
  if (!path?.startsWith("/")) fail("environment-unreadable", `${variable}-missing`);
  try { accessSync(path, fsConstants.X_OK); } catch { fail("environment-unreadable", `${variable}-not-executable`); }
  return path;
};

let binaries = null;
const loadBinaries = () => {
  if (binaries === null) {
    try {
      binaries = Object.freeze({
        git: resolveExecutable("DEPLOY_GIT_BINARY", "git"),
        node: resolveExecutable("DEPLOY_NODE_BINARY", "node"),
        npm: resolveExecutable("DEPLOY_NPM_BINARY", "npm"),
        backup: backupConfigurationFromEnvironment(),
      });
    } catch (error) {
      fail("environment-unreadable", error instanceof Error ? error.message : String(error));
    }
  }
  return binaries;
};

let prisma = null;
const database = async () => {
  if (prisma) return prisma;
  const module = await import("@prisma/client").catch(() => fail("database-client-unavailable", "prisma-client-import-failed"));
  prisma = new module.PrismaClient();
  return prisma;
};

// A migration tail is evidence only. An unreadable history must not invent a
// deploy refusal or change the existing migration command's control flow; the
// ledger records null when the read cannot be proved.
const migrationTail = async () => {
  try {
    const db = await database();
    const rows = await db.$queryRawUnsafe(
      'SELECT "migration_name" AS "name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "finished_at" DESC, "migration_name" DESC LIMIT 1',
    );
    return typeof rows[0]?.name === "string" ? rows[0].name : null;
  } catch {
    return null;
  }
};

const blockingRuns = async () => {
  throwIfInterrupted();
  const db = await database();
  try {
    const statement = blockingRunsStatement();
    const runs = await db.$queryRawUnsafe(statement.sql, ...statement.parameters);
    throwIfInterrupted();
    return runs;
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail("quiet-window-query-failed", "platform-database-unreadable");
  }
};

const notify = async ({ outcome, reason, detail = "", from, to }) => {
  if (outcome === "success") throwIfInterrupted();
  const db = await database();
  const body = `[auto-deploy] ${outcome}: ${from} -> ${to}; reason=${reason}${detail ? `; detail=${detail}` : ""}`;
  const dedupeKey = `auto-deploy:${createHash("sha256").update(body).digest("hex")}`;
  try {
    const chatId = process.env.FEISHU_DEFAULT_CHAT_ID;
    if (!chatId) fail("environment-unreadable", "FEISHU_DEFAULT_CHAT_ID-missing");
    const thread = await db.inboxThread.findFirst({ where: { channel: "FEISHU", externalChatId: chatId, sessionId: null } })
      ?? await db.inboxThread.create({ data: { channel: "FEISHU", externalChatId: chatId } });
    // A successful deploy needs no operator action, so it lands already closed:
    // the delivery worker only picks up `open`, so the record is archived
    // without a Feishu push and without joining the awaiting-reply queue. The
    // Inbox reads the newest one to show when production last moved.
    const archived = outcome === "success";
    await db.inboxMessage.upsert({
      where: { dedupeKey },
      create: {
        from: "AGENT", kind: "TEXT", body, dedupeKey, threadId: thread.id,
        ...(archived ? { status: "CLOSED", answeredAt: new Date() } : {}),
      },
      update: {},
    });
    if (outcome === "success") throwIfInterrupted();
    log(`INBOX ${body}`);
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail("inbox-notification-failed", `${outcome}-${reason}`);
  }
};

const sleep = (milliseconds) => {
  throwIfInterrupted();
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      interruptController.signal.removeEventListener("abort", onAbort);
      accept();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(interruptFailure());
    };
    interruptController.signal.addEventListener("abort", onAbort, { once: true });
  });
};

const launchctl = async (reason, args, options = {}) => checked(reason, "/bin/launchctl", args, { capture: true, ...options });
const domain = () => `gui/${process.getuid()}`;

const acquireDeployBarrier = async () => {
  throwIfInterrupted();
  const module = await import("@prisma/client").catch(() => fail("deploy-barrier-unavailable", "prisma-client-import-failed"));
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("max_connection_lifetime", "0");
  url.searchParams.set("max_idle_connection_lifetime", "0");
  const session = new module.PrismaClient({ datasources: { db: { url: url.href } } });
  try {
    await session.$connect();
    throwIfInterrupted();
    const rows = await session.$queryRawUnsafe(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4) AS granted, pg_backend_pid() AS pid",
      DEPLOY_BARRIER_CLASS,
      DEPLOY_BARRIER_KEY,
    );
    throwIfInterrupted();
    if (rows.length !== 1 || rows[0]?.granted !== true) { await session.$disconnect(); return null; }
    const pid = Number(rows[0].pid);
    let released = false;
    return trackResource({
      verify: async () => {
        if (released) return false;
        const checks = await session.$queryRawUnsafe(
          `SELECT pg_backend_pid() AS pid, EXISTS (
             SELECT 1 FROM pg_locks
             WHERE locktype = 'advisory' AND pid = pg_backend_pid()
               AND classid = $1::oid AND objid = $2::oid AND objsubid = 2
               AND granted AND mode = 'ExclusiveLock'
           ) AS held`,
          DEPLOY_BARRIER_CLASS,
          DEPLOY_BARRIER_KEY,
        ).catch(() => []);
        // The backend identity and pg_locks row prove the pinned session still
        // owns the exact exclusive key; either becoming unreadable is loss.
        return checks.length === 1 && Number(checks[0]?.pid) === pid && checks[0]?.held === true;
      },
      release: async () => {
        if (released) return;
        released = true;
        try { await session.$queryRawUnsafe("SELECT pg_advisory_unlock($1::int4, $2::int4)", DEPLOY_BARRIER_CLASS, DEPLOY_BARRIER_KEY); }
        finally { await session.$disconnect(); }
      },
    });
  } catch (error) {
    await session.$disconnect().catch(() => undefined);
    if (error instanceof DeployFailure) throw error;
    fail("deploy-barrier-unavailable", error instanceof Error ? error.name : "query-failed");
  }
};

const waitForQuiet = async () => {
  while (true) {
    throwIfInterrupted();
    const before = await blockingRuns();
    if (before.length > 0) {
      log(`HOLD quiet-window blockers=${before.length} statuses=${[...new Set(before.map((run) => run.status))].join(",")}`);
      await sleep(POLL_MS);
      continue;
    }
    const barrier = await acquireDeployBarrier();
    if (barrier === null) {
      log("HOLD quiet-window deploy-barrier-contended");
      await sleep(POLL_MS);
      continue;
    }
    let after;
    try {
      after = await blockingRuns();
    } catch (error) {
      await barrier.release();
      throw error;
    }
    if (after.length === 0) {
      log("PASS quiet-window deploy-barrier-held blockers=0");
      return barrier;
    }
    await barrier.release();
    log(`HOLD quiet-window raced-blockers=${after.length}`);
    await sleep(POLL_MS);
  }
};

const acquireLock = async () => {
  const lock = acquireProcessLock({ path: LOCK_PATH, stateDir: STATE_DIR });
  return lock === null ? null : trackResource(lock);
};

const writeEscalation = async (record) => {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${ESCALATION_PATH}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify({ notificationDelivered: false, ...record, escalatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, ESCALATION_PATH);
  log(`ESCALATED reason=${record.reason} from=${record.from} to=${record.to}`);
};

const markEscalationNotified = async () => {
  const record = readJson(ESCALATION_PATH, "escalation-state-unreadable");
  const temporary = `${ESCALATION_PATH}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify({ ...record, notificationDelivered: true }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, ESCALATION_PATH);
};

const retryEscalationNotification = async () => {
  const record = readJson(ESCALATION_PATH, "escalation-state-unreadable");
  if (record.notificationDelivered === true) return;
  await notify({
    outcome: "failure",
    reason: String(record.reason ?? "unknown-failure"),
    detail: String(record.detail ?? ""),
    from: String(record.from ?? "unknown"),
    to: String(record.to ?? "unknown"),
  });
  await markEscalationNotified();
};

const persistAndNotifyFailure = async (failure, from, to) => {
  await writeEscalation({ outcome: "failure", reason: failure.reason, detail: failure.detail, from, to });
  try {
    await retryEscalationNotification();
  } catch {
    log(`STOP inbox-notification-pending reason=${failure.reason}`);
  }
};

const parseArgs = (args) => {
  const allowed = new Set(["--dry-run", "--clear-escalation", "--prune-history"]);
  const unknown = args.find((argument) => !allowed.has(argument));
  if (unknown) fail("usage", `unknown-argument-${unknown}`);
  const modes = ["--dry-run", "--clear-escalation", "--prune-history"].filter((mode) => args.includes(mode));
  if (modes.length > 1) fail("usage", "modes-are-mutually-exclusive");
  return {
    dryRun: args.includes("--dry-run"),
    clearEscalation: args.includes("--clear-escalation"),
    pruneHistory: args.includes("--prune-history"),
  };
};

const pruneHistory = () => {
  const result = pruneDeployHistory({ stateDir: STATE_DIR });
  const releases = existsSync(RELEASES_PATH)
    ? pruneReleaseDirectories({ deployRoot: REPOSITORY_ROOT })
    : { kept: 0, removed: 0, protected: [] };
  log(`PRUNE deploy-history releases-kept=${releases.kept} releases-removed=${releases.removed} backups-kept=${result.keptBackups} backups-removed=${result.removedBackups}`);
  return { ...result, releases };
};

const serviceState = async () => {
  const unavailable = [];
  for (const label of SERVICE_LABELS) {
    const result = await command("/bin/launchctl", ["print", `${domain()}/${label}`], { capture: true });
    if (result.code !== 0 || !/^\s*state = running\s*$/mu.test(result.stdout)) unavailable.push(label);
  }
  return { ok: unavailable.length === 0, unavailable };
};

/** Prove the wrapper-first migration before any new pointer is activated. Each
 * loaded definition must name the stable shared wrapper, each label must still
 * be running from the old current target, and the API must report that exact
 * current release commit. */
const verifyStableServicePaths = async () => {
  const wrapper = serviceWrapperPath(REPOSITORY_ROOT);
  try {
    return await verifyServiceInventory({
      repositoryRoot: REPOSITORY_ROOT,
      start: async (invocation) => {
        const result = await command("/bin/launchctl", ["print", `${domain()}/${invocation.label}`], { capture: true });
        const running = result.code === 0 && /^\s*state = running\s*$/mu.test(result.stdout);
        const wrapped = result.stdout.includes(wrapper) && result.stdout.includes(invocation.label);
        return { ok: running && wrapped, targetReleaseId: invocation.releaseIdentity };
      },
      readiness: async ({ label, invocation }) => {
        if (label !== "com.agentos.api") return { ok: true, releaseIdentity: invocation.releaseIdentity };
        const port = process.env.API_PORT ?? "3000";
        const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
        const version = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(2_000) });
        const payload = version.ok ? await version.json() : {};
        return {
          ok: health.ok && version.ok && payload.commit === invocation.releaseCommit && payload.dirty === false,
          releaseIdentity: invocation.releaseIdentity,
        };
      },
    });
  } catch (error) {
    fail("service-wrapper-verification-failed", error instanceof Error ? error.message : String(error));
  }
};

const dryRun = async () => {
  await loadEnvironment();
  loadBinaries();
  const from = readDeployedRevision();
  const to = await remoteMainRevision();
  const result = await dryRunDecision({
    revisions: async () => ({ from, to }),
    blockingRuns,
    artifactState: async () => {
      try {
        const artifact = findReleaseArtifact({ deployRoot: REPOSITORY_ROOT, revision: to });
        return { ok: true, releaseName: artifact.releaseName };
      } catch (error) {
        const failure = failureOf(error);
        return { ok: false, reason: failure.reason };
      }
    },
    serviceState,
    backupState: async () => {
      const requested = loadBinaries().backup;
      try {
        const verified = verifyBackupConfiguration(requested);
        return { ok: true, mode: verified.mode };
      } catch (error) {
        return {
          ok: false,
          mode: requested.mode,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
  for (const line of result.lines) log(line);
  return !result.artifact.ok || !result.services.ok || !result.backup.ok ? 1 : 0;
};

const makeWritable = (root) => {
  const visit = (path) => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return;
    chmodSync(path, status.mode & 0o777 | (status.isDirectory() ? 0o700 : 0o600));
    if (status.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!Number.isSafeInteger(POLL_MS) || POLL_MS < 1_000) fail("environment-invalid", "QUIET_WINDOW_POLL_SECONDS-must-be-a-positive-integer");
  if (options.clearEscalation) {
    if (existsSync(ESCALATION_PATH)) unlinkSync(ESCALATION_PATH);
    log("CLEARED escalation operator-action-required-before-this-command");
    return 0;
  }
  if (options.dryRun) return dryRun();
  if (options.pruneHistory) {
    loadBinaries();
    const result = await runLocked({ acquireLock, log }, async () => {
      pruneHistory();
      return { ok: true };
    });
    return result.ok ? 0 : 1;
  }

  await loadEnvironment();
  loadBinaries();
  if (existsSync(ESCALATION_PATH)) {
    await retryEscalationNotification();
    log(`STOP escalation-active path=${ESCALATION_PATH}`);
    return 2;
  }

  return runLocked({ acquireLock, log }, async () => {
    let from = "unknown";
    let to = "unknown";
    try {
      from = readDeployedRevision();
      to = await remoteMainRevision();
    } catch (error) {
      const failure = failureOf(error);
      await persistAndNotifyFailure(failure, from, to);
      return { ok: false, reason: failure.reason };
    }
    if (from === to) {
      pruneHistory();
      log(`NOOP already-deployed revision=${from}`);
      return { ok: true, skipped: "already-deployed" };
    }

    let operationWorkspace = null;
    let preparedRelease = null;
    let barrier = null;
    let ledger = null;
    const transactionId = randomUUID();
    const backupDirectory = join(STATE_DIR, "backups");
    try {
      ledger = createDeploymentLedger({ stateDir: STATE_DIR, deploymentId: transactionId, targetCommit: to });
      ledger.start({ targetCommit: to });
      const built = await checked(
        "release-artifact-build-failed",
        loadBinaries().node,
        [join(SCRIPT_DIR, "build-release-artifact.mjs"), to],
        { capture: true },
      );
      const receiptLine = built.stdout.trim().split("\n").findLast((line) => line.startsWith("RELEASE-ARTIFACT "));
      if (!receiptLine) fail("release-artifact-build-failed", "builder-receipt-missing");
      let receipt;
      try { receipt = JSON.parse(receiptLine.slice("RELEASE-ARTIFACT ".length)); }
      catch { fail("release-artifact-build-failed", "builder-receipt-invalid"); }
      preparedRelease = verifyReleaseArtifact({
        deployRoot: REPOSITORY_ROOT,
        revision: to,
        releaseName: receipt.releaseName,
      });
      ledger.record("ARTIFACT_PREPARED", {
        targetCommit: to,
        releaseDirectoryIdentity: preparedRelease.releaseName,
        activatedBuildStamp: preparedRelease.buildStamp,
      });
    } catch (error) {
      const failure = failureOf(error);
      if (ledger && failure.reason !== "deployment-ledger-write-failed") {
        try { ledger.record("FAILED", { targetCommit: to, reasonCode: failure.reason }); }
        catch (ledgerError) { log(`STOP deployment-ledger-write-failed detail=${ledgerError instanceof Error ? ledgerError.name : "unknown"}`); }
      }
      if (!shouldPersistFailure({ dryRun: false, reason: failure.reason, upgradeStarted: false })) {
        log(`STOP ${failure.reason}${failure.detail ? ` detail=${failure.detail}` : ""}; no-upgrade-started`);
        return { ok: false, reason: failure.reason };
      }
      await persistAndNotifyFailure(failure, from, to);
      return { ok: false, reason: failure.reason };
    }
    const host = createProductionHost({
      verifyArtifact: async (target) => {
        if (!preparedRelease) fail("release-artifact-missing", target);
        preparedRelease = verifyReleaseArtifact({
          deployRoot: REPOSITORY_ROOT,
          revision: target,
          releaseName: preparedRelease.releaseName,
        });
        return preparedRelease;
      },
      waitForQuiet: async () => {
        barrier = await waitForQuiet();
      },
      prepareWorkspace: async () => {
        operationWorkspace = join(STATE_DIR, `operation-${transactionId}`);
        try {
          cpSync(preparedRelease.releaseDirectory, operationWorkspace, { recursive: true, errorOnExist: true });
          makeWritable(operationWorkspace);
        } catch (error) {
          fail("operation-workspace-preparation-failed", error?.code ?? "copy-failed");
        }
      },
      backup: async () => {
        mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
        const output = join(backupDirectory, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${from.slice(0, 12)}-${to.slice(0, 12)}.dump`);
        try {
          await writePgDumpBackup({
            configuration: loadBinaries().backup,
            databaseUrl: process.env.DATABASE_URL,
            output,
            signal: interruptController.signal,
          });
        } catch (error) {
          throwIfInterrupted();
          fail("database-backup-failed", error instanceof Error ? error.message : String(error));
        }
        return { backupIdentity: basename(output) };
      },
      guardedMigration: async () => {
        const migrationTailBefore = await migrationTail();
        await checked("guarded-migration-refused", loadBinaries().node, ["node_modules/tsx/dist/cli.mjs", "packages/db/prisma/preflight-goal-execution.ts"], {
          cwd: operationWorkspace,
        });
        await checked("guarded-migration-refused", loadBinaries().node, [
          "node_modules/prisma/build/index.js",
          "migrate",
          "deploy",
          "--schema",
          "packages/db/prisma/schema.prisma",
        ], {
          cwd: operationWorkspace,
        });
        const migrationTailAfter = await migrationTail();
        return { migrationTailBefore, migrationTailAfter };
      },
      generatePrismaClient: () => checked("prisma-client-generation-refused", loadBinaries().node, [
        "node_modules/prisma/build/index.js",
        "generate",
        "--schema",
        "packages/db/prisma/schema.prisma",
      ], { cwd: operationWorkspace }),
      syncCanonicalPrompts: () => checked("canonical-prompt-sync-refused", loadBinaries().node, [
        "node_modules/tsx/dist/cli.mjs",
        "packages/db/prisma/sync-canonical-prompts.ts",
      ], { cwd: operationWorkspace }),
      verifyRuntimePrismaClient: async () => {
        if (!generatedPrismaClientIsComplete(operationWorkspace)) {
          fail("runtime-prisma-client-missing", "operation-generated-client-is-absent");
        }
      },
      verifyStableServicePaths: async () => {
        await verifyStableServicePaths();
      },
      assertQuietBeforeRestart: async () => {
        if (!await barrier.verify()) fail("deploy-barrier-lost", "exclusive-session-lock-not-held");
        const blockers = await blockingRuns();
        if (blockers.length > 0) fail("quiet-window-lost", `blockers-${blockers.length}`);
      },
      publishBuild: async () => {
        if (!preparedRelease) fail("release-artifact-missing", "verified-release-not-prepared");
        preparedRelease = verifyReleaseArtifact({
          deployRoot: REPOSITORY_ROOT,
          revision: to,
          releaseName: preparedRelease.releaseName,
        });
        const activated = activateReleasePointer({ root: REPOSITORY_ROOT, release: preparedRelease.releaseName });
        const relativeTarget = (target) => target === null ? null : `releases/${target}`;
        const pointerTransition = Object.freeze({
          oldTarget: relativeTarget(activated.oldTarget),
          newTarget: relativeTarget(activated.newTarget),
          previousTarget: relativeTarget(activated.previousTarget),
        });
        return {
          releaseDirectoryIdentity: preparedRelease.releaseName,
          releaseIdentity: {
            name: preparedRelease.releaseName,
            commit: preparedRelease.revision,
            digest: preparedRelease.digest,
          },
          pointerOldTarget: pointerTransition.oldTarget,
          pointerNewTarget: pointerTransition.newTarget,
          pointerTransition,
          rollback: async () => rollbackReleasePointer({ root: REPOSITORY_ROOT }),
          commit: async () => undefined,
        };
      },
      restartServices: async () => {
        for (const label of SERVICE_LABELS) await launchctl("service-restart-failed", ["kickstart", "-k", `${domain()}/${label}`]);
      },
      verifyServices: async (revisions) => {
        const deadline = Date.now() + 30_000;
        let lastReason = "not-ready";
        while (Date.now() < deadline) {
          const state = await serviceState();
          if (!state.ok) lastReason = `launchd-unavailable-${state.unavailable.join(",")}`;
          else {
            try {
              const port = process.env.API_PORT ?? "3000";
              const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
              const version = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(2_000) });
              const payload = version.ok ? await version.json() : {};
              if (health.ok && version.ok && payload.commit === revisions.to && payload.dirty === false) {
                throwIfInterrupted();
                return {
                  activatedBuildStamp: {
                    packageName: payload.packageName,
                    commit: payload.commit,
                    dirty: payload.dirty,
                  },
                };
              }
              lastReason = `health-${health.status}-version-${version.status}-commit-${String(payload.commit ?? "unknown")}`;
            } catch (error) {
              if (error instanceof DeployFailure) throw error;
              lastReason = error instanceof Error ? error.name : "probe-failed";
            }
          }
          await sleep(1_000);
        }
        fail("service-verification-failed", lastReason);
      },
      restorePreviousServices: async () => {
        for (const label of SERVICE_LABELS) {
          await launchctl("previous-service-restore-failed", ["kickstart", "-k", `${domain()}/${label}`], { allowAfterInterrupt: true });
        }
      },
      escalate: writeEscalation,
      markEscalationNotified,
      notify,
      log,
      cleanupWorkspace: async () => {
        try {
          if (operationWorkspace && existsSync(operationWorkspace)) {
            makeWritable(operationWorkspace);
            rmSync(operationWorkspace, { recursive: true, force: true });
          }
        } finally {
          if (barrier) await barrier.release();
        }
      },
    });
    const result = await executeUpgrade(host, { from, to }, { ledger, ledgerStarted: true });
    if (result.ok) pruneHistory();
    return result.ok ? { ok: true } : { ok: false, reason: result.failure.reason };
  }).then((result) => result.ok ? 0 : 1);
};

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    if (!interruption.interrupt(signal)) return;
    log(`STOP deploy-interrupted detail=${signal}; rolling-back-before-exit-${code}`);
  });
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  const failure = failureOf(error);
  log(`STOP ${failure.reason}${failure.detail ? ` detail=${failure.detail}` : ""}`);
  const dryRunMode = process.argv.includes("--dry-run");
  if (shouldPersistFailure({ dryRun: dryRunMode, reason: failure.reason }) && !existsSync(ESCALATION_PATH)) {
    await writeEscalation({ outcome: "failure", reason: failure.reason, detail: failure.detail, from: "unknown", to: "unknown" })
      .catch((writeError) => log(`STOP escalation-write-failed detail=${writeError instanceof Error ? writeError.name : "unknown"}`));
  }
  if (shouldPersistFailure({ dryRun: dryRunMode, reason: failure.reason }) && existsSync(ESCALATION_PATH)) {
    await loadEnvironment()
      .then(retryEscalationNotification)
      .catch(() => log(`STOP inbox-notification-pending reason=${failure.reason}`));
  }
  exitCode = failure.reason === "usage" ? 64 : 1;
} finally {
  await Promise.allSettled([...activeResources].map((resource) => resource.release()));
  if (prisma) await prisma.$disconnect().catch(() => undefined);
}
process.exitCode = interruption.receivedSignal() === "SIGINT" ? 130 : interruption.receivedSignal() === "SIGTERM" ? 143 : exitCode;
