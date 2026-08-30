export type RecoveryIdentity = {
  repository: string;
  prNumber: number;
  targetBranch: string;
  authorizedHeadSha: string;
  authorizedBaseSha: string;
  observedBaseSha: string;
};

export type RecoveryCandidate = RecoveryIdentity & {
  integratorTaskId: string;
  readinessTaskId: string;
  regressionTaskId: string;
  sourceRunId: string;
  stopId: string;
  authorizationActivityId: string;
};

export const candidateRefusalCodes = [
  "identity-incomplete",
  "source-run-unbound",
  "evidence-invalid",
  "source-run-mismatch",
  "chain-active",
  "output-mismatch",
  "tail-unresolved",
  "tail-state-mismatch",
  "authorization-invalid",
  "intent-count",
  "intent-mismatch",
  "authorized-base-mismatch",
  "readiness-head-mismatch",
  "target-unresolved",
  "target-mismatch",
  "target-branch-mismatch",
] as const;

export type CandidateRefusalCode = typeof candidateRefusalCodes[number];

export type DurableCandidateFacts = {
  task: {
    id: string;
    chainId: string | null;
    chainIndex: number | null;
    repoId: string | null;
    repositoryPresent: boolean;
    status: string;
    isIntegratorStep: boolean;
  } | null;
  stop: {
    stopId: string;
    condition: string;
    evidence: string;
    sourceRunId: string | null;
  } | null;
  existingAttempt: {
    status: string;
    reopenableLegacyRefusal: boolean;
  } | null;
  sourceRun: {
    id: string;
    taskId: string | null;
    status: string;
    hasSession: boolean;
  } | null;
  activeRunCount: number | null;
  output: {
    runId: string | null;
    kind: string;
    outcome: string;
    condition: string | null;
    evidence: string | null;
  } | null;
  readiness: {
    id: string;
    status: string;
    isReadinessStep: boolean;
    outputCommitSha: string | null;
  } | null;
  regression: { id: string; status: string } | null;
  authorizationSelection: {
    authorization: {
      activityId: string;
      repository: string;
      prNumber: number;
      headSha: string;
      baseSha: string;
      baseRef: string;
    } | null;
    refusal: string | null;
  } | null;
  intents: Array<{
    sourceRunId?: unknown;
    authorizationActivityId?: unknown;
    prNumber?: unknown;
    headSha?: unknown;
  }> | null;
  target:
    | { resolved: false; unresolvable: string }
    | { resolved: true; repository: string; prNumber: number }
    | null;
  firstRunTargetRef: string | null;
};

type Comparison = { status: string; behindBy: number };

export type RecoveryPullRequestFacts = {
  repository: string;
  number: number;
  state: string | null;
  isDraft: boolean | null;
  merged: boolean | null;
  baseRefName: string | null;
  baseSha: string | null;
  headRefOid: string | null;
  headCommitOid: string | null;
  autoMergeRequest: unknown | null;
  mergeQueueEntry: unknown | null;
};

export type FreshRecoveryFacts =
  | { kind: "reader-unavailable" }
  | { kind: "reader-failure"; reason: string }
  | {
      kind: "snapshot";
      candidate: RecoveryCandidate;
      snapshot: RecoveryPullRequestFacts;
      comparisonAvailable: boolean;
      authorizedAdvance: Comparison | null;
      observedAdvance: Comparison | null;
    };

export type Skip = { kind: "skip" };
export type Retry = { kind: "retry"; reason: string };
export type Ineligible = { kind: "ineligible"; reason: string };
export type Inspect = { kind: "inspect"; candidate: RecoveryCandidate };
export type Queue = { kind: "queue"; candidate: RecoveryCandidate; currentBaseSha: string };
export type Exhausted = { kind: "exhausted"; reason: string };

type CandidateRefusal = { code: CandidateRefusalCode; stopId: string };

export type CandidateDecision = Skip | (Retry & CandidateRefusal) | (Ineligible & CandidateRefusal) | Inspect;
export type FreshDecision = Retry | Ineligible | Queue;
export type DurableDecision = Skip | Retry | Ineligible | Exhausted | Queue;
export type RetryBudgetDecision = (Retry & { classificationAttempt: number }) | Ineligible;

