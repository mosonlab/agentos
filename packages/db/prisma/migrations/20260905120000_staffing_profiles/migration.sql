-- Staffing profiles, and the canonical Agent identity they name.
--
-- Two changes that cannot be separated. A named plan per TaskTemplate says who
-- runs each step and which optional steps a chain instantiated from it keeps,
-- replacing the project-wide `Project.skipOptionalSteps` switch, which could
-- only say "every optional step, everywhere in this project". A profile entry
-- names an Agent row, and canonical identity moves in the same release from
-- the operator-editable `Agent.name` to `Agent.canonicalRole` — with the
-- canonical slugs themselves changing to role-model-effort. The rename happens
-- in place: ids are preserved, so every Task, Run, Session, TaskTemplateStep
-- and cost row keeps pointing at the same Agent.
--
-- Backfills and column drops share one migration on purpose (precedent:
-- 20260826180000_merge_gate_attestation): the retired switch and the retired
-- flag are the only sources for what replaces them, so each must be read
-- before it is dropped.

-- 1. The profile tables ------------------------------------------------------

CREATE TABLE "StaffingProfile" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "taskTemplateId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StaffingProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StaffingProfileEntry" (
  "profileId" TEXT NOT NULL,
  "outputKind" TEXT NOT NULL,
  "assigneeAgentId" TEXT,
  "include" BOOLEAN,

  CONSTRAINT "StaffingProfileEntry_pkey" PRIMARY KEY ("profileId","outputKind")
);

CREATE INDEX "StaffingProfile_projectId_idx" ON "StaffingProfile"("projectId");

CREATE INDEX "StaffingProfile_taskTemplateId_idx" ON "StaffingProfile"("taskTemplateId");

CREATE UNIQUE INDEX "StaffingProfile_taskTemplateId_name_key" ON "StaffingProfile"("taskTemplateId", "name");

CREATE INDEX "StaffingProfileEntry_assigneeAgentId_idx" ON "StaffingProfileEntry"("assigneeAgentId");

ALTER TABLE "StaffingProfile"
  ADD CONSTRAINT "StaffingProfile_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StaffingProfile"
  ADD CONSTRAINT "StaffingProfile_taskTemplateId_fkey"
  FOREIGN KEY ("taskTemplateId") REFERENCES "TaskTemplate"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StaffingProfileEntry"
  ADD CONSTRAINT "StaffingProfileEntry_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "StaffingProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not SET NULL: an operator's staffing decision must not quietly
-- become "fall back to the canonical assignee" because an Agent row was
-- deleted. Archive is refused separately, by the API, with the profile list.
ALTER TABLE "StaffingProfileEntry"
  ADD CONSTRAINT "StaffingProfileEntry_assigneeAgentId_fkey"
  FOREIGN KEY ("assigneeAgentId") REFERENCES "Agent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. The canonical Agent columns ---------------------------------------------

ALTER TABLE "Agent" ADD COLUMN "canonicalRole" TEXT;
ALTER TABLE "Agent" ADD COLUMN "customizedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 3. Backfill both from what they replace ------------------------------------

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

-- 4. Refuse before renaming anything -----------------------------------------

-- A target slug already taken in the same project by a different row is a
-- migration error: silently skipping it would leave canonicalRole naming a role
-- file whose name the row does not carry, and canonical sync would then adopt
-- across two rows. The whole inventory is checked before the first rename, so a
-- refused upgrade leaves every name as it found it.
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
  END LOOP;
END $$;

-- 5. Rename the canonical rows in place --------------------------------------

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
BEGIN
  FOREACH rename SLICE 1 IN ARRAY renames LOOP
    UPDATE "Agent"
    SET "name" = rename[2], "canonicalRole" = rename[2]
    WHERE "name" = rename[1] AND "canonicalRole" = rename[1];
  END LOOP;
END $$;

CREATE UNIQUE INDEX "Agent_projectId_canonicalRole_key" ON "Agent"("projectId", "canonicalRole");

-- 6. One default profile per existing template row ---------------------------

-- Canonical, legacy or custom alike. The id is derived from the template id so
-- the backfill needs no cuid generator inside SQL and stays unique without one.
INSERT INTO "StaffingProfile" ("id", "projectId", "taskTemplateId", "name", "isDefault", "createdAt", "updatedAt")
SELECT 'staffing_' || template."id", template."projectId", template."id", 'Default', true, NOW(), NOW()
FROM "TaskTemplate" AS template;

-- Entries key on the step's exact outputKind. `DISTINCT ON` keeps the lowest
-- stepIndex for a kind: authoring forbids duplicate kinds, but a row written
-- before that validator existed must still produce one entry rather than fail
-- the whole upgrade here. `include` is null for a step the template does not
-- mark optional; for an optional step it is the inverse of the project switch
-- being retired, so a project that skipped optional steps keeps skipping them.
INSERT INTO "StaffingProfileEntry" ("profileId", "outputKind", "assigneeAgentId", "include")
SELECT DISTINCT ON (profile."id", step."outputKind")
  profile."id",
  step."outputKind",
  step."assigneeAgentId",
  CASE WHEN step."optional" THEN NOT project."skipOptionalSteps" ELSE NULL END
FROM "TaskTemplateStep" AS step
JOIN "StaffingProfile" AS profile ON profile."taskTemplateId" = step."taskTemplateId"
JOIN "TaskTemplate" AS template ON template."id" = step."taskTemplateId"
JOIN "Project" AS project ON project."id" = template."projectId"
ORDER BY profile."id", step."outputKind", step."stepIndex";

-- 7. Drop what the two backfills replaced ------------------------------------

ALTER TABLE "Project" DROP COLUMN "skipOptionalSteps";

ALTER TABLE "Agent" DROP COLUMN "runtimeConfigCustomized";
