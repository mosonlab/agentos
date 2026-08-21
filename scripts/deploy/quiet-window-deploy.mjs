#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeployFailure,
  SERVICE_LABELS,
  dryRunDecision,
  executeUpgrade,
  gitPreflightFailure,
  runLocked,
} from "./quiet-window-lib.mjs";
import {
  acquireProcessLock,
  blockingRunsStatement,
  DEPLOY_ARTIFACT_PATHS,
  inspectGitPreflight,
  publishDirectories,
} from "./quiet-window-adapters.mjs";
import { createProductionHost } from "./quiet-window-host.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "../..");
const STATE_DIR = join(REPOSITORY_ROOT, ".agentos-deploy");
const LOCK_PATH = join(STATE_DIR, "lock");
const ESCALATION_PATH = join(STATE_DIR, "escalated.json");
const API_BUILD_STAMP = join(REPOSITORY_ROOT, "packages/api/dist/build-info.json");
const POLL_SECONDS_TEXT = process.env.QUIET_WINDOW_POLL_SECONDS ?? "60";
const POLL_SECONDS = /^\d+$/u.test(POLL_SECONDS_TEXT) ? Number(POLL_SECONDS_TEXT) : Number.NaN;
const POLL_MS = POLL_SECONDS * 1_000;
const SHA = /^[0-9a-f]{40}$/u;
const DEPLOY_BARRIER_CLASS = 0x41_47_44_50; // Must match @agentos/db deploy-barrier.ts ("AGDP").
const DEPLOY_BARRIER_KEY = 1;

const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };
const activeResources = new Set();
const trackResource = (resource) => {
  const release = resource.release.bind(resource);
  resource.release = async () => {
    try { await release(); } finally { activeResources.delete(resource); }
  };
  activeResources.add(resource);
  return resource;
};

const command = (program, args, { cwd = REPOSITORY_ROOT, env = process.env, capture = false } = {}) =>
  new Promise((accept, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => accept({ code: code ?? 1, signal, stdout, stderr }));
  });

const checked = async (reason, program, args, options) => {
  log(`START ${reason}`);
  const result = await command(program, args, options).catch((error) => ({ code: 1, stderr: String(error), stdout: "" }));
  if (result.code !== 0) {
    const diagnosis = (result.stderr || result.stdout || "").trim().slice(-2_000).replaceAll(/\s+/gu, " ");
    fail(reason, `exit-${result.code}${diagnosis ? `: ${diagnosis}` : ""}`);
  }
  log(`PASS ${reason}`);
  return result;
};

const gitText = (...args) => execFileSync(loadBinaries().git, ["-C", REPOSITORY_ROOT, ...args], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

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
  const stamp = readJson(API_BUILD_STAMP, "deployed-revision-unreadable");
  if (!SHA.test(stamp.commit ?? "") || stamp.dirty !== false || stamp.packageName !== "@agentos/api") {
    fail("deployed-revision-unreadable", "api-dist-stamp-is-not-a-clean-agentos-api-build");
  }
  return stamp.commit;
};

const remoteMainRevision = async () => {
  const result = await command(loadBinaries().git, ["ls-remote", "--exit-code", "origin", "refs/heads/main"], { capture: true });
  const revision = result.stdout.trim().split(/\s+/u)[0] ?? "";
  if (result.code !== 0 || !SHA.test(revision)) fail("remote-main-unreadable", `exit-${result.code}`);
  return revision;
};

const loadEnvironment = async () => {
  const envPath = join(REPOSITORY_ROOT, ".env");
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
  binaries ??= Object.freeze({
    git: resolveExecutable("DEPLOY_GIT_BINARY", "git"),
    npm: resolveExecutable("DEPLOY_NPM_BINARY", "npm"),
    pgDump: resolveExecutable("DEPLOY_PG_DUMP_BINARY", "pg_dump"),
  });
  return binaries;
};

let prisma = null;
const database = async () => {
  if (prisma) return prisma;
  const module = await import("@prisma/client").catch(() => fail("database-client-unavailable", "prisma-client-import-failed"));
  prisma = new module.PrismaClient();
  return prisma;
};

const blockingRuns = async () => {
  const db = await database();
  try {
    const statement = blockingRunsStatement();
    return await db.$queryRawUnsafe(statement.sql, ...statement.parameters);
  } catch {
    fail("quiet-window-query-failed", "platform-database-unreadable");
  }
};

