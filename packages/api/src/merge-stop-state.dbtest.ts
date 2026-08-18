/**
 * §4.0, §D-P5, §D-P7 and §D-P8 — the control plane's half of the contract.
 *
 * What these tests are really about is exclusivity. A stop is not a status; it
 * is a state the chain cannot leave except through an answer with a terminal
 * disposition, and the interesting cases are the ones where an answer exists
 * and the chain still must not move.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  applyInboxDecisionTx,
  enqueueTaskRun,
  MERGE_INTEGRATOR_KIND,
  parseStopAnswerMetadata,
  PrismaClient,
} from "@agentos/db";

import { seedIntegratorChain, type IntegratorChain } from "./merge-integrator-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-stop-state";
const RUNNER = "runner-stop-state";

const call = async (method: string, path: string, body?: unknown, token = OPERATOR): Promise<{ status: number; body: any }> => {
  const priorOperator = process.env.OPERATOR_TOKEN;
  const priorRunner = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  try {
    const response = await createApp(db).request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  } finally {
    if (priorOperator === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorOperator;
    if (priorRunner === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = priorRunner;
  }
};

/** A live step-10 run the merge executor would be holding. */
const liveIntegratorRun = async (chain: IntegratorChain, runNumber = 1, maxRuns = 5) => {
  const run = await db.run.create({ data: {
    projectId: chain.project.id, taskId: chain.integratorTask!.id, agentId: chain.integratorAgent.id,
    repoId: chain.repo.id, runNumber, dedupeKey: `task:${chain.integratorTask!.id}:run:${runNumber}`,
    runner: "CLAUDE", model: "mechanical/merge-executor-v1", promptHash: "mechanical", status: "RUNNING",
    opensPullRequest: false, runnerId: "merge-executor-1", maxRunsPerTask: maxRuns,
    fencingToken: `1:${chain.integratorTask!.id}:${runNumber}`, leaseExpiresAt: new Date(Date.now() + 600_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: chain.project.id, agentId: chain.integratorAgent.id,
    taskId: chain.integratorTask!.id, runner: "CLAUDE", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: chain.integratorTask!.id }, data: { status: "DOING" } });
  return run;
};

const completeRun = async (run: { id: string; fencingToken: string | null }, overrides: Record<string, unknown> = {}) =>
  call("POST", `/runner/runs/${run.id}/complete`, {
    runnerId: "merge-executor-1", fencingToken: run.fencingToken, exitCode: 0,
    terminalEventSeen: true, terminalSuccess: true, cleanupStatus: "SUCCEEDED", ...overrides,
  }, RUNNER);

/** What the executor writes before it completes: the fenced merge-result output. */
const persistOutcome = async (taskId: string, runId: string, body: string) => {
  await db.taskStepOutput.upsert({
    where: { taskId }, create: { taskId, runId, kind: "merge-result", body }, update: { runId, body },
  });
};

const stopQuestionFor = async (taskId: string) =>
  db.inboxMessage.findFirst({ where: { taskId, status: "OPEN", kind: "MULTIPLE_CHOICE" }, orderBy: { createdAt: "desc" } });

const stoppedChain = async (label: string, condition = "head-drift") => {
  const chain = await seedIntegratorChain(db, { label });
  const run = await liveIntegratorRun(chain);
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({
    outcome: "stopped", condition, evidence: "authorized head a…, live head c…",
  }));
  assert.equal((await completeRun(run)).status, 200);
  return { chain, run };
};

test("N16 a recorded stop lands the stop state: run SUCCEEDED, task REVIEW, question open, no chain advance", async () => {
  const { chain, run } = await stoppedChain("n16");
  // Protocol-level success: the executor executed its contract exactly. The
  // deviation is in the outcome, not in the run.
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, "SUCCEEDED");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "REVIEW");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  assert.ok(question, "a stop question is open");
  assert.deepEqual((question!.choices as Array<{ id: string }>).map((choice) => choice.id), ["re-authorize", "abandon"]);
  const activities = await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } });
  assert.equal(activities.filter((row) => (row.metadata as any)?.kind === MERGE_INTEGRATOR_KIND.result).length, 1);
  assert.equal(activities.filter((row) => row.body.includes("Chain complete")).length, 0);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1, "no automatic retry");
});

test("Y1 the append-only stop history survives an output replacement", async () => {
  const { chain, run } = await stoppedChain("y1");
  // A later write replaces the single output row; the guard reads history, not
  // the replaceable latest view, so the stop cannot be erased by overwriting it.
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({ outcome: "merged", mergeCommitSha: "d".repeat(40) }));
  const patched = await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "DONE" });
  assert.equal(patched.status, 409);
  assert.match(patched.body.error, /head-drift/u);
});

