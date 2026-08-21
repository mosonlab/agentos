#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
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
const RUNNER_LABELS = SERVICE_LABELS.filter((label) => label.includes(".runner"));
const DIST_PATHS = Object.freeze([
  "packages/github-client/dist",
  "packages/db/dist",
  "packages/api/dist",
  "packages/runner/dist",
  "packages/inbox/dist",
  "packages/merge-executor/dist",
  "packages/cli/dist",
  "apps/web/dist",
]);

const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };

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
  if (result.code !== 0) fail(reason, `exit-${result.code}`);
  log(`PASS ${reason}`);
  return result;
};

const gitText = (...args) => execFileSync("git", ["-C", REPOSITORY_ROOT, ...args], {
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
  const result = await command("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"], { capture: true });
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
    return await db.$queryRawUnsafe(
      `SELECT "id", "status"::text AS "status" FROM "Run" WHERE "status"::text IN ('claimed','provisioning','running') ORDER BY "id"`,
    );
  } catch {
    fail("quiet-window-query-failed", "platform-database-unreadable");
  }
};

const notify = async ({ outcome, reason, detail = "", from, to }) => {
  const db = await database();
  const body = `[auto-deploy] ${outcome}: ${from} -> ${to}; reason=${reason}${detail ? `; detail=${detail}` : ""}`;
  try {
    let threadId;
    const chatId = process.env.FEISHU_DEFAULT_CHAT_ID;
    if (chatId) {
      const thread = await db.inboxThread.findFirst({ where: { channel: "FEISHU", externalChatId: chatId, sessionId: null } })
        ?? await db.inboxThread.create({ data: { channel: "FEISHU", externalChatId: chatId } });
      threadId = thread.id;
    }
    await db.inboxMessage.create({ data: {
      from: "AGENT",
      kind: "TEXT",
      body,
      dedupeKey: `auto-deploy:${outcome}:${from}:${to}:${randomUUID()}`,
      ...(threadId ? { threadId } : {}),
    } });
    log(`INBOX ${body}`);
  } catch {
    fail("inbox-notification-failed", `${outcome}-${reason}`);
  }
};

const sleep = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));

const launchctl = async (reason, args) => checked(reason, "/bin/launchctl", args);
const domain = () => `gui/${process.getuid()}`;

const freezeRunners = async () => {
  const frozen = [];
  try {
    for (const label of RUNNER_LABELS) {
      await launchctl("quiet-window-freeze-failed", ["kill", "SIGSTOP", `${domain()}/${label}`]);
      frozen.push(label);
    }
    return frozen;
  } catch (error) {
    for (const label of frozen.reverse()) {
      await command("/bin/launchctl", ["kill", "SIGCONT", `${domain()}/${label}`], { capture: true });
    }
    throw error;
  }
};

const continueRunners = async (labels = RUNNER_LABELS) => {
  const failures = [];
  for (const label of labels) {
    const result = await command("/bin/launchctl", ["kill", "SIGCONT", `${domain()}/${label}`], { capture: true });
    if (result.code !== 0) failures.push(label);
  }
  if (failures.length > 0) fail("quiet-window-resume-failed", `labels-${failures.join(",")}`);
};

const waitForQuiet = async () => {
  while (true) {
    const before = await blockingRuns();
    if (before.length > 0) {
      log(`HOLD quiet-window blockers=${before.length} statuses=${[...new Set(before.map((run) => run.status))].join(",")}`);
      await sleep(POLL_MS);
      continue;
    }
    // Freeze every process able to claim queued work, then ask the database
    // again. The second read closes the ordinary check/restart race: queued
    // work cannot become claimed while the deployment is in the window.
    const frozen = await freezeRunners();
    let after;
    try {
      await sleep(1_000);
      after = await blockingRuns();
    } catch (error) {
      await continueRunners(frozen);
      throw error;
    }
    if (after.length === 0) {
      log("PASS quiet-window runners-frozen blockers=0");
      return frozen;
    }
    await continueRunners(frozen);
    log(`HOLD quiet-window raced-blockers=${after.length}`);
    await sleep(POLL_MS);
  }
};

