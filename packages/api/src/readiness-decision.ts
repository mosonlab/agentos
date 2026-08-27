import {
  defenseTriggers,
  type ChangedFile,
  type MergeEvidence,
} from "@agentos/db";

import type { GitHubReadError, PullRequestSnapshot } from "./github-read.js";

type Comparison = {
  status: "ahead" | "behind" | "diverged" | "identical";
  behindBy: number;
  filesComplete: boolean;
  files: ChangedFile[];
};

type ReadinessContext = {
  readiness: {
    id: string;
    chainId: string | null;
    projectId: string;
    repoId: string | null;
  };
  now: Date;
};

type RegressionPass = {
  headSha: string;
  baseHeadSha: string;
};

export type ReadinessInput = ReadinessContext & (
  | { stage: "claim-lost" | "regression-pending" }
  | { stage: "missing-regression-evidence" }
  | { stage: "invalid-regression-evidence" }
  | { stage: "reader-unavailable" }
  | { stage: "target-unresolved"; unresolvable: "none" | "ambiguous" | "repository" }
  | {
      stage: "read-failed";
      failure: {
        kind: GitHubReadError["kind"] | "unexpected";
        message: string;
      };
    }
  | {
      stage: "ready";
      regression: RegressionPass;
      target: { repository: string; prNumber: number };
      snapshot: PullRequestSnapshot;
      comparison: Comparison | null;
      evidence: MergeEvidence | { error: string } | null;
    }
);

export type ReadinessDecision =
  | {
      kind: "authorize";
      evidence: MergeEvidence;
      repository: string;
      prNumber: number;
      issuedAt: string;
      baseSha: string;
      headSha: string;
      /**
       * The defence-list paths this diff moved. They no longer hold the merge;
       * the worker records them as an audit message against the readiness task.
       */
      auditTriggers: Array<{ path: string; reason: string }>;
    }
  | {
      kind: "requeue-regression";
      reason: string;
      staleBaseSha: string;
      currentBaseSha: string;
    }
  | { kind: "defer"; reason: string }
  | { kind: "stop"; condition: string; evidence: string }
  | { kind: "skip" };

const stop = (condition: string, evidence: string): ReadinessDecision => (
  { kind: "stop", condition, evidence }
);

export const readinessDecision = (input: ReadinessInput): ReadinessDecision => {
  switch (input.stage) {
    case "claim-lost":
    case "regression-pending":
      return { kind: "skip" };
    case "missing-regression-evidence":
      return stop("regression-evidence-missing", "missing head-bound regression PASS evidence");
    case "invalid-regression-evidence":
      return stop("regression-evidence-invalid", "missing or stale head-bound regression PASS evidence");
    case "reader-unavailable":
      return stop("github-reader-unavailable", "server-side GitHub comparison reader is unavailable");
    case "target-unresolved":
      return stop("pull-request-target-unresolved", `pull-request target is ${input.unresolvable}`);
    case "read-failed": {
      const evidence = `readiness evaluation failed: ${input.failure.message}`;
      if (input.failure.kind === "timeout" || input.failure.kind === "transport") {
        return { kind: "defer", reason: evidence };
      }
      return stop("readiness-read-failed", evidence);
    }
    case "ready":
      break;
  }

  const { regression, snapshot } = input;
  if (snapshot.headRefOid !== regression.headSha) {
    return {
      kind: "requeue-regression",
      staleBaseSha: regression.baseHeadSha,
      currentBaseSha: snapshot.baseSha ?? "missing",
      reason: `stale PASS head ${regression.headSha}; current PR head is ${snapshot.headRefOid ?? "missing"}`,
    };
  }
  if (!snapshot.baseSha || !snapshot.baseRefName) {
    return stop("pull-request-base-missing", "pull request base identity is unavailable");
  }
  if (snapshot.baseSha !== regression.baseHeadSha) {
    return {
      kind: "requeue-regression",
      staleBaseSha: regression.baseHeadSha,
      currentBaseSha: snapshot.baseSha,
      reason: "target base advanced after regression PASS",
    };
  }
  const comparison = input.comparison;
  if (!comparison) {
    return stop("readiness-facts-incomplete", "server-side comparison facts are unavailable");
  }
  if (!comparison.filesComplete) {
    return stop(
      "comparison-incomplete",
      "GitHub comparison file list is truncated or completeness is unproven",
    );
  }
  if ((comparison.status !== "ahead" && comparison.status !== "identical") || comparison.behindBy !== 0) {
    return {
      kind: "requeue-regression",
      staleBaseSha: regression.baseHeadSha,
      currentBaseSha: snapshot.baseSha,
      reason: `server-side ancestry check refused ${comparison.status} comparison with behind_by=${comparison.behindBy}`,
    };
  }

  if (!input.evidence) {
    return stop("readiness-facts-incomplete", "merge evidence facts are unavailable");
  }
  if ("error" in input.evidence) {
    return stop("merge-evidence-invalid", input.evidence.error);
  }
  return {
    kind: "authorize",
    evidence: input.evidence,
    repository: input.target.repository,
    prNumber: input.target.prNumber,
    issuedAt: input.now.toISOString(),
    baseSha: snapshot.baseSha,
    headSha: regression.headSha,
    auditTriggers: defenseTriggers(comparison.files),
  };
};
