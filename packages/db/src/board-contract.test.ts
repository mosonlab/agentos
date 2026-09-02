import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(fileURLToPath(new URL("./board-contract.ts", import.meta.url)), "utf8");

test("the browser-safe board contract imports only types", () => {
  const runtimeSpecifiers = [
    ...source.matchAll(/(?:^|\n)\s*import(?!\s+type\b)[^;]*?from\s+"([^"]+)"/gu),
    ...source.matchAll(/(?:^|\n)\s*import\s+"([^"]+)"/gu),
    ...source.matchAll(/(?:^|\n)\s*export(?!\s+type\b)[^;]*?from\s+"([^"]+)"/gu),
    ...source.matchAll(/\brequire\s*\(\s*"([^"]+)"/gu),
    ...source.matchAll(/\bimport\s*\(\s*"([^"]+)"/gu),
  ].map((match) => match[1]);
  assert.deepEqual(runtimeSpecifiers, []);

  const typeSpecifiers = [
    ...source.matchAll(/(?:^|\n)\s*import\s+type\b[^;]*?from\s+"([^"]+)"/gu),
  ].map((match) => match[1]);
  assert.deepEqual(typeSpecifiers, ["@prisma/client", "./wire-contract.js"]);
});

test("the package publishes the board contract as an isolated subpath", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.deepEqual(manifest.exports["./board-contract"], {
    types: "./src/board-contract.ts",
    development: "./src/board-contract.ts",
    import: "./dist/board-contract.js",
  });
});
