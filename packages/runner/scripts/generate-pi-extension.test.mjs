import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { generatedPiExtension, PI_EXTENSION, RECEIPT_MODULE } from "./generate-pi-extension.mjs";

test("the pi extension in git is the one generated from the receipt module", () => {
  assert.equal(
    readFileSync(PI_EXTENSION, "utf8"),
    generatedPiExtension(),
    "run `node packages/runner/scripts/generate-pi-extension.mjs`",
  );
});

test("the generated region carries the whole writer and the asset defines it nowhere else", () => {
  const generated = generatedPiExtension();
  const module = readFileSync(RECEIPT_MODULE, "utf8");
  for (const symbol of ["taskOutputReceiptPath", "writeTaskOutputReceipt"]) {
    const definition = `export const ${symbol} =`;
    assert.ok(module.includes(definition), `${symbol} must be defined in the receipt module`);
    assert.equal(
      generated.split(definition).length - 1,
      1,
      `${symbol} must be defined exactly once in the pi extension`,
    );
  }
});
