export const COMPLETION_REJECTION_ACTIVITY_KIND = "mergeExecutor.completionRejected";

export type CompletionRejection = {
  status: number;
  responseBody: string;
};

export type CompletionRejectionParseResult =
  | { status: "ok"; rejection: CompletionRejection }
  | { status: "different-run" }
  | { status: "malformed" };

export const parseCompletionRejection = (
  metadata: unknown,
  sourceRunId: string,
): CompletionRejectionParseResult => {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return { status: "malformed" };
  }
  const record = metadata as Record<string, unknown>;
  if (record.kind !== COMPLETION_REJECTION_ACTIVITY_KIND
    || typeof record.sourceRunId !== "string") {
    return { status: "malformed" };
  }
  if (record.sourceRunId !== sourceRunId) return { status: "different-run" };
  if (record.schemaVersion !== 1
    || typeof record.status !== "number"
    || !Number.isInteger(record.status)
    || record.status < 100
    || record.status > 599
    || typeof record.responseBody !== "string") {
    return { status: "malformed" };
  }
  return { status: "ok", rejection: { status: record.status, responseBody: record.responseBody } };
};
