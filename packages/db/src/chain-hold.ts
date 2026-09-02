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
  /** Operator-facing dense ordinal. Zero means no layer was admitted. */
  heldLayer: number | null;
  /** Stored effective layer used by producer barriers; null for before-first. */
  heldExecutionLayer?: number | null;
};

const executionBarrier = (control: ChainHoldControl): number | null => (
  control.heldLayer === 0 && control.heldExecutionLayer == null
    ? null
    : control.heldExecutionLayer ?? control.heldLayer
);

export const heldBeforeFirstLayer = (control: ChainHoldControl): boolean => (
  control.state === ChainControlState.HELD
  && control.heldLayer === 0
  && control.heldExecutionLayer == null
);

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
  const barrier = executionBarrier(control);
  return heldBeforeFirstLayer(control)
    || control.heldLayer === null
    || subjectLayer === null
    || barrier === null
    || subjectLayer > barrier;
};

/** Prisma expression for every Task refused by one persisted control row. */
export const heldWhere = (control: ChainHoldControl): Prisma.TaskWhereInput | null => {
  if (control.state !== ChainControlState.HELD) return null;
  const address = { projectId: control.projectId, chainId: control.chainId };
  const barrier = executionBarrier(control);
  if (control.heldLayer === null || heldBeforeFirstLayer(control) || barrier === null) return address;
  return {
    ...address,
    OR: [
      { chainLayer: { gt: barrier } },
      {
        chainLayer: null,
        OR: [
          { chainIndex: { gt: barrier } },
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
    OR (${control}."heldLayer" = 0 AND ${control}."heldExecutionLayer" IS NULL)
    OR COALESCE(${task}."chainLayer", ${task}."chainIndex") IS NULL
    OR COALESCE(${task}."chainLayer", ${task}."chainIndex")
      > COALESCE(${control}."heldExecutionLayer", ${control}."heldLayer")
  )
`;
