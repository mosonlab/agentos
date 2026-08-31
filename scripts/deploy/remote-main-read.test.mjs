import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRemoteMainResult,
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

test("SSH timeout and reset failures remain transient despite git's generic footer", async () => {
  const diagnostics = [
    "ssh: connect to host github.com port 22: Operation timed out\nfatal: Could not read from remote repository.\n",
    "Connection reset by 140.82.114.4 port 22\nfatal: Could not read from remote repository.\n",
  ];

  for (const stderr of diagnostics) {
    const result = { code: 128, stdout: "", stderr };
    assert.equal(classifyRemoteMainResult(result).failure?.reason, "remote-main-unreadable");
    let attempts = 0;
    await assert.rejects(
      readRemoteMainRevision({
        run: async () => { attempts += 1; return result; },
        delaysMs: [2_000, 5_000],
        wait: async () => undefined,
      }),
      (error) => error?.reason === "remote-main-unreadable",
    );
    assert.equal(attempts, 3);
  }
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
