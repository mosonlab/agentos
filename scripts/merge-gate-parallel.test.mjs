// Fixtures for parallel_steps in scripts/merge-gate.sh.
//
// The gate runs its steps in concurrent groups, and a parallel group is where
// the two properties a verdict depends on are normally lost: that every failure
// is reported, and that the report says which step each result belongs to. Both
// are invisible on a green run, so they are tested here rather than inferred
// from gates that happened to pass.
//
// The function is extracted from merge-gate.sh and run for real. Re-typing it
// into a fixture would test a copy, and the copy is the one thing that cannot
// drift into disagreeing with the gate while still passing.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";

const gatePath = fileURLToPath(new URL("./merge-gate.sh", import.meta.url));

const test = (name, body) => nodeTest(name, { concurrency: true }, body);

// The extraction is bounded by two literals that exist in merge-gate.sh for
// this purpose. If either stops matching, the tests fail loudly here instead of
// silently exercising nothing.
const extractParallelSteps = () => {
  const source = readFileSync(gatePath, "utf8");
  const start = source.indexOf('GATE_STEP_SEPARATOR="::"');
  assert.notEqual(start, -1, "merge-gate.sh no longer defines GATE_STEP_SEPARATOR");
  const bodyStart = source.indexOf("\nparallel_steps() {", start);
  assert.notEqual(bodyStart, -1, "merge-gate.sh no longer defines parallel_steps");
  const end = source.indexOf("\n}\n", bodyStart);
  assert.notEqual(end, -1, "parallel_steps has no terminating brace");
  return source.slice(start, end + 3);
};

const PARALLEL_STEPS = extractParallelSteps();

// Enough of the gate for the function under test to run: the two output helpers,
// the report array it appends to, the temp root it writes member logs into, and
// the working directory it runs members in. Nothing here stands in for the
// behaviour being tested.
const HARNESS = `
set -uo pipefail
say() { printf '\\n== %s\\n' "$1"; }
note() { printf '   %s\\n' "$1"; }
STEP_REPORT=()
FAILED_STEP=""
GATE_TMP="$1"
REPO_ROOT="$2"
${PARALLEL_STEPS}
`;

