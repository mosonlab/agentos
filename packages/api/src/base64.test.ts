import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeStrictBase64 } from "./base64.js";

test("canonical base64 decodes to exactly the bytes it encodes", () => {
  for (let byteLength = 1; byteLength <= 48; byteLength += 1) {
    const bytes = randomBytes(byteLength);
    const decoded = decodeStrictBase64(bytes.toString("base64"));
    assert.ok(decoded, `${byteLength} bytes round-tripped to null`);
    assert.deepEqual(decoded, bytes);
  }
});

test("a character outside the alphabet is refused wherever it sits", () => {
  // Node's own decoder discards these and returns the 32 bytes of the rest,
  // which is what let a malformed key through the startup gate.
  const key = randomBytes(32).toString("base64");
  for (const malformed of [`!!!!${key}`, `${key}!!!!`, `${key.slice(0, 20)}!!!!${key.slice(20)}`, `${key.slice(0, 43)}!=`]) {
    assert.equal(decodeStrictBase64(malformed), null, `${malformed.slice(0, 12)}… was accepted`);
    // The point of the test: the loose decoder cannot tell the difference.
    assert.equal(Buffer.from(malformed, "base64").length >= 30, true);
  }
});

test("non-canonical spellings are refused: unpadded, over-padded, whitespace, base64url", () => {
  const key = randomBytes(32).toString("base64");
  for (const value of [
    "",
    key.replace(/=+$/u, ""),
    `${key}=`,
    ` ${key}`,
    `${key}\n`,
    key.replace(/.{4}/u, "AB CD"),
    randomBytes(32).toString("base64url"),
  ]) {
    assert.equal(decodeStrictBase64(value), null, `${JSON.stringify(value.slice(0, 12))} was accepted`);
  }
});

test("padding bits the decoder would discard are refused", () => {
  // "AAAB" and "AAAA" decode to the same three bytes; only one of them is the
  // encoding of those bytes.
  assert.ok(decodeStrictBase64("AAAA"));
  assert.equal(decodeStrictBase64("AAB="), null);
  assert.equal(decodeStrictBase64("AB=="), null);
});

test("secrets.ts reads the encryption key through this parser, not through Buffer.from", () => {
  // The startup verdict and the rule applied when a Run first opens a Secret
  // have to be the same rule; two spellings of it is how they drift.
  const secrets = readFileSync(fileURLToPath(new URL("./secrets.ts", import.meta.url)), "utf8");
  assert.match(secrets, /decodeStrictBase64\(encoded\)/u);
  assert.equal(
    /Buffer\.from\(encoded, "base64"\)/u.test(secrets),
    false,
    "secrets.ts still decodes the key with Node's loose decoder",
  );
});

test("the key the generator writes is accepted by the parser that guards it", () => {
  // `scripts/setup-local.mjs` encodes the key with `toString("base64")`. If that
  // ever became `base64url`, every generated .env would be refused at startup.
  const generator = readFileSync(fileURLToPath(new URL("../../../scripts/setup-local.mjs", import.meta.url)), "utf8");
  assert.match(generator, /function base64Secret\(randomBytes, byteLength\) \{\n\s*return randomBytes\(byteLength\)\.toString\("base64"\);/u);
  const decoded = decodeStrictBase64(randomBytes(32).toString("base64"));
  assert.equal(decoded?.length, 32);
});
