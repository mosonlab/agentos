/**
 * The one way a canonical role addresses an Agent row.
 *
 * R9 made `canonicalRole` the canonical identity of an Agent and left `name`
 * operator-editable. Every caller that means "the Agent installed from
 * `agents/roles/<role>.md`" therefore has to resolve the role column first and
 * treat the name only as the legacy spelling of a row installed before the
 * column existed.
 *
 * Doing that as one `findFirst` with `OR: [{ canonicalRole }, { canonicalRole:
 * null, name }]` is what this module replaces: after a legitimate rename an
 * operator may create their own Agent under the freed slug, both branches then
 * match, and an unordered `findFirst` may bind a template step — or, in the
 * seed, write a canonical role — onto the operator's row. The two reads here
 * are ordered instead: the role row wins whenever it exists, and a same-named
 * custom row is never touched.
 */
import type { Prisma } from "@prisma/client";

const canonicalAgentSelect = {
  id: true,
  name: true,
  canonicalRole: true,
  customizedFields: true,
  archivedAt: true,
} as const satisfies Prisma.AgentSelect;

export type CanonicalAgentRow = {
  id: string;
  name: string;
  canonicalRole: string | null;
  customizedFields: string[];
  archivedAt: Date | null;
};

/**
 * The Agent one canonical role addresses in one project, or null.
 *
 * `activeOnly` decides whether an archived row answers. An archived *role* row
 * answers null rather than falling through to the legacy name branch: the role
 * is taken, and a same-named row is somebody else's Agent.
 */
export const findCanonicalAgent = async (
  tx: Prisma.TransactionClient,
  input: { projectId: string; canonicalRole: string; activeOnly: boolean },
): Promise<CanonicalAgentRow | null> => {
  const byRole = await tx.agent.findUnique({
    where: { projectId_canonicalRole: { projectId: input.projectId, canonicalRole: input.canonicalRole } },
    select: canonicalAgentSelect,
  });
  if (byRole) return input.activeOnly && byRole.archivedAt !== null ? null : byRole;
  return tx.agent.findFirst({
    where: {
      projectId: input.projectId,
      canonicalRole: null,
      name: input.canonicalRole,
      ...(input.activeOnly ? { archivedAt: null } : {}),
    },
    select: canonicalAgentSelect,
  });
};
