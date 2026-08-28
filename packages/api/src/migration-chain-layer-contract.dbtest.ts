import assert from "node:assert/strict";
import { test } from "node:test";

import {
  migrationColumns,
  migrationFailureOutput,
  migrationHarnessEnabled,
  migrationQuery,
  migrationSnapshot,
  retiredFollowUpColumn,
  retiredFollowUpIndex,
  stageBeforeChainLayerExpand,
} from "./chain-layer-migration-fixture.js";

/**
 * The chain-layer CONTRACT migration: what it keeps, and what it refuses.
 *
 * Split out of migration.dbtest.ts, unchanged. Both tests replay the real
 * migration history before they start, which is why they are the two most
 * expensive proofs in the suite; in their own file they run beside the expand
 * tests instead of after them.
 */

test("contract migration preserves a consistent legacy chain and removes follow-ups", {
  skip: !migrationHarnessEnabled,
}, async () => {
  const fixture = stageBeforeChainLayerExpand();
  try {
    fixture.execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('contract-project', 'contract-project', 'contract-project', NOW());
      INSERT INTO "TaskTemplate" ("id", "projectId", "name", "description", "variables", "updatedAt")
      VALUES ('contract-template', 'contract-project', 'legacy-template', 'legacy', ARRAY[]::text[], NOW());
      INSERT INTO "TaskTemplateStep" ("id", "taskTemplateId", "stepIndex", "name", "assigneeType", "prompt")
      VALUES ('contract-step-1', 'contract-template', 1, 'step 1', 'agent', 'prompt 1'),
             ('contract-step-2', 'contract-template', 2, 'step 2', 'agent', 'prompt 2');
      INSERT INTO "Task" ("id", "projectId", "name", "description", "chainId", "chainIndex", "updatedAt")
      VALUES ('contract-task-1', 'contract-project', 'task 1', 'task 1', 'contract-chain', 1, NOW()),
             ('contract-task-2', 'contract-project', 'task 2', 'task 2', 'contract-chain', 2, NOW());
      UPDATE "Task" SET "${retiredFollowUpColumn}" = 'contract-task-2' WHERE "id" = 'contract-task-1';
    `);
    fixture.applyExpandMigration();
    fixture.applyContractMigration();

    assert.deepEqual(
      await migrationQuery<{ stepIndex: number; layer: number }>(fixture,
        'SELECT "stepIndex", "layer" FROM "TaskTemplateStep" ORDER BY "stepIndex"'),
      [{ stepIndex: 1, layer: 1 }, { stepIndex: 2, layer: 2 }],
    );
    assert.deepEqual(
      await migrationQuery<{ chainIndex: number; chainLayer: number }>(fixture,
        'SELECT "chainIndex", "chainLayer" FROM "Task" WHERE "chainId" = \'contract-chain\' ORDER BY "chainIndex"'),
      [{ chainIndex: 1, chainLayer: 1 }, { chainIndex: 2, chainLayer: 2 }],
    );
    assert.deepEqual(await migrationColumns(fixture), ["chainLayer", "layer"]);
    assert.deepEqual(
      await migrationQuery<{ indexname: string }>(fixture,
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = '${retiredFollowUpIndex}'`),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});

test("contract migration refuses an inconsistent follow-up before tightening or dropping", {
  skip: !migrationHarnessEnabled,
}, async () => {
  const fixture = stageBeforeChainLayerExpand();
  try {
    fixture.execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('contract-fence-project', 'contract-fence-project', 'contract-fence-project', NOW());
      INSERT INTO "TaskTemplate" ("id", "projectId", "name", "description", "variables", "updatedAt")
      VALUES ('contract-fence-template', 'contract-fence-project', 'legacy-template', 'legacy', ARRAY[]::text[], NOW());
      INSERT INTO "TaskTemplateStep" ("id", "taskTemplateId", "stepIndex", "name", "assigneeType", "prompt")
      VALUES ('contract-fence-step', 'contract-fence-template', 1, 'step', 'agent', 'prompt');
      INSERT INTO "Task" ("id", "projectId", "name", "description", "chainId", "chainIndex", "updatedAt")
      VALUES ('contract-fence-source', 'contract-fence-project', 'source', 'source', 'contract-fence-chain', 1, NOW()),
             ('contract-fence-target', 'contract-fence-project', 'target', 'target', 'contract-fence-chain', 2, NOW());
    `);
    fixture.applyExpandMigration();
    // The expand fence has already run. Introduce a legacy inconsistency after
    // it so this test exercises the contract migration's second fence.
    fixture.execute(`UPDATE "Task" SET "${retiredFollowUpColumn}" = 'contract-fence-source' WHERE "id" = 'contract-fence-target';`);
    const before = await migrationSnapshot(fixture);
    let error: unknown;
    try {
      fixture.applyContractMigration();
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, "the contract follow-up consistency fence must fail");
    assert.match(migrationFailureOutput(error), /chain-layer-contract: inconsistent-follow-up-relationship/u);
    assert.deepEqual(await migrationSnapshot(fixture), before);
    assert.deepEqual(await migrationColumns(fixture), ["chainLayer", "layer"]);
    assert.deepEqual(
      await migrationQuery<{ is_nullable: string }>(fixture,
        `SELECT is_nullable FROM information_schema.columns WHERE table_schema = '${fixture.schema.replaceAll("'", "''")}' AND table_name = 'TaskTemplateStep' AND column_name = 'layer'`),
      [{ is_nullable: "YES" }],
    );
    assert.deepEqual(
      await migrationQuery<{ column_name: string }>(fixture,
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'Task' AND column_name = '${retiredFollowUpColumn}'`),
      [{ column_name: retiredFollowUpColumn }],
    );
  } finally {
    fixture.cleanup();
  }
});
