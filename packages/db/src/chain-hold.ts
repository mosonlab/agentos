import { ChainControlState, Prisma } from "@prisma/client";

import { layerOf, type ChainLayerRow } from "./chain-order.js";

export type ChainHoldSubject = ChainLayerRow & {
  projectId: string;
  chainId: string | null;
};

export type ChainHoldControl = {
  projectId: string;
  chainId: string;
  state: ChainControlState;
  heldLayer: number | null;
};

/**
 * Answers whether one Step is beyond its persisted Chain hold. Unknown Step
 * execution metadata and an invalid HELD control without a layer both fail
 * closed. An absent, released, or differently addressed control is unheld.
 */
export const heldPredicate = (
  subject: ChainHoldSubject,
  control: ChainHoldControl | null | undefined,
): boolean => {
  if (control?.state !== ChainControlState.HELD
    || subject.chainId === null
    || control.projectId !== subject.projectId
    || control.chainId !== subject.chainId) return false;
  const subjectLayer = layerOf(subject);
  return control.heldLayer === null || subjectLayer === null || subjectLayer > control.heldLayer;
};

/** Prisma expression for every Task refused by one persisted control row. */
export const heldWhere = (control: ChainHoldControl): Prisma.TaskWhereInput | null => {
  if (control.state !== ChainControlState.HELD) return null;
  const address = { projectId: control.projectId, chainId: control.chainId };
  if (control.heldLayer === null) return address;
  return {
    ...address,
    OR: [
      { chainLayer: { gt: control.heldLayer } },
      {
        chainLayer: null,
        OR: [
          { chainIndex: { gt: control.heldLayer } },
          { chainIndex: null },
        ],
      },
    ],
  };
};

/**
 * Raw SQL expression equivalent to heldPredicate. The arguments are trusted
 * SQL fragments naming the Task and ChainControl aliases in the caller query.
 */
export const heldSql = (task: Prisma.Sql, control: Prisma.Sql): Prisma.Sql => Prisma.sql`
  ${control}."projectId" = ${task}."projectId"
  AND ${control}."chainId" = ${task}."chainId"
  AND ${control}."state" = lower(${ChainControlState.HELD})::"ChainControlState"
  AND (
    ${control}."heldLayer" IS NULL
    OR COALESCE(${task}."chainLayer", ${task}."chainIndex") IS NULL
    OR COALESCE(${task}."chainLayer", ${task}."chainIndex") > ${control}."heldLayer"
  )
`;
