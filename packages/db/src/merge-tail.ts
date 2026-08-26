import { MergeRecoveryStatus, type Prisma } from "@prisma/client";

import {
  DIRECT_INTEGRATOR_TEMPLATE_NAME,
  INTEGRATOR_TEMPLATE_NAME,
  LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME,
  LEGACY_INTEGRATOR_TEMPLATE_NAME,
  LEGACY_PRE_ADJUDICATION_DIRECT_TEMPLATE_PREFIX,
  LEGACY_PRE_ADJUDICATION_TEMPLATE_PREFIX,
  LEGACY_PRE_ZERO_GATE_TEMPLATE_PREFIX,
} from "./merge-integrator.js";

export const MERGE_TAIL_SCHEMA_VERSION = 1;
export const MERGE_READINESS_OUTPUT_KIND = "merge-authorization";
export const DIRECT_MERGE_READINESS_STEP_INDEX = 6;
export const MERGE_READINESS_STEP_INDEX = 11;
export const LEGACY_DIRECT_MERGE_READINESS_STEP_INDEX = 6;
export const LEGACY_MERGE_READINESS_STEP_INDEX = 11;
/** The adjudication-era graphs carried one extra node, so their readiness sat one ordinal later. */
export const LEGACY_PRE_ADJUDICATION_DIRECT_MERGE_READINESS_STEP_INDEX = 7;
export const LEGACY_PRE_ADJUDICATION_MERGE_READINESS_STEP_INDEX = 12;
export const MERGE_TAIL_KIND = {
  baseDriftRecovery: "mergeTail.baseDriftRecovery",
  regression: "mergeTail.regression",
  repairAttempt: "mergeTail.repairAttempt",
  repairResult: "mergeTail.repairResult",
  reviewObligation: "mergeTail.reviewObligation",
  readiness: "mergeTail.readiness",
  authorityResign: "mergeTail.authorityResign",
} as const;

/**
 * The failure reason a merge-readiness step carries while an independent review
 * is open. It is a park the review owns and resolves, not a stalled step, so
 * generic recovery has to be able to recognise it.
 */
export const INDEPENDENT_REVIEW_OPEN_PREFIX = "independent-review-open:";

/**
 * The failure reason a regression-verification step carries while it waits for
 * the operator to re-sign `release-authority.json`. Like the review park it is
 * owned and resolved by a specific mechanism — here the resign worker — so
 * generic recovery must leave it alone rather than re-queue the step under it.
 */
export const AUTHORITY_RESIGN_OPEN_PREFIX = "authority-resign-open:";

/**
 * The dedupe key prefix of the inbox message that carries a re-signature
 * request: `authority-resign:<taskId>:<headSha>`. Only the control plane can
 * write a dedupe key, so counting these keys is how many rounds a task has
 * actually been sent back — a number no run can inflate.
 */
export const AUTHORITY_RESIGN_DEDUPE_PREFIX = "authority-resign:";

/**
 * How many times one chain may be sent back for a re-signature before the tail
 * stops instead. Re-signing is an operator action, so a repeat means the last
 * signature did not in fact cover this tree; a third one is a loop, not
 * progress.
 */
export const MAX_AUTHORITY_RESIGN_ROUNDS = 3;

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
  | { schemaVersion: 1; outcome: "refresh-conflict"; headSha: string; baseHeadSha: string; summary: string }
  /**
   * The tree moved attested release-path files without re-signing
   * `release-authority.json`, so the migration preflight refuses it and the
   * gate cannot pass. Reported instead of a gate run: no agent can close it,
   * because the signing key is the operator's and never enters a run.
   */
  | { schemaVersion: 1; outcome: "authority-resign"; headSha: string; baseHeadSha: string; summary: string };

