import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { Input } from "../components/ui/input";
import { GoalLimitInputs } from "../components/goal-limit-inputs";
import { SecretValueInput } from "../components/secret-value-input";

test("Input emits an explicit text type by default", () => {
  assert.match(renderToStaticMarkup(<Input defaultValue="plain" />), /type="text"/);
});

test("Secrets keeps the write-only value control masked", () => {
  const markup = renderToStaticMarkup(<SecretValueInput defaultValue="fixture" />);
  assert.match(markup, /type="password"/);
  assert.doesNotMatch(markup, /type="text"/);
});

test("Goals keeps all four constrained controls numeric", () => {
  const markup = renderToStaticMarkup(<GoalLimitInputs values={{ spendCap: "", maxDurationMin: "120", stallTimeoutMin: "10", stuckThreshold: "19" }} onChange={() => undefined} />);
  const numericInputs = markup.match(/<input[^>]*type="number"[^>]*>/g) ?? [];
  assert.equal(numericInputs.length, 4);
  assert.match(numericInputs[0] ?? "", /min="0"/);
  assert.match(numericInputs[0] ?? "", /step="0\.01"/);
  for (const input of numericInputs.slice(1)) assert.match(input, /min="1"/);
});

test("every Input call site declares its semantic type", () => {
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : extname(path) === ".tsx" && !path.endsWith(".test.tsx") ? [path] : [];
  });
  const offenders = walk(sourceRoot).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return [...source.matchAll(/<Input\b([^>]*)>/gs)]
      .filter((match) => !/\btype\s*=/.test(match[1] ?? ""))
      .map((match) => `${path}:${source.slice(0, match.index).split("\n").length}`);
  });
  assert.deepEqual(offenders, []);
});
