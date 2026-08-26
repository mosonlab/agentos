// Fixtures for parallel_steps and for the verdict cleanup prints, both in
// scripts/merge-gate.sh.
//
// The gate runs its steps in concurrent groups, and a parallel group is where
// the two properties a verdict depends on are normally lost: that every failure
// is reported, and that the report says which step each result belongs to. Both
// are invisible on a green run, so they are tested here rather than inferred
// from gates that happened to pass.
//
// The third property is that a run which was stopped does not report a verdict.
// A gate killed mid-step used to print MERGE GATE: FAIL naming whichever step it
// was in, so a reviewer reading that line recorded a judgement about the commit
// that nothing had formed. Nothing about it is visible on a green run either.
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
// Sourced by the harnesses below rather than restated in them. The verdict's
// exit codes and the four lines that carry them live in one file, and a fixture
// that re-typed them would keep passing while the gate's real output changed
// underneath it — which is the whole reason the module exists.
const libPath = fileURLToPath(new URL("./gate-worker/lib.sh", import.meta.url));

const test = (name, body) => nodeTest(name, { concurrency: true }, body);

// The extraction is bounded by two literals that exist in merge-gate.sh for
// this purpose. If either stops matching, the tests fail loudly here instead of
// silently exercising nothing.
const extractParallelSteps = () => {
  const source = readFileSync(gatePath, "utf8");
  // From the stop classifier rather than from the separator: what a member's
  // exit status means is part of what this group reports, so the fixture must
  // run the gate's own classification and not a copy of it.
  const start = source.indexOf("\nstopped_from_outside() {");
  assert.notEqual(start, -1, "merge-gate.sh no longer defines stopped_from_outside");
  assert.notEqual(
    source.indexOf('GATE_STEP_SEPARATOR="::"', start),
    -1,
    "merge-gate.sh no longer defines GATE_STEP_SEPARATOR after the stop classifier",
  );
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
. ${JSON.stringify(libPath)}
STEP_REPORT=()
FAILED_STEP=""
NO_VERDICT_REASON=""
NO_VERDICT_EXIT="$GATE_EXIT_NO_VERDICT"
GATE_REAL_FAILURE=""
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
        `printf 'NO_VERDICT=%s\\n' "$NO_VERDICT_REASON"\n` +
        `exit "$status"\n`,
    );
    const result = spawnSync("bash", [script, root, root], { encoding: "utf8" });
    const stdout = result.stdout ?? "";
    const report = stdout
      .slice(stdout.indexOf("REPORT-BEGIN") + "REPORT-BEGIN\n".length, stdout.indexOf("REPORT-END"))
      .split("\n")
      .filter((line) => line.trim() !== "");
    const failedStep = /^FAILED_STEP=(.*)$/m.exec(stdout)?.[1] ?? "";
    const noVerdict = /^NO_VERDICT=(.*)$/m.exec(stdout)?.[1] ?? "";
    return { status: result.status, stdout, stderr: result.stderr ?? "", report, failedStep, noVerdict };
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

test("PARALLEL-STOPPED a member killed from outside is not a FAIL", () => {
  // The incident this exists for: an operator killed the process tree of a gate
  // that had deadlocked, and the gate reported MERGE GATE: FAIL naming the
  // group. Nothing in that group judged the commit — it was stopped — and a
  // reviewer who copies that line records a verdict that was never formed.
  const run = runGroup(`"a group" "good" true :: "killed" sh -c 'kill -TERM $$; sleep 30'`);
  assert.equal(run.status, 1);
  assert.equal(run.failedStep, "killed");
  assert.match(run.noVerdict, /^killed was stopped before it could be judged$/);
  assert.equal(run.report.filter((line) => line.startsWith("STOP")).length, 1);
  assert.equal(run.report.filter((line) => line.startsWith("FAIL")).length, 0);
});

