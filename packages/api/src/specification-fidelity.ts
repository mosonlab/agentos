import {
  DIRECT_TEMPLATE_NAME,
  githubRepositoryFromRemote,
  INTEGRATOR_TEMPLATE_NAME,
  Prisma,
} from "@agentos/db";

import { isCanonicalBlindFindingsStep, isCanonicalSolFindingsStep } from "./canonical-task-output.js";
import { isValidBranchName } from "./branch-name.js";

/** Stable, machine-readable reason included in every claim refusal from this check. */
export const SPEC_TRANSCRIPTION_REFUSAL_REASON = "spec-transcription-mismatch";

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
  ) => Promise<Uint8Array | null>;
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

const FEATURE_BRIEF_MARKER = /Feature brief:\r?\n/u;
const PERSIST_OUTPUT_MARKER = /\r?\nPersist the final /u;

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

/** Extract the original direct-chain brief from the composed implementation prompt. */
export const directTaskBriefFromDescription = (description: string): string | null => {
  const marker = FEATURE_BRIEF_MARKER.exec(description);
  if (!marker || marker.index < 0) return null;
  const start = marker.index + marker[0].length;
  let suffix = -1;
  let offset = start;
  while (offset < description.length) {
    const match = PERSIST_OUTPUT_MARKER.exec(description.slice(offset));
    if (!match || match.index === undefined) break;
    suffix = offset + match.index;
    offset = suffix + match[0].length;
  }
  if (suffix < start) return null;
  return description.slice(start, suffix);
};

const refusal = (detail: string): string =>
  `Spec transcription claim refused: ${SPEC_TRANSCRIPTION_REFUSAL_REASON}: ${detail}`;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const compoundAuthority = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
): Promise<{ text: string } | { error: string }> => {
  if (!candidate.task.templateId || !candidate.task.chainId) {
    return { error: refusal("compound chain identity is unavailable") };
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
  if (!source) return { error: refusal("approved specification output is missing") };
  if (source.kind !== "spec") return { error: refusal("approved specification output has an unexpected kind") };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.body);
  } catch {
    return { error: refusal("approved specification output is not valid JSON") };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.spec !== "string") {
    return { error: refusal("approved specification output has no canonical spec field") };
  }
  return { text: parsed.spec };
};

const directAuthority = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
): Promise<{ text: string } | { error: string }> => {
  if (!candidate.task.templateId || !candidate.task.chainId) {
    return { error: refusal("direct chain identity is unavailable") };
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
  if (!source) return { error: refusal("direct-chain implementation task is missing") };
  const text = directTaskBriefFromDescription(source.description);
  return text === null ? { error: refusal("direct-chain task brief is unavailable") } : { text };
};

const authorityFor = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
): Promise<{ text: string } | { error: string }> => {
  const templateName = candidate.task.templateStep?.taskTemplate?.name;
  if (templateName === INTEGRATOR_TEMPLATE_NAME) return compoundAuthority(tx, candidate);
  if (templateName === DIRECT_TEMPLATE_NAME) return directAuthority(tx, candidate);
  return { error: refusal(`unsupported review template ${templateName ?? "missing"}`) };
};

/**
 * Verify the immutable implementation head contains exactly the specification
 * its chain was authorized to review. A non-null error is a claim refusal; the
 * caller must leave the queued run untouched and surface it to the runner.
 */
export const specificationTranscriptionRefusal = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
  implementationHeadSha: string | null,
  reader: SpecificationReader | null,
  signal: AbortSignal,
): Promise<string | null> => {
  const step = candidate.task.templateStep;
  if (!step || (!isCanonicalSolFindingsStep(step) && !isCanonicalBlindFindingsStep(step))) return null;
  if (!reader) return refusal("server-side repository content reader is unavailable");
  if (!implementationHeadSha) return refusal("pinned implementation head is unavailable");
  if (!candidate.branch || !isValidBranchName(candidate.branch)) return refusal("materialized specification branch is unavailable");

  const authority = await authorityFor(tx, candidate);
  if ("error" in authority) return authority.error;

  const repository = githubRepositoryFromRemote(candidate.repo.remoteUrl) ?? candidate.repo.remoteUrl;
  const path = specificationPathForBranch(candidate.branch);
  let materialized: Uint8Array | null;
  try {
    materialized = await reader.readFileAtCommit(repository, path, implementationHeadSha, signal);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "repository content read failed";
    return refusal(detail);
  }
  if (!materialized) return refusal(`materialized ${path} is missing from the implementation head`);
  const authoritativeBytes = new TextEncoder().encode(authority.text);
  return bytesEqual(normalizeLineEndings(materialized), normalizeLineEndings(authoritativeBytes))
    ? null
    : refusal(`materialized ${path} does not match the authoritative specification`);
};
