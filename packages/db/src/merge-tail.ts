import type { Prisma } from "@prisma/client";

export const MERGE_TAIL_SCHEMA_VERSION = 1;
export const MERGE_READINESS_OUTPUT_KIND = "merge-authorization";
export const MERGE_TAIL_KIND = {
  baseDriftRecovery: "mergeTail.baseDriftRecovery",
  regression: "mergeTail.regression",
  repairAttempt: "mergeTail.repairAttempt",
  repairResult: "mergeTail.repairResult",
  reviewObligation: "mergeTail.reviewObligation",
  readiness: "mergeTail.readiness",
} as const;

export const MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES = 2;
export const MAX_BASE_DRIFT_CLASSIFICATION_RETRIES = 30;

const SHA = /^[0-9a-f]{40}$/u;

export type BaseDriftRecoveryIdentity = {
  integratorTaskId: string;
  sourceStopId: string;
};

export type BaseDriftRecoveryContext = BaseDriftRecoveryIdentity & {
  kind: typeof MERGE_TAIL_KIND.baseDriftRecovery;
  schemaVersion: typeof MERGE_TAIL_SCHEMA_VERSION;
  attempt: number;
  sourceRunId: string;
  authorizationActivityId: string;
  repository: string;
  prNumber: number;
  targetBranch: string;
  authorizedHeadSha: string;
  authorizedBaseSha: string;
  observedBaseSha: string;
  currentBaseSha: string;
  readinessTaskId: string;
  regressionTaskId: string;
};

export type BaseDriftRecoveryMetadata =
  | (BaseDriftRecoveryContext & { state: "queued"; recoveryRunId: string })
  | (BaseDriftRecoveryContext & {
      state: "tail-stopped";
      recoveryRunId: string;
      phase: "regression" | "independent-review";
      reason: string;
      dedupeKey: string;
    })
  | (BaseDriftRecoveryContext & { state: "exhausted"; reason: string })
  | (BaseDriftRecoveryIdentity & {
      kind: typeof MERGE_TAIL_KIND.baseDriftRecovery;
      schemaVersion: typeof MERGE_TAIL_SCHEMA_VERSION;
      state: "ineligible";
      reason: string;
    })
  | (BaseDriftRecoveryIdentity & {
      kind: typeof MERGE_TAIL_KIND.baseDriftRecovery;
      schemaVersion: typeof MERGE_TAIL_SCHEMA_VERSION;
      state: "classification-retry";
      reason: string;
      classificationAttempt: number;
    });

export type BaseDriftRecoveryActivity = {
  taskId: string;
  actorType: string;
  metadata: Prisma.JsonValue | null;
};

export type BaseDriftRecoveryExpectation = Partial<{
  activityTaskId: string;
  integratorTaskId: string;
  regressionTaskId: string;
  sourceStopId: string;
  recoveryRunId: string;
}>;

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const positiveInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0;

/**
 * The sole parser for the server-owned automatic base-drift recovery contract.
 * A metadata discriminator is not authority: provenance, the activity's real
 * task, and every state-specific identity binding are checked together.
 */
