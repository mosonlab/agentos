import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, type PrismaClient } from "@agentos/db";

import { claimRun } from "./run-claim.js";
import { SPEC_TRANSCRIPTION_REFUSAL_REASON } from "./specification-fidelity.js";

/**
 * The retry loop, which was untestable while it was welded to the route: it
 * only ever ran with a real Serializable transaction underneath it, so the
 * behaviour it exists for — a lost conflict is not a claim failure — could not
 * be observed without provoking a real conflict.
 *
 * `$transaction` is the only thing these tests stub. The transaction body
 * never runs, which is the point: what is under test is what the module does
 * with a transaction that lost.
 */

const conflict = (code: string, sqlstate?: string) => new Prisma.PrismaClientKnownRequestError(
  "serialization failure",
  { code, clientVersion: "test", ...(sqlstate ? { meta: { code: sqlstate } } : {}) },
);

const dbThatFails = (errors: unknown[]) => {
  let attempts = 0;
  const db = {
    $transaction: async () => {
      attempts += 1;
      const error = errors[attempts - 1];
      if (error) throw error;
      return null;
    },
  } as unknown as PrismaClient;
  return { db, attempts: () => attempts };
};

const input = {
  body: { runnerId: "runner-1", leaseSeconds: 60 },
  claimantClass: "runner" as const,
  now: new Date("2026-08-26T00:00:00.000Z"),
};

test("a lost serialization conflict is retried rather than surfaced", async () => {
  const { db, attempts } = dbThatFails([conflict("P2034")]);
  assert.equal(await claimRun(db, input), null);
  assert.equal(attempts(), 2);
});

test("a raw-statement conflict arrives as P2010 and is retried too", async () => {
  const { db, attempts } = dbThatFails([conflict("P2010", "40001")]);
  assert.equal(await claimRun(db, input), null);
  assert.equal(attempts(), 2);
});

test("six attempts is the ceiling; the sixth loss is thrown", async () => {
  const { db, attempts } = dbThatFails(Array.from({ length: 6 }, () => conflict("P2034")));
  await assert.rejects(claimRun(db, input), (error: unknown) => (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"
  ));
  assert.equal(attempts(), 6);
});

test("an error that is not a serialization conflict is not retried", async () => {
  const { db, attempts } = dbThatFails([new Error("boom")]);
  await assert.rejects(claimRun(db, input), /boom/);
  assert.equal(attempts(), 1);
});

test("a tampered direct review specification is refused before the claim CAS", async () => {
  const implementationHeadSha = "b".repeat(40);
  const implementationBaseSha = "a".repeat(40);
  const candidate = {
    id: "review-run",
    projectId: "project-1",
    repoId: "repo-1",
    agentId: "agent-1",
    runner: "CODEX",
    runNumber: 1,
    status: "QUEUED",
    readyAt: new Date("2026-08-26T00:00:00.000Z"),
    createdAt: new Date("2026-08-26T00:00:00.000Z"),
    leaseGeneration: 0,
    targetBranch: implementationHeadSha,
    branch: "feature/spec-check",
    maxDurationMin: 60,
    stallTimeoutMin: 10,
    session: null,
    task: {
      id: "review-task",
      projectId: "project-1",
      repoId: "repo-1",
      templateId: "template-1",
      templateStepId: "step-2",
      chainId: "chain-1",
      chainIndex: 2,
      chainLayer: 2,
      status: "TODO",
      archivedAt: null,
      assigneeType: "AGENT",
      targetBranch: implementationHeadSha,
      description: "review prompt\nFeature brief:\nreview brief\nPersist the final sol-findings output for this step through the AgentOS task output endpoint.",
      templateStep: {
        stepIndex: 2,
        outputKind: "sol-findings",
        baseFromStepIndex: 1,
        attachmentsFromPrevious: true,
        taskTemplate: { name: "direct-engineer-workflow" },
      },
    },
    repo: { id: "repo-1", remoteUrl: "https://github.com/acme/repo.git", defaultBranch: "main" },
    agent: {
      name: "review-agent",
      archivedAt: null,
      repoAccess: [{ repoId: "repo-1", projectId: "project-1" }],
      environment: { secrets: [] },
      secretGrants: [],
    },
  };
  const calls: Array<{ repository: string; path: string; commitSha: string }> = [];
  const tx = {
    $queryRaw: async () => [{ granted: true }],
    run: { findMany: async () => [candidate] },
    runnerBackendState: { findUnique: async () => null },
    taskStepOutput: {
      findFirst: async () => ({
        kind: "implementation",
        body: JSON.stringify({ schemaVersion: 1, baseSha: implementationBaseSha, headSha: implementationHeadSha }),
        commitSha: implementationHeadSha,
      }),
    },
    task: { findFirst: async () => ({ description: "implementation prompt\nFeature brief:\nauthoritative brief\nPersist the final implementation output for this step through the AgentOS task output endpoint." }) },
  };
  const db = {
    $transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  const result = await claimRun(db, {
    ...input,
    specificationReader: {
      readFileAtCommit: async (repository, path, commitSha) => {
        calls.push({ repository, path, commitSha });
        return new TextEncoder().encode("tampered brief");
      },
    },
  });
  assert.ok(result && "error" in result);
  assert.match(result.error, new RegExp(SPEC_TRANSCRIPTION_REFUSAL_REASON, "u"));
  assert.deepEqual(calls, [{
    repository: "acme/repo",
    path: ".chain/feature/spec-check/spec.md",
    commitSha: implementationHeadSha,
  }]);
});
