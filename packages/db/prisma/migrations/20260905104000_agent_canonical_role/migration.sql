-- Canonical identity moves from Agent.name to Agent.canonicalRole, and the
-- single runtimeConfigCustomized flag becomes a per-field list.
--
-- The canonical slugs themselves change in this release (role-model-effort),
-- so the rename happens here, in place: ids are preserved, and every Task,
-- Run, Session, TaskTemplateStep and cost row keeps pointing at the same row.
-- Only `name` and `canonicalRole` move.

ALTER TABLE "Agent" ADD COLUMN "canonicalRole" TEXT;
ALTER TABLE "Agent" ADD COLUMN "customizedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Only model and runnerPreference were ever markable, so no other field can be
-- known to be operator-edited; everything else is treated as uncustomized.
UPDATE "Agent"
SET "customizedFields" = ARRAY['model', 'runnerPreference']::TEXT[]
WHERE "runtimeConfigCustomized" = true;

-- Adopt the pre-rename canonical inventory as canonicalRole. A row whose name
-- is not in the inventory is operator-created and keeps a null canonicalRole.
UPDATE "Agent"
SET "canonicalRole" = "name"
WHERE "name" IN (
  'default',
  'frontend-dev',
  'implementation-plan-executioner',
  'librarian',
  'merge-integrator',
  'merge-resolver',
  'plan',
  'plan-reviser',
  'regression-verifier',
  'review-coordinator',
  'review-coordinator-opus',
  'review-coordinator-sol',
  'senior-dev',
  'senior-dev-astra-low',
  'senior-dev-luna',
  'senior-dev-opus',
  'senior-dev-sol',
  'spec',
  'spec-revalidator'
);

-- Rename the canonical rows to the new role-model-effort slugs. A target slug
-- already taken in the same project by a different row is a migration error:
-- silently skipping it would leave canonicalRole naming a role file whose name
-- the row does not carry, and canonical sync would then adopt across two rows.
DO $$
DECLARE
  renames CONSTANT TEXT[][] := ARRAY[
    ['plan', 'plan-fable-medium'],
    ['spec', 'spec-opus-high'],
    ['plan-reviser', 'plan-reviser-opus-high'],
    ['spec-revalidator', 'spec-revalidator-luna-xhigh'],
    ['review-coordinator', 'review-coordinator-astra-medium'],
    ['review-coordinator-sol', 'code-reviewer-sol-high'],
    ['review-coordinator-opus', 'code-reviewer-opus-high'],
    ['implementation-plan-executioner', 'plan-executor-astra-medium'],
    ['senior-dev', 'senior-dev-astra-medium'],
    ['senior-dev-luna', 'senior-dev-luna-max'],
    ['senior-dev-sol', 'senior-dev-sol-high'],
    ['senior-dev-opus', 'senior-dev-opus-medium'],
    ['frontend-dev', 'frontend-dev-opus-medium'],
    ['librarian', 'librarian-luna-xhigh'],
    ['regression-verifier', 'regression-verifier-luna-xhigh'],
    ['merge-resolver', 'merge-resolver-opus-medium']
  ];
  rename TEXT[];
  taken RECORD;
BEGIN
  FOREACH rename SLICE 1 IN ARRAY renames LOOP
    SELECT taken_agent."id", taken_agent."projectId" INTO taken
    FROM "Agent" AS taken_agent
    JOIN "Agent" AS canonical
      ON canonical."projectId" = taken_agent."projectId"
     AND canonical."canonicalRole" = rename[1]
    WHERE taken_agent."name" = rename[2]
      AND taken_agent."id" <> canonical."id"
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION
        'Agent slug % is already taken in project % by Agent %; rename or archive it before upgrading',
        rename[2], taken."projectId", taken."id";
    END IF;

    UPDATE "Agent"
    SET "name" = rename[2], "canonicalRole" = rename[2]
    WHERE "name" = rename[1] AND "canonicalRole" = rename[1];
  END LOOP;
END $$;

ALTER TABLE "Agent" DROP COLUMN "runtimeConfigCustomized";

CREATE UNIQUE INDEX "Agent_projectId_canonicalRole_key" ON "Agent"("projectId", "canonicalRole");