const refusalReason = (code: CandidateRefusalCode, detail?: string): string => {
  switch (code) {
    case "identity-incomplete": return "chain or repository identity is incomplete";
    case "source-run-unbound": return "stop is not bound to an executor run";
    case "evidence-invalid": return "base-drift evidence is malformed or is not a SHA-only drift payload";
    case "source-run-mismatch": return "source executor run identity or terminal state does not match the stop";
    case "chain-active": return "the chain has an active foreign run while recovery is being classified";
    case "output-mismatch": return "executor output does not exactly match the recorded source stop";
    case "tail-unresolved": return "current direct/compound regression and readiness tail cannot be resolved";
    case "tail-state-mismatch": return "merge tail task state is not the completed-readiness/stopped-executor shape";
    case "authorization-invalid": return `authorized readiness evidence is ${detail ?? "missing"}`;
    case "intent-count": return "source executor run has multiple server-bound merge intents";
    case "intent-mismatch": return "executor intent does not match the selected authorization";
    case "authorized-base-mismatch": return "stop evidence does not match the authorized base SHA";
    case "readiness-head-mismatch": return "readiness output does not match the authorized head SHA";
    case "target-unresolved": return `pull-request identity is ${detail ?? "unresolved"}`;
    case "target-mismatch": return "resolved repository or pull-request identity differs from the authorization";
    case "target-branch-mismatch": return "chain first-run target ref differs from the authorized base ref";
  }
};

const parseBaseDriftEvidence = (value: string): { observed: string; authorized: string } | null => {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const evidence = parsed as Record<string, unknown>;
  if (Object.keys(evidence).sort().join(",") !== "authorized,observed") return null;
  if (typeof evidence.observed !== "string" || !/^[0-9a-f]{40}$/u.test(evidence.observed)) return null;
  if (typeof evidence.authorized !== "string" || !/^[0-9a-f]{40}$/u.test(evidence.authorized)) return null;
  if (evidence.observed === evidence.authorized) return null;
  return { observed: evidence.observed, authorized: evidence.authorized };
};

/**
 * Owns all durable candidate eligibility policy. The reader supplies database
 * facts only; this decider turns those facts into the one recovery ruling.
 */
