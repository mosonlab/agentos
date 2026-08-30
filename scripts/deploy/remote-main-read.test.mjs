import assert from "node:assert/strict";
import test from "node:test";

import {
  autoClearTransientRemoteMainEscalation,
  readRemoteMainRevision,
} from "./remote-main-read.mjs";

const revision = "b".repeat(40);
const transientFailure = {
  code: 128,
  stdout: "",
  stderr: "fatal: unable to access remote: Failed to connect to 127.0.0.1 port 443",
};

test("a transient remote-main flap recovers inside the retry budget without escalation", async () => {
  const results = [transientFailure, {
    code: 0,
    stdout: `${revision}\trefs/heads/main\n`,
    stderr: "",
  }];
  const retries = [];
  const waits = [];

  const actual = await readRemoteMainRevision({
    run: async () => results.shift(),
    delaysMs: [2_000, 5_000],
    wait: async (milliseconds) => { waits.push(milliseconds); },
    onRetry: (retry) => { retries.push(retry); },
  });

  assert.equal(actual, revision);
  assert.deepEqual(waits, [2_000]);
  assert.deepEqual(retries.map(({ reason, attempt, nextAttempt, waitMs }) => ({
    reason,
    attempt,
    nextAttempt,
    waitMs,
  })), [{ reason: "remote-main-unreadable", attempt: 1, nextAttempt: 2, waitMs: 2_000 }]);
});

test("a transient remote-main flap past the retry budget escalates", async () => {
  let attempts = 0;
  const retries = [];

  await assert.rejects(
    readRemoteMainRevision({
      run: async () => { attempts += 1; return transientFailure; },
      delaysMs: [2_000, 5_000],
      wait: async () => undefined,
      onRetry: (retry) => { retries.push(retry); },
    }),
    (error) => error?.reason === "remote-main-unreadable"
      && error?.detail === "exit-128",
  );

  assert.equal(attempts, 3);
  assert.equal(retries.length, 2);
});

test("authentication and malformed successful reads are never transient", async () => {
  const cases = [
    {
      result: { code: 128, stdout: "", stderr: "fatal: Authentication failed for remote" },
      reason: "remote-main-auth-failed",
    },
    {
      result: { code: 0, stdout: "not-a-revision\trefs/heads/main\n", stderr: "" },
      reason: "remote-main-corrupt-response",
    },
  ];

  for (const { result, reason } of cases) {
    let attempts = 0;
    await assert.rejects(
      readRemoteMainRevision({
        run: async () => { attempts += 1; return result; },
        delaysMs: [2_000, 5_000],
        wait: async () => assert.fail("non-transient reads must not back off"),
      }),
      (error) => error?.reason === reason,
    );
    assert.equal(attempts, 1);
  }
});

test("a latched transient escalation self-clears after a successful clearing read", async () => {
  const audit = [];
  let clearCalls = 0;
  const escalation = {
    reason: "remote-main-unreadable",
    escalatedAt: "2026-08-30T15:00:00.000Z",
  };

  const result = await autoClearTransientRemoteMainEscalation({
    escalation,
    readRemoteMain: async () => revision,
    clear: async () => { clearCalls += 1; },
    audit: (entry) => { audit.push(entry); },
    now: () => new Date("2026-08-30T15:05:00.000Z"),
  });

  assert.deepEqual(result, { cleared: true, revision });
  assert.equal(clearCalls, 1);
  assert.deepEqual(audit, [
    `AUDIT escalation-auto-cleared escalation=remote-main-unreadable failed-window=2026-08-30T15:00:00.000Z..2026-08-30T15:05:00.000Z clearing-read=${revision}`,
  ]);
});

test("corruption-class escalations never self-clear", async () => {
  let readCalls = 0;
  let clearCalls = 0;
  const audit = [];

  const result = await autoClearTransientRemoteMainEscalation({
    escalation: {
      reason: "remote-main-corrupt-response",
      escalatedAt: "2026-08-30T15:00:00.000Z",
    },
    readRemoteMain: async () => { readCalls += 1; return revision; },
    clear: async () => { clearCalls += 1; },
    audit: (entry) => { audit.push(entry); },
  });

  assert.deepEqual(result, { cleared: false });
  assert.equal(readCalls, 0);
  assert.equal(clearCalls, 0);
  assert.deepEqual(audit, []);
});

test("a corrupt clearing read leaves a latched transient escalation untouched", async () => {
  let clearCalls = 0;
  await assert.rejects(
    autoClearTransientRemoteMainEscalation({
      escalation: {
        reason: "remote-main-unreadable",
        escalatedAt: "2026-08-30T15:00:00.000Z",
      },
      readRemoteMain: async () => readRemoteMainRevision({
        run: async () => ({ code: 0, stdout: "invalid\n", stderr: "" }),
      }),
      clear: async () => { clearCalls += 1; },
      audit: () => assert.fail("a failed clearing read must not be audited as cleared"),
    }),
    (error) => error?.reason === "remote-main-corrupt-response",
  );
  assert.equal(clearCalls, 0);
});

test("a transient marker without a valid failed window stays latched", async () => {
  let readCalls = 0;
  const result = await autoClearTransientRemoteMainEscalation({
    escalation: { reason: "remote-main-unreadable", escalatedAt: "invalid" },
    readRemoteMain: async () => { readCalls += 1; return revision; },
    clear: async () => assert.fail("an unauditable escalation must not clear"),
    audit: () => assert.fail("an unauditable escalation must not emit a clear audit"),
  });
  assert.deepEqual(result, { cleared: false });
  assert.equal(readCalls, 0);
});
