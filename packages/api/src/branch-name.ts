const BRANCH_FORBIDDEN = /[\s~^:?*[\\]/u;

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** Shared final authority for every branch name accepted by the API.
 * Mirrors `git check-ref-format --branch` for the supported AgentOS forms. */
export const isValidBranchName = (value: string): boolean => {
  if (value.length === 0 || value.length > 255) return false;
  if (hasControlCharacter(value) || BRANCH_FORBIDDEN.test(value)) return false;
  if (value === "@" || value === "HEAD" || value.startsWith("refs/")) return false;
  if (value.startsWith("-") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("@{")) return false;
  return value.split("/").every((segment) => (
    segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock")
  ));
};
