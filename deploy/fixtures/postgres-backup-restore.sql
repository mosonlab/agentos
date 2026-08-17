\set ON_ERROR_STOP on
BEGIN;

INSERT INTO "Project" (
  id, name, slug, "yamlDocument", "maxDurationMin", "stallTimeoutMin",
  "maxSessionsPerTask", "spendCap", "createdAt", "updatedAt"
) VALUES (
  'ossd-project', 'OSS-D Fixture', 'ossd-fixture', 'synthetic: true',
  45, 7, 4, 12.34, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z'
);

INSERT INTO "Environment" (
  id, "projectId", name, networking, "allowedHosts", "createdAt", "updatedAt"
) VALUES (
  'ossd-environment', 'ossd-project', 'isolated', 'limited',
  ARRAY['fixture.invalid']::text[], '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z'
);

INSERT INTO "Agent" (
  id, "projectId", "environmentId", name, title, model,
  "foundationalPrompt", "rolePrompt", "runnerPreference", "inboxAccess",
  "disabledTools", "createdAt", "updatedAt"
) VALUES (
  'ossd-agent', 'ossd-project', 'ossd-environment', 'restore-verifier',
  'Restore Verifier', 'synthetic-model', 'fixture foundation', 'fixture role',
  'codex', true, ARRAY['web']::text[],
  '2026-08-17T00:00:01Z', '2026-08-17T00:00:01Z'
);

INSERT INTO "Task" (
  id, "projectId", "assigneeAgentId", name, description, "targetBranch",
  status, source, "assigneeType", "approvalGate", "opensPullRequest",
  "scheduleKind", "maxDurationMin", "stallTimeoutMin", "maxSessionsPerTask",
  "spendCapApplicable", "createdAt", "updatedAt"
) VALUES (
  'ossd-task', 'ossd-project', 'ossd-agent', 'Backup restore fixture',
  'Synthetic data used only by the OSS-D rehearsal', 'synthetic/restore',
  'review', 'manual', 'agent', false, false, 'once-now', 45, 7, 4, false,
  '2026-08-17T00:00:02Z', '2026-08-17T00:00:02Z'
);

INSERT INTO "Run" (
  id, "projectId", "taskId", "agentId", "runNumber", "dedupeKey", status,
  "readyAt", runner, "leaseGeneration", "workspaceRetained",
  "opensPullRequest", "targetBranch", branch, "pushedBranch", "pushStatus",
  model, "promptHash", "maxDurationMin", "stallTimeoutMin", "maxRunsPerTask",
  "spendCapApplicable", "queuedAt", "startedAt", "endedAt", "createdAt", "updatedAt"
) VALUES (
  'ossd-run', 'ossd-project', 'ossd-task', 'ossd-agent', 1,
  'ossd-fixture-run', 'succeeded', '2026-08-17T00:00:03Z', 'codex', 0, false,
  false, 'synthetic/restore', 'synthetic/restore', 'synthetic/restore', 'succeeded',
  'synthetic-model', 'ossd-prompt-hash', 45, 7, 4, false,
  '2026-08-17T00:00:03Z', '2026-08-17T00:00:04Z', '2026-08-17T00:00:05Z',
  '2026-08-17T00:00:03Z', '2026-08-17T00:00:05Z'
);

INSERT INTO "InboxMessage" (
  id, "from", "agentId", "taskId", kind, body, choices,
  "selectedChoiceId", status, channel, "deliveryStatus", "deliveryAttempts",
  "nextDeliveryAt", "deliveredAt", "createdAt", "answeredAt"
) VALUES (
  'ossd-inbox', 'agent', 'ossd-agent', 'ossd-task', 'multiple-choice',
  'Synthetic restore survived?', '[{"id":"yes","label":"Yes"}]'::jsonb,
  'yes', 'answered', 'feishu', 'delivered', 1,
  '2026-08-17T00:00:06Z', '2026-08-17T00:00:06Z',
  '2026-08-17T00:00:06Z', '2026-08-17T00:00:07Z'
);

COMMIT;
