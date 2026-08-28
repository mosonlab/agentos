import assert from "node:assert/strict";
import { test } from "node:test";

import {
  migrationColumns,
  migrationFailureOutput,
  migrationHarnessEnabled,
  migrationQuery,
  migrationSnapshot,
  retiredFollowUpColumn,
  stageBeforeChainLayerExpand,
} from "./chain-layer-migration-fixture.js";

/**
 * The chain-layer EXPAND migration: the dense ranking it performs, and the two
 * preflights that must abort it before a row changes.
 *
 * Split out of migration.dbtest.ts, unchanged. See the sibling contract file.
 */

test("chain-layer expand migration dense-ranks legacy template steps and chain nodes", {
  skip: !migrationHarnessEnabled,
}, async () => {
  const fixture = stageBeforeChainLayerExpand();
  try {
    fixture.execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('chain-layer-project', 'chain-layer-project', 'chain-layer-project', NOW());
      INSERT INTO "TaskTemplate" ("id", "projectId", "name", "description", "variables", "updatedAt")
      VALUES ('chain-layer-template', 'chain-layer-project', 'legacy-template', 'legacy', ARRAY[]::text[], NOW());
      INSERT INTO "TaskTemplateStep" ("id", "taskTemplateId", "stepIndex", "name", "assigneeType", "prompt")
      VALUES
        ('chain-layer-step-09', 'chain-layer-template', 9, 'step 9', 'agent', 'prompt'),
        ('chain-layer-step-40', 'chain-layer-template', 40, 'step 40', 'agent', 'prompt'),
        ('chain-layer-step-90', 'chain-layer-template', 90, 'step 90', 'agent', 'prompt');
      INSERT INTO "Task" ("id", "projectId", "name", "description", "chainId", "chainIndex", "updatedAt")
      VALUES
        ('chain-layer-task-08', 'chain-layer-project', 'task 8', 'task', 'legacy-chain', 8, NOW()),
        ('chain-layer-task-40', 'chain-layer-project', 'task 40', 'task', 'legacy-chain', 40, NOW()),
        ('chain-layer-task-90', 'chain-layer-project', 'task 90', 'task', 'legacy-chain', 90, NOW());
    `);

    fixture.applyExpandMigration();

    assert.deepEqual(
      await migrationQuery<{ stepIndex: number; layer: number | null }>(fixture,
        'SELECT "stepIndex", "layer" FROM "TaskTemplateStep" ORDER BY "stepIndex"'),
      [
        { stepIndex: 9, layer: 1 },
        { stepIndex: 40, layer: 2 },
        { stepIndex: 90, layer: 3 },
      ],
    );
    assert.deepEqual(
      await migrationQuery<{ chainIndex: number; chainLayer: number | null }>(fixture,
        'SELECT "chainIndex", "chainLayer" FROM "Task" WHERE "chainId" = \'legacy-chain\' ORDER BY "chainIndex"'),
      [
        { chainIndex: 8, chainLayer: 1 },
        { chainIndex: 40, chainLayer: 2 },
        { chainIndex: 90, chainLayer: 3 },
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

test("partial chain identity aborts expand before changing rows", {
  skip: !migrationHarnessEnabled,
}, async () => {
  const fixture = stageBeforeChainLayerExpand();
  try {
    fixture.execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('partial-project', 'partial-project', 'partial-project', NOW());
      INSERT INTO "Task" ("id", "projectId", "name", "description", "chainId", "updatedAt")
      VALUES ('partial-task', 'partial-project', 'partial', 'partial', 'partial-chain', NOW());
    `);
    const before = await migrationSnapshot(fixture);
    let error: unknown;
    try {
      fixture.applyExpandMigration();
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, "the partial-chain preflight must fail");
    assert.match(migrationFailureOutput(error), /chain-layer-expand: partial-chain-identity/u);
    assert.deepEqual(await migrationSnapshot(fixture), before);
    assert.deepEqual(await migrationColumns(fixture), []);
  } finally {
    fixture.cleanup();
  }
});

test("inconsistent follow-up relationship aborts expand before changing rows", {
  skip: !migrationHarnessEnabled,
}, async () => {
  const fixture = stageBeforeChainLayerExpand();
  try {
    fixture.execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('follow-up-project', 'follow-up-project', 'follow-up-project', NOW());
      INSERT INTO "Task" ("id", "projectId", "name", "description", "chainId", "chainIndex", "updatedAt")
      VALUES ('follow-up-target', 'follow-up-project', 'target', 'target', 'chain-b', 2, NOW());
      INSERT INTO "Task" ("id", "projectId", "name", "description", "chainId", "chainIndex", "${retiredFollowUpColumn}", "updatedAt")
      VALUES ('follow-up-source', 'follow-up-project', 'source', 'source', 'chain-a', 1, 'follow-up-target', NOW());
    `);
    const before = await migrationSnapshot(fixture);
    let error: unknown;
    try {
      fixture.applyExpandMigration();
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, "the follow-up consistency preflight must fail");
    assert.match(migrationFailureOutput(error), /chain-layer-expand: inconsistent-follow-up-relationship/u);
    assert.deepEqual(await migrationSnapshot(fixture), before);
    assert.deepEqual(await migrationColumns(fixture), []);
  } finally {
    fixture.cleanup();
  }
});
