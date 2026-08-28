import {
  githubRepositoryFromRemote,
  isDirectImplementationStep,
  Prisma,
  stepRole,
} from "@anneal/db";

import { abortableDelay, abortReason } from "./abortable-delay.js";
import { isCanonicalBlindFindingsStep, isCanonicalSolFindingsStep } from "./canonical-task-output.js";
import { isValidBranchName } from "./branch-name.js";
import { GitHubReadError } from "./github-read.js";
import { readBrief } from "./task-brief.js";

/** Stable, operator-visible reasons for the distinct fail-closed outcomes. */
export const SPEC_TRANSCRIPTION_REFUSAL_REASON = "spec-transcription-mismatch";
export const SPEC_TRANSCRIPTION_UNREADABLE_REASON = "spec-transcription-unreadable";
export const SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON = "spec-transcription-authority-missing";

export type SpecificationRefusalReason =
  | typeof SPEC_TRANSCRIPTION_REFUSAL_REASON
  | typeof SPEC_TRANSCRIPTION_UNREADABLE_REASON
  | typeof SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON;

export type SpecificationRefusalClassification = "transient" | "non-transient";

export type SpecificationRefusal = {
  reason: SpecificationRefusalReason;
  classification: SpecificationRefusalClassification;
  message: string;
};

/** The path the implementation step promises to materialize. */
export const specificationPathForBranch = (branch: string): string => `.chain/${branch}/spec.md`;

export type SpecificationMaterialization = {
  kind: "direct-implementation";
  path: string;
  body: string;
};

/** Prepare the direct-chain brief for runner-owned workspace bootstrap. */
export const specificationMaterializationForDirectImplementation = (
  task: {
    description: string;
    templateId?: string | null;
    chainId?: string | null;
    templateStep?: {
      stepIndex?: number;
      outputKind?: string;
      priorOutputKinds: readonly string[];
      taskTemplate?: { name: string } | null;
    } | null;
  },
  branch: string | null,
): SpecificationMaterialization | null => {
  if (!task.templateId || !task.chainId
    || !isDirectImplementationStep(task.templateStep ?? null)
    || !branch || !isValidBranchName(branch)) return null;
  const parsed = readBrief(task.description, {
    legacyAttachmentsFromPrevious: (task.templateStep?.priorOutputKinds.length ?? 0) > 0,
  });
  return "unparseable" in parsed ? null : {
    kind: "direct-implementation",
    path: specificationPathForBranch(branch),
    body: parsed.brief,
  };
};

/** Narrow repository capability needed by review-claim verification. */
export type SpecificationReader = {
  readFileAtCommit: (
    repository: string,
    path: string,
    commitSha: string,
    signal: AbortSignal,
    /** The exact original Repo.remoteUrl used to key the runner mirror. */
    remoteUrl: string,
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

/** Normalize CR variants and ignore one optional trailing LF without decoding arbitrary bytes. */
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
  if (normalized.at(-1) === 0x0a) normalized.pop();
  return Uint8Array.from(normalized);
};

const refusal = (
  reason: SpecificationRefusalReason,
  detail: string,
  classification: SpecificationRefusalClassification,
): SpecificationRefusal => ({
  reason,
  classification,
  message: `Spec transcription claim refused: ${reason}: ${detail}`,
});

export const specificationUnreadableRefusal = (
  detail: string,
  classification: SpecificationRefusalClassification,
): SpecificationRefusal => (
  refusal(SPEC_TRANSCRIPTION_UNREADABLE_REASON, detail, classification)
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

type AuthoritySource = {
  description: string;
  templateStep: { outputKind: string; priorOutputKinds: string[] } | null;
  stepOutput: { kind: string; body: string } | null;
};

const compoundAuthority = (source: AuthoritySource): AuthorityResult => {
  if (!source.stepOutput) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "approved specification output is missing",
      "non-transient",
    ) };
  }
  if (source.stepOutput.kind !== "spec") {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "approved specification output has an unexpected kind",
      "non-transient",
    ) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.stepOutput.body);
  } catch {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "approved specification output is not valid JSON",
      "non-transient",
    ) };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.spec !== "string") {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "approved specification output has no canonical spec field",
      "non-transient",
    ) };
  }
  return { text: parsed.spec };
};

const directAuthority = (source: AuthoritySource): AuthorityResult => {
  if (!source.templateStep) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "direct-chain implementation step metadata is missing",
      "non-transient",
    ) };
  }
  const parsed = readBrief(source.description, {
    legacyAttachmentsFromPrevious: source.templateStep.priorOutputKinds.length > 0,
  });
  return "unparseable" in parsed
    ? { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "direct-chain task brief is unavailable",
      "non-transient",
    ) }
    : { text: parsed.brief };
};

type AuthorityResult = { text: string } | { error: SpecificationRefusal };

const authorityFor = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
): Promise<AuthorityResult> => {
  if (!candidate.task.templateId || !candidate.task.chainId) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "chain identity is unavailable",
      "non-transient",
    ) };
  }
  const sources = await tx.task.findMany({
    where: {
      projectId: candidate.task.projectId,
      templateId: candidate.task.templateId,
      chainId: candidate.task.chainId,
    },
    select: {
      description: true,
      templateStep: { select: { outputKind: true, priorOutputKinds: true } },
      stepOutput: { select: { kind: true, body: true } },
    },
  });
  const sourcesForRole = (role: "spec" | "implementation") => sources.filter((source) => (
    source.templateStep !== null && stepRole(source.templateStep) === role
  ));
  const specificationSources = sourcesForRole("spec");
  if (specificationSources.length > 1) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "compound chain has multiple specification steps",
      "non-transient",
    ) };
  }
  if (specificationSources[0]) return compoundAuthority(specificationSources[0]);

  const implementationSources = sourcesForRole("implementation");
  if (implementationSources.length !== 1) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      implementationSources.length === 0
        ? "direct-chain implementation task is missing"
        : "direct chain has multiple implementation steps",
      "non-transient",
    ) };
  }
  return directAuthority(implementationSources[0]!);
};