// Runs one group and reports what the gate would have: the exit status, the
// replayed output, the step report lines, and the failed-step string that
// becomes `MERGE GATE: FAIL (...)`.
const runGroup = (members) => {
  const root = mkdtempSync(join(tmpdir(), "merge-gate-parallel."));
  try {
    const script = join(root, "harness.sh");
    writeFileSync(
      script,
      `${HARNESS}\nparallel_steps ${members}\nstatus=$?\n` +
        `printf 'REPORT-BEGIN\\n'\n` +
        `for line in "\${STEP_REPORT[@]:-}"; do printf '%s\\n' "$line"; done\n` +
        `printf 'REPORT-END\\n'\n` +
        `printf 'FAILED_STEP=%s\\n' "$FAILED_STEP"\n` +
        `exit "$status"\n`,
    );
    const result = spawnSync("bash", [script, root, root], { encoding: "utf8" });
    const stdout = result.stdout ?? "";
    const report = stdout
      .slice(stdout.indexOf("REPORT-BEGIN") + "REPORT-BEGIN\n".length, stdout.indexOf("REPORT-END"))
      .split("\n")
      .filter((line) => line.trim() !== "");
    const failedStep = /^FAILED_STEP=(.*)$/m.exec(stdout)?.[1] ?? "";
    return { status: result.status, stdout, stderr: result.stderr ?? "", report, failedStep };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("PARALLEL-ALL every member runs, and the group passes when they all do", () => {
  const run = runGroup(
    `"a group" "first" sh -c 'echo ran-first' :: "second" sh -c 'echo ran-second' :: "third" sh -c 'echo ran-third'`,
  );
  assert.equal(run.status, 0);
  assert.match(run.stdout, /ran-first/);
  assert.match(run.stdout, /ran-second/);
  assert.match(run.stdout, /ran-third/);
  assert.equal(run.report.length, 3);
  for (const line of run.report) assert.match(line, /^ok /);
  assert.equal(run.failedStep, "");
});

test("PARALLEL-ORDER replays member output in submission order, not completion order", () => {
  // The first member is deliberately the slowest, so completion order is the
  // reverse of submission order and an unbuffered group would prove it.
  const run = runGroup(
    `"a group" "slow" sh -c 'sleep 1; echo from-slow' :: "quick" sh -c 'echo from-quick'`,
  );
  assert.equal(run.status, 0);
  const slowHeading = run.stdout.indexOf("--- slow ---");
  const quickHeading = run.stdout.indexOf("--- quick ---");
  assert.ok(slowHeading !== -1 && quickHeading !== -1, "both members should be replayed under their labels");
  assert.ok(slowHeading < quickHeading, "submission order should survive completion order");
  // Each member's output belongs under its own heading, not merged into one stream.
  assert.ok(run.stdout.indexOf("from-slow") > slowHeading);
  assert.ok(run.stdout.indexOf("from-slow") < quickHeading);
});

test("PARALLEL-FAIL-ALL names every failing member, not only the first", () => {
  const run = runGroup(
    `"a group" "good" true :: "bad one" false :: "bad two" sh -c 'exit 3'`,
  );
  assert.equal(run.status, 1);
  // The whole point of running these together: one gate reports both problems.
  assert.equal(run.failedStep, "bad one, bad two");
  assert.equal(run.report.filter((line) => line.startsWith("FAIL")).length, 2);
  assert.equal(run.report.filter((line) => line.startsWith("ok")).length, 1);
});

test("PARALLEL-FAIL-ONE names the single failing member", () => {
  const run = runGroup(`"a group" "good" true :: "bad" false`);
  assert.equal(run.status, 1);
  assert.equal(run.failedStep, "bad");
});

test("PARALLEL-DURATION charges each member for its own time, not the wait before it", () => {
  // The quick member is submitted second. Timed from the parent, it would be
  // charged for the slow member's three seconds too, because the parent waits
  // in submission order.
  const run = runGroup(
    `"a group" "slow" sh -c 'sleep 3' :: "quick" sh -c 'true'`,
  );
  assert.equal(run.status, 0);
  const quick = run.report.find((line) => line.includes("quick"));
  assert.ok(quick, "the quick member should appear in the report");
  const seconds = Number(/(\d+)s$/.exec(quick.trim())?.[1]);
  assert.ok(Number.isInteger(seconds), `expected a duration, got ${quick}`);
  assert.ok(seconds <= 1, `the quick member should not be charged for the slow one: ${quick}`);
});

test("PARALLEL-USAGE refuses a member with no command", () => {
  const run = runGroup(`"a group" "label only"`);
  assert.notEqual(run.status, 0);
  // Usage errors go to stderr, where every other refusal in the gate puts them.
  assert.match(run.stderr, /names no command/);
});

test("PARALLEL-INTERRUPT stops members still running before the gate tears down", async () => {
  // The danger a signal creates is not a slow exit, it is a fast one: cleanup
  // removes GATE_TMP, releases the worktree lock and deletes the postgres
  // container, and a member that outlived all three keeps writing into a
  // checkout the next gate has already claimed.
  const root = mkdtempSync(join(tmpdir(), "merge-gate-interrupt."));
  try {
    const memberPidFile = join(root, "member.pid");
    const script = join(root, "harness.sh");
    writeFileSync(
      script,
      `${HARNESS}\n` +
        `trap 'terminate_group_steps; exit 143' TERM\n` +
        `parallel_steps "a group" "long" sh -c 'printf %s "$$" > "$0"; exec sleep 30' ${JSON.stringify(memberPidFile)}\n`,
    );
    const harness = spawn("bash", [script, root, root], { stdio: "ignore" });

    // The member has to have reported its own pid before the signal, or the
    // test would pass by racing rather than by stopping anything.
    const deadline = Date.now() + 15_000;
    let memberPid = "";
    while (Date.now() < deadline) {
      try {
        memberPid = readFileSync(memberPidFile, "utf8").trim();
        if (memberPid !== "") break;
      } catch {
        // Not written yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.notEqual(memberPid, "", "the member never reported its pid");
    assert.doesNotThrow(() => process.kill(Number(memberPid), 0), "the member should be running before the signal");

    harness.kill("SIGTERM");
    await new Promise((resolve) => harness.on("exit", resolve));

    // Checked after the harness has exited: that is the moment cleanup would
    // have finished deleting everything the member is still writing to.
    let alive = true;
    try {
      process.kill(Number(memberPid), 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `member ${memberPid} outlived the gate that started it`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PARALLEL-INTERRUPT stops the members before cleanup removes what they use", () => {
  // Order, not just presence. Signalling the members after GATE_TMP is gone
  // and the lock is released closes nothing.
  const source = readFileSync(gatePath, "utf8");
  const cleanup = source.slice(source.indexOf("\ncleanup() {"));
  const stop = cleanup.indexOf("terminate_group_steps");
  const discard = cleanup.indexOf("discard_gate_tmp");
  const release = cleanup.indexOf("release_lock");
  assert.ok(stop !== -1, "cleanup no longer stops in-flight members");
  assert.ok(stop < discard, "cleanup removes GATE_TMP before stopping the members writing into it");
  assert.ok(stop < release, "cleanup releases the worktree lock before the members using it have stopped");
});

test("PARALLEL-ARGUMENTS passes arguments through without re-splitting them", () => {
  // %q round-tripping is what lets a member carry a quoted argument. A member
  // whose argument contains a space must arrive as one argument.
  const run = runGroup(
    `"a group" "spaced" sh -c 'printf "%s\\n" "$0"' "one two three"`,
  );
  assert.equal(run.status, 0);
  assert.match(run.stdout, /one two three/);
});
