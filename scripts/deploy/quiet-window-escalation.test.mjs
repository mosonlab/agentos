import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkExistingEscalation,
  resolveRemoteMainTarget,
} from "./quiet-window-escalation.mjs";

const revision = "b".repeat(40);
const eligibleEscalation = {
  reason: "remote-main-unreadable",
  detail: "exit-128",
  escalatedAt: "2026-08-30T15:00:00.000Z",
  autoClear: { schemaVersion: 1, source: "remote-main-transport-classifier" },
};

const fixture = (t, escalation = eligibleEscalation) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-escalation-test-"));
  const escalationPath = join(root, "escalated.json");
  writeFileSync(escalationPath, `${JSON.stringify(escalation)}\n`);
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
      retryEscalationNotification: async () => { retryCalls += 1; },
    },
  };
};

test("production escalation state clears an eligible marker and reuses its read revision", async (t) => {
  const state = fixture(t);

  const result = await checkExistingEscalation({
    ...state.options,
    readRemoteMain: async () => revision,
    now: () => new Date("2026-08-30T15:05:00.000Z"),
  });

  assert.deepEqual(result, { active: false, revision });
  assert.equal(existsSync(state.escalationPath), false);
  assert.equal(state.retryCalls(), 0);
  assert.deepEqual(state.logs, [
    `AUDIT escalation-auto-cleared escalation=remote-main-unreadable failed-window=2026-08-30T15:00:00.000Z..2026-08-30T15:05:00.000Z clearing-read=${revision}`,
  ]);
});

test("a marker replaced during the clearing read remains latched", async (t) => {
  const state = fixture(t);
  const replacement = { reason: "remote-main-auth-failed", escalatedAt: "2026-08-30T15:01:00.000Z" };

  const result = await checkExistingEscalation({
    ...state.options,
    readRemoteMain: async () => {
      writeFileSync(state.escalationPath, `${JSON.stringify(replacement)}\n`);
      return revision;
    },
  });

  assert.deepEqual(result, { active: true });
  assert.deepEqual(JSON.parse(readFileSync(state.escalationPath, "utf8")), replacement);
  assert.equal(state.retryCalls(), 1);
  assert.match(state.logs[0], /failure-reason=escalation-state-changed/u);
});

test("an already removed identical marker is treated as cleared without re-escalation", async (t) => {
  const state = fixture(t);

  const result = await checkExistingEscalation({
    ...state.options,
    readRemoteMain: async () => {
      unlinkSync(state.escalationPath);
      return revision;
    },
  });

  assert.deepEqual(result, { active: false, revision });
  assert.equal(state.retryCalls(), 0);
  assert.deepEqual(state.logs, []);
});

test("an escalation of another class stays latched without a remote read", async (t) => {
  const state = fixture(t, {
    reason: "remote-main-corrupt-response",
    escalatedAt: "2026-08-30T15:00:00.000Z",
  });
  let readCalls = 0;

  const result = await checkExistingEscalation({
    ...state.options,
    readRemoteMain: async () => { readCalls += 1; return revision; },
  });

  assert.deepEqual(result, { active: true });
  assert.equal(readCalls, 0);
  assert.equal(existsSync(state.escalationPath), true);
  assert.equal(state.retryCalls(), 1);
});

test("two startup invocations serialize clearing to one audit with no replacement marker", async (t) => {
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
  const checkEscalation = () => checkExistingEscalation({
    ...state.options,
    readRemoteMain: async () => {
      signalReadStarted();
      await readReleased;
      return revision;
    },
  });
  const options = {
    acquireLock,
    log: state.options.log,
    checkEscalation,
    readRemoteMain: async () => assert.fail("the clearing read should supply the target"),
    persistFailure: async () => assert.fail("a successful clear must not persist a failure"),
  };

  const first = resolveRemoteMainTarget(options);
  await readStarted;
  const second = await resolveRemoteMainTarget(options);
  releaseRead();
  const firstResult = await first;

  assert.deepEqual(firstResult, { targetCommit: revision });
  assert.deepEqual(second, { ok: true, skipped: "lock-held" });
  assert.equal(existsSync(state.escalationPath), false);
  assert.equal(state.logs.filter((line) => line.startsWith("AUDIT escalation-auto-cleared")).length, 1);
  assert.equal(state.logs.filter((line) => line.startsWith("SKIP concurrent-run")).length, 1);
});
