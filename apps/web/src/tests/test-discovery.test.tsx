import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { globSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoot = resolve(packageRoot, "src");

const testScript = (): string => {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = manifest.scripts?.test;
  assert.ok(script, "package.json declares no test script");
  return script;
};

/** The argument list the test runner is actually handed, reproduced the way npm
 *  produces it. The host-proof wrapper passes the Node invocation as a quoted
 *  `sh -c` payload, so inspect that payload rather than treating its closing quote
 *  as part of Node's arguments. The payload's shell still performs the word
 *  splitting this regression guards: a quoted glob reaches Node's recursive
 *  matcher while an unquoted one is flattened by a shell whose `**` means `*`. */
const runnerOperands = (script: string): string[] => {
  const command = /\/bin\/sh -c '([^']*)'$/u.exec(script)?.[1] ?? script;
  const testFlag = command.indexOf("--test");
  assert.notEqual(testFlag, -1, "test script does not invoke node --test");
  const tail = command.slice(testFlag + "--test".length);
  return execFileSync("sh", ["-c", `printf '%s\\n' ${tail}`], { cwd: packageRoot })
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
};

const discovered = (operands: string[]): Set<string> =>
  new Set(operands.flatMap((operand) => globSync(operand, { cwd: packageRoot })));

/** Every test file on disk, found without consulting the script at all. */
const onDisk = (): string[] =>
  readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.test\.tsx?$/.test(entry.name))
    .map((entry) => relative(packageRoot, resolve(entry.parentPath, entry.name)))
    .sort();

test("the test script reaches every test file under src, at any depth", () => {
  const files = onDisk();

  // Guards against the assertion going quiet: a nested test file must exist for
  // "reaches every depth" to mean anything at all.
  const nested = files.filter((file) => file.split("/").length > 3);
  assert.ok(nested.length > 0, "no test file below src/<dir>/ — the depth check is vacuous");

  const reached = discovered(runnerOperands(testScript()));
  assert.deepEqual(files.filter((file) => !reached.has(file)), []);
});
