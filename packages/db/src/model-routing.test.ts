/**
 * The subpath's one structural promise, asserted rather than intended.
 *
 * `@anneal/db/model-routing` is imported by the browser bundle. If anything in
 * it ever acquires an import — `@prisma/client` above all, but equally a sibling
 * module that has one — the console starts shipping the control plane. The
 * assertion is therefore the strongest available and the cheapest to keep: the
 * file imports nothing at all, the same bar `merge-integrator.ts` holds.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ENFORCED_BY, MODELS, TOOL_KEYS } from "./model-routing.js";

const source = readFileSync(fileURLToPath(new URL("./model-routing.ts", import.meta.url)), "utf8");

test("the published subpath imports nothing at all", () => {
  const specifiers = [
    ...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gu),
    ...source.matchAll(/(?:^|\n)\s*import\s+"([^"]+)"/gu),
    ...source.matchAll(/\brequire\s*\(\s*"([^"]+)"/gu),
    ...source.matchAll(/\bimport\s*\(\s*"([^"]+)"/gu),
  ].map((match) => match[1]);
  assert.deepEqual(specifiers, []);
});

test("the package publishes it as a subpath resolving to built output", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.deepEqual(manifest.exports["./model-routing"], {
    types: "./src/model-routing.ts",
    import: "./dist/model-routing.js",
  });
});

test("every catalog runner is an enforced runner", () => {
  for (const entry of MODELS) assert.ok(Object.hasOwn(ENFORCED_BY, entry.runner), entry.id);
  for (const keys of Object.values(ENFORCED_BY)) {
    for (const key of keys) assert.ok(TOOL_KEYS.includes(key), key);
  }
});
