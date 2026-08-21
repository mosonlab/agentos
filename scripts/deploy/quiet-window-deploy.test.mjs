import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DeployFailure,
  dryRunDecision,
  executeUpgrade,
  gitPreflightFailure,
  quietWindowIsOpen,
  runLocked,
} from "./quiet-window-lib.mjs";
import { renderLaunchdPlist } from "./install-launchd.mjs";
import { acquireProcessLock, blockingRunsStatement, DEPLOY_ARTIFACT_PATHS, inspectGitPreflight, publishDirectories } from "./quiet-window-adapters.mjs";
import { createProductionHost } from "./quiet-window-host.mjs";

const revisions = { from: "a".repeat(40), to: "b".repeat(40) };

const fixture = (failure = null) => {
  const calls = [];
  const state = { serving: "previous", escalated: null, notification: null, restarted: false };
  const step = (name, work = async () => undefined) => async () => {
    calls.push(name);
    if (failure === name) {
      const reason = name === "canonical-prompt-sync" ? "canonical-prompt-sync-refused" : `${name}-failed`;
      throw new DeployFailure(reason, "fixture");
    }
    return work();
  };
  const host = {
    fastForward: step("fast-forward", async () => revisions.to),
    createStage: step("create-stage"),
    installDependencies: step("install-dependencies"),
    prismaGenerate: step("prisma-generate"),
    build: step("build"),
    backup: step("backup"),
    guardedMigration: step("guarded-migration"),
    syncCanonicalPrompts: step("canonical-prompt-sync"),
    verifyRuntimePrismaClient: step("verify-runtime-prisma-client"),
    assertQuietBeforeRestart: step("quiet-recheck"),
    publishBuild: step("publish-build", async () => {
      state.serving = "candidate";
      return {
        rollback: async () => { calls.push("rollback-build"); state.serving = "previous"; },
        commit: async () => { calls.push("commit-build"); },
      };
    }),
    restartServices: step("restart-services", async () => { state.restarted = true; }),
    verifyServices: step("verify-services"),
    restorePreviousServices: step("restore-previous-services", async () => { state.restarted = false; }),
    escalate: async (record) => { calls.push("escalate"); state.escalated = record; },
    notify: async (record) => { calls.push(`notify-${record.outcome}`); state.notification = record; },
    cleanupStage: async () => { calls.push("cleanup-stage"); },
  };
  return { host, calls, state };
};

test("quiet-window predicate blocks only claimed, provisioning, and running", () => {
  for (const status of ["claimed", "provisioning", "running", "CLAIMED", "RUNNING"]) {
    assert.equal(quietWindowIsOpen([{ status }]), false, status);
  }
  for (const status of ["queued", "waiting-inbox", "succeeded", "failed"]) {
    assert.equal(quietWindowIsOpen([{ status }]), true, status);
  }
  assert.equal(quietWindowIsOpen([{ status: "queued" }, { status: "waiting-inbox" }]), true);
});

test("production host factory refuses a missing mechanism", () => {
  assert.throws(() => createProductionHost({}), /production-host-adapter-missing:fastForward/u);
});

test("published artifact includes the generated runtime dependency tree", () => {
  assert.equal(DEPLOY_ARTIFACT_PATHS.at(-1), "node_modules");
  assert.ok(DEPLOY_ARTIFACT_PATHS.includes("packages/api/dist"));
});

test("git preflight names dirty and non-fast-forward refusals", () => {
  assert.equal(gitPreflightFailure({ dirty: true, head: "a", target: "b", fastForward: true }), "dirty-working-tree");
  assert.equal(gitPreflightFailure({ dirty: false, head: "a", target: "b", fastForward: false }), "non-fast-forward-main");
  assert.equal(gitPreflightFailure({ dirty: false, head: "a", target: "b", fastForward: true }), null);
  assert.equal(gitPreflightFailure({ dirty: false, head: "b", target: "b", fastForward: false }), null);
});

test("successful upgrade runs the safety sequence in order", async () => {
  const { host, calls, state } = fixture();
  assert.deepEqual(await executeUpgrade(host, revisions), { ok: true });
  assert.deepEqual(calls, [
    "fast-forward", "create-stage", "install-dependencies", "prisma-generate", "build", "backup",
    "guarded-migration", "canonical-prompt-sync", "verify-runtime-prisma-client", "quiet-recheck",
    "publish-build", "restart-services", "verify-services", "notify-success", "commit-build", "cleanup-stage",
  ]);
  assert.equal(state.serving, "candidate");
  assert.equal(state.notification.from, revisions.from);
  assert.equal(state.notification.to, revisions.to);
});