export const parseBaseDriftRecoveryActivity = (
  row: BaseDriftRecoveryActivity,
  expected: BaseDriftRecoveryExpectation = {},
): BaseDriftRecoveryMetadata | null => {
  if (row.actorType !== "control-plane") return null;
  if (expected.activityTaskId !== undefined && row.taskId !== expected.activityTaskId) return null;
  const value = asJsonObject(row.metadata);
  if (!value || value.kind !== MERGE_TAIL_KIND.baseDriftRecovery
    || value.schemaVersion !== MERGE_TAIL_SCHEMA_VERSION
    || !nonempty(value.integratorTaskId) || !nonempty(value.sourceStopId)) return null;
  if (expected.integratorTaskId !== undefined && value.integratorTaskId !== expected.integratorTaskId) return null;
  if (expected.sourceStopId !== undefined && value.sourceStopId !== expected.sourceStopId) return null;

  if (value.state === "ineligible") {
    return nonempty(value.reason) ? value as BaseDriftRecoveryMetadata : null;
  }
  if (value.state === "classification-retry") {
    return nonempty(value.reason) && positiveInteger(value.classificationAttempt)
      ? value as BaseDriftRecoveryMetadata
      : null;
  }

  if (!positiveInteger(value.attempt)
    || !nonempty(value.sourceRunId) || !nonempty(value.authorizationActivityId)
    || !nonempty(value.repository) || !positiveInteger(value.prNumber)
    || !nonempty(value.targetBranch)
    || typeof value.authorizedHeadSha !== "string" || !SHA.test(value.authorizedHeadSha)
    || typeof value.authorizedBaseSha !== "string" || !SHA.test(value.authorizedBaseSha)
    || typeof value.observedBaseSha !== "string" || !SHA.test(value.observedBaseSha)
    || typeof value.currentBaseSha !== "string" || !SHA.test(value.currentBaseSha)
    || !nonempty(value.readinessTaskId) || !nonempty(value.regressionTaskId)) return null;
  if (expected.regressionTaskId !== undefined && value.regressionTaskId !== expected.regressionTaskId) return null;

  if (value.state === "exhausted") {
    return nonempty(value.reason) ? value as BaseDriftRecoveryMetadata : null;
  }
  if ((value.state !== "queued" && value.state !== "tail-stopped") || !nonempty(value.recoveryRunId)) return null;
  if (expected.recoveryRunId !== undefined && value.recoveryRunId !== expected.recoveryRunId) return null;
  if (value.state === "queued") return value as BaseDriftRecoveryMetadata;
  return (value.phase === "regression" || value.phase === "independent-review")
    && nonempty(value.reason) && nonempty(value.dedupeKey)
    ? value as BaseDriftRecoveryMetadata
    : null;
};

export type RegressionVerdict =
  | { schemaVersion: 1; outcome: "pass"; headSha: string; baseHeadSha: string; gateVerdict: "PASS" }
  | { schemaVersion: 1; outcome: "gate-fail"; headSha: string; baseHeadSha: string; gateVerdict: "FAIL"; summary: string }
  | { schemaVersion: 1; outcome: "refresh-conflict"; headSha: string; baseHeadSha: string; summary: string };

export type ResolverResult =
  | { schemaVersion: 1; outcome: "resolved"; startHeadSha: string; targetHeadSha: string; resolvedHeadSha: string; tradeOffs: string[]; changedTestExpectations: string[] }
  | { schemaVersion: 1; outcome: "unable"; startHeadSha: string; targetHeadSha: string; blockingContradiction: string };

export type RegressionParse =
  | { status: "ok"; verdict: RegressionVerdict }
  | { status: "invalid"; reason: string };

export const parseRegressionVerdict = (body: string | null | undefined): RegressionParse => {
  if (!body) return { status: "invalid", reason: "missing regression output" };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { status: "invalid", reason: "regression output is not JSON" }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", reason: "regression output is not an object" };
  }
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== MERGE_TAIL_SCHEMA_VERSION) return { status: "invalid", reason: "unsupported regression schemaVersion" };
  if (typeof value.headSha !== "string" || !SHA.test(value.headSha)) return { status: "invalid", reason: "invalid regression headSha" };
  if (typeof value.baseHeadSha !== "string" || !SHA.test(value.baseHeadSha)) return { status: "invalid", reason: "invalid regression baseHeadSha" };
  if (value.outcome === "pass" && value.gateVerdict === "PASS") {
    return { status: "ok", verdict: value as RegressionVerdict };
  }
  if (value.outcome === "gate-fail" && value.gateVerdict === "FAIL" && typeof value.summary === "string" && value.summary.length > 0) {
    return { status: "ok", verdict: value as RegressionVerdict };
  }
  if (value.outcome === "refresh-conflict" && typeof value.summary === "string" && value.summary.length > 0) {
    return { status: "ok", verdict: value as RegressionVerdict };
  }
  return { status: "invalid", reason: "regression outcome and gateVerdict disagree or required summary is absent" };
};