test("N18 an absent, wrong-kind or unparseable output lands missing-or-malformed-result, synthesizing nothing", async () => {
  for (const [label, prepare] of [
    ["absent", async () => {}],
    ["wrong-kind", async (taskId: string, runId: string) => {
      await db.taskStepOutput.create({ data: { taskId, runId, kind: "result", body: "done" } });
    }],
    ["unparseable", async (taskId: string, runId: string) => {
      await persistOutcome(taskId, runId, "the merge went fine, trust me");
    }],
  ] as const) {
    const chain = await seedIntegratorChain(db, { label: `n18-${label}` });
    const run = await liveIntegratorRun(chain);
    await prepare(chain.integratorTask!.id, run.id);
    assert.equal((await completeRun(run, { output: "Run finished" })).status, 200, label);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "REVIEW", label);
    const stop = (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
      .find((row) => (row.metadata as any)?.kind === MERGE_INTEGRATOR_KIND.result);
    assert.equal((stop!.metadata as any).condition, "missing-or-malformed-result", label);
    const output = await db.taskStepOutput.findUnique({ where: { taskId: chain.integratorTask!.id } });
    // X3: the control plane never writes "Run N completed successfully." onto a
    // merge step, because that body would read as a merge that never happened.
    assert.ok(!output || !output.body.includes("completed successfully"), label);
  }
});

test("a merged outcome advances the chain and lands DONE", async () => {
  const chain = await seedIntegratorChain(db, { label: "merged" });
  const run = await liveIntegratorRun(chain);
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({ outcome: "merged", mergeCommitSha: "e".repeat(40) }));
  assert.equal((await completeRun(run)).status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "DONE");
  assert.equal(await stopQuestionFor(chain.integratorTask!.id), null);
});

test("N19 no generic exit from a stop: PATCH, retry and enqueue are all refused", async () => {
  const { chain } = await stoppedChain("n19");
  assert.equal((await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "DONE" })).status, 409);
  assert.equal((await call("POST", `/tasks/${chain.integratorTask!.id}/retry`)).status, 409);
  await assert.rejects(
    db.$transaction((tx) => enqueueTaskRun(tx, chain.integratorTask!.id)),
    /stopped on head-drift/u,
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "REVIEW");
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
});

test("N19 flag-incident is not an exit: the guard holds and the promised later choices are actually offered", async () => {
  const { chain } = await stoppedChain("n19-incident", "changed-underneath-me");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  assert.deepEqual(
    (question!.choices as Array<{ id: string }>).map((choice) => choice.id),
    ["accept-foreign-merge", "flag-incident"],
  );
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-flag", decision: "flag-incident",
  }));
  const answer = (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
    .map((row) => parseStopAnswerMetadata(row.metadata)).find(Boolean);
  assert.equal(answer!.disposition, "nonterminal");

  // C3: an answer exists, and every generic exit is still refused.
  assert.equal((await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "DONE" })).status, 409);
  assert.equal((await call("POST", `/tasks/${chain.integratorTask!.id}/retry`)).status, 409);
  const followUp = await stopQuestionFor(chain.integratorTask!.id);
  assert.ok(followUp && followUp.id !== question!.id, "a fresh follow-up question exists");
  assert.deepEqual(
    (followUp!.choices as Array<{ id: string }>).map((choice) => choice.id),
    ["accept-foreign-merge", "abandon"],
  );
  // A replayed identical answer changes nothing.
  const replay = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-flag-2", decision: "flag-incident",
  }));
  assert.equal(replay.duplicate, true);

  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: followUp!.id, externalEventId: "evt-accept", decision: "accept-foreign-merge",
  }));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "DONE");
  // And only now does an ordinary route work again.
  assert.equal((await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "REVIEW" })).status, 200);
});

test("N19 abandon closes the chain with the abandonment explicit, never as a delivery", async () => {
  const { chain } = await stoppedChain("n19-abandon");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-abandon", decision: "abandon",
  }));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "DONE");
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: chain.integratorTask!.id } });
  assert.match(output.body, /abandoned/iu);
  assert.match(output.body, /No merge was performed/iu);
  const completion = (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
    .find((row) => row.body.includes("abandoned"));
  assert.ok(completion, "the completion activity names the abandonment");
});

test("N19 re-authorize creates no run and writes no authorization; it asks for evidence first", async () => {
  const { chain } = await stoppedChain("n19-reauth");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-reauth", decision: "re-authorize",
  }));
  // C2 in the control plane: the answer to a stop is a *request* for evidence,
  // not an authorization. Nothing runs until the human reads the new card.
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
  const authorizations = (await db.taskActivity.findMany({ where: { taskId: chain.gateTask.id } }))
    .filter((row) => (row.metadata as any)?.kind === MERGE_INTEGRATOR_KIND.authorization);
  assert.equal(authorizations.length, 0);
  const confirmation = await db.inboxMessage.findFirst({
    where: { gateTaskId: chain.gateTask.id, status: "OPEN" }, orderBy: { createdAt: "desc" },
  });
  assert.ok(confirmation, "a fresh confirmation card was requested");
  const requests = (await db.taskActivity.findMany({ where: { taskId: chain.gateTask.id } }))
    .filter((row) => (row.metadata as any)?.purpose === "confirmation");
  assert.equal(requests.length, 1);
  // The guard is still in force: refresh-requested is not terminal.
  assert.equal((await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "DONE" })).status, 409);
});