const notify = async ({ outcome, reason, detail = "", from, to }) => {
  const db = await database();
  const body = `[auto-deploy] ${outcome}: ${from} -> ${to}; reason=${reason}${detail ? `; detail=${detail}` : ""}`;
  const dedupeKey = `auto-deploy:${createHash("sha256").update(body).digest("hex")}`;
  try {
    const chatId = process.env.FEISHU_DEFAULT_CHAT_ID;
    if (!chatId) fail("environment-unreadable", "FEISHU_DEFAULT_CHAT_ID-missing");
    const thread = await db.inboxThread.findFirst({ where: { channel: "FEISHU", externalChatId: chatId, sessionId: null } })
      ?? await db.inboxThread.create({ data: { channel: "FEISHU", externalChatId: chatId } });
    await db.inboxMessage.upsert({
      where: { dedupeKey },
      create: { from: "AGENT", kind: "TEXT", body, dedupeKey, threadId: thread.id },
      update: {},
    });
    log(`INBOX ${body}`);
  } catch {
    fail("inbox-notification-failed", `${outcome}-${reason}`);
  }
};

const sleep = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));

const launchctl = async (reason, args) => checked(reason, "/bin/launchctl", args, { capture: true });
const domain = () => `gui/${process.getuid()}`;

const acquireDeployBarrier = async () => {
  const module = await import("@prisma/client").catch(() => fail("deploy-barrier-unavailable", "prisma-client-import-failed"));
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("max_connection_lifetime", "0");
  url.searchParams.set("max_idle_connection_lifetime", "0");
  const session = new module.PrismaClient({ datasources: { db: { url: url.href } } });
  try {
    await session.$connect();
    const rows = await session.$queryRawUnsafe(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4) AS granted, pg_backend_pid() AS pid",
      DEPLOY_BARRIER_CLASS,
      DEPLOY_BARRIER_KEY,
    );
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
    fail("deploy-barrier-unavailable", error instanceof Error ? error.name : "query-failed");
  }
};

