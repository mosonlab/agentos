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

test("an Error inside a context object is readable rather than `{}`", () => {
  // Every crash this daemon reports is logged as `log.error(msg, { runId, error })`,
  // and an Error carries no enumerable own properties: this is the one line an
  // operator reads after a crash, and it used to read `"error":{}`.
  const lines: string[] = [];
  const sink = { log: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  makeLog(makeRedactor(), sink).error("mechanical run crashed", { runId: "run-1", error: new Error("Anneal API 409: fencing token refused") });
  assert.equal(lines[0]!.includes('"error":{}'), false, lines[0]);
  assert.match(lines[0]!, /"name":"Error"/u);
  assert.match(lines[0]!, /"message":"Anneal API 409: fencing token refused"/u);
  assert.match(lines[0]!, /"stack":"Error: Anneal API 409/u);
});

test("a nested Error keeps its whole cause chain, aggregate members included", () => {
  // `fetch` reports a refused connection as a message-less AggregateError under
  // the cause of a bare "fetch failed"; the reason exists nowhere else.
  const text = makeRedactor()({
    error: new Error("fetch failed", { cause: new AggregateError([new Error("connect ECONNREFUSED 127.0.0.1:3000")], "") }),
  });
  assert.match(text, /"message":"fetch failed"/u);
  assert.match(text, /"name":"AggregateError"/u);
  assert.match(text, /connect ECONNREFUSED 127\.0\.0\.1:3000/u);
});

test("a token inside a nested Error's message, stack or cause is redacted", () => {
  const text = makeRedactor(TOKEN)({
    runId: "run-1",
    error: new Error(`request failed with Bearer ${TOKEN}`, { cause: new Error(`minted ${TOKEN}`) }),
  });
  assert.equal(text.includes(TOKEN), false, text);
  assert.ok(text.includes(`request failed with Bearer ${REDACTED}`), text);
  assert.ok(text.includes(`minted ${REDACTED}`), text);
});
