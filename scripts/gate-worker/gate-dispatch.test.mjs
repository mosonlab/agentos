// Fixtures for the slot locks in scripts/gate-worker/lib.sh and for the exit
// codes scripts/gate-worker/gate-dispatch.sh reports.
//
// Two things are under test and both are mechanisms, not text.
//
// The first is the capacity invariant: three slots, and never a fourth. That is
// a concurrency property, so the cases here run real concurrent processes
// against a real lock root. The bug they exist for is specific — a slot lock
// that is created before it names its owner has a window in which a second
// dispatcher reads "no owner", calls the lock abandoned and takes the slot its
// owner is gating in — and `refuses a lock that names no pid` reproduces
// exactly that window as a state on disk, deterministically, with no timing to
// lose.
//
// The second is that a verdict and the absence of a verdict never share an exit
// code. Those cases run the dispatcher itself against a throwaway repository
// whose merge-gate.sh, mirror-push.sh and remote-gate.sh are stubs, because
// what is being proved is which code comes back from which failure, and a real
// gate would take minutes to prove one bit of it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const libPath = join(here, "lib.sh");
const dispatchPath = join(here, "gate-dispatch.sh");

const test = (name, body) => nodeTest(name, { concurrency: true }, body);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "gate-dispatch-fixture",
  GIT_AUTHOR_EMAIL: "gate-dispatch-fixture",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "gate-dispatch-fixture",
  GIT_COMMITTER_EMAIL: "gate-dispatch-fixture",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

const scratch = (t) => {
  const root = mkdtempSync(join(tmpdir(), "gate-dispatch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

// One bash process, lib.sh sourced, whatever the case wants to say afterwards.
const runBash = (script, options = {}) =>
  spawnSync("bash", ["-c", `set -uo pipefail\n. "${libPath}"\n${script}`], {
    encoding: "utf8",
    ...options,
  });

const slotRoot = (t) => {
  const root = join(scratch(t), "slots");
  mkdirSync(root, { recursive: true });
  return root;
};

const lockFile = (root, slot) => join(root, `${slot}.slot`);

// --- the capacity invariant --------------------------------------------------

test("one claimer takes the slot and names itself in it", (t) => {
  const root = slotRoot(t);
  const result = runBash(`gate_slot_try "${root}" local && cat "${root}/local.slot"`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+$/);
});

test("a slot held by a live pid is refused", (t) => {
  const root = slotRoot(t);
  // This test process is alive by construction, so the lock it writes is a
  // holder that `kill -0` will find.
  writeFileSync(lockFile(root, "local"), `${process.pid}\n`);
  const result = runBash(`gate_slot_try "${root}" local`);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(lockFile(root, "local"), "utf8").trim(), String(process.pid));
});

test("refuses a lock that names no pid rather than reclaiming it", (t) => {
  // The regression. A lock created before its owner was written names nobody,
  // and the whole failure was reading that as "abandoned": two dispatchers then
  // ran one slot. An empty lock is now blocking and loud, never reclaimed.
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "remote-1"), "");
  const result = runBash(`gate_slot_try "${root}" remote-1`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /names no pid/);
  assert.ok(readFileSync(lockFile(root, "remote-1"), "utf8") === "");
});

test("refuses a lock whose contents are not a pid", (t) => {
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "remote-2"), "held by somebody\n");
  const result = runBash(`gate_slot_try "${root}" remote-2`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /names no pid/);
});

test("refuses an old-format lock directory instead of ignoring it", (t) => {
  // The pre-#132 dispatcher held a directory. The two shapes do not exclude
  // each other, so a lock directory this implementation cannot see is how three
  // slots would become six during a changeover.
  const root = slotRoot(t);
  mkdirSync(join(root, "local.lock"));
  const result = runBash(`gate_slot_try "${root}" local`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /old-format slot lock/);
});

test("reclaims a slot whose holder is gone", (t) => {
  const root = slotRoot(t);
  // A pid that has certainly exited: spawn one and wait for it.
  const dead = spawnSync("bash", ["-c", 'echo $$'], { encoding: "utf8" });
  const deadPid = dead.stdout.trim();
  writeFileSync(lockFile(root, "local"), `${deadPid}\n`);
  const result = runBash(`gate_slot_try "${root}" local && cat "${root}/local.slot"`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /reclaimed slot local/);
  assert.notEqual(result.stdout.trim(), deadPid);
});

