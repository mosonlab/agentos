/**
 * The merge executor's §D-P1 custody claim is that its credential never reaches
 * a child process's environment or argv. That claim is only as strong as the
 * weakest module the executor's process can load, and this package is now one
 * of them.
 *
 * So the same assertion the executor makes about its own source is made here,
 * about ours. It also keeps the package honest about its shape: a transport is
 * injected, never spawned, which is what lets the runner drive this engine over
 * the `gh` CLI while the executor drives it over HTTP with a token in memory.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = dirname(fileURLToPath(import.meta.url));

const stripComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//gu, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

test("no shipped source file in this package can spawn a child process", async () => {
  const forbidden = /\b(?:child_process|spawnSync|spawn|execFile|execSync|\bexec\(|fork\()/u;
  const entries = (await readdir(sourceRoot)).filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"));
  assert.ok(entries.length > 0, "the scan found no source files, so it proved nothing");
  for (const entry of entries) {
    const offending = stripComments(await readFile(join(sourceRoot, entry), "utf8"))
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => forbidden.test(line));
    assert.deepEqual(offending, [], `${entry} references child-process execution`);
  }
});

test("the package has no runtime dependencies to smuggle one in through", async () => {
  const manifest = JSON.parse(await readFile(join(sourceRoot, "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(manifest.dependencies ?? {}, {});
});