const acquireLock = async () => {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(LOCK_PATH, "wx", 0o600);
    try {
      writeFileSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return { release: async () => { try { unlinkSync(LOCK_PATH); } catch { /* a lost lock is already a loud next-run refusal */ } } };
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    fail("deploy-lock-unavailable", error?.code ?? "unknown");
  }
};

const writeEscalation = async (record) => {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${ESCALATION_PATH}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify({ ...record, escalatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, ESCALATION_PATH);
  log(`ESCALATED reason=${record.reason} from=${record.from} to=${record.to}`);
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
    if (result.code !== 0) unavailable.push(label);
  }
  return { ok: unavailable.length === 0, unavailable };
};

const repositoryState = async (target) => {
  const source = gitText("rev-parse", "HEAD");
  const dirty = gitText("status", "--porcelain").length > 0;
  let fastForward = "verify-after-fetch";
  try {
    execFileSync("git", ["-C", REPOSITORY_ROOT, "cat-file", "-e", `${target}^{commit}`], { stdio: "ignore" });
    fastForward = commandSyncOk("git", ["-C", REPOSITORY_ROOT, "merge-base", "--is-ancestor", source, target]) ? "yes" : "no";
  } catch { /* ls-remote can name an object this checkout has not fetched */ }
  return { source, dirty, fastForward };
};

const commandSyncOk = (program, args) => {
  try { execFileSync(program, args, { stdio: "ignore" }); return true; } catch { return false; }
};

