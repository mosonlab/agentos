import assert from "node:assert/strict";
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
    fastForward: step("fast-forward"),
    createStage: step("create-stage"),
    prismaGenerate: step("prisma-generate"),
    build: step("build"),
    backup: step("backup"),
    guardedMigration: step("guarded-migration"),
    syncCanonicalPrompts: step("canonical-prompt-sync"),
    assertQuietBeforeRestart: step("quiet-recheck"),
    publishBuild: step("publish-build", async () => {
      state.serving = "candidate";
      return {
        rollback: async () => { calls.push("rollback-build"); state.serving = "previous"; },
        commit: async () => { calls.push("commit-build"); },
      };
    }),
    restartServices: step("restart-services", async () => { state.restarted = true; }),
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
    "fast-forward", "create-stage", "prisma-generate", "build", "backup",
    "guarded-migration", "canonical-prompt-sync", "quiet-recheck",
    "publish-build", "restart-services", "notify-success", "commit-build", "cleanup-stage",
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
    "fast-forward", "create-stage", "prisma-generate", "build",
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
  assert.equal(result.lines.filter((line) => line.includes("mutation=skipped")).length, 8);
});

test("launchd renderer escapes paths and leaves no placeholder", () => {
  const template = "<string>__NODE_BINARY__</string><string>__DEPLOY_SCRIPT__</string><string>__REPOSITORY_ROOT__</string><string>__STDOUT_PATH__</string><string>__STDERR_PATH__</string>";
  const rendered = renderLaunchdPlist(template, {
    nodeBinary: "/node&bin",
    deployScript: "/repo/<deploy>",
    repositoryRoot: "/repo",
    stdoutPath: "/logs/out",
    stderrPath: "/logs/err",
  });
  assert.match(rendered, /\/node&amp;bin/u);
  assert.match(rendered, /\/repo\/&lt;deploy&gt;/u);
  assert.doesNotMatch(rendered, /__[A-Z_]+__/u);
});