export const classifyCandidate = (facts: DurableCandidateFacts): CandidateDecision => {
  const { task, stop } = facts;
  if (!task?.isIntegratorStep || !stop || stop.condition !== "base-drift") return { kind: "skip" };
  if (facts.existingAttempt
    && facts.existingAttempt.status !== "VALIDATING"
    && !facts.existingAttempt.reopenableLegacyRefusal) return { kind: "skip" };

  const refuse = (code: CandidateRefusalCode, detail?: string): CandidateDecision => ({
    kind: code === "chain-active" ? "retry" : "ineligible",
    code,
    reason: refusalReason(code, detail),
    stopId: stop.stopId,
  });
  if (!task.chainId || task.chainIndex === null || !task.repoId || !task.repositoryPresent) {
    return refuse("identity-incomplete");
  }
  if (!stop.sourceRunId) return refuse("source-run-unbound");
  const evidence = parseBaseDriftEvidence(stop.evidence);
  if (!evidence) return refuse("evidence-invalid");
  const sourceRun = facts.sourceRun;
  if (!sourceRun || sourceRun.taskId !== task.id || sourceRun.status !== "SUCCEEDED" || !sourceRun.hasSession) {
    return refuse("source-run-mismatch");
  }
  if (facts.activeRunCount === null) throw new Error(`Candidate facts for ${task.id} omit the active Run count`);
  if (facts.activeRunCount !== 0) return refuse("chain-active");

  const output = facts.output;
  if (output?.runId !== sourceRun.id || output?.kind !== "merge-result"
    || output.outcome !== "stopped" || output.condition !== "base-drift"
    || output.evidence !== stop.evidence) {
    return refuse("output-mismatch");
  }
  const { readiness, regression } = facts;
  if (!readiness?.isReadinessStep || !regression) return refuse("tail-unresolved");
  if (task.status !== "REVIEW" || readiness.status !== "DONE" || regression.status !== "DONE") {
    return refuse("tail-state-mismatch");
  }

  const selection = facts.authorizationSelection;
  if (!selection) throw new Error(`Candidate facts for ${task.id} omit the authorization selection`);
  if (!selection.authorization || selection.refusal) {
    return refuse("authorization-invalid", selection.refusal ?? "missing");
  }
  const authorization = selection.authorization;
  if (!facts.intents) throw new Error(`Candidate facts for ${task.id} omit merge intents`);
  const intents = facts.intents.filter((intent) => intent.sourceRunId === sourceRun.id);
  if (intents.length > 1) return refuse("intent-count");
  const intent = intents[0];
  if (intent && (intent.authorizationActivityId !== authorization.activityId
    || intent.prNumber !== authorization.prNumber || intent.headSha !== authorization.headSha)) {
    return refuse("intent-mismatch");
  }
  if (evidence.authorized !== authorization.baseSha) return refuse("authorized-base-mismatch");
  if (readiness.outputCommitSha !== authorization.headSha) return refuse("readiness-head-mismatch");

  if (!facts.target) throw new Error(`Candidate facts for ${task.id} omit the resolved target`);
  if (!facts.target.resolved) return refuse("target-unresolved", facts.target.unresolvable);
  if (facts.target.repository !== authorization.repository || facts.target.prNumber !== authorization.prNumber) {
    return refuse("target-mismatch");
  }
  if (facts.firstRunTargetRef !== authorization.baseRef) return refuse("target-branch-mismatch");
  return { kind: "inspect", candidate: {
    integratorTaskId: task.id,
    readinessTaskId: readiness.id,
    regressionTaskId: regression.id,
    sourceRunId: sourceRun.id,
    stopId: stop.stopId,
    authorizationActivityId: authorization.activityId,
    repository: facts.target.repository,
    prNumber: facts.target.prNumber,
    targetBranch: authorization.baseRef,
    authorizedHeadSha: authorization.headSha,
    authorizedBaseSha: authorization.baseSha,
    observedBaseSha: evidence.observed,
  } };
};

const candidatesMatch = (left: RecoveryCandidate, right: RecoveryCandidate): boolean => {
  const fields: Array<keyof RecoveryCandidate> = [
    "integratorTaskId", "readinessTaskId", "regressionTaskId", "sourceRunId", "stopId",
    "authorizationActivityId", "repository", "prNumber", "targetBranch", "authorizedHeadSha",
    "authorizedBaseSha", "observedBaseSha",
  ];
  return fields.every((field) => left[field] === right[field]);
};

/**
 * Owns every base-drift recovery classification rule. The worker reads durable
 * and remote facts, then applies these stage-specific results without widening
 * their decision unions; this module performs no I/O.
 */