export const parseResolverResult = (
  body: string | null | undefined,
): { status: "ok"; result: ResolverResult } | { status: "invalid"; reason: string } => {
  let value: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(body ?? "null") as unknown;
    value = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return { status: "invalid", reason: "merge-resolver output is not valid JSON" };
  }
  if (!value || value.schemaVersion !== 1 || (value.outcome !== "resolved" && value.outcome !== "unable")) {
    return { status: "invalid", reason: "merge-resolver output has an unknown schema or outcome" };
  }
  if (typeof value.startHeadSha !== "string" || !SHA.test(value.startHeadSha)
    || typeof value.targetHeadSha !== "string" || !SHA.test(value.targetHeadSha)) {
    return { status: "invalid", reason: "merge-resolver output is not bound to well-formed start and target heads" };
  }
  if (value.outcome === "unable") {
    if (typeof value.blockingContradiction !== "string" || value.blockingContradiction.trim().length === 0) {
      return { status: "invalid", reason: "merge-resolver unable output has no blocking contradiction" };
    }
    return { status: "ok", result: value as ResolverResult };
  }
  if (typeof value.resolvedHeadSha !== "string" || !SHA.test(value.resolvedHeadSha)
    || !Array.isArray(value.tradeOffs) || !value.tradeOffs.every((entry) => typeof entry === "string")
    || !Array.isArray(value.changedTestExpectations) || !value.changedTestExpectations.every((entry) => typeof entry === "string")) {
    return { status: "invalid", reason: "merge-resolver resolved output is malformed or has no resolved head" };
  }
  return { status: "ok", result: value as ResolverResult };
};

export type MergeReadinessStepShape = {
  stepIndex: number;
  outputKind: string;
  taskTemplate?: { name: string } | null;
  taskTemplateName?: string | null;
} | null | undefined;

export const isMergeReadinessStep = (step: MergeReadinessStepShape): boolean => {
  if (!step || step.outputKind !== MERGE_READINESS_OUTPUT_KIND) return false;
  const name = step.taskTemplate?.name ?? step.taskTemplateName ?? null;
  return (name === "direct-engineer-workflow" && step.stepIndex === 6)
    || (name === "compound-engineer-workflow" && step.stepIndex === 11);
};

const DEFENSE_EXACT = new Set([
  "scripts/merge-gate.sh",
  "packages/db/src/workflow.ts",
  "packages/db/src/merge-integrator.ts",
  "packages/db/src/merge-integrator-db.ts",
  "packages/db/src/merge-tail.ts",
  "packages/db/src/template-sources.ts",
  "packages/db/src/agent-contract.ts",
  "packages/db/prisma/seed.ts",
  "packages/db/prisma/sync-canonical-prompts.ts",
  "packages/api/src/merge-readiness-worker.ts",
  "packages/api/src/github-read.ts",
  "packages/api/src/index.ts",
  "packages/api/src/app.ts",
  "agents/roles/merge-resolver.md",
  "agents/roles/merge-integrator.md",
]);

export const defenseListReason = (path: string): string | null => {
  if (DEFENSE_EXACT.has(path)) return "merge-tail-machinery";
  if (path.startsWith("packages/api/src/merge-")) return "merge-tail-machinery";
  if (path.startsWith("scripts/gate-worker/")) return "gate-worker";
  if (path.startsWith("packages/db/prisma/migrations/")) return "database-migration";
  if (path.startsWith("packages/merge-executor/")) return "merge-execution";
  if (path.startsWith("agents/templates/direct-engineer-workflow/")
    || path.startsWith("agents/templates/compound-engineer-workflow/")) return "template-step-set";
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (/^release-authority(?:\.|$)/u.test(basename)) return "release-authority";
  return null;
};

export type ChangedFile = { filename: string; previousFilename: string | null; patch: string | null };

export const isTestPath = (path: string): boolean => (
  /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/u.test(path)
  || /(?:\.(?:dbtest|test|spec)|-test)\.[^.]+$/u.test(path)
);

export const patchModifiesExistingLines = (patch: string | null): boolean => {
  if (patch === null) return true;
  return patch.split("\n").some((line) => line.startsWith("-") && !line.startsWith("---"));
};

export const defenseTriggers = (files: ChangedFile[]): Array<{ path: string; reason: string }> => files.flatMap((file) => {
  const paths = file.previousFilename && file.previousFilename !== file.filename
    ? [file.filename, file.previousFilename]
    : [file.filename];
  return paths.flatMap((path) => {
    const reason = defenseListReason(path);
    return reason ? [{ path, reason }] : [];
  });
});

export const resolutionTestTriggers = (files: ChangedFile[]): Array<{ path: string; reason: string }> => files.flatMap((file) => {
  const paths = file.previousFilename && file.previousFilename !== file.filename
    ? [file.filename, file.previousFilename]
    : [file.filename];
  return paths.flatMap((path) => (
    isTestPath(path) && patchModifiesExistingLines(file.patch)
      ? [{ path, reason: file.patch === null ? "existing-test-lines-unverifiable" : "existing-test-lines-modified" }]
      : []
  ));
});

export const asJsonObject = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
);
