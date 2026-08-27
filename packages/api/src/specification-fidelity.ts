import {
  githubRepositoryFromRemote,
  Prisma,
  stepRole,
} from "@agentos/db";

import { isCanonicalBlindFindingsStep, isCanonicalSolFindingsStep } from "./canonical-task-output.js";
import { isValidBranchName } from "./branch-name.js";
import { featureBriefFromTaskDescription } from "./templates.js";

/** Stable, operator-visible reasons for the distinct fail-closed outcomes. */
export const SPEC_TRANSCRIPTION_REFUSAL_REASON = "spec-transcription-mismatch";
export const SPEC_TRANSCRIPTION_UNREADABLE_REASON = "spec-transcription-unreadable";
export const SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON = "spec-transcription-authority-missing";

export type SpecificationRefusalReason =
  | typeof SPEC_TRANSCRIPTION_REFUSAL_REASON
  | typeof SPEC_TRANSCRIPTION_UNREADABLE_REASON
  | typeof SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON;

export type SpecificationRefusal = {
  reason: SpecificationRefusalReason;
  message: string;
};

/** The path the implementation step promises to materialize. */
export const specificationPathForBranch = (branch: string): string => `.chain/${branch}/spec.md`;

/** Narrow repository capability needed by review-claim verification. */
export type SpecificationReader = {
  readFileAtCommit: (
    repository: string,
    path: string,
    commitSha: string,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
};

type ReviewTask = {
  id: string;
  projectId: string;
  templateId: string | null;
  chainId: string | null;
  chainIndex: number | null;
  description: string;
  templateStep?: {
    stepIndex: number;
    outputKind: string;
    baseFromStepIndex: number | null;
    taskTemplate?: { name: string };
  } | null;
};

type ReviewRepo = { remoteUrl: string };

export type SpecificationReviewCandidate = {
  task: ReviewTask;
  repo: ReviewRepo;
  branch: string | null;
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => (
  left.length === right.length && left.every((byte, index) => byte === right[index])
);

/** Normalize CRLF and lone CR to LF without decoding arbitrary bytes. */
export const normalizeLineEndings = (bytes: Uint8Array): Uint8Array => {
  const normalized: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0x0d) {
      if (bytes[index + 1] === 0x0a) index += 1;
      normalized.push(0x0a);
    } else {
      normalized.push(byte);
    }
  }
  return Uint8Array.from(normalized);
};

const refusal = (reason: SpecificationRefusalReason, detail: string): SpecificationRefusal => ({
  reason,
  message: `Spec transcription claim refused: ${reason}: ${detail}`,
});

export const specificationUnreadableRefusal = (detail: string): SpecificationRefusal => (
  refusal(SPEC_TRANSCRIPTION_UNREADABLE_REASON, detail)
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

type AuthoritySource = {
  description: string;
  templateStep: { outputKind: string; attachmentsFromPrevious: boolean } | null;
  stepOutput: { kind: string; body: string } | null;
};

const compoundAuthority = (source: AuthoritySource): AuthorityResult => {
  if (!source.stepOutput) {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "approved specification output is missing") };
  }
  if (source.stepOutput.kind !== "spec") {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "approved specification output has an unexpected kind") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.stepOutput.body);
  } catch {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "approved specification output is not valid JSON") };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.spec !== "string") {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "approved specification output has no canonical spec field") };
  }
  return { text: parsed.spec };
};

const directAuthority = (source: AuthoritySource): AuthorityResult => {
  if (!source.templateStep) {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "direct-chain implementation step metadata is missing") };
  }
  const text = featureBriefFromTaskDescription(
    source.description,
    source.templateStep.attachmentsFromPrevious,
  );
  return text === null
    ? { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "direct-chain task brief is unavailable") }
    : { text };
};

type AuthorityResult = { text: string } | { error: SpecificationRefusal };

