export const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

export const asString = (value: unknown): string | null => typeof value === "string" ? value : null;

export const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Join the text parts of a provider content array. Tool-only and malformed
 * messages deliberately contribute no visible text. */
export const contentText = (content: unknown): string => asArray(content)
  .map((part) => asString(asRecord(part)?.text))
  .filter((part): part is string => part !== null)
  .join("\n");

/** PI's textSignature is a JSON string carrying the provider message identity. */
export const textSignatureId = (content: unknown): string | null => {
  for (const part of asArray(content)) {
    const signature = asString(asRecord(part)?.textSignature);
    if (signature === null) continue;
    try {
      const id = asString(asRecord(JSON.parse(signature) as unknown)?.id);
      if (id !== null) return id;
    } catch {
      // An unparseable provider signature contributes no deduplication key.
    }
  }
  return null;
};
