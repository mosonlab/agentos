/**
 * Browser-safe Chain execution ordering.
 *
 * Callers adapt their persisted or wire field names to this small structural
 * interface. A stored layer is authoritative, with the Chain index retained
 * only as the legacy compatibility fallback.
 */

export type ChainLayerRow = {
  layer: number | null;
  index: number | null;
};

export type ChainOrderRow = ChainLayerRow & {
  id: string;
};

export type MissingLayerOptions = {
  /** Unknown execution metadata sorts after every persisted layer. */
  missing: "last";
};

const MISSING_LAYER_LAST = Number.MAX_SAFE_INTEGER;

export function layerOf(row: ChainLayerRow): number | null;
export function layerOf(row: ChainLayerRow, options: MissingLayerOptions): number;
export function layerOf(row: ChainLayerRow, options?: MissingLayerOptions): number | null {
  return row.layer ?? row.index ?? (options?.missing === "last" ? MISSING_LAYER_LAST : null);
}

const numberOrder = (left: number, right: number): number => (
  left < right ? -1 : left > right ? 1 : 0
);

const textOrder = (left: string, right: string): number => (
  left < right ? -1 : left > right ? 1 : 0
);

/** Total execution order: effective layer, legacy index, then stable row id. */
export const compare = (left: ChainOrderRow, right: ChainOrderRow): number => (
  numberOrder(layerOf(left, { missing: "last" }), layerOf(right, { missing: "last" }))
    || numberOrder(left.index ?? MISSING_LAYER_LAST, right.index ?? MISSING_LAYER_LAST)
    || textOrder(left.id, right.id)
);

/** Dense one-based ordinals keyed by effective layer in execution order. */
export const denseOrdinals = (rows: readonly ChainLayerRow[]): ReadonlyMap<number, number> => {
  const layers = [...new Set(rows.map((row) => layerOf(row, { missing: "last" })))]
    .sort(numberOrder);
  return new Map(layers.map((layer, index) => [layer, index + 1]));
};
