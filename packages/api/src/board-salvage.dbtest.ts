import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, RunStatus, TaskStatus } from "@anneal/db";

import { readBoard } from "./board.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
let sequence = 0;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const BASE = "a".repeat(40);
const OTHER_BASE = "b".repeat(40);

const seedTask = async (options: {
  lost?: boolean;
  laterBaseSha?: string | null;
} = {}) => {
  const suffix = `${process.pid}-${sequence++}`;
  const project = await db.project.create({ data: {
    name: "Board salvage",
    slug: `board-salvage-${suffix}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "local",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `agent-${suffix}`,
    title: "Agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id,
    name: "Show stranded salvage",
    description: "board projection fixture",
    assigneeType: "HUMAN",
    status: TaskStatus.TODO,
  } });
  if (options.lost !== false) {
    await db.run.create({ data: {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      runNumber: 1,
      dedupeKey: `board-salvage:${task.id}:run:1`,
      runner: "CODEX",
      status: RunStatus.LOST,
      model: "claude",
      pushedBranch: "agentos/salvage/run-1",
      baseSha: BASE,
    } });
  }
  if (options.laterBaseSha !== null) {
    await db.run.create({ data: {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      runNumber: 2,
      dedupeKey: `board-salvage:${task.id}:run:2`,
      runner: "CODEX",
      status: RunStatus.QUEUED,
      model: "claude",
      baseSha: options.laterBaseSha ?? BASE,
    } });
  }
  return { project, task };
};

const projectedSalvages = async (projectId: string) => {
  const cards = await readBoard(db, { projectId, archived: "false" });
  assert.equal(cards.length, 1);
  return cards[0]!.strandedSalvageBranches;
};

test("a later Run on the LOST base projects its stranded salvage branch", async () => {
  const { project } = await seedTask({ laterBaseSha: BASE });
  assert.deepEqual(await projectedSalvages(project.id), [{
    branch: "agentos/salvage/run-1",
    lostRunNumber: 1,
  }]);
});

test("a later Run on a different base does not strand the salvage branch", async () => {
  const { project } = await seedTask({ laterBaseSha: OTHER_BASE });
  assert.deepEqual(await projectedSalvages(project.id), []);
});

test("a Task without a LOST Run projects an empty stranded-salvage list", async () => {
  const { project } = await seedTask({ lost: false, laterBaseSha: BASE });
  assert.deepEqual(await projectedSalvages(project.id), []);
});