test("PARALLEL-STOPPED a member that crashed on its own is still a FAIL", () => {
  // The boundary. SIGSEGV is the code under test behaving badly, not an
  // operator stopping the run, and treating it as "no verdict" would let a real
  // failure be re-dispatched as an errand until somebody read the log.
  const run = runGroup(`"a group" "crashed" sh -c 'kill -SEGV $$; sleep 30'`);
  assert.equal(run.status, 1);
  assert.equal(run.failedStep, "crashed");
  assert.equal(run.noVerdict, "");
  assert.equal(run.report.filter((line) => line.startsWith("FAIL")).length, 1);
});

test("PARALLEL-STOPPED a real failure outranks a member that was stopped", () => {
  // The gate did learn something about the commit, so the run has a verdict and
  // the stopped member does not erase it.
  const run = runGroup(
    `"a group" "bad" false :: "killed" sh -c 'kill -TERM $$; sleep 30'`,
  );
  assert.equal(run.status, 1);
  assert.equal(run.failedStep, "bad");
  assert.equal(run.noVerdict, "");
});

test("PARALLEL-USAGE refuses a member with no command", () => {
  const run = runGroup(`"a group" "label only"`);
  assert.notEqual(run.status, 0);
  // Usage errors go to stderr, where every other refusal in the gate puts them.
  assert.match(run.stderr, /names no command/);
});

// --- the verdict cleanup prints ---------------------------------------------

// cleanup() and the signal handlers, run for real against stubbed teardown. The
// question these answer is only ever "which last line, and which code", so the
// container, the lock and the temp directory are stubs; nothing they do changes
// the answer.
const extractVerdict = () => {
  const source = readFileSync(gatePath, "utf8");
  const start = source.indexOf("\ncleanup() {");
  assert.notEqual(start, -1, "merge-gate.sh no longer defines cleanup");
  const endMarker = "trap 'interrupted TERM 143' TERM";
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, "merge-gate.sh no longer routes TERM through interrupted");
  return source.slice(start, end + endMarker.length);
};

const VERDICT_HARNESS = `
set -uo pipefail
say() { printf '\\n== %s\\n' "$1"; }
note() { printf '   %s\\n' "$1"; }
terminate_group_steps() { :; }
discard_gate_tmp() { :; }
release_lock() { :; }
KEEP_POSTGRES=0
POSTGRES_STARTED=0
CONTAINER=stub
STEP_REPORT=()
FAILED_STEP=""
GATED_HEAD=abc123
. ${JSON.stringify(libPath)}
NO_VERDICT_REASON=""
NO_VERDICT_EXIT="$GATE_EXIT_NO_VERDICT"
GATE_REAL_FAILURE=""
${extractVerdict()}
`;

const runVerdict = (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "merge-gate-verdict."));
  try {
    const script = join(root, "verdict.sh");
    writeFileSync(script, `${VERDICT_HARNESS}\n${scenario}\n`);
    const result = spawnSync("bash", [script], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("VERDICT an interrupted gate reports the absence of a verdict, not a FAIL", () => {
  // The defect in full: the signal arrives while a step is in flight, so
  // cleanup sees a non-zero status and a FAILED_STEP naming that step, which
  // reads exactly like the step having failed. It did not fail. It never
  // finished, and 143 is the code that says so.
  const run = runVerdict(`FAILED_STEP="the suites"\nkill -TERM $$\nsleep 30`);
  assert.equal(run.status, 143);
  assert.match(run.stdout, /GATE NOT RUN: the gate was stopped by SIGTERM during the suites/);
  assert.doesNotMatch(run.stdout, /MERGE GATE: FAIL/);
  assert.doesNotMatch(run.stdout, /MERGE GATE: PASS/);
});

test("VERDICT a stopped step exits 76, the code that means no gate judged this", () => {
  const run = runVerdict(
    `NO_VERDICT_REASON="the suites was stopped before it could be judged"\n` +
      `FAILED_STEP="the suites"\nexit 1`,
  );
  assert.equal(run.status, 76);
  assert.match(run.stdout, /GATE NOT RUN: the suites was stopped before it could be judged/);
  assert.doesNotMatch(run.stdout, /MERGE GATE: FAIL/);
});

test("VERDICT a step that really failed is still a FAIL naming it", () => {
  // The direction this must not be wrong in: nothing above may turn a judgement
  // the gate did form into an errand.
  const run = runVerdict(`FAILED_STEP="a step"\nexit 1`);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /MERGE GATE: FAIL \(a step\)/);
  assert.doesNotMatch(run.stdout, /GATE NOT RUN/);
});

test("VERDICT a clean run still passes and still names its commit", () => {
  const run = runVerdict(`exit 0`);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /MERGE GATE: PASS abc123/);
  assert.doesNotMatch(run.stdout, /GATE NOT RUN/);
});

