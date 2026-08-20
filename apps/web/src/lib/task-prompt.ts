export type TaskPromptParts = {
  responsibility: string;
  productContract: string | null;
};

const CONTRACT_MARKER = "Product Contract:";
const RESPONSIBILITY_MARKERS = ["Step responsibility:", "Human gate responsibility:"] as const;

/** Separates the per-step instruction from the common contract without
 * pretending that any runner-only prompt components are present in this body. */
export const partitionTaskPrompt = (description: string): TaskPromptParts => {
  const contractAt = description.indexOf(CONTRACT_MARKER);
  const marker = RESPONSIBILITY_MARKERS
    .map((candidate) => ({ candidate, at: description.indexOf(candidate) }))
    .filter(({ at }) => at >= 0)
    .sort((left, right) => left.at - right.at)[0];
  const responsibilityAt = marker?.at ?? -1;
  if (contractAt < 0 || responsibilityAt < 0 || responsibilityAt <= contractAt) {
    return { responsibility: description.trim(), productContract: null };
  }
  const prefix = description.slice(0, contractAt).trim();
  const responsibility = description.slice(responsibilityAt + marker!.candidate.length).trim();
  return {
    responsibility: [prefix, responsibility].filter(Boolean).join("\n\n"),
    productContract: description.slice(contractAt, responsibilityAt).trim(),
  };
};
