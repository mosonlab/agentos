// Goal 5a0 dependency gate — evidence-destination containment tests.
//
// These cover binding obligation (a) from the plan's final review: the gate's
// evidence destination must be one it cannot collide with, and every refused
// destination must stop the harness *before any file is written*. The four
// negatives the finding names — the filesystem root, a repository checkout, an
// existing non-empty directory, and a symlink — each get their own case, plus a
// non-allowlisted root and an explicit name-collision case for the copy itself.
// A passing good-path test alone does not satisfy the obligation, so the
// positives here are companions, never the evidence.
//
// The classifier and reference-graph fixtures required by plan Step 15.7.2 are
// NOT in this file; the dry checks they drive are not implemented yet.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const scriptsDirectory = fileURLToPath(new URL(".", import.meta.url));
const harness = join(scriptsDirectory, "goal-5a0-dependency-gate.sh");
const library = join(scriptsDirectory, "goal-5a0-evidence-destination.sh");

const scratch = mkdtempSync(join(tmpdir(), "goal5a0-gate-test."));
after(() => rmSync(scratch, { recursive: true, force: true }));

const makeDirectory = (...parts) => {
  const path = join(scratch, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
};

/** A checks entry point that succeeds and writes one artifact. */
const passingChecks = (() => {
  const path = join(scratch, "checks-pass.sh");
  writeFileSync(path, '#!/usr/bin/env bash\nprintf "L\\t0\\n" >> "$GATE_DIR/exit-status.tsv"\necho ok > "$GATE_DIR/L.out"\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
})();

/** A checks entry point that dies by signal without any handler running. */
const signalledChecks = (() => {
  const path = join(scratch, "checks-signalled.sh");
  writeFileSync(path, '#!/usr/bin/env bash\nprintf "L\\t137\\n" >> "$GATE_DIR/exit-status.tsv"\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
})();

const runHarness = (evidenceRoot, { allowlist, checks = passingChecks } = {}) => {
  try {
    const stdout = execFileSync("bash", [harness, evidenceRoot], {
      encoding: "utf8",
      env: {
        ...process.env,
        GOAL5A0_EVIDENCE_ROOTS: allowlist ?? scratch,
        GATE_CHECKS: checks,
      },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? -1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
};

/** Drives one library function directly, which is how the copy's refusal is observable. */
const runLibrary = (body, env = {}) => {
  try {
    const stdout = execFileSync("bash", ["-c", `set -u; . ${JSON.stringify(library)}\n${body}`], {
      encoding: "utf8",
      env: { ...process.env, GOAL5A0_EVIDENCE_ROOTS: scratch, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? -1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
};

const leaves = (root) => readdirSync(root).filter((entry) => entry.startsWith("goal5a0-gate."));

test("negative: the filesystem root is refused and nothing is written", () => {
  const result = runHarness("/", { allowlist: "/" });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /filesystem root|top-level directory/u);
  assert.doesNotMatch(result.stdout, /SAFE_TO_IMPLEMENT/u);
  assert.equal(leaves("/").length, 0, "nothing was written at /");
});

test("negative: a repository checkout is refused and nothing is written", () => {
  const checkout = makeDirectory("checkout");
  mkdirSync(join(checkout, ".git"));
  const nested = join(checkout, "docs", "evidence");
  mkdirSync(nested, { recursive: true });

  const result = runHarness(nested);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /inside a git checkout/u);
  assert.doesNotMatch(result.stdout, /SAFE_TO_IMPLEMENT/u);
  assert.deepEqual(readdirSync(nested), [], "the checkout was not written to");
});

test("negative: an existing non-empty directory is refused and its contents survive", () => {
  const populated = makeDirectory("populated");
  writeFileSync(join(populated, "outcome.txt"), "SAFE_TO_IMPLEMENT from a previous run\n");
  writeFileSync(join(populated, "exit-status.tsv"), "label\texit\nL\t0\n");

  const result = runHarness(populated);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /unrelated entries/u);
  assert.doesNotMatch(result.stdout, /SAFE_TO_IMPLEMENT/u);
  assert.equal(readFileSync(join(populated, "outcome.txt"), "utf8"), "SAFE_TO_IMPLEMENT from a previous run\n");
  assert.deepEqual(readdirSync(populated).sort(), ["exit-status.tsv", "outcome.txt"]);
});

test("negative: a symlinked destination is refused and its target is untouched", () => {
  const target = makeDirectory("symlink-target");
  const link = join(scratch, "symlinked-evidence");
  symlinkSync(target, link);

  const result = runHarness(link);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /symlink/u);
  assert.doesNotMatch(result.stdout, /SAFE_TO_IMPLEMENT/u);
  assert.deepEqual(readdirSync(target), [], "the symlink target was not written to");
});

test("negative: a root outside the allowlist is refused, and an unset allowlist is refused", () => {
  const outside = makeDirectory("outside");
  const allowed = makeDirectory("allowed");

  const refused = runHarness(outside, { allowlist: allowed });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stdout + refused.stderr, /outside GOAL5A0_EVIDENCE_ROOTS/u);
  assert.deepEqual(readdirSync(outside), []);

  const unset = runLibrary(`goal5a0_validate_evidence_root ${JSON.stringify(outside)}`, { GOAL5A0_EVIDENCE_ROOTS: "" });
  assert.notEqual(unset.code, 0);
  assert.match(unset.stderr, /GOAL5A0_EVIDENCE_ROOTS is unset/u);
});

test("negative: the copy refuses a name collision instead of overwriting it", () => {
  const source = makeDirectory("collide-source");
  writeFileSync(join(source, "outcome.txt"), "SAFE_TO_IMPLEMENT\n");
  writeFileSync(join(source, "L.out"), "new\n");
  const leaf = makeDirectory("collide-leaf");
  writeFileSync(join(leaf, "outcome.txt"), "prior evidence\n");

  const result = runLibrary(
    `goal5a0_capture_into_leaf ${JSON.stringify(source)} ${JSON.stringify(leaf)}`,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /leaf is not empty at the moment of use|refusing to overwrite/u);
  assert.equal(readFileSync(join(leaf, "outcome.txt"), "utf8"), "prior evidence\n", "the colliding file was not overwritten");
  assert.equal(existsSync(join(leaf, "L.out")), false, "the capture stopped before writing any file");
});

test("companion positive: an allowlisted empty root gets a fresh leaf and the evidence lands in it", () => {
  const root = makeDirectory("good-root");
  const result = runHarness(root);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /SAFE_TO_IMPLEMENT/u);

  const created = leaves(root);
  assert.equal(created.length, 1, "the harness created exactly one leaf it owns");
  const contents = readdirSync(join(root, created[0])).sort();
  assert.deepEqual(contents, ["L.out", "exit-status.tsv", "outcome.txt"]);
  assert.equal(readFileSync(join(root, created[0], "outcome.txt"), "utf8"), "SAFE_TO_IMPLEMENT\n");
  assert.equal(existsSync(join(root, "outcome.txt")), false, "nothing was written into the root itself");

  // A second run reuses the same root and cannot collide with the first run's leaf.
  const second = runHarness(root);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.equal(leaves(root).length, 2);
});

test("a signal-killed recorded check stops the run through the >= 128 guard, with the partial evidence preserved", () => {
  const root = makeDirectory("signalled-root");
  const result = runHarness(root, { checks: signalledChecks });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /STOPPED_FOR_REROUTE signal-terminated command/u);
  assert.doesNotMatch(result.stdout, /SAFE_TO_IMPLEMENT/u);

  const created = leaves(root);
  assert.equal(created.length, 1);
  const outcome = readFileSync(join(root, created[0], "outcome.txt"), "utf8");
  assert.match(outcome, /^STOPPED_FOR_REROUTE/u);
  assert.match(readFileSync(join(root, created[0], "exit-status.tsv"), "utf8"), /L\t137/u);
});

test("no goal5a0-gate temporary root survives a completed run", () => {
  const root = makeDirectory("cleanup-root");
  // Only the roots *this* run creates. Another gate running on the same machine
  // owns its own `goal5a0-gate.*` directory and is entitled to be holding it
  // open; counting those as this run's leak turned a shared machine into a red
  // test rather than a leaking harness.
  const before = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("goal5a0-gate.")));
  runHarness(root);
  const surviving = readdirSync(tmpdir())
    .filter((entry) => entry.startsWith("goal5a0-gate.") && !before.has(entry));
  assert.deepEqual(surviving, [], `temporary roots leaked: ${surviving.join(", ")}`);
});
