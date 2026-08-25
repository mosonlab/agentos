import { MergeRecoveryStatus, type Prisma } from "@prisma/client";

import {
  DIRECT_INTEGRATOR_TEMPLATE_NAME,
  INTEGRATOR_TEMPLATE_NAME,
  LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME,
  LEGACY_INTEGRATOR_TEMPLATE_NAME,
} from "./merge-integrator.js";

export const MERGE_TAIL_SCHEMA_VERSION = 1;
export const MERGE_READINESS_OUTPUT_KIND = "merge-authorization";
export const DIRECT_MERGE_READINESS_STEP_INDEX = 7;
export const MERGE_READINESS_STEP_INDEX = 12;
export const LEGACY_DIRECT_MERGE_READINESS_STEP_INDEX = 6;
export const LEGACY_MERGE_READINESS_STEP_INDEX = 11;
export const MERGE_TAIL_KIND = {
  baseDriftRecovery: "mergeTail.baseDriftRecovery",
  regression: "mergeTail.regression",
  repairAttempt: "mergeTail.repairAttempt",
  repairResult: "mergeTail.repairResult",
  reviewObligation: "mergeTail.reviewObligation",
  operatorDecision: "mergeTail.operatorDecision",
  readiness: "mergeTail.readiness",
} as const;

export const MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES = 2;
export const MAX_BASE_DRIFT_CLASSIFICATION_RETRIES = 30;

export type MergeRecoveryPhase =
  | "validation"
  | "repair"
  | "authorization-wait"
  | "downstream-stop"
  | "succeeded"
  | "actual-failure";

const RECOVERY_TRANSITIONS: Record<MergeRecoveryStatus, ReadonlySet<MergeRecoveryStatus>> = {
  [MergeRecoveryStatus.VALIDATING]: new Set([MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.FAILED]),
  [MergeRecoveryStatus.REPAIRING]: new Set([
    MergeRecoveryStatus.AWAITING_AUTHORIZATION,
    MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
  ]),
  [MergeRecoveryStatus.AWAITING_AUTHORIZATION]: new Set([
    MergeRecoveryStatus.REPAIRING,
    MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
    MergeRecoveryStatus.SUCCEEDED,
  ]),
  [MergeRecoveryStatus.BLOCKED_DOWNSTREAM]: new Set(),
  [MergeRecoveryStatus.SUCCEEDED]: new Set(),
  [MergeRecoveryStatus.FAILED]: new Set(),
};

export const mergeRecoveryTransitionAllowed = (
  from: MergeRecoveryStatus,
  to: MergeRecoveryStatus,
): boolean => from === to || RECOVERY_TRANSITIONS[from].has(to);

export const mergeRecoveryPhase = (status: MergeRecoveryStatus): MergeRecoveryPhase => (
  status === MergeRecoveryStatus.VALIDATING ? "validation"
    : status === MergeRecoveryStatus.REPAIRING ? "repair"
      : status === MergeRecoveryStatus.AWAITING_AUTHORIZATION ? "authorization-wait"
        : status === MergeRecoveryStatus.BLOCKED_DOWNSTREAM ? "downstream-stop"
          : status === MergeRecoveryStatus.SUCCEEDED ? "succeeded"
            : "actual-failure"
);

const SHA = /^[0-9a-f]{40}$/u;

export type RegressionVerdict =
  | { schemaVersion: 1; outcome: "pass"; headSha: string; baseHeadSha: string; gateVerdict: "PASS" }
  | { schemaVersion: 1; outcome: "review-fail"; headSha: string; baseHeadSha: string; summary: string }
  | { schemaVersion: 1; outcome: "gate-fail"; headSha: string; baseHeadSha: string; gateVerdict: "FAIL"; summary: string }
  | { schemaVersion: 1; outcome: "refresh-conflict"; headSha: string; baseHeadSha: string; summary: string };

export type RegressionRepairHandoff = {
  schemaVersion: 1;
  trigger:
    | { kind: "regression-verdict"; verdict: Exclude<RegressionVerdict, { outcome: "pass" }> }
    | {
      kind: "independent-review-rejection";
      verdict: Extract<RegressionVerdict, { outcome: "pass" }>;
      review: {
        taskId: string;
        headSha: string;
        baseHeadSha: string;
        summary: string;
        outputKind: string;
        outputBody: string;
      };
    };
  repair: {
    kind: "review-fix" | "gate-fix" | "refresh-conflict";
    taskId: string;
    startHeadSha: string;
    targetHeadSha: string;
    resolvedHeadSha: string;
    outputKind: string;
    outputBody: string;
  };
  retry?: {
    previousRunId: string;
    startHeadSha: string;
  };
};

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
  if (value.outcome === "review-fail" && typeof value.summary === "string" && value.summary.trim().length > 0) {
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
  return (name === DIRECT_INTEGRATOR_TEMPLATE_NAME && step.stepIndex === DIRECT_MERGE_READINESS_STEP_INDEX)
    || (name === INTEGRATOR_TEMPLATE_NAME && step.stepIndex === MERGE_READINESS_STEP_INDEX)
    || (name === LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME && step.stepIndex === LEGACY_DIRECT_MERGE_READINESS_STEP_INDEX)
    || (name === LEGACY_INTEGRATOR_TEMPLATE_NAME && step.stepIndex === LEGACY_MERGE_READINESS_STEP_INDEX);
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
