import { stepRole } from "@agentos/db";

const FEATURE_BRIEF_PREFIX = "\nFeature brief:\n";
const PRIOR_OUTPUTS_REMINDER = "\nRead the prior template steps' persisted outputs before working.";
const PERSIST_OUTPUT_PREFIX = "\nPersist the final ";
const PERSIST_OUTPUT_SUFFIX = " output for this step through the AgentOS task output endpoint.";

const BRIEF_HEADER_PREFIX = "\n<!-- agentos:task-brief:v1 length=";
const BRIEF_HEADER_SUFFIX = " -->\n";
const BRIEF_FOOTER = "\n<!-- /agentos:task-brief:v1 -->";

export type TaskBrief = {
  prompt: string;
  brief: string;
  hadReminder: boolean;
};

export type UnparseableTaskBrief = { unparseable: string };

type LocatedTaskBrief = TaskBrief & {
  suffix: string;
};

type LegacyBriefMigration = {
  legacyAttachmentsFromPrevious: boolean;
};

export const stepHasTaskBrief = (outputKind: string): boolean => {
  const role = stepRole({ outputKind });
  return role !== "readiness" && role !== "integrator";
};

const outputIsPlatformAuthored = (outputKind: string): boolean => {
  const role = stepRole({ outputKind });
  return role === "readiness" || role === "integrator" || role === "regression";
};

const frameBrief = (brief: string): string => (
  `${BRIEF_HEADER_PREFIX}${brief.length}${BRIEF_HEADER_SUFFIX}${brief}${BRIEF_FOOTER}`
);

export const composeBrief = (input: {
  prompt: string;
  brief?: string | undefined;
  attachmentsFromPrevious: boolean;
  outputKind: string;
}): string => {
  // Readiness and merge execution are server-owned mechanical Steps. Their
  // task cards preview the canonical prompt, but no model reads generated
  // brief, predecessor, or output-persistence context from them.
  if (!stepHasTaskBrief(input.outputKind)) return input.prompt;
  return [
    input.prompt,
    input.brief ? frameBrief(input.brief) : "",
    input.attachmentsFromPrevious ? PRIOR_OUTPUTS_REMINDER : "",
    outputIsPlatformAuthored(input.outputKind)
      ? ""
      : `${PERSIST_OUTPUT_PREFIX}${input.outputKind}${PERSIST_OUTPUT_SUFFIX}`,
  ].join("");
};

const readFencedBrief = (description: string): LocatedTaskBrief | UnparseableTaskBrief | null => {
  const headerStart = description.indexOf(BRIEF_HEADER_PREFIX);
  if (headerStart < 0) return null;
  const lengthStart = headerStart + BRIEF_HEADER_PREFIX.length;
  const headerEnd = description.indexOf(BRIEF_HEADER_SUFFIX, lengthStart);
  if (headerEnd < 0) return { unparseable: "task brief fence header is incomplete" };
  const encodedLength = description.slice(lengthStart, headerEnd);
  if (!/^\d+$/u.test(encodedLength)) return { unparseable: "task brief fence length is invalid" };
  const briefLength = Number(encodedLength);
  if (!Number.isSafeInteger(briefLength)) return { unparseable: "task brief fence length is unsafe" };
  const briefStart = headerEnd + BRIEF_HEADER_SUFFIX.length;
  const briefEnd = briefStart + briefLength;
  if (description.slice(briefEnd, briefEnd + BRIEF_FOOTER.length) !== BRIEF_FOOTER) {
    return { unparseable: "task brief fence does not match its declared length" };
  }
  const suffix = description.slice(briefEnd + BRIEF_FOOTER.length);
  return {
    prompt: description.slice(0, headerStart),
    brief: description.slice(briefStart, briefEnd),
    hadReminder: suffix.startsWith(PRIOR_OUTPUTS_REMINDER),
    suffix,
  };
};

/** Read descriptions written before fenced briefs were introduced. */
const readLegacyBrief = (
  description: string,
  attachmentsFromPrevious: boolean,
): LocatedTaskBrief | UnparseableTaskBrief => {
  const markerStart = description.indexOf(FEATURE_BRIEF_PREFIX);
  if (markerStart < 0) return { unparseable: "task brief marker is missing" };
  const briefStart = markerStart + FEATURE_BRIEF_PREFIX.length;
  const persistStart = description.lastIndexOf(PERSIST_OUTPUT_PREFIX);
  const suffixStart = persistStart >= briefStart ? persistStart : description.length;
  const reminderStart = suffixStart - PRIOR_OUTPUTS_REMINDER.length;
  const hadReminder = attachmentsFromPrevious
    && reminderStart >= briefStart
    && description.slice(reminderStart, suffixStart) === PRIOR_OUTPUTS_REMINDER;
  const briefEnd = hadReminder ? reminderStart : suffixStart;
  return {
    prompt: description.slice(0, markerStart),
    brief: description.slice(briefStart, briefEnd),
    hadReminder,
    suffix: description.slice(briefEnd),
  };
};

const locateBrief = (
  description: string,
  migration?: LegacyBriefMigration,
): LocatedTaskBrief | UnparseableTaskBrief => {
  const fenced = readFencedBrief(description);
  if (fenced !== null) return fenced;
  return migration
    ? readLegacyBrief(description, migration.legacyAttachmentsFromPrevious)
    : { unparseable: "task brief fence is missing" };
};

/** Read the direct Chain's Specification of record without caller-supplied encoding facts. */
export const readBrief = (
  description: string,
  migration?: LegacyBriefMigration,
): TaskBrief | UnparseableTaskBrief => {
  const result = locateBrief(description, migration);
  if ("unparseable" in result) return result;
  const { suffix: _suffix, ...brief } = result;
  return brief;
};

/** Replace only the brief and preserve the platform-authored prompt and suffix. */
export const rewriteBrief = (
  description: string,
  newBrief: string,
  migration?: LegacyBriefMigration,
): string | UnparseableTaskBrief => {
  const result = locateBrief(description, migration);
  if ("unparseable" in result) return result;
  return `${result.prompt}${frameBrief(newBrief)}${result.suffix}`;
};
