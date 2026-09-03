/**
 * The forged-merge chain, end to end.
 *
 * Merge authority in this system is not "whoever merged on GitHub" — it is
 * whoever managed to persist a `merge-result` output saying `merged` and then
 * complete the mechanical run. The control plane does not re-verify that claim
 * against GitHub; it advances the chain (§4.0). So the whole of the authority
 * rests on *who is allowed to write that pair*, and the review of PR #130 found
 * the pair was reachable from the fleet-wide RUNNER_TOKEN: the claim route
 * matched the executor allowlist against `runnerId` from the request body, a
 * value the caller writes about itself.
 *
 * These tests walk the complete attack — claim as the executor with a plain
 * runner bearer, obtain a session credential, forge the output, complete — and
 * assert it is refused at every link, plus a positive control so the refusal is
 * demonstrably not "nothing works".
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  enqueueTaskRun,
  INTEGRATOR_OUTPUT_KIND,
  PrismaClient,
  TaskStatus,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import { seedIntegratorChain, type IntegratorChain } from "./merge-integrator-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-forgery";
const RUNNER = "runner-forgery";
const EXECUTOR_TOKEN = "merge-executor-token-forgery";
const EXECUTOR_RUNNER = "merge-executor-1";
const IMPOSTOR_RUNNER = "runner-7";

const withTokens = async <T>(body: () => Promise<T>): Promise<T> => {
  const prior = [
    ["OPERATOR_TOKEN", process.env.OPERATOR_TOKEN],
    ["RUNNER_TOKEN", process.env.RUNNER_TOKEN],
    ["MERGE_EXECUTOR_TOKEN", process.env.MERGE_EXECUTOR_TOKEN],
    ["MERGE_EXECUTOR_RUNNER_IDS", process.env.MERGE_EXECUTOR_RUNNER_IDS],
  ] as const;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  process.env.MERGE_EXECUTOR_TOKEN = EXECUTOR_TOKEN;
  process.env.MERGE_EXECUTOR_RUNNER_IDS = EXECUTOR_RUNNER;
  try {
    return await body();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

const call = async (
  method: string, path: string, token: string, body?: unknown,
): Promise<{ status: number; body: any }> => withTokens(async () => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) as any };
});

const queueIntegratorRun = async (chain: IntegratorChain): Promise<string> => {
  await db.task.update({ where: { id: chain.integratorTask!.id }, data: { status: TaskStatus.TODO } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as any, chain.integratorTask!.id));
  return (run as { id: string }).id;
};

const MERGED = JSON.stringify({ outcome: "merged", mergeCommitSha: "0".repeat(40) });

const completion = (runnerId: string, fencingToken: string) => ({
  runnerId, fencingToken, exitCode: 0, outcome: { case: "succeeded" },
  cleanupStatus: "SUCCEEDED",
});

test("a plain runner bearer cannot claim the mechanical run by naming the executor id", async () => {
  const chain = await seedIntegratorChain(db, { label: "forge-claim" });
  const runId = await queueIntegratorRun(chain);

  // Link 1 of the chain, and the one that used to succeed: the impostor holds
  // only RUNNER_TOKEN and simply writes the publicly configured executor id
  // into the body. Authority now comes from the bearer, so it is offered
  // nothing — and, crucially, is issued no session credential.
  const forged = await call("POST", "/runner/tasks/claim", RUNNER, {
    runnerId: EXECUTOR_RUNNER,
    contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
  });
  assert.equal(forged.status, 204, JSON.stringify(forged.body));

  const run = await db.run.findUniqueOrThrow({
    where: { id: runId }, select: { status: true, runnerId: true, sessionTokenHash: true },
  });
  assert.equal(run.status, "QUEUED");
  assert.equal(run.runnerId, null);
  assert.equal(run.sessionTokenHash, null);
});

test("a session credential held under a non-executor runner id cannot author a merge-result", async () => {
  const chain = await seedIntegratorChain(db, { label: "forge-output" });
  const runId = await queueIntegratorRun(chain);
  // The world as it would be if link 1 had succeeded: the impostor holds a
  // valid, unexpired session token and fencing token for the mechanical run.
  // The output route is a second, independent gate on the same identity fact,
  // so the forged `merge-result` is refused even from inside that session.
  const { sessionToken, fencingToken } = await forceClaim(runId, IMPOSTOR_RUNNER);

  const forged = await call("PUT", `/session/runs/${runId}/output`, sessionToken, {
    fencingToken, kind: INTEGRATOR_OUTPUT_KIND, body: MERGED,
  });
  assert.equal(forged.status, 403, JSON.stringify(forged.body));
  assert.equal(await db.taskStepOutput.count({ where: { taskId: chain.integratorTask!.id } }), 0);
});

test("completing a mechanical run is refused to every principal but the executor", async () => {
  const chain = await seedIntegratorChain(db, { label: "forge-complete" });
  const runId = await queueIntegratorRun(chain);
  const { fencingToken } = await forceClaim(runId, EXECUTOR_RUNNER);
  // Link 3 on its own: even with the correct runner id and a live fencing
  // token, the completion that advances the chain is bound to the executor's
  // credential. A leaked fencing token in a runner process buys nothing.
  const forged = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER, completion(EXECUTOR_RUNNER, fencingToken),
  );
  assert.equal(forged.status, 403, JSON.stringify(forged.body));
  const task = await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id }, select: { status: true } });
  assert.equal(task.status, TaskStatus.DOING);
});

test("the executor credential completes nothing but mechanical runs", async () => {
  const chain = await seedIntegratorChain(db, { label: "forge-ordinary" });
  // The other direction of §D-P1 rule 3 at the completion surface: an executor
  // credential that wandered onto an ordinary run must not finish it either.
  const run = await db.run.findUniqueOrThrow({ where: { id: chain.gateRun.id } });
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", runnerId: EXECUTOR_RUNNER, fencingToken: "fence-ordinary",
    leaseExpiresAt: new Date(Date.now() + 600_000), leaseGeneration: 1,
  } });
  const refused = await call(
    "POST", `/runner/runs/${run.id}/complete`, EXECUTOR_TOKEN, completion(EXECUTOR_RUNNER, "fence-ordinary"),
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
});

test("positive control: the executor's own credential claims, writes and completes, and the chain advances", async () => {
  const chain = await seedIntegratorChain(db, { label: "forge-control" });
  const runId = await queueIntegratorRun(chain);

  const claimed = await call("POST", "/runner/tasks/claim", EXECUTOR_TOKEN, {
    runnerId: EXECUTOR_RUNNER,
    contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.run.id, runId);
  assert.equal(claimed.body.executionMode, "mechanical");

  const written = await call("PUT", `/session/runs/${runId}/output`, claimed.body.sessionToken, {
    fencingToken: claimed.body.fencingToken, kind: INTEGRATOR_OUTPUT_KIND, body: MERGED,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, EXECUTOR_TOKEN,
    completion(EXECUTOR_RUNNER, claimed.body.fencingToken),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, true);
  const task = await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id }, select: { status: true } });
  assert.equal(task.status, TaskStatus.DONE);
});

test("an executor token aliased onto the runner token authenticates no executor at all", async () => {
  const chain = await seedIntegratorChain(db, { label: "forge-alias" });
  await queueIntegratorRun(chain);
  const prior = process.env.MERGE_EXECUTOR_TOKEN;
  try {
    // A deployment that "configures" the executor by reusing RUNNER_TOKEN has
    // configured nothing: the aliased value mints a runner principal, which is
    // offered no mechanical run. Misconfiguration stalls; it does not merge.
    await withTokens(async () => {
      process.env.MERGE_EXECUTOR_TOKEN = RUNNER;
      const response = await createApp(db).request("/runner/tasks/claim", {
        method: "POST",
        headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
        body: JSON.stringify({ runnerId: EXECUTOR_RUNNER, contractVersion: RUN_COMPLETION_CONTRACT_VERSION }),
      });
      assert.equal(response.status, 204);
    });
  } finally {
    if (prior === undefined) delete process.env.MERGE_EXECUTOR_TOKEN;
    else process.env.MERGE_EXECUTOR_TOKEN = prior;
  }
});

/**
 * Puts a queued run into the state a successful claim would leave, without
 * going through the claim route — the point of these tests is to gate the
 * *later* links independently, so they must be reachable even when link 1 holds.
 */
const forceClaim = async (
  runId: string, runnerId: string,
): Promise<{ sessionToken: string; fencingToken: string }> => {
  const { hashToken } = await import("./auth.js");
  const sessionToken = `agos_session_forced_${runId}`;
  const fencingToken = `fence-${runId}`;
  const now = new Date();
  await db.run.update({ where: { id: runId }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseGeneration: 1,
    leaseExpiresAt: new Date(now.getTime() + 600_000),
    sessionTokenHash: hashToken(sessionToken),
    sessionTokenExpiresAt: new Date(now.getTime() + 600_000),
    sessionTokenRevokedAt: null,
    claimedAt: now, heartbeatAt: now,
  } });
  await db.task.update({ where: { id: (await db.run.findUniqueOrThrow({ where: { id: runId }, select: { taskId: true } })).taskId! }, data: { status: TaskStatus.DOING } });
  return { sessionToken, fencingToken };
};