export function classifyFresh(facts: Extract<FreshRecoveryFacts, { kind: "reader-unavailable" }>): Retry;
export function classifyFresh(facts: Extract<FreshRecoveryFacts, { kind: "reader-failure" }>): Retry;
export function classifyFresh(facts: Extract<FreshRecoveryFacts, { kind: "snapshot" }>): FreshDecision;
export function classifyFresh(facts: FreshRecoveryFacts): FreshDecision {
  switch (facts.kind) {
    case "reader-unavailable":
      return { kind: "retry", reason: "server-side GitHub reader is unavailable" };
    case "reader-failure":
      return { kind: "retry", reason: facts.reason };
    case "snapshot":
      break;
  }

  const { candidate, snapshot } = facts;
  if (snapshot.repository !== candidate.repository || snapshot.number !== candidate.prNumber) {
    return { kind: "ineligible", reason: "fresh repository or pull-request identity mismatches the authorization" };
  }
  if (snapshot.state !== "OPEN" || snapshot.merged !== false) {
    return { kind: "ineligible", reason: "pull request is no longer an unmerged OPEN pull request" };
  }
  if (snapshot.isDraft !== false) {
    return { kind: "ineligible", reason: "pull request draft state changed after authorization" };
  }
  if (snapshot.autoMergeRequest !== null || snapshot.mergeQueueEntry !== null) {
    return { kind: "ineligible", reason: "pull request entered foreign automatic merge machinery" };
  }
  if (snapshot.baseRefName !== candidate.targetBranch) {
    return { kind: "ineligible", reason: "target ref changed after authorization" };
  }
  if (snapshot.headRefOid !== candidate.authorizedHeadSha || snapshot.headCommitOid !== candidate.authorizedHeadSha) {
    return { kind: "ineligible", reason: "pull-request head changed after authorization" };
  }
  if (!snapshot.baseSha || !/^[0-9a-f]{40}$/u.test(snapshot.baseSha) || snapshot.baseSha === candidate.authorizedBaseSha) {
    return { kind: "ineligible", reason: "fresh target base does not prove an advanced SHA" };
  }
  if (!facts.comparisonAvailable) {
    return { kind: "ineligible", reason: "server-side ancestry comparison is unavailable" };
  }
  if (!facts.authorizedAdvance) {
    return { kind: "retry", reason: "authorized-base ancestry facts are incomplete" };
  }
  if (facts.authorizedAdvance.status !== "ahead" || facts.authorizedAdvance.behindBy !== 0) {
    return {
      kind: "ineligible",
      reason: `target base change is not a forward advancement (${facts.authorizedAdvance.status}, behind_by=${facts.authorizedAdvance.behindBy})`,
    };
  }
  if (candidate.observedBaseSha !== snapshot.baseSha) {
    if (!facts.observedAdvance) {
      return { kind: "retry", reason: "executor-observed-base ancestry facts are incomplete" };
    }
    if ((facts.observedAdvance.status !== "ahead" && facts.observedAdvance.status !== "identical")
      || facts.observedAdvance.behindBy !== 0) {
      return {
        kind: "ineligible",
        reason: `current target base does not descend from the executor-observed base (${facts.observedAdvance.status}, behind_by=${facts.observedAdvance.behindBy})`,
      };
    }
  }
  return { kind: "queue", candidate, currentBaseSha: snapshot.baseSha };
}

export const classifyDurable = (facts: {
  expected: RecoveryCandidate;
  candidateDecision: CandidateDecision;
  aggregateValidating: boolean;
  recoveryCount: number;
  maxRecoveries: number;
  currentBaseSha: string;
}): DurableDecision => {
  if (!facts.aggregateValidating) return { kind: "skip" };
  switch (facts.candidateDecision.kind) {
    case "skip":
      return { kind: "ineligible", reason: "durable chain state changed during fresh recovery verification" };
    case "retry":
      return { kind: "retry", reason: facts.candidateDecision.reason };
    case "ineligible":
      return { kind: "ineligible", reason: facts.candidateDecision.reason };
    case "inspect":
      break;
  }
  if (!candidatesMatch(facts.candidateDecision.candidate, facts.expected)) {
    return { kind: "ineligible", reason: "durable chain state changed during fresh recovery verification" };
  }
  if (facts.recoveryCount >= facts.maxRecoveries) {
    return {
      kind: "exhausted",
      reason: `automatic recovery limit ${facts.maxRecoveries} reached for ${facts.expected.repository}#${facts.expected.prNumber} targeting ${facts.expected.targetBranch}`,
    };
  }
  return { kind: "queue", candidate: facts.expected, currentBaseSha: facts.currentBaseSha };
};

export const classifyRetryBudget = (facts: {
  reason: string;
  validationAttempts: number;
  maxAttempts: number;
}): RetryBudgetDecision => {
  const classificationAttempt = facts.validationAttempts + 1;
  if (classificationAttempt > facts.maxAttempts) {
    return {
      kind: "ineligible",
      reason: `classification retry limit ${facts.maxAttempts} reached after transient failure: ${facts.reason}`,
    };
  }
  return { kind: "retry", reason: facts.reason, classificationAttempt };
};
