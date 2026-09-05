-- Staffing profiles. A named plan per TaskTemplate says who runs each step and
-- which optional steps a chain instantiated from it keeps. It replaces the
-- project-wide `Project.skipOptionalSteps` switch, which could only say "every
-- optional step, everywhere in this project".
--
-- The backfill and the column drop share one migration on purpose (precedent:
-- 20260826180000_merge_gate_attestation): the per-project switch is the only
-- source for the `include` flags, so it must be read before it is dropped.

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

-- One default profile per existing template row, canonical, legacy or custom.
-- The id is derived from the template id so the backfill needs no cuid
-- generator inside SQL and stays unique without one.
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

ALTER TABLE "Project" DROP COLUMN "skipOptionalSteps";