export type RegressionRepairHandoff = {
  schemaVersion: 1;
  trigger:
    | { kind: "regression-verdict"; verdict: Exclude<RegressionVerdict, { outcome: "pass" | "authority-resign" }> }
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
  if (value.outcome === "authority-resign" && typeof value.summary === "string" && value.summary.trim().length > 0) {
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
    || (name === LEGACY_INTEGRATOR_TEMPLATE_NAME && step.stepIndex === LEGACY_MERGE_READINESS_STEP_INDEX)
    || (name?.startsWith(LEGACY_PRE_ADJUDICATION_DIRECT_TEMPLATE_PREFIX) === true
      && step.stepIndex === LEGACY_PRE_ADJUDICATION_DIRECT_MERGE_READINESS_STEP_INDEX)
    || (name?.startsWith(LEGACY_PRE_ADJUDICATION_TEMPLATE_PREFIX) === true
      && step.stepIndex === LEGACY_PRE_ADJUDICATION_MERGE_READINESS_STEP_INDEX)
    || (name?.startsWith(LEGACY_PRE_ZERO_GATE_TEMPLATE_PREFIX) === true
      && step.stepIndex === MERGE_READINESS_STEP_INDEX);
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

/**
 * A single defect the independent merge-tail review found, with the severity
 * that decides whether the merge stops for it.
 *
 * `blocking` is reserved for a reachable behavioural defect — correctness, data
 * integrity, or security — and the reviewer owes a reachability argument for it.
 * Everything else (specification consistency that no caller can reach, style,
 * defensive hardening) is `follow-up`: it becomes a backlog card and the merge
 * proceeds.
 */
export type IndependentReviewFinding = {
  severity: "blocking" | "follow-up";
  title: string;
  detail: string;
  reachability?: string;
};

export type IndependentReviewDecision = {
  headSha: string;
  findings: IndependentReviewFinding[];
  /** Derived from the findings; the reviewer never states it. */
  outcome: "approved" | "accepted-with-followups" | "rejected";
  /** The blocking findings rendered for the repair agent; empty when none. */
  blockingSummary: string;
};

export type IndependentReviewParse =
  | { status: "ok"; decision: IndependentReviewDecision }
  | { status: "invalid"; reason: string };

/** Blocking rejections the autonomous tail repairs before it stops for a human. */
export const MAX_BLOCKING_REVIEW_ROUNDS = 3;

/**
 * What one decision may contain.
 *
 * Every follow-up finding becomes a Task and an Activity written serially while
 * the completion transaction holds the whole chain mutex, so an unbounded
 * findings array is an unbounded transaction. A review that has more than this
 * to say about one exact range is not a decision the tail can act on.
 */
export const MAX_REVIEW_FINDINGS = 50;
export const MAX_REVIEW_FINDING_TITLE = 200;
export const MAX_REVIEW_FINDING_TEXT = 4_000;

const reviewFinding = (value: unknown, index: number): IndependentReviewFinding | string => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `finding ${index} is not an object`;
  }
  const finding = value as Record<string, unknown>;
  if (finding.severity !== "blocking" && finding.severity !== "follow-up") {
    return `finding ${index} has no blocking or follow-up severity`;
  }
  if (typeof finding.title !== "string" || finding.title.trim().length === 0) {
    return `finding ${index} has no title`;
  }
  if (finding.title.length > MAX_REVIEW_FINDING_TITLE) {
    return `finding ${index} has a title longer than ${String(MAX_REVIEW_FINDING_TITLE)} characters`;
  }
  if (typeof finding.detail !== "string" || finding.detail.trim().length === 0) {
    return `finding ${index} has no detail`;
  }
  if (finding.detail.length > MAX_REVIEW_FINDING_TEXT) {
    return `finding ${index} has a detail longer than ${String(MAX_REVIEW_FINDING_TEXT)} characters`;
  }
  if (finding.severity === "blocking"
    && (typeof finding.reachability !== "string" || finding.reachability.trim().length === 0)) {
    return `blocking finding ${index} has no reachability argument`;
  }
  if (typeof finding.reachability === "string" && finding.reachability.length > MAX_REVIEW_FINDING_TEXT) {
    return `finding ${index} has a reachability argument longer than ${String(MAX_REVIEW_FINDING_TEXT)} characters`;
  }
  return {
    severity: finding.severity,
    title: finding.title.trim(),
    detail: finding.detail.trim(),
    ...(typeof finding.reachability === "string" ? { reachability: finding.reachability.trim() } : {}),
  };
};

/**
 * Reads the independent review's decision and derives its outcome server-side.
 *
 * The reviewer reports findings and their severity; it does not report a
 * verdict. One authority over "does this stop the merge" is the whole point —
 * a stated outcome could disagree with the severities under it, and there would
 * be no non-arbitrary way to settle that disagreement inside the tail.
 */
export const parseIndependentReviewDecision = (
  body: string | null | undefined,
  expectedHeadSha: string,
): IndependentReviewParse => {
  if (!body) return { status: "invalid", reason: "missing independent review output" };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { status: "invalid", reason: "independent review output is not JSON" }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", reason: "independent review output is not an object" };
  }
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== MERGE_TAIL_SCHEMA_VERSION) {
    return { status: "invalid", reason: "unsupported independent review schemaVersion" };
  }
  if (typeof value.headSha !== "string" || !SHA.test(value.headSha)) {
    return { status: "invalid", reason: "invalid independent review headSha" };
  }
  if (value.headSha !== expectedHeadSha) {
    return { status: "invalid", reason: `independent review decision is bound to ${value.headSha}, not ${expectedHeadSha}` };
  }
  if (!Array.isArray(value.findings)) return { status: "invalid", reason: "independent review output has no findings array" };
  if (value.findings.length > MAX_REVIEW_FINDINGS) {
    return { status: "invalid", reason: `independent review reported more than ${String(MAX_REVIEW_FINDINGS)} findings for one exact range` };
  }
  const findings: IndependentReviewFinding[] = [];
  for (const [index, entry] of value.findings.entries()) {
    const finding = reviewFinding(entry, index);
    if (typeof finding === "string") return { status: "invalid", reason: finding };
    findings.push(finding);
  }
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  return {
    status: "ok",
    decision: {
      headSha: value.headSha,
      findings,
      outcome: blocking.length > 0 ? "rejected" : findings.length > 0 ? "accepted-with-followups" : "approved",
      blockingSummary: blocking.map((finding) => `${finding.title}: ${finding.detail}`).join("\n"),
    },
  };
};
