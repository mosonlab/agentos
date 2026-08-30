import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compare, denseOrdinals, layerOf, type ChainOrderRow } from "./chain-order.js";

const row = (
  id: string,
  layer: number | null,
  index: number | null,
): ChainOrderRow => ({ id, layer, index });

test("the browser-safe ordering module imports nothing", () => {
  const source = readFileSync(new URL("./chain-order.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/mu);
});

test("the package publishes chain-order as an isolated subpath", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    exports: Record<string, unknown>;
  };
  assert.deepEqual(packageJson.exports["./chain-order"], {
    types: "./src/chain-order.ts",
    import: "./dist/chain-order.js",
  });
});

test("layerOf prefers stored layer, falls back to index, and preserves an unknown layer", () => {
  assert.equal(layerOf(row("stored", 4, 1)), 4);
  assert.equal(layerOf(row("null-layer", null, 3)), 3);
  assert.equal(layerOf(row("null-index", 7, null)), 7);
  assert.equal(layerOf(row("both-null", null, null)), null);
});

test("the named last sentinel puts missing execution metadata after persisted layers", () => {
  const missing = layerOf(row("missing", null, null), { missing: "last" });
  assert.equal(missing, Number.MAX_SAFE_INTEGER);
  assert.ok(missing > layerOf(row("known", 9, null), { missing: "last" }));
});

test("compare is total across layer ties, null indexes, and ids", () => {
  const rows = [
    row("missing", null, null),
    row("layer-two-null-index", 2, null),
    row("layer-one-b", 1, 4),
    row("layer-one-a", 1, 4),
    row("legacy", null, 3),
  ];

  assert.deepEqual([...rows].sort(compare).map(({ id }) => id), [
    "layer-one-a",
    "layer-one-b",
    "layer-two-null-index",
    "legacy",
    "missing",
  ]);
  assert.equal(compare(row("same", 1, 2), row("same", 1, 2)), 0);
});

test("denseOrdinals is one-based across sparse layers and the named sentinel", () => {
  const ordinals = denseOrdinals([
    row("parallel-a", 40, 2),
    row("unknown", null, null),
    row("first", 10, 1),
    row("parallel-b", 40, 3),
    row("legacy", null, 90),
  ]);

  assert.deepEqual([...ordinals], [
    [10, 1],
    [40, 2],
    [90, 3],
    [Number.MAX_SAFE_INTEGER, 4],
  ]);
});