test("a reclaim already in flight is refused, not raced", (t) => {
  const root = slotRoot(t);
  const dead = spawnSync("bash", ["-c", 'echo $$'], { encoding: "utf8" });
  const deadPid = dead.stdout.trim();
  writeFileSync(lockFile(root, "local"), `${deadPid}\n`);
  // The witness link is what makes exactly one of two dispatchers the reclaimer.
  // Holding it stands in for the other dispatcher being mid-reclaim.
  writeFileSync(join(root, `.reclaim.local.${deadPid}`), `${deadPid}\n`);
  const result = runBash(`gate_slot_try "${root}" local`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /another dispatcher is reclaiming/);
});

test("release removes only a lock this process owns", (t) => {
  const root = slotRoot(t);
  const result = runBash(
    `gate_slot_try "${root}" local && gate_slot_release "${root}" local && test ! -e "${root}/local.slot"`,
  );
  assert.equal(result.status, 0, result.stderr);
});

test("release leaves a lock that names somebody else", (t) => {
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "local"), `${process.pid}\n`);
  const result = runBash(`gate_slot_release "${root}" local`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not releasing slot local/);
  assert.equal(readFileSync(lockFile(root, "local"), "utf8").trim(), String(process.pid));
});

test("sixteen concurrent claimers on one slot produce exactly one holder", (t) => {
  const root = slotRoot(t);
  const winners = join(root, "winners");
  // Each claimer appends only if it took the slot. A single `>>` of a short
  // line is atomic enough for a count, and the count is the whole assertion:
  // the old shape produced more than one here.
  // The winner stays alive after taking the slot. A claimer that exits at once
  // leaves a lock naming a dead pid, which the next claimer is *right* to
  // reclaim — that is a lock working, not a lock failing, and a fixture that
  // does not hold the slot open would be measuring the wrong thing.
  const claimer = `
    . "${libPath}"
    if gate_slot_try "${root}" local; then
      printf '%s\\n' "$$" >> "${winners}"
      sleep 2
    fi
  `;
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -uo pipefail
       : > "${winners}"
       for i in $(seq 1 16); do
         bash -c '${claimer.replace(/'/g, "'\\''")}' &
       done
       wait`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const held = readFileSync(winners, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(held.length, 1, `expected one holder, got ${held.length}: ${held.join(",")}`);
});

test("nine concurrent claimers across three slots produce exactly three holders", (t) => {
  const root = slotRoot(t);
  const winners = join(root, "winners");
  const claimer = `
    . "${libPath}"
    for slot in local remote-1 remote-2; do
      if gate_slot_try "${root}" "$slot"; then
        printf '%s %s\\n' "$slot" "$$" >> "${winners}"
        sleep 2
        break
      fi
    done
  `;
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -uo pipefail
       : > "${winners}"
       for i in $(seq 1 9); do
         bash -c '${claimer.replace(/'/g, "'\\''")}' &
       done
       wait`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const held = readFileSync(winners, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(held.length, 3, `expected three holders, got ${held.length}: ${held.join(" | ")}`);
  assert.equal(new Set(held.map((line) => line.split(" ")[0])).size, 3);
});

test("a killed holder's lock is released by the signal traps", (t) => {
  const root = slotRoot(t);
  const started = join(root, "started");
  const holder = spawnSync(
    "bash",
    [
      "-c",
      `set -uo pipefail
       . "${libPath}"
       HELD=""
       cleanup() { s=$?; trap - EXIT; [ -n "$HELD" ] && gate_slot_release "${root}" "$HELD"; exit $s; }
       trap cleanup EXIT
       trap 'exit 143' TERM
       gate_slot_try "${root}" local && HELD=local
       : > "${started}"
       sleep 20 &
       wait $!`,
    ],
    { encoding: "utf8", timeout: 3000, killSignal: "SIGTERM" },
  );
  // spawnSync's own timeout is the kill: the point is that the trap ran.
  assert.ok(holder.signal === "SIGTERM" || holder.status !== null);
  const result = runBash(`test ! -e "${root}/local.slot"`);
  assert.equal(result.status, 0, `the lock survived a TERM'd holder`);
});

// --- the exit-code contract --------------------------------------------------