const authorityFor = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
): Promise<AuthorityResult> => {
  if (!candidate.task.templateId || !candidate.task.chainId) {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "chain identity is unavailable") };
  }
  const sources = await tx.task.findMany({
    where: {
      projectId: candidate.task.projectId,
      templateId: candidate.task.templateId,
      chainId: candidate.task.chainId,
    },
    select: {
      description: true,
      templateStep: { select: { outputKind: true, attachmentsFromPrevious: true } },
      stepOutput: { select: { kind: true, body: true } },
    },
  });
  const sourcesForRole = (role: "spec" | "implementation") => sources.filter((source) => (
    source.templateStep !== null && stepRole(source.templateStep) === role
  ));
  const specificationSources = sourcesForRole("spec");
  if (specificationSources.length > 1) {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "compound chain has multiple specification steps") };
  }
  if (specificationSources[0]) return compoundAuthority(specificationSources[0]);

  const implementationSources = sourcesForRole("implementation");
  if (implementationSources.length !== 1) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      implementationSources.length === 0
        ? "direct-chain implementation task is missing"
        : "direct chain has multiple implementation steps",
    ) };
  }
  return directAuthority(implementationSources[0]!);
};

export type SpecificationVerification = {
  key: string;
  repository: string;
  path: string;
  implementationHeadSha: string;
  authoritativeBytes: Uint8Array;
};

export type SpecificationVerificationPreparation =
  | { status: "not-required" }
  | { status: "refused"; refusal: SpecificationRefusal }
  | { status: "ready"; verification: SpecificationVerification };

/** Snapshot database-backed authority while the claim transaction is open. */
export const prepareSpecificationVerification = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
  implementationHeadSha: string | null,
): Promise<SpecificationVerificationPreparation> => {
  const step = candidate.task.templateStep;
  if (!step || (!isCanonicalSolFindingsStep(step) && !isCanonicalBlindFindingsStep(step))) {
    return { status: "not-required" };
  }
  if (!implementationHeadSha) {
    return { status: "refused", refusal: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "pinned implementation head is unavailable",
    ) };
  }
  if (!candidate.branch || !isValidBranchName(candidate.branch)) {
    return { status: "refused", refusal: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "materialized specification branch is unavailable",
    ) };
  }

  const authority = await authorityFor(tx, candidate);
  if ("error" in authority) return { status: "refused", refusal: authority.error };

  const repository = githubRepositoryFromRemote(candidate.repo.remoteUrl);
  if (!repository) {
    return { status: "refused", refusal: specificationUnreadableRefusal(
      `repository remote is not a supported GitHub repository: ${candidate.repo.remoteUrl}`,
    ) };
  }
  const path = specificationPathForBranch(candidate.branch);
  const authoritativeBytes = new TextEncoder().encode(authority.text);
  return {
    status: "ready",
    verification: {
      key: [candidate.task.id, implementationHeadSha, candidate.branch, authority.text].join("\0"),
      repository,
      path,
      implementationHeadSha,
      authoritativeBytes,
    },
  };
};

const isAbortError = (error: unknown): boolean => (
  error instanceof Error && error.name === "AbortError"
);

/** Perform repository I/O only; callers must invoke this outside a transaction. */
export const verifyPreparedSpecification = async (
  verification: SpecificationVerification,
  reader: SpecificationReader | null,
  signal: AbortSignal,
): Promise<SpecificationRefusal | null> => {
  if (!reader) return specificationUnreadableRefusal("server-side repository content reader is unavailable");
  let materialized: Uint8Array;
  try {
    materialized = await reader.readFileAtCommit(
      verification.repository,
      verification.path,
      verification.implementationHeadSha,
      signal,
    );
  } catch (error: unknown) {
    if (signal.aborted || isAbortError(error)) throw error;
    const detail = error instanceof Error ? error.message : "repository content read failed";
    return specificationUnreadableRefusal(detail);
  }
  return bytesEqual(
    normalizeLineEndings(materialized),
    normalizeLineEndings(verification.authoritativeBytes),
  )
    ? null
    : refusal(
      SPEC_TRANSCRIPTION_REFUSAL_REASON,
      `materialized ${verification.path} does not match the authoritative specification`,
    );
};
