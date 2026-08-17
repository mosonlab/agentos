export type TaskPromptParts = {
  responsibility: string;
  productContract: string | null;
};

const CONTRACT_MARKER = "Product Contract:";
const RESPONSIBILITY_MARKER = "Step responsibility:";

/** Separates the per-step instruction from the common contract without
 * pretending that any runner-only prompt components are present in this body. */
export const partitionTaskPrompt = (description: string): TaskPromptParts => {
  const contractAt = description.indexOf(CONTRACT_MARKER);
  const responsibilityAt = description.indexOf(RESPONSIBILITY_MARKER);
  if (contractAt < 0 || responsibilityAt < 0 || responsibilityAt <= contractAt) {
    return { responsibility: description.trim(), productContract: null };
  }
  const prefix = description.slice(0, contractAt).trim();
  const responsibility = description.slice(responsibilityAt + RESPONSIBILITY_MARKER.length).trim();
  return {
    responsibility: [prefix, responsibility].filter(Boolean).join("\n\n"),
    productContract: description.slice(contractAt, responsibilityAt).trim(),
  };
};