test("N20 an external failure at the ceiling buys an integrator step no extra run", async () => {
  const chain = await seedIntegratorChain(db, { label: "n20-external" });
  const run = await liveIntegratorRun(chain, 5, 5);
  const completion = await completeRun(run, {
    exitCode: 1, terminalSuccess: false, terminalEventSeen: false, externalFailure: true,
    failureClass: "TRANSIENT_PROVIDER", retryable: true, failureReason: "network",
  });
  assert.equal(completion.status, 200);
  // §D-P5: the automatic path may not raise the ceiling, so no run 6 exists and
  // the row's own ceiling is unchanged.
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).maxRunsPerTask, 5);
});

test("N20 an ordinary task's external-failure compensation is unchanged", async () => {
  const chain = await seedIntegratorChain(db, { label: "n20-ordinary" });
  const run = await db.run.create({ data: {
    projectId: chain.project.id, taskId: chain.gateTask.id, agentId: chain.agent.id, repoId: chain.repo.id,
    runNumber: 5, dedupeKey: `task:${chain.gateTask.id}:run:5`, runner: "CLAUDE", model: "claude-opus-5:high",
    promptHash: "hash", status: "RUNNING", runnerId: "merge-executor-1", maxRunsPerTask: 5,
    fencingToken: `1:${chain.gateTask.id}:5`, leaseExpiresAt: new Date(Date.now() + 600_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: chain.project.id, agentId: chain.agent.id, taskId: chain.gateTask.id,
    runner: "CLAUDE", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: chain.gateTask.id }, data: { status: "DOING" } });
  const completion = await completeRun(run, {
    exitCode: 1, terminalSuccess: false, terminalEventSeen: false, externalFailure: true,
    failureClass: "TRANSIENT_PROVIDER", retryable: true, failureReason: "network",
  });
  assert.equal(completion.status, 200);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).maxRunsPerTask, 6);
});

test("N22 the repair path: a correction bounded by the chain's own delivered pull requests", async () => {
  const chain = await seedIntegratorChain(db, { label: "n22-repair", prNumbers: [10, 11] });
  const run = await liveIntegratorRun(chain);
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({
    outcome: "stopped", condition: "target-unresolvable", evidence: "observed 10, 11",
  }));
  await completeRun(run);
  const question = await stopQuestionFor(chain.integratorTask!.id);
  // MF-8: re-authorize is not offered, because it could not change the run rows
  // the target is derived from.
  assert.deepEqual(
    (question!.choices as Array<{ id: string }>).map((choice) => choice.id),
    ["open-repair", "abandon"],
  );
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-repair", decision: "open-repair",
  }));

  const foreign = await call("POST", `/tasks/${chain.integratorTask!.id}/merge-target`, { prNumber: 999 });
  assert.equal(foreign.status, 409);
  assert.match(foreign.body.error, /not among this chain/u);
  assert.equal(
    (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
      .filter((row) => (row.metadata as any)?.kind === MERGE_INTEGRATOR_KIND.targetCorrection).length,
    0,
    "a refused correction writes no record",
  );

  const accepted = await call("POST", `/tasks/${chain.integratorTask!.id}/merge-target`, { prNumber: 11 });
  assert.equal(accepted.status, 201);
  assert.deepEqual(accepted.body.observed, [10, 11]);
  assert.ok(accepted.body.confirmationCardId, "the repair asks for a confirmation card");
  assert.equal(
    (await db.inboxMessage.findUniqueOrThrow({ where: { id: accepted.body.confirmationCardId } })).status,
    "OPEN",
  );
  // The guard is still in force until that card is approved.
  assert.equal((await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "DONE" })).status, 409);
});

test("N22 a chain that delivered no pull request is told so, and abandon is the exit", async () => {
  const chain = await seedIntegratorChain(db, { label: "n22-empty" });
  await db.run.updateMany({ where: { taskId: chain.gateTask.id }, data: { pullRequestNumber: null } });
  const run = await liveIntegratorRun(chain);
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({
    outcome: "stopped", condition: "target-unresolvable", evidence: "observed none",
  }));
  await completeRun(run);
  const refused = await call("POST", `/tasks/${chain.integratorTask!.id}/merge-target`, { prNumber: 7 });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /delivered no pull request/u);
  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-empty-abandon", decision: "abandon",
  }));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "DONE");
});