test("the first failing step stops the pipeline and keeps the previous build serving", async () => {
  const { host, calls, state } = fixture("build");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "build-failed");
  assert.deepEqual(calls, [
    "fast-forward", "create-stage", "install-dependencies", "prisma-generate", "build",
    "escalate", "notify-failure", "cleanup-stage",
  ]);
  assert.equal(state.serving, "previous");
  assert.equal(state.restarted, false);
  assert.equal(state.escalated.reason, "build-failed");
});

test("structural sync refusal escalates without publishing or restarting", async () => {
  const { host, calls, state } = fixture("canonical-prompt-sync");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "canonical-prompt-sync-refused");
  assert.equal(calls.includes("publish-build"), false);
  assert.equal(calls.includes("restart-services"), false);
  assert.equal(state.serving, "previous");
  assert.equal(state.escalated.reason, "canonical-prompt-sync-refused");
});

test("restart failure rolls the build back and restarts the previous services", async () => {
  const { host, calls, state } = fixture("restart-services");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(state.serving, "previous");
  assert.equal(calls.includes("rollback-build"), true);
  assert.equal(calls.includes("restore-previous-services"), true);
  assert.equal(calls.includes("commit-build"), false);
});

test("a service that exits after kickstart rolls back before success", async () => {
  const { host, calls, state } = fixture("verify-services");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "verify-services-failed");
  assert.equal(state.serving, "previous");
  assert.ok(calls.includes("rollback-build"));
  assert.ok(calls.includes("restore-previous-services"));
  assert.equal(calls.includes("notify-success"), false);
});

test("a stale /version target is a service-verification failure", async () => {
  const { host, calls, state } = fixture();
  host.verifyServices = async () => {
    calls.push("verify-services-stale-version");
    throw new DeployFailure("service-verification-failed", "stale-version");
  };
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "service-verification-failed");
  assert.equal(state.serving, "previous");
  assert.ok(calls.includes("restore-previous-services"));
});

test("notification revisions use the target fixed by fetch after a quiet wait", async () => {
  const { host, state } = fixture();
  const advanced = "c".repeat(40);
  host.fastForward = async () => advanced;
  assert.deepEqual(await executeUpgrade(host, revisions), { ok: true });
  assert.equal(state.notification.to, advanced);
});

test("a held lock prevents a concurrent pipeline", async () => {
  let ran = false;
  const lines = [];
  const result = await runLocked({ acquireLock: async () => null, log: (line) => lines.push(line) }, async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.deepEqual(result, { ok: true, skipped: "lock-held" });
  assert.deepEqual(lines, ["SKIP concurrent-run lock-held"]);
});

test("a lock is released after the owner fails", async () => {
  let released = false;
  await assert.rejects(
    runLocked({
      acquireLock: async () => ({ release: async () => { released = true; } }),
      log: () => undefined,
    }, async () => { throw new Error("fixture"); }),
    /fixture/,
  );
  assert.equal(released, true);
});

test("the production SQL is derived from the blocking-status authority", () => {
  const statement = blockingRunsStatement();
  assert.deepEqual(statement.parameters, ["claimed", "provisioning", "running"]);
  assert.match(statement.sql, /IN \(\$1,\$2,\$3\)/u);
  for (const status of statement.parameters) assert.equal(statement.sql.includes(`'${status}'`), false);
});

test("production Git preflight refuses real dirty and divergent repositories", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-git-"));
  const git = "/usr/bin/git";
  const run = (...args) => execFileSync(git, ["-C", root, ...args], { encoding: "utf8" }).trim();
  run("init", "-b", "main");
  run("config", "user.name", "Fixture");
  run("config", "user.email", "fixture@example.com");
  writeFileSync(join(root, "file"), "base");
  run("add", "file");
  run("commit", "-m", "base");
  const base = run("rev-parse", "HEAD");
  run("checkout", "-b", "target");
  writeFileSync(join(root, "file"), "target");
  run("commit", "-am", "target");
  const target = run("rev-parse", "HEAD");
  run("checkout", "--detach", base);
  assert.equal(inspectGitPreflight({ git, root, target }).refusal, null);
  writeFileSync(join(root, "dirty"), "dirty");
  assert.equal(inspectGitPreflight({ git, root, target }).refusal, "dirty-working-tree");
  rmSync(join(root, "dirty"));
  writeFileSync(join(root, "file"), "divergent");
  run("commit", "-am", "divergent");
  assert.equal(inspectGitPreflight({ git, root, target }).refusal, "non-fast-forward-main");
  rmSync(root, { recursive: true, force: true });
});