const dryRun = async () => {
  await loadEnvironment();
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
  return result.repository.dirty || result.repository.fastForward === "no" || !result.services.ok || !result.authority.ok ? 1 : 0;
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
  if (existsSync(ESCALATION_PATH)) {
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
      await writeEscalation({ reason: failure.reason, detail: failure.detail, from, to });
      await notify({ outcome: "failure", reason: failure.reason, detail: failure.detail, from, to });
      return { ok: false, reason: failure.reason };
    }
    if (from === to) {
      log(`NOOP already-deployed revision=${from}`);
      return { ok: true, skipped: "already-deployed" };
    }

    let frozenRunners = [];
    let stage = null;
    let runnersFrozen = false;
    let restartStarted = false;
    const transactionId = randomUUID();
    const backupDirectory = join(STATE_DIR, "backups");
    const previousDirectory = join(STATE_DIR, `previous-${transactionId}`);
    try {
      frozenRunners = await waitForQuiet();
      runnersFrozen = true;
    } catch (error) {
      const failure = error instanceof DeployFailure
        ? error
        : new DeployFailure("unexpected-error", error instanceof Error ? error.message : String(error));
      await writeEscalation({ reason: failure.reason, detail: failure.detail, from, to });
      await notify({ outcome: "failure", reason: failure.reason, detail: failure.detail, from, to });
      return { ok: false, reason: failure.reason };
    }
    const host = {
      fastForward: async () => {
        const dirty = gitText("status", "--porcelain").length > 0;
        if (dirty) fail("dirty-working-tree", "checkout-has-uncommitted-content");
        await checked("fetch-main-failed", "git", ["fetch", "origin", "main"]);
        to = gitText("rev-parse", "origin/main");
        const head = gitText("rev-parse", "HEAD");
        const fastForward = commandSyncOk("git", ["-C", REPOSITORY_ROOT, "merge-base", "--is-ancestor", head, to]);
        const refusal = gitPreflightFailure({ dirty: false, head, target: to, fastForward });
        if (refusal) fail(refusal, `${head}-to-${to}`);
        if (head !== to) await checked("fast-forward-failed", "git", ["merge", "--ff-only", "origin/main"]);
      },
      createStage: async () => {
        stage = join(STATE_DIR, `stage-${transactionId}`);
        await checked("staging-worktree-failed", "git", ["worktree", "add", "--detach", stage, "HEAD"]);
        if (!existsSync(join(REPOSITORY_ROOT, "node_modules"))) fail("staging-dependencies-missing", "checkout-node_modules-is-absent");
        await checked("staging-dependencies-failed", "/bin/cp", ["-cR", join(REPOSITORY_ROOT, "node_modules"), join(stage, "node_modules")]);
      },
      prismaGenerate: () => checked("prisma-generate-failed", "npm", ["run", "db:generate"], { cwd: stage }),
      build: async () => {
        await checked("build-failed", "npm", ["run", "build"], { cwd: stage });
        const stamp = readJson(join(stage, "packages/api/dist/build-info.json"), "build-stamp-invalid");
        if (stamp.commit !== to || stamp.dirty !== false) fail("build-stamp-invalid", "staged-api-dist-does-not-match-target");
        for (const path of DIST_PATHS) if (!existsSync(join(stage, path))) fail("build-output-missing", path);
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
        await checked("database-backup-failed", "pg_dump", args, { env: backupEnv });
        chmodSync(output, 0o600);
      },
      guardedMigration: async () => {
        copyFileSync(join(REPOSITORY_ROOT, ".env"), join(stage, ".env"));
        chmodSync(join(stage, ".env"), 0o600);
        const authority = readAuthority(stage);
        await checked("guarded-migration-refused", "npm", ["run", "db:migrate-goal-execution"], {
          cwd: stage,
          env: {
            ...process.env,
            GOAL5A0_MASTER_SHA: authority.masterSha,
            GOAL5A0_CONTROL_PLANE_A_SHA: authority.controlPlaneASha,
          },
        });
      },
      syncCanonicalPrompts: () => checked("canonical-prompt-sync-refused", "npm", ["run", "db:sync-canonical-prompts"], { cwd: stage }),
      assertQuietBeforeRestart: async () => {
        const blockers = await blockingRuns();
        if (blockers.length > 0) fail("quiet-window-lost", `blockers-${blockers.length}`);
      },
      publishBuild: async () => {
        mkdirSync(previousDirectory, { recursive: true, mode: 0o700 });
        const moved = [];
        try {
          for (const path of DIST_PATHS) {
            const live = join(REPOSITORY_ROOT, path);
            const prior = join(previousDirectory, path);
            mkdirSync(dirname(prior), { recursive: true });
            const entry = { live, prior, staged: join(stage, path), hadPrior: existsSync(live), published: false };
            if (entry.hadPrior) renameSync(live, prior);
            moved.push(entry);
            renameSync(join(stage, path), live);
            entry.published = true;
          }
        } catch (error) {
          for (const entry of moved.reverse()) {
            if (entry.published && existsSync(entry.live)) renameSync(entry.live, entry.staged);
            if (entry.hadPrior) renameSync(entry.prior, entry.live);
          }
          fail("build-swap-failed", error?.code ?? "rename-failed");
        }
        let settled = false;
        return {
          rollback: async () => {
            if (settled) return;
            for (const path of [...DIST_PATHS].reverse()) {
              const live = join(REPOSITORY_ROOT, path);
              const prior = join(previousDirectory, path);
              if (existsSync(live)) rmSync(live, { recursive: true, force: true });
              if (existsSync(prior)) renameSync(prior, live);
            }
            settled = true;
          },
          commit: async () => {
            if (!settled) log(`RETAIN previous-build path=${previousDirectory}`);
            settled = true;
          },
        };
      },
      restartServices: async () => {
        restartStarted = true;
        for (const label of SERVICE_LABELS) await launchctl("service-restart-failed", ["kickstart", "-k", `${domain()}/${label}`]);
        runnersFrozen = false;
      },
      restorePreviousServices: async () => {
        for (const label of SERVICE_LABELS) await launchctl("previous-service-restore-failed", ["kickstart", "-k", `${domain()}/${label}`]);
        runnersFrozen = false;
      },
      escalate: writeEscalation,
      notify,
      cleanupStage: async () => {
        if (stage && existsSync(stage)) await command("git", ["worktree", "remove", "--force", stage], { capture: true });
        await command("git", ["worktree", "prune"], { capture: true });
        if (runnersFrozen && !restartStarted) await continueRunners(frozenRunners);
      },
    };
    const result = await executeUpgrade(host, { from, to });
    return result.ok ? { ok: true } : { ok: false, reason: result.failure.reason };
  }).then((result) => result.ok ? 0 : 1);
};

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  const failure = error instanceof DeployFailure ? error : new DeployFailure("unexpected-error", error instanceof Error ? error.message : String(error));
  log(`STOP ${failure.reason}${failure.detail ? ` detail=${failure.detail}` : ""}`);
  exitCode = failure.reason === "usage" ? 64 : 1;
} finally {
  if (prisma) await prisma.$disconnect().catch(() => undefined);
}
process.exitCode = exitCode;
