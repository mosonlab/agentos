import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const referencePath = join(repositoryRoot, "docs", "repo-contract", "merge-gate.sh");
const source = readFileSync(referencePath, "utf8");
const commandMarker = "  npm test\n";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "repo-contract-gate-fixture",
  GIT_AUTHOR_EMAIL: "repo-contract-gate-fixture",
  GIT_COMMITTER_NAME: "repo-contract-gate-fixture",
  GIT_COMMITTER_EMAIL: "repo-contract-gate-fixture",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
for (const name of Object.keys(GIT_ENV)) {
  if (name.startsWith("AGENTOS_RUN_")) delete GIT_ENV[name];
}

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const write = (cwd, name, contents) => writeFileSync(join(cwd, name), contents);

const commit = (cwd, message) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

const fixture = (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "repo-contract-gate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q", "-b", "main");
  write(cwd, "tracked.txt", "base\n");
  const master = commit(cwd, "baseline");
  git(cwd, "checkout", "-q", "-b", "feature");
  write(cwd, "tracked.txt", "candidate\n");
  const head = commit(cwd, "candidate");
  return { cwd, master, head };
};

const installGate = (t, replacement) => {
  assert.equal(source.match(new RegExp(commandMarker, "g"))?.length, 1);
  const directory = mkdtempSync(join(tmpdir(), "repo-contract-gate-script-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "merge-gate.sh");
  writeFileSync(path, source.replace(commandMarker, () => `${replacement}\n`), { mode: 0o755 });
  return path;
};

const run = (t, fixtureData, replacement, args = [], overrides = {}) => {
  const script = installGate(t, replacement);
  const result = spawnSync("bash", [script, ...args], {
    cwd: fixtureData.cwd,
    env: { ...GIT_ENV, ...overrides },
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const finalLine = (result) => {
  const lines = result.output.trimEnd().split(/\r?\n/u);
  const ansiEscape = String.fromCharCode(27);
  return lines.at(-1)?.replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, "gu"), "") ?? "";
};

const assertNoVerdict = (result) => {
  assert.doesNotMatch(result.output, /^(?:MERGE GATE|GATE NOT RUN):/mu);
};

test("a passing command with both pins emits the authoritative PASS wire line", (t) => {
  const data = fixture(t);
  const result = run(t, data, ":", ["--expect-head", data.head, "--master", data.master]);
  assert.equal(result.status, 0, result.output);
  assert.equal(finalLine(result), `MERGE GATE: PASS ${data.head}`);
});

test("a passing manual command without --master is not authoritative", (t) => {
  const data = fixture(t);
  const result = run(t, data, ":", ["--expect-head", data.head]);
  assert.equal(result.status, 3, result.output);
  assert.equal(finalLine(result), "MERGE GATE: NOT AUTHORITATIVE (master not stated)");
});

test("a command failure is a FAIL verdict with status one", (t) => {
  const data = fixture(t);
  const result = run(t, data, "exit 7", ["--expect-head", data.head, "--master", data.master]);
  assert.equal(result.status, 1, result.output);
  assert.equal(finalLine(result), "MERGE GATE: FAIL (the repository test command failed (exit 7))");
});

test("usage errors return two without any verdict and do not run the command", (t) => {
  const data = fixture(t);
  const witness = join(data.cwd, "command-ran");
  const replacement = `touch "$GATE_FIXTURE_WITNESS"`;
  const result = run(t, data, replacement, ["--expect-head"], { GATE_FIXTURE_WITNESS: witness });
  assert.equal(result.status, 2, result.output);
  assertNoVerdict(result);
  assert.equal(existsSync(witness), false);
});

test("an Anneal Run refuses before the repository command with code 76", (t) => {
  const data = fixture(t);
  const witness = join(data.cwd, "command-ran");
  const result = run(t, data, `touch "$GATE_FIXTURE_WITNESS"`, ["--master", data.master], {
    AGENTOS_RUN_ID: "fixture-run",
    GATE_FIXTURE_WITNESS: witness,
  });
  assert.equal(result.status, 76, result.output);
  assert.equal(finalLine(result), "GATE NOT RUN: refused inside Anneal run fixture-run");
  assert.equal(existsSync(witness), false);
});

test("mismatched expect-head and invalid master are FAIL preconditions", (t) => {
  const data = fixture(t);
  const mismatch = run(t, data, "touch should-not-run", ["--expect-head", "0".repeat(40), "--master", data.master]);
  assert.equal(mismatch.status, 1, mismatch.output);
  assert.equal(finalLine(mismatch), `MERGE GATE: FAIL (HEAD is ${data.head} but --expect-head asked for ${"0".repeat(40)})`);

  const invalid = run(t, data, "touch should-not-run", ["--master", "not-an-object-id"]);
  assert.equal(invalid.status, 1, invalid.output);
  assert.equal(finalLine(invalid), "MERGE GATE: FAIL (--master must be a full 40-character object id)");
});

test("a missing or non-ancestor master is rejected before the command", (t) => {
  const data = fixture(t);
  const missing = run(t, data, "touch should-not-run", ["--master", "f".repeat(40)]);
  assert.equal(missing.status, 1, missing.output);
  assert.equal(finalLine(missing), `MERGE GATE: FAIL (--master ${"f".repeat(40)} is not a commit in this repository)`);

  git(data.cwd, "checkout", "-q", "main");
  write(data.cwd, "other.txt", "unrelated\n");
  const other = commit(data.cwd, "unrelated");
  git(data.cwd, "checkout", "-q", "feature");
  const nonAncestor = run(t, data, "touch should-not-run", ["--master", other]);
  assert.equal(nonAncestor.status, 1, nonAncestor.output);
  assert.equal(finalLine(nonAncestor), `MERGE GATE: FAIL (--master ${other} is not an ancestor of ${data.head})`);
});

test("dirty-before, HEAD drift, and dirty-after are all FAIL verdicts", (t) => {
  const dirtyBefore = fixture(t);
  write(dirtyBefore.cwd, "tracked.txt", "edited before\n");
  const before = run(t, dirtyBefore, "touch should-not-run", ["--master", dirtyBefore.master]);
  assert.equal(before.status, 1, before.output);
  assert.equal(finalLine(before), "MERGE GATE: FAIL (working tree is not clean before the repository test command)");

  const headDrift = fixture(t);
  const drift = run(t, headDrift, "git commit --allow-empty -q -m drift", ["--master", headDrift.master]);
  assert.equal(drift.status, 1, drift.output);
  assert.match(finalLine(drift), new RegExp(`^MERGE GATE: FAIL \\(HEAD changed from ${headDrift.head} to [0-9a-f]{40} during the repository test command\\)$`, "u"));

  const dirtyAfter = fixture(t);
  const after = run(t, dirtyAfter, "touch dirty-after", ["--master", dirtyAfter.master]);
  assert.equal(after.status, 1, after.output);
  assert.equal(finalLine(after), "MERGE GATE: FAIL (working tree is not clean after the repository test command)");
});

test("SIGINT and SIGTERM retain their no-verdict codes and wire line", (t) => {
  for (const [signal, status, replacement] of [
    ["SIGINT", 130, 'kill -INT "$$"'],
    ["SIGTERM", 143, 'kill -TERM "$$"'],
  ]) {
    const data = fixture(t);
    const result = run(t, data, replacement, ["--master", data.master]);
    assert.equal(result.status, status, result.output);
    assert.equal(finalLine(result), `GATE NOT RUN: the gate was stopped by ${signal} during the repository test command`);
  }
});