const waitForQuiet = async () => {
  while (true) {
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

const readAuthority = (root = REPOSITORY_ROOT) => {
  const authority = readJson(join(root, "release-authority.json"), "release-authority-invalid");
  if (!SHA.test(authority.masterSha ?? "") || !SHA.test(authority.controlPlaneASha ?? "")) {
    fail("release-authority-invalid", "authority-shas-missing-or-malformed");
  }
  return authority;
};

const parseArgs = (args) => {
  const allowed = new Set(["--dry-run", "--clear-escalation"]);
  const unknown = args.find((argument) => !allowed.has(argument));
  if (unknown) fail("usage", `unknown-argument-${unknown}`);
  if (args.includes("--dry-run") && args.includes("--clear-escalation")) fail("usage", "modes-are-mutually-exclusive");
  return { dryRun: args.includes("--dry-run"), clearEscalation: args.includes("--clear-escalation") };
};

const serviceState = async () => {
  const unavailable = [];
  for (const label of SERVICE_LABELS) {
    const result = await command("/bin/launchctl", ["print", `${domain()}/${label}`], { capture: true });
    if (result.code !== 0 || !/^\s*state = running\s*$/mu.test(result.stdout)) unavailable.push(label);
  }
  return { ok: unavailable.length === 0, unavailable };
};

const repositoryState = async (target) => {
  const source = gitText("rev-parse", "HEAD");
  const dirty = gitText("status", "--porcelain").length > 0;
  let fastForward = "verify-after-fetch";
  try {
    execFileSync(loadBinaries().git, ["-C", REPOSITORY_ROOT, "cat-file", "-e", `${target}^{commit}`], { stdio: "ignore" });
    fastForward = commandSyncOk(loadBinaries().git, ["-C", REPOSITORY_ROOT, "merge-base", "--is-ancestor", source, target]) ? "yes" : "no";
  } catch { /* ls-remote can name an object this checkout has not fetched */ }
  return { source, dirty, fastForward };
};

const commandSyncOk = (program, args) => {
  try { execFileSync(program, args, { stdio: "ignore" }); return true; } catch { return false; }
};

const dryRun = async () => {
  await loadEnvironment();
  loadBinaries();
  const from = readDeployedRevision();
  const to = await remoteMainRevision();
  const source = gitText("rev-parse", "HEAD");
  const result = await dryRunDecision({
    revisions: async () => ({ from, source, to }),
    blockingRuns,
    repositoryState: () => repositoryState(to),
    serviceState,
    authorityState: async () => {
      try { readAuthority(); return { ok: true }; } catch (error) { return { ok: false, reason: error.reason ?? "invalid" }; }
    },
  });
  for (const line of result.lines) log(line);
  return result.repository.dirty || result.repository.fastForward !== "yes" || !result.services.ok || !result.authority.ok ? 1 : 0;
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
      const failure = error instanceof DeployFailure
        ? error
        : new DeployFailure("unexpected-error", error instanceof Error ? error.message : String(error));
      await persistAndNotifyFailure(failure, from, to);
      return { ok: false, reason: failure.reason };
    }
    if (from === to) {
      log(`NOOP already-deployed revision=${from}`);
      return { ok: true, skipped: "already-deployed" };
    }

    let stage = null;
    let barrier = null;
    const transactionId = randomUUID();
    const backupDirectory = join(STATE_DIR, "backups");
    const previousDirectory = join(STATE_DIR, `previous-${transactionId}`);
    try {
      barrier = await waitForQuiet();
    } catch (error) {
      const failure = error instanceof DeployFailure
        ? error
        : new DeployFailure("unexpected-error", error instanceof Error ? error.message : String(error));
      await persistAndNotifyFailure(failure, from, to);
      return { ok: false, reason: failure.reason };
    }
    const host = createProductionHost({
      fastForward: async () => {
        const dirty = gitText("status", "--porcelain").length > 0;
        const headBeforeFetch = gitText("rev-parse", "HEAD");
        const preflight = gitPreflightFailure({ dirty, head: headBeforeFetch, target: headBeforeFetch, fastForward: true });
        if (preflight) fail(preflight, "checkout-has-uncommitted-content");
        await checked("fetch-main-failed", loadBinaries().git, ["fetch", "origin", "main"]);
        to = gitText("rev-parse", "origin/main");
        const state = inspectGitPreflight({ git: loadBinaries().git, root: REPOSITORY_ROOT, target: to });
        const { head } = state;
        if (state.refusal) fail(state.refusal, `${head}-to-${to}`);
        if (head !== to) await checked("fast-forward-failed", loadBinaries().git, ["merge", "--ff-only", "origin/main"]);
        return to;
      },
      createStage: async () => {
        stage = join(STATE_DIR, `stage-${transactionId}`);
        await checked("staging-worktree-failed", loadBinaries().git, ["worktree", "add", "--detach", stage, "HEAD"]);
      },
      installDependencies: () => checked("staging-dependencies-failed", loadBinaries().npm, ["ci"], { cwd: stage }),
      prismaGenerate: () => checked("prisma-generate-failed", loadBinaries().npm, ["run", "db:generate"], { cwd: stage }),
      build: async () => {
        await checked("build-failed", loadBinaries().npm, ["run", "build"], { cwd: stage });
        const stamp = readJson(join(stage, "packages/api/dist/build-info.json"), "build-stamp-invalid");
        if (stamp.commit !== to || stamp.dirty !== false) fail("build-stamp-invalid", "staged-api-dist-does-not-match-target");
        for (const path of DEPLOY_ARTIFACT_PATHS) if (!existsSync(join(stage, path))) fail("build-output-missing", path);
      },
      backup: async () => {
        mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
        let databaseUrl;
        try {
          databaseUrl = new URL(process.env.DATABASE_URL);
        } catch {
          fail("database-backup-failed", "DATABASE_URL-is-invalid");
        }
        if (!new Set(["postgres:", "postgresql:"]).has(databaseUrl.protocol)) {
          fail("database-backup-failed", "DATABASE_URL-is-not-postgresql");
        }
        const output = join(backupDirectory, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${from.slice(0, 12)}-${to.slice(0, 12)}.dump`);
        closeSync(openSync(output, "wx", 0o600));
        const backupEnv = { ...process.env, PGPASSWORD: decodeURIComponent(databaseUrl.password) };
        const args = [
          "-Fc", "--file", output,
          "--host", databaseUrl.hostname,
          "--port", databaseUrl.port || "5432",
          "--username", decodeURIComponent(databaseUrl.username),
          "--dbname", decodeURIComponent(databaseUrl.pathname.replace(/^\//u, "")),
        ];
        await checked("database-backup-failed", loadBinaries().pgDump, args, { env: backupEnv });
        chmodSync(output, 0o600);
      },
      guardedMigration: async () => {
        copyFileSync(join(REPOSITORY_ROOT, ".env"), join(stage, ".env"));
        chmodSync(join(stage, ".env"), 0o600);
        const authority = readAuthority(stage);
        await checked("guarded-migration-refused", loadBinaries().npm, ["run", "db:migrate-goal-execution"], {
          cwd: stage,
          env: {
            ...process.env,
            GOAL5A0_MASTER_SHA: authority.masterSha,
            GOAL5A0_CONTROL_PLANE_A_SHA: authority.controlPlaneASha,
          },
        });
      },
      syncCanonicalPrompts: () => checked("canonical-prompt-sync-refused", loadBinaries().npm, ["run", "db:sync-canonical-prompts"], { cwd: stage }),
      verifyRuntimePrismaClient: async () => {
        if (!existsSync(join(stage, "node_modules/.prisma/client/index.js"))) {
          fail("runtime-prisma-client-missing", "staged-generated-client-is-absent");
        }
      },
      assertQuietBeforeRestart: async () => {
        if (!await barrier.verify()) fail("deploy-barrier-lost", "exclusive-session-lock-not-held");
        const blockers = await blockingRuns();
        if (blockers.length > 0) fail("quiet-window-lost", `blockers-${blockers.length}`);
      },
      publishBuild: async () => publishDirectories({ root: REPOSITORY_ROOT, stage, previousDirectory, paths: DEPLOY_ARTIFACT_PATHS }),
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
              if (health.ok && version.ok && payload.commit === revisions.to && payload.dirty === false) return;
              lastReason = `health-${health.status}-version-${version.status}-commit-${String(payload.commit ?? "unknown")}`;
            } catch (error) { lastReason = error instanceof Error ? error.name : "probe-failed"; }
          }
          await sleep(1_000);
        }
        fail("service-verification-failed", lastReason);
      },
      restorePreviousServices: async () => {
        for (const label of SERVICE_LABELS) await launchctl("previous-service-restore-failed", ["kickstart", "-k", `${domain()}/${label}`]);
      },
      escalate: writeEscalation,
      markEscalationNotified,
      notify,
      log,
      cleanupStage: async () => {
        let cleanupFailure = null;
        try {
          if (stage && existsSync(join(stage, ".env"))) rmSync(join(stage, ".env"), { force: true });
          if (stage && existsSync(stage)) await checked("staging-cleanup-failed", loadBinaries().git, ["worktree", "remove", "--force", stage], { capture: true });
          await checked("staging-cleanup-failed", loadBinaries().git, ["worktree", "prune"], { capture: true });
        } catch (error) {
          cleanupFailure = error;
        } finally {
          if (barrier) await barrier.release();
        }
        if (cleanupFailure) throw cleanupFailure;
      },
    });
    const result = await executeUpgrade(host, { from, to });
    return result.ok ? { ok: true } : { ok: false, reason: result.failure.reason };
  }).then((result) => result.ok ? 0 : 1);
};

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    void Promise.allSettled([...activeResources].map((resource) => resource.release()))
      .finally(() => process.exit(code));
  });
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  const failure = error instanceof DeployFailure ? error : new DeployFailure("unexpected-error", error instanceof Error ? error.message : String(error));
  log(`STOP ${failure.reason}${failure.detail ? ` detail=${failure.detail}` : ""}`);
  if (failure.reason !== "usage" && !existsSync(ESCALATION_PATH)) {
    await writeEscalation({ outcome: "failure", reason: failure.reason, detail: failure.detail, from: "unknown", to: "unknown" })
      .catch((writeError) => log(`STOP escalation-write-failed detail=${writeError instanceof Error ? writeError.name : "unknown"}`));
  }
  if (failure.reason !== "usage" && existsSync(ESCALATION_PATH)) {
    await loadEnvironment()
      .then(retryEscalationNotification)
      .catch(() => log(`STOP inbox-notification-pending reason=${failure.reason}`));
  }
  exitCode = failure.reason === "usage" ? 64 : 1;
} finally {
  if (prisma) await prisma.$disconnect().catch(() => undefined);
}
process.exitCode = exitCode;
