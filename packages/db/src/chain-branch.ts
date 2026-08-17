import { createHash } from "node:crypto";

/**
 * The single branch every run of every step of one `chainId` chain pushes to.
 *
 * Derived, never stored: a column would be a second source of truth that can
 * disagree with this function, and the very first run of a chain — the one that
 * must create the branch — has no earlier row to read it from.
 *
 * The key is `${projectId}:${chainId}`, the same pair `chainKey`
 * (`packages/api/src/chain.ts`) uses, because that pair is what the platform
 * means by "one chain": `activateChainSuccessor` scopes its successor lookup by
 * both. It is spelled out here rather than imported because `@agentos/api`
 * depends on `@agentos/db` and not the reverse; `chain-branch.test.ts` asserts
 * the two agree.
 *
 * Both halves of the name are load-bearing. The slug is for the operator reading
 * `git branch`; the fingerprint is for correctness, because `chainId` is
 * free-form operator input (`z.string().trim().min(1).max(100)`) that may not be
 * a legal git ref, may collide after slugging, and may be reused by another
 * project — `@@unique([chainId, chainIndex])` does not scope it per project.
 *
 * The name does not depend on the repo. Two steps of one chain on different
 * repos get the same name on each remote, which spec R2 requires; those are
 * different refs and do not interact. Whether a given remote *has* the ref is a
 * separate question, answered by `resolveRunBranches` from `Run.pushedBranch`
 * scoped by `repoId` — never by this function.
 */
export const sharedChainBranch = ({ projectId, chainId }: { projectId: string; chainId: string }): string => {
  const fingerprint = createHash("sha256").update(`${projectId}:${chainId}`).digest("hex").slice(0, 8);
  const slug = chainId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return `agentos/chain/${slug || "chain"}-${fingerprint}`;
};
