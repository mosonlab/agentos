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

export type CandidateLoad =
  | { kind: "skip" }
  | { kind: "refused"; code: CandidateRefusalCode; stopId: string; detail?: string }
  | { kind: "candidate"; candidate: RecoveryCandidate };

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

export type RecoveryFacts =
  | { stage: "candidate"; load: CandidateLoad }
  | { stage: "reader-unavailable" }
  | { stage: "reader-failure"; reason: string }
  | {
      stage: "fresh";
      candidate: RecoveryCandidate;
      snapshot: RecoveryPullRequestFacts;
      comparisonAvailable: boolean;
      authorizedAdvance: Comparison | null;
      observedAdvance: Comparison | null;
    }
  | {
      stage: "classification-retry";
      reason: string;
      validationAttempts: number;
      maxAttempts: number;
    }
  | {
      stage: "durable";
      expected: RecoveryCandidate;
      load: CandidateLoad;
      aggregateValidating: boolean;
      recoveryCount: number;
      maxRecoveries: number;
      currentBaseSha: string;
    };

export type RecoveryDecision =
  | { kind: "inspect"; candidate: RecoveryCandidate }
  | { kind: "queue"; candidate: RecoveryCandidate; currentBaseSha: string }
  | { kind: "retry"; reason: string; classificationAttempt?: number }
  | { kind: "ineligible"; reason: string }
  | { kind: "exhausted"; reason: string }
  | { kind: "skip" };

const refusalReason = (refusal: Extract<CandidateLoad, { kind: "refused" }>): string => {
  switch (refusal.code) {
    case "identity-incomplete": return "chain or repository identity is incomplete";
    case "source-run-unbound": return "stop is not bound to an executor run";
    case "evidence-invalid": return "base-drift evidence is malformed or is not a SHA-only drift payload";
    case "source-run-mismatch": return "source executor run identity or terminal state does not match the stop";
    case "chain-active": return "the chain has an active foreign run while recovery is being classified";
    case "output-mismatch": return "executor output does not exactly match the recorded source stop";
    case "tail-unresolved": return "current direct/compound regression and readiness tail cannot be resolved";
    case "tail-state-mismatch": return "merge tail task state is not the completed-readiness/stopped-executor shape";
    case "authorization-invalid": return `authorized readiness evidence is ${refusal.detail ?? "missing"}`;
    case "intent-count": return "source executor run has multiple server-bound merge intents";
    case "intent-mismatch": return "executor intent does not match the selected authorization";
    case "authorized-base-mismatch": return "stop evidence does not match the authorized base SHA";
    case "readiness-head-mismatch": return "readiness output does not match the authorized head SHA";
    case "target-unresolved": return `pull-request identity is ${refusal.detail ?? "unresolved"}`;
    case "target-mismatch": return "resolved repository or pull-request identity differs from the authorization";
    case "target-branch-mismatch": return "chain first-run target ref differs from the authorized base ref";
  }
};

const candidateDecision = (load: CandidateLoad): RecoveryDecision => {
  if (load.kind === "skip") return { kind: "skip" };
  if (load.kind === "candidate") return { kind: "inspect", candidate: load.candidate };
  const reason = refusalReason(load);
  return load.code === "chain-active" ? { kind: "retry", reason } : { kind: "ineligible", reason };
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
 * and remote facts, then applies this result; this module performs no I/O.
 */
export const recoveryDecision = (facts: RecoveryFacts): RecoveryDecision => {
  switch (facts.stage) {
    case "candidate":
      return candidateDecision(facts.load);
    case "reader-unavailable":
      return { kind: "retry", reason: "server-side GitHub reader is unavailable" };
    case "reader-failure":
      return { kind: "retry", reason: facts.reason };
    case "classification-retry": {
      const classificationAttempt = facts.validationAttempts + 1;
      if (classificationAttempt > facts.maxAttempts) {
        return {
          kind: "ineligible",
          reason: `classification retry limit ${facts.maxAttempts} reached after transient failure: ${facts.reason}`,
        };
      }
      return { kind: "retry", reason: facts.reason, classificationAttempt };
    }
    case "durable": {
      if (!facts.aggregateValidating) return { kind: "skip" };
      const loaded = candidateDecision(facts.load);
      if (loaded.kind === "skip") {
        return { kind: "ineligible", reason: "durable chain state changed during fresh recovery verification" };
      }
      if (loaded.kind !== "inspect") return loaded;
      if (!candidatesMatch(loaded.candidate, facts.expected)) {
        return { kind: "ineligible", reason: "durable chain state changed during fresh recovery verification" };
      }
      if (facts.recoveryCount >= facts.maxRecoveries) {
        return {
          kind: "exhausted",
          reason: `automatic recovery limit ${facts.maxRecoveries} reached for ${facts.expected.repository}#${facts.expected.prNumber} targeting ${facts.expected.targetBranch}`,
        };
      }
      return { kind: "queue", candidate: facts.expected, currentBaseSha: facts.currentBaseSha };
    }
    case "fresh":
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
};
