import type { Prisma } from "@prisma/client";

export const MERGE_TAIL_SCHEMA_VERSION = 1;
export const MERGE_READINESS_OUTPUT_KIND = "merge-authorization";
export const MERGE_TAIL_KIND = {
  regression: "mergeTail.regression",
  repairAttempt: "mergeTail.repairAttempt",
  repairResult: "mergeTail.repairResult",
  reviewObligation: "mergeTail.reviewObligation",
  readiness: "mergeTail.readiness",
} as const;

const SHA = /^[0-9a-f]{40}$/u;

export type RegressionVerdict =
  | { schemaVersion: 1; outcome: "pass"; headSha: string; baseHeadSha: string; gateVerdict: "PASS" }
  | { schemaVersion: 1; outcome: "gate-fail"; headSha: string; baseHeadSha: string; gateVerdict: "FAIL"; summary: string }
  | { schemaVersion: 1; outcome: "refresh-conflict"; headSha: string; baseHeadSha: string; summary: string };

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
  "packages/api/src/app.ts",
  "agents/roles/merge-resolver.md",
  "agents/roles/merge-integrator.md",
]);

export const defenseListReason = (path: string): string | null => {
  if (DEFENSE_EXACT.has(path)) return "merge-tail-machinery";
  if (path.startsWith("scripts/gate-worker/")) return "gate-worker";
  if (path.startsWith("packages/db/prisma/migrations/")) return "database-migration";
  if (path.startsWith("packages/merge-executor/")) return "merge-execution";
  if (path.startsWith("agents/templates/direct-engineer-workflow/")
    || path.startsWith("agents/templates/compound-engineer-workflow/")) return "template-step-set";
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (/^release-authority(?:\.|$)/u.test(basename)) return "release-authority";
  return null;
};

export type ChangedFile = { filename: string; patch: string | null };

export const isTestPath = (path: string): boolean => (
  /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/u.test(path)
  || /\.(?:dbtest|test|spec)\.[^.]+$/u.test(path)
);

export const patchModifiesExistingLines = (patch: string | null): boolean => {
  if (patch === null) return true;
  return patch.split("\n").some((line) => line.startsWith("-") && !line.startsWith("---"));
};

export const defenseTriggers = (files: ChangedFile[]): Array<{ path: string; reason: string }> => files.flatMap((file) => {
  const reason = defenseListReason(file.filename);
  return reason ? [{ path: file.filename, reason }] : [];
});

export const resolutionTestTriggers = (files: ChangedFile[]): Array<{ path: string; reason: string }> => files.flatMap((file) => (
  isTestPath(file.filename) && patchModifiesExistingLines(file.patch)
    ? [{ path: file.filename, reason: file.patch === null ? "existing-test-lines-unverifiable" : "existing-test-lines-modified" }]
    : []
));

export const asJsonObject = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
);
