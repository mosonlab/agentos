import {
  githubRepositoryFromRemote,
  INTEGRATOR_TEMPLATE_NAME,
  Prisma,
} from "@agentos/db";

import { isCanonicalBlindFindingsStep, isCanonicalSolFindingsStep } from "./canonical-task-output.js";
import { isValidBranchName } from "./branch-name.js";
import { featureBriefFromTaskDescription } from "./templates.js";

/** Stable, machine-readable reasons for the distinct fail-closed outcomes. */
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

/** The repository path the implementation step promises to materialize. */
export const specificationPathForBranch = (branch: string): string => `.chain/${branch}/spec.md`;

/**
 * The API only needs this narrow part of the GitHub reader. Keeping the seam
 * separate from PR reads also lets claim tests provide a deterministic reader
 * without inventing a pull-request fixture.
 */
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

/** Normalize CRLF and lone CR to LF without decoding/re-encoding arbitrary bytes. */
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

const compoundAuthority = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
): Promise<AuthorityResult> => {
  if (!candidate.task.templateId || !candidate.task.chainId) {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "compound chain identity is unavailable") };
  }
  const source = await tx.taskStepOutput.findFirst({
    where: {
      task: {
        projectId: candidate.task.projectId,
        templateId: candidate.task.templateId,
        chainId: candidate.task.chainId,
        chainIndex: 1,
      },
    },
    select: { kind: true, body: true },
  });
  if (!source) return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "approved specification output is missing") };
  if (source.kind !== "spec") return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "approved specification output has an unexpected kind") };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.body);
  } catch {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "approved specification output is not valid JSON") };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.spec !== "string") {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "approved specification output has no canonical spec field") };
  }
  return { text: parsed.spec };
};

const directAuthority = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
): Promise<AuthorityResult> => {
  if (!candidate.task.templateId || !candidate.task.chainId) {
    return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "direct chain identity is unavailable") };
  }
  // Every instantiated step carries the brief in its composed prompt, but the
  // implementation step is the direct chain's source of authority. Reading it
  // here avoids letting a later review-task description edit redefine the brief
  // that the implementation was instructed to transcribe.
  const source = await tx.task.findFirst({
    where: {
      projectId: candidate.task.projectId,
      templateId: candidate.task.templateId,
      chainId: candidate.task.chainId,
      chainIndex: 1,
    },
    select: { description: true },
  });
  if (!source) return { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "direct-chain implementation task is missing") };
  const text = featureBriefFromTaskDescription(source.description);
  return text === null
    ? { error: refusal(SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON, "direct-chain task brief is unavailable") }
    : { text };
};

type AuthorityResult = { text: string } | { error: SpecificationRefusal };

const authorityFor = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
): Promise<AuthorityResult> => {
  const templateName = candidate.task.templateStep?.taskTemplate?.name;
  return templateName === INTEGRATOR_TEMPLATE_NAME
    ? compoundAuthority(tx, candidate)
    : directAuthority(tx, candidate);
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

/** Snapshot all database-backed authority while the claim transaction is open. */
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

  const repository = githubRepositoryFromRemote(candidate.repo.remoteUrl) ?? candidate.repo.remoteUrl;
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

/** Perform only the bounded repository I/O; callers must invoke this outside transactions. */
export const verifyPreparedSpecification = async (
  verification: SpecificationVerification,
  reader: SpecificationReader | null,
  signal: AbortSignal,
): Promise<SpecificationRefusal | null> => {
  if (!reader) return refusal(SPEC_TRANSCRIPTION_UNREADABLE_REASON, "server-side repository content reader is unavailable");
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
    return refusal(SPEC_TRANSCRIPTION_UNREADABLE_REASON, detail);
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