test("a killed filesystem-lock owner is reclaimed with process identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-lock-"));
  const lockPath = join(root, "lock");
  const moduleUrl = new URL("./quiet-window-adapters.mjs", import.meta.url).href;
  const code = `import { acquireProcessLock } from ${JSON.stringify(moduleUrl)}; acquireProcessLock({path:${JSON.stringify(lockPath)}}); console.log('READY'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((accept, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk) => chunk.includes("READY") ? accept() : reject(new Error("lock owner not ready")));
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise((accept) => child.once("exit", accept));
  const recovered = acquireProcessLock({ path: lockPath });
  assert.ok(recovered?.recovered);
  await recovered.release();
  rmSync(root, { recursive: true, force: true });
});

test("real directory publication restores previous bytes after a partial swap", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-publish-"));
  const stage = join(root, "stage");
  const previous = join(root, "previous");
  for (const path of ["one/dist", "two/dist"]) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "value"), `old-${path}`);
  }
  mkdirSync(join(stage, "one/dist"), { recursive: true });
  writeFileSync(join(stage, "one/dist/value"), "new-one");
  assert.throws(
    () => publishDirectories({ root, stage, previousDirectory: previous, paths: ["one/dist", "two/dist"] }),
    /build-swap-failed/u,
  );
  assert.equal(readFileSync(join(root, "one/dist/value"), "utf8"), "old-one/dist");
  assert.equal(readFileSync(join(root, "two/dist/value"), "utf8"), "old-two/dist");
  rmSync(root, { recursive: true, force: true });
});

test("dry-run reads every decision surface and invokes no mutation", async () => {
  const calls = [];
  const result = await dryRunDecision({
    revisions: async () => { calls.push("revisions"); return { from: "a", source: "a", to: "b" }; },
    blockingRuns: async () => { calls.push("runs"); return [{ id: "r1", status: "waiting-inbox" }]; },
    repositoryState: async () => { calls.push("repository"); return { dirty: false, fastForward: "yes" }; },
    serviceState: async () => { calls.push("services"); return { ok: true }; },
    authorityState: async () => { calls.push("authority"); return { ok: true }; },
  });
  assert.equal(result.quiet, true);
  assert.deepEqual(new Set(calls), new Set(["revisions", "runs", "repository", "services", "authority"]));
  assert.equal(result.lines.filter((line) => line.includes("mutation=skipped")).length, 11);
});

test("launchd renderer pins child binaries, escapes paths, and leaves no placeholder", () => {
  const template = "<string>__NODE_BINARY__</string><string>__DEPLOY_SCRIPT__</string><string>__REPOSITORY_ROOT__</string><string>__STDOUT_PATH__</string><string>__STDERR_PATH__</string><string>__GIT_BINARY__</string><string>__NPM_BINARY__</string><string>__PG_DUMP_BINARY__</string>";
  const rendered = renderLaunchdPlist(template, {
    nodeBinary: "/node&bin",
    deployScript: "/repo/<deploy>",
    repositoryRoot: "/repo",
    stdoutPath: "/logs/out",
    stderrPath: "/logs/err",
    gitBinary: "/usr/bin/git",
    npmBinary: "/opt/homebrew/bin/npm",
    pgDumpBinary: "/opt/homebrew/bin/pg_dump",
  });
  assert.match(rendered, /\/node&amp;bin/u);
  assert.match(rendered, /\/repo\/&lt;deploy&gt;/u);
  assert.match(rendered, /\/opt\/homebrew\/bin\/npm/u);
  assert.match(rendered, /\/opt\/homebrew\/bin\/pg_dump/u);
  assert.doesNotMatch(rendered, /__[A-Z_]+__/u);
});
