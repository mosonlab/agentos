import { ChainControlState, Prisma } from "@prisma/client";

type ChainControlDb = Pick<Prisma.TransactionClient, "chainControl">;

export type ChainControlKey = {
  projectId: string;
  chainId: string;
};

/**
 * The one shared read of the persisted Chain hold authority. Every requested
 * key receives a value: an absent row and a RELEASED row both become the same
 * not-held snapshot, while a HELD row retains the layer and audit facts needed
 * by admission, activation and claim callers. The map is keyed by the same
 * project/Chain pair used by Chain progress readers because chainId alone is
 * only project-local identity.
 */
export type ChainControlSnapshot = {
  projectId: string;
  chainId: string;
  state: ChainControlState;
  held: boolean;
  heldLayer: number | null;
  heldAt: Date | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: Date | null;
  releaseRequestId: string | null;
  holdGeneration: number;
};

export const chainControlKey = ({ projectId, chainId }: ChainControlKey): string => `${projectId}:${chainId}`;

const notHeld = ({ projectId, chainId }: ChainControlKey): ChainControlSnapshot => ({
  projectId,
  chainId,
  state: ChainControlState.RELEASED,
  held: false,
  heldLayer: null,
  heldAt: null,
  holdRequestId: null,
  holdReason: null,
  releasedAt: null,
  releaseRequestId: null,
  holdGeneration: 0,
});

const snapshot = (row: {
  projectId: string;
  chainId: string;
  state: ChainControlState;
  heldLayer: number | null;
  heldAt: Date | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: Date | null;
  releaseRequestId: string | null;
  holdGeneration: number;
}): ChainControlSnapshot => ({
  projectId: row.projectId,
  chainId: row.chainId,
  state: row.state,
  held: row.state === ChainControlState.HELD,
  heldLayer: row.heldLayer,
  heldAt: row.heldAt,
  holdRequestId: row.holdRequestId,
  holdReason: row.holdReason,
  releasedAt: row.releasedAt,
  releaseRequestId: row.releaseRequestId,
  holdGeneration: row.holdGeneration,
});

export const readChainControls = async (
  tx: ChainControlDb,
  keys: readonly ChainControlKey[],
): Promise<Map<string, ChainControlSnapshot>> => {
  const unique = [...new Map(keys.map((key) => [chainControlKey(key), key])).values()];
  if (unique.length === 0) return new Map();
  const rows = await tx.chainControl.findMany({
    where: { OR: unique },
    select: {
      projectId: true,
      chainId: true,
      state: true,
      heldLayer: true,
      heldAt: true,
      holdRequestId: true,
      holdReason: true,
      releasedAt: true,
      releaseRequestId: true,
      holdGeneration: true,
    },
  });
  const byKey = new Map(rows.map((row) => [chainControlKey(row), snapshot(row)]));
  return new Map(unique.map((key) => [chainControlKey(key), byKey.get(chainControlKey(key)) ?? notHeld(key)]));
};

export const readChainControl = async (
  tx: ChainControlDb,
  key: ChainControlKey,
): Promise<ChainControlSnapshot> => (
  (await readChainControls(tx, [key])).get(chainControlKey(key)) ?? notHeld(key)
);