// A group and the verdict together, which is the only way to observe what a
// signal arriving mid-group actually prints. Both extractions are the gate's
// own source; cleanup's teardown is stubbed for the same reason as above.
const COMBINED_HARNESS = `
set -uo pipefail
say() { printf '\\n== %s\\n' "$1"; }
note() { printf '   %s\\n' "$1"; }
discard_gate_tmp() { :; }
release_lock() { :; }
KEEP_POSTGRES=0
POSTGRES_STARTED=0
CONTAINER=stub
STEP_REPORT=()
FAILED_STEP=""
GATED_HEAD=abc123
. ${JSON.stringify(libPath)}
NO_VERDICT_REASON=""
NO_VERDICT_EXIT="$GATE_EXIT_NO_VERDICT"
GATE_REAL_FAILURE=""
GATE_GROUP_PIDS=()
GATE_TMP="$1"
REPO_ROOT="$2"
${extractVerdict()}
${PARALLEL_STEPS}
`;

// Runs a group, waits until the member that is meant to block has reported its
// pid, then signals the harness the way an operator kills a hung gate.
const interruptGroup = async (members) => {
  const root = mkdtempSync(join(tmpdir(), "merge-gate-interrupted-group."));
  try {
    const memberPidFile = join(root, "member.pid");
    const script = join(root, "harness.sh");
    writeFileSync(script, `${COMBINED_HARNESS}\n${members(JSON.stringify(memberPidFile))}\n`);
    const harness = spawn("bash", [script, root, root]);
    let stdout = "";
    harness.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    harness.stderr.on("data", () => {});

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
    assert.notEqual(memberPid, "", "the blocking member never reported its pid");

    harness.kill("SIGTERM");
    const status = await new Promise((resolve) => harness.on("exit", (code, signal) => resolve(code ?? signal)));
    return { status, stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("VERDICT the incident shape: a group stopped mid-flight prints no verdict", async () => {
  // What the 2026-08-25 gate should have printed. Its group was stuck, the
  // operator killed it, and it answered MERGE GATE: FAIL naming the group.
  const run = await interruptGroup(
    (pidFile) => `parallel_steps "the suites" "stuck" sh -c 'printf %s "$$" > "$0"; exec sleep 30' ${pidFile}`,
  );
  assert.equal(run.status, 143);
  assert.match(run.stdout, /GATE NOT RUN: the gate was stopped by SIGTERM during the suites/);
  assert.doesNotMatch(run.stdout, /MERGE GATE: FAIL/);
});

test("VERDICT a failure seen before the signal survives it", async () => {
  // The other direction, and the reason the failure is recorded as each member
  // is reaped rather than in the group's closing accounting: that accounting
  // never runs when a later member is still blocked. Without it the gate would
  // answer "no verdict" about a commit one of its steps had already failed.
  const run = await interruptGroup(
    (pidFile) =>
      `parallel_steps "the suites" "bad" sh -c 'exit 1' :: "stuck" sh -c 'printf %s "$$" > "$0"; exec sleep 30' ${pidFile}`,
  );
  assert.equal(run.status, 1);
  assert.match(run.stdout, /MERGE GATE: FAIL \(bad\)/);
  assert.doesNotMatch(run.stdout, /GATE NOT RUN/);
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