// A repository the dispatcher will accept: it has scripts/merge-gate.sh, a
// clean tree and a resolvable HEAD, so the local slot is eligible. The three
// scripts the dispatcher shells out to are stubs; lib.sh and gate-dispatch.sh
// are the real ones.
const fixtureRepo = (t, { mergeGate, mirrorPush, remoteGate }) => {
  const root = scratch(t);
  mkdirSync(join(root, "scripts", "gate-worker"), { recursive: true });
  const put = (path, body) => {
    writeFileSync(join(root, path), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(root, path), 0o755);
  };
  put("scripts/merge-gate.sh", mergeGate ?? 'printf "MERGE GATE: PASS stub\\n"; exit 0');
  put("scripts/gate-worker/mirror-push.sh", mirrorPush ?? 'printf "MIRROR PUSH: OK\\n"; exit 0');
  put("scripts/gate-worker/remote-gate.sh", remoteGate ?? 'printf "MERGE GATE: PASS stub\\n"; exit 0');
  cpSync(libPath, join(root, "scripts", "gate-worker", "lib.sh"));
  cpSync(dispatchPath, join(root, "scripts", "gate-worker", "gate-dispatch.sh"));
  chmodSync(join(root, "scripts", "gate-worker", "gate-dispatch.sh"), 0o755);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: GIT_ENV });
  execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root, env: GIT_ENV });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
  return { root, head };
};

const dispatch = (t, repo, args, env = {}) => {
  const cache = join(scratch(t), "cache");
  mkdirSync(cache, { recursive: true });
  return spawnSync("bash", [join(repo.root, "scripts/gate-worker/gate-dispatch.sh"), ...args], {
    cwd: repo.root,
    encoding: "utf8",
    env: { ...GIT_ENV, XDG_CACHE_HOME: cache, ...env },
  });
};

test("a local PASS comes back as 0 with the gate's own verdict line", (t) => {
  const repo = fixtureRepo(t, {});
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
});

test("a local FAIL comes back as 1, unchanged", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "MERGE GATE: FAIL (stub)\\n"; exit 1',
  });
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MERGE GATE: FAIL/);
});

test("NOT AUTHORITATIVE keeps its own code", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "MERGE GATE: NOT AUTHORITATIVE\\n"; exit 3',
  });
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 3);
});

test("a failed mirror push is 76 and not a FAIL", (t) => {
  // The regression: this used to exit 1 while printing "no gate was run", so an
  // automation reading the exit code could not tell a transport problem from a
  // judgement about the commit.
  const repo = fixtureRepo(t, {
    mirrorPush: 'printf "mirror-push: broken\\n" >&2; exit 1',
  });
  // Dirty the tree so the local slot is ineligible and the dispatch must go
  // remote, which is the path the push is on.
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: /m);
  assert.doesNotMatch(result.stdout, /MERGE GATE: FAIL/);
});

test("the remote path's exit code is passed through unchanged", (t) => {
  const repo = fixtureRepo(t, {
    remoteGate: 'printf "GATE NOT RUN: stub precondition\\n"; exit 76',
  });
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stdout, /GATE NOT RUN/);
});

test("an ssh transport failure stays 255", (t) => {
  const repo = fixtureRepo(t, { remoteGate: "exit 255" });
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 255);
});

test("every slot busy times out at 75 with no verdict", (t) => {
  const repo = fixtureRepo(t, {});
  const cache = join(scratch(t), "cache");
  const slots = join(cache, "gate-dispatch");
  mkdirSync(slots, { recursive: true });
  for (const slot of ["local", "remote-1", "remote-2"]) {
    writeFileSync(join(slots, `${slot}.slot`), `${process.pid}\n`);
  }
  const result = spawnSync(
    "bash",
    [join(repo.root, "scripts/gate-worker/gate-dispatch.sh"), repo.head, "--timeout-minutes", "0"],
    {
      cwd: repo.root,
      encoding: "utf8",
      env: { ...GIT_ENV, XDG_CACHE_HOME: cache, GATE_DISPATCH_POLL_SECONDS: "1" },
    },
  );
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stdout, /GATE DISPATCH: NO SLOT/);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
});

test("the dispatcher releases its slot when the gate ends", (t) => {
  const repo = fixtureRepo(t, {});
  const cache = join(scratch(t), "cache");
  mkdirSync(cache, { recursive: true });
  const result = spawnSync(
    "bash",
    [join(repo.root, "scripts/gate-worker/gate-dispatch.sh"), repo.head],
    { cwd: repo.root, encoding: "utf8", env: { ...GIT_ENV, XDG_CACHE_HOME: cache } },
  );
  assert.equal(result.status, 0, result.stderr);
  const check = spawnSync("test", ["-e", join(cache, "gate-dispatch", "local.slot")]);
  assert.notEqual(check.status, 0, "the local slot was not released");
});

test("a destination that is not an ssh destination is refused before anything is sent", (t) => {
  const repo = fixtureRepo(t, {});
  const result = dispatch(t, repo, [repo.head, "--server", "host; rm -rf /"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a usable ssh destination/);
});
