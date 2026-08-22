import assert from "node:assert/strict";
import { test } from "node:test";

import { REDACTED, makeLog, makeRedactor } from "./redaction.js";

const TOKEN = `ghp_${"Z".repeat(36)}`;

test("the token never survives a log line, an error, or a nested context object", () => {
  const redact = makeRedactor(TOKEN);
  assert.equal(redact(`Authorization: Bearer ${TOKEN}`).includes(TOKEN), false);
  assert.match(redact(`Bearer ${TOKEN}`), new RegExp(REDACTED.replace(/[[\]]/gu, "\\$&"), "u"));
  assert.equal(redact(new Error(`request failed with ${TOKEN}`)).includes(TOKEN), false);
  assert.equal(redact({ headers: { Authorization: `Bearer ${TOKEN}` } }).includes(TOKEN), false);
  assert.equal(redact([{ token: TOKEN }]).includes(TOKEN), false);
});

test("every recording path of the executor's log is filtered", () => {
  const lines: string[] = [];
  const sink = { log: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  const log = makeLog(makeRedactor(TOKEN), sink);
  log.info(`starting with ${TOKEN}`);
  log.warn("heartbeat failed", { error: new Error(`Bearer ${TOKEN}`) });
  log.error("crashed", { body: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => !line.includes(TOKEN)), lines.join("\n"));
});

test("a short or absent secret is not used as a redaction pattern", () => {
  // Otherwise a two-character "secret" would blank out unrelated substrings of
  // every message and make the log useless, which is its own failure mode.
  const redact = makeRedactor("ab", null, undefined, "");
  assert.equal(redact("a readable message about ab"), "a readable message about ab");
});

test("overlapping secrets redact longest-first, so no fragment survives", () => {
  const redact = makeRedactor("prefix-secret", "prefix-secret-and-more");
  assert.equal(redact("value=prefix-secret-and-more").includes("and-more"), false);
});

test("a run-scoped logger adds installation-token redaction on the same sink", () => {
  const lines: string[] = [];
  const sink = { log: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  const startupSecret = "startup-secret-value";
  const installationToken = "installation-token-value";
  const log = makeLog(makeRedactor(startupSecret), sink).withSecrets(installationToken);
  log.error(`${startupSecret} ${installationToken}`);
  assert.equal(lines[0]!.includes(startupSecret), false);
  assert.equal(lines[0]!.includes(installationToken), false);
});