export type SpecificationVerification = {
  key: string;
  repository: string;
  /** Exact remote URL used by the runner mirror's hash key. */
  remoteUrl: string;
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
      "non-transient",
    ) };
  }
  if (!candidate.branch || !isValidBranchName(candidate.branch)) {
    return { status: "refused", refusal: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "materialized specification branch is unavailable",
      "non-transient",
    ) };
  }

  const authority = await authorityFor(tx, candidate);
  if ("error" in authority) return { status: "refused", refusal: authority.error };

  const repository = githubRepositoryFromRemote(candidate.repo.remoteUrl);
  if (!repository) {
    return { status: "refused", refusal: specificationUnreadableRefusal(
      `repository remote is not a supported GitHub repository: ${candidate.repo.remoteUrl}`,
      "non-transient",
    ) };
  }
  const path = specificationPathForBranch(candidate.branch);
  const authoritativeBytes = new TextEncoder().encode(authority.text);
  return {
    status: "ready",
    verification: {
      key: [
        candidate.task.id,
        repository,
        candidate.repo.remoteUrl,
        implementationHeadSha,
        candidate.branch,
        authority.text,
      ].join("\0"),
      repository,
      remoteUrl: candidate.repo.remoteUrl,
      path,
      implementationHeadSha,
      authoritativeBytes,
    },
  };
};

const isAbortError = (error: unknown): boolean => (
  error instanceof Error && error.name === "AbortError"
);

export type SpecificationReadFailureKind = "transient" | "permanent";

const TRANSIENT_SYSTEM_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

/** Only transport and deadline failures are retried; repository/content responses fail closed immediately. */
export const classifySpecificationReadFailure = (error: unknown): SpecificationReadFailureKind => {
  if (error instanceof GitHubReadError) {
    return error.kind === "timeout" || error.kind === "transport" ? "transient" : "permanent";
  }
  if (isAbortError(error)) return "transient";
  const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return code && TRANSIENT_SYSTEM_ERROR_CODES.has(code) ? "transient" : "permanent";
};

type SpecificationReadRetryOptions = {
  retryDelaysMs?: readonly number[];
  attemptTimeoutsMs?: readonly number[];
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

// Three reads and both backoffs preserve the claim-side read's existing 4s total bound.
const SPECIFICATION_READ_ATTEMPT_TIMEOUTS_MS = [1_200, 1_200, 1_200] as const;
const SPECIFICATION_READ_RETRY_DELAYS_MS = [100, 300] as const;

const failureDetail = (error: unknown): string => (
  error instanceof Error ? error.message : "repository content read failed"
);

/** Perform repository I/O only; callers must invoke this outside a transaction. */
export const verifyPreparedSpecification = async (
  verification: SpecificationVerification,
  reader: SpecificationReader | null,
  signal: AbortSignal,
  options: SpecificationReadRetryOptions = {},
): Promise<SpecificationRefusal | null> => {
  if (!reader) return specificationUnreadableRefusal(
    "server-side repository content reader is unavailable",
    "non-transient",
  );
  const retryDelaysMs = options.retryDelaysMs ?? SPECIFICATION_READ_RETRY_DELAYS_MS;
  const attemptTimeoutsMs = options.attemptTimeoutsMs ?? SPECIFICATION_READ_ATTEMPT_TIMEOUTS_MS;
  const wait = options.wait ?? abortableDelay;
  let materialized: Uint8Array | undefined;
  for (let attempt = 0; materialized === undefined; attempt += 1) {
    signal.throwIfAborted();
    const attemptDeadline = new AbortController();
    const abortFromRequest = (): void => attemptDeadline.abort(abortReason(signal));
    signal.addEventListener("abort", abortFromRequest, { once: true });
    const timeoutMs = attemptTimeoutsMs[Math.min(attempt, attemptTimeoutsMs.length - 1)] ?? 4_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attemptDeadline.abort();
    }, timeoutMs);
    let failure: unknown;
    try {
      materialized = await reader.readFileAtCommit(
        verification.repository,
        verification.path,
        verification.implementationHeadSha,
        attemptDeadline.signal,
        verification.remoteUrl,
      );
      continue;
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      failure = timedOut
        ? new GitHubReadError(`repository content read exceeded the ${timeoutMs}ms server deadline`, "timeout")
        : error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortFromRequest);
    }

    const detail = failureDetail(failure);
    const failureKind = classifySpecificationReadFailure(failure);
    const delayMs = retryDelaysMs[attempt];
    if (failureKind === "permanent" || delayMs === undefined) {
      return specificationUnreadableRefusal(
        delayMs === undefined && attempt > 0
          ? `after ${attempt} retries (${attempt + 1} total attempts); last failure: ${detail}`
          : detail,
        failureKind === "transient" ? "transient" : "non-transient",
      );
    }
    await wait(delayMs, signal);
  }
  return bytesEqual(
    normalizeLineEndings(materialized),
    normalizeLineEndings(verification.authoritativeBytes),
  )
    ? null
    : refusal(
      SPEC_TRANSCRIPTION_REFUSAL_REASON,
      `materialized ${verification.path} does not match the authoritative specification`,
      "non-transient",
    );
};
