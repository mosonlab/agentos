import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkExistingEscalation,
  ESCALATION_RETRY_CAP,
  resolveRemoteMainTarget,
} from "./quiet-window-escalation.mjs";

const revision = "b".repeat(40);
const retryableReasons = new Set(["remote-main-unreadable"]);
const retryableEscalation = {
  reason: "remote-main-unreadable",
  detail: "exit-128",
  attempts: 1,
  escalatedAt: "2026-08-30T15:00:00.000Z",
};

const fixture = (t, escalation = retryableEscalation) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-escalation-test-"));
  const escalationPath = join(root, "escalated.json");
  writeFileSync(escalationPath, `${JSON.stringify(escalation)}\n`, { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logs = [];
  let retryCalls = 0;
  return {
    escalationPath,
    logs,
    retryCalls: () => retryCalls,
    options: {
      escalationPath,
      log: (line) => { logs.push(line); },
      retryableReasons,
      retryCap: ESCALATION_RETRY_CAP,
      retryEscalationNotification: async () => { retryCalls += 1; },
    },
  };
};

test("the shipped retry policy admits an eligible marker without clearing it early", async (t) => {
  const state = fixture(t);

  const result = await checkExistingEscalation(state.options);

  assert.equal(result.active, false);
  assert.equal(result.retryEscalation.reason, "remote-main-unreadable");
  assert.equal(result.retryEscalation.attempts, 1);
  assert.equal(existsSync(state.escalationPath), true);
  assert.equal(state.retryCalls(), 1);
  assert.deepEqual(state.logs, []);
});

test("a pending failure notification logs a retry without stopping admission", async (t) => {
  const state = fixture(t);

  const result = await checkExistingEscalation({
    ...state.options,
    retryEscalationNotification: async () => { throw new Error("inbox-unavailable"); },
  });

  assert.equal(result.active, false);
  assert.equal(result.retryEscalation.reason, "remote-main-unreadable");
  assert.deepEqual(state.logs, ["RETRY inbox-notification-pending reason=remote-main-unreadable"]);
});

test("a marker replaced while retrying notification remains latched", async (t) => {
  const state = fixture(t);
  const replacement = { reason: "remote-main-auth-failed", escalatedAt: "2026-08-30T15:01:00.000Z" };

  const result = await checkExistingEscalation({
    ...state.options,
    retryEscalationNotification: async () => {
      writeFileSync(state.escalationPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    },
  });

  assert.deepEqual(result, { active: true });
  assert.deepEqual(JSON.parse(readFileSync(state.escalationPath, "utf8")), replacement);
  assert.deepEqual(state.logs, [`STOP escalation-active path=${state.escalationPath}`]);
});

test("a marker removed while retrying notification needs no retry state", async (t) => {
  const state = fixture(t);

  const result = await checkExistingEscalation({
    ...state.options,
    retryEscalationNotification: async () => { unlinkSync(state.escalationPath); },
  });

  assert.deepEqual(result, { active: false });
  assert.equal(existsSync(state.escalationPath), false);
});

test("an escalation outside the shipped allowlist stays latched", async (t) => {
  const state = fixture(t, {
    reason: "remote-main-corrupt-response",
    escalatedAt: "2026-08-30T15:00:00.000Z",
  });

  const result = await checkExistingEscalation(state.options);

  assert.deepEqual(result, { active: true });
  assert.equal(existsSync(state.escalationPath), true);
  assert.equal(state.retryCalls(), 1);
});

test("two startup invocations serialize target reads while leaving self-clear to full-run success", async (t) => {
  const state = fixture(t);
  let held = false;
  let releaseRead;
  let signalReadStarted;
  const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
  const readReleased = new Promise((resolve) => { releaseRead = resolve; });
  const acquireLock = async () => {
    if (held) return null;
    held = true;
    return { release: async () => { held = false; } };
  };
  const options = {
    acquireLock,
    log: state.options.log,
    checkEscalation: () => checkExistingEscalation(state.options),
    readRemoteMain: async () => {
      signalReadStarted();
      await readReleased;
      return revision;
    },
    persistFailure: async () => assert.fail("a successful target read must not persist a failure"),
  };

  const first = resolveRemoteMainTarget(options);
  await readStarted;
  const second = await resolveRemoteMainTarget(options);
  releaseRead();
  const firstResult = await first;

  assert.deepEqual(firstResult, { targetCommit: revision });
  assert.deepEqual(second, { ok: true, skipped: "lock-held" });
  assert.equal(existsSync(state.escalationPath), true);
  assert.equal(state.logs.filter((line) => line.startsWith("SKIP concurrent-run")).length, 1);
});
