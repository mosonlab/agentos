// Fixtures for the slot locks in scripts/gate-worker/lib.sh and for the exit
// codes scripts/gate-worker/gate-dispatch.sh reports.
//
// Two things are under test and both are mechanisms, not text.
//
// The first is the per-slot capacity invariant: one holder for each named slot,
// never two holders in one slot. That is a concurrency property, so the cases
// here run real concurrent processes against a real lock root. The bug they
// exist for is specific — a slot lock
// that is created before it names its owner has a window in which a second
// dispatcher reads "no owner", calls the lock abandoned and takes the slot its
// owner is gating in — and `refuses a lock that names no pid` reproduces
// exactly that window as a state on disk, deterministically, with no timing to
// lose.
//
// The second is that a slot which is busy and a slot whose lock cannot be
// operated are different answers. `gate_slot_try` returns 1 for the first and 2
// for the second, and the dispatcher spends a timeout waiting only on the
// first: a lock nobody can take does not free up, and reporting it as a full
// queue sent operators to wait for a slot that was never going to open.
//
// The third is that a verdict and the absence of a verdict never share an exit
// code. Those cases run the dispatcher itself against a throwaway repository
// whose merge-gate.sh, mirror-push.sh and remote-gate.sh are stubs, because
// what is being proved is which code comes back from which failure, and a real
// gate would take minutes to prove one bit of it.
//
// The fourth is the origin-backed merge lease: mutual exclusion, release,
// status, the machine and human steal boundaries, and compare-and-swap under
// concurrent steal attempts. Those cases use a local bare origin so they test
// Git's real ref-update behavior without reaching a hosted repository.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
const mergeLeasePath = join(here, "..", "merge-lease.sh");

const test = (name, body) => nodeTest(name, { concurrency: true }, body);

// The dispatcher and the gate read their topology and their sizing out of the
// environment: `AGENTOS_GATE_SERVER` alone collapses the dispatcher to a single
// server with an empty fallback (gate-dispatch.sh), which turns a case that
// pre-fills the desktop slots into a wait for a slot that cannot open. A
// session configured to reach a real gate worker exports that variable, so a
// fixture that inherits the host environment tests the host's topology instead
// of the one it declares. The host's Git identity was already neutralised here
// for the same reason; behaviour belongs on the same list. Stripping by prefix
// rather than by name means a variable added to the dispatcher later cannot
// reintroduce the leak.
const hostNeutralEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("AGENTOS_GATE_") && !key.startsWith("GATE_DISPATCH_"),
  ),
);

const FIXTURE_ENV = {
  ...hostNeutralEnv,
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
  // 2, not 1: nobody can take this slot and no amount of waiting changes that.
  assert.equal(result.status, 2);
  assert.match(result.stderr, /names no pid/);
  assert.ok(readFileSync(lockFile(root, "remote-1"), "utf8") === "");
});

test("refuses a lock whose contents are not a pid", (t) => {
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "remote-1"), "held by somebody\n");
  const result = runBash(`gate_slot_try "${root}" remote-1`);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /names no pid/);
});

test("refuses an old-format lock directory instead of ignoring it", (t) => {
  // The pre-#132 dispatcher held a directory. The two shapes do not exclude
  // each other, so a lock directory this implementation cannot see is how three
  // slots would become six during a changeover.
  const root = slotRoot(t);
  mkdirSync(join(root, "local.lock"));
  const result = runBash(`gate_slot_try "${root}" local`);
  // Broken rather than busy: this implementation cannot tell whether an old
  // dispatcher is holding it, and "cannot tell" is not something to wait out.
  assert.equal(result.status, 2);
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

test("a slot root that cannot be written to is broken, not busy", (t) => {
  // The regression. A read-only cache directory used to return 1 — the same
  // answer as "somebody is running a gate" — and the dispatcher then polled a
  // slot that could never be taken until its timeout and reported a full queue.
  const root = slotRoot(t);
  chmodSync(root, 0o555);
  // Restored inline rather than in an after hook: the hook that removes the
  // scratch directory was registered first and would run against a directory
  // nothing is allowed to delete from.
  const result = runBash(`gate_slot_try "${root}" local`);
  chmodSync(root, 0o755);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not write a lock under/);
});

test("busy and broken are different return values, not different messages", (t) => {
  // Stated as one assertion because everything downstream depends on it: the
  // dispatcher branches on the number, never on the text.
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "local"), `${process.pid}\n`);
  writeFileSync(lockFile(root, "remote-1"), "not a pid\n");
  const busy = runBash(`gate_slot_try "${root}" local`);
  const broken = runBash(`gate_slot_try "${root}" remote-1`);
  assert.equal(busy.status, 1);
  assert.equal(broken.status, 2);
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

test("eight concurrent claimers across two slots produce exactly two holders", (t) => {
  const root = slotRoot(t);
  const winners = join(root, "winners");
  const claimer = `
    . "${libPath}"
    for slot in remote-1 local; do
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
       for i in $(seq 1 8); do
         bash -c '${claimer.replace(/'/g, "'\\''")}' &
       done
       wait`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const held = readFileSync(winners, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(held.length, 2, `expected two holders, got ${held.length}: ${held.join(" | ")}`);
  assert.equal(new Set(held.map((line) => line.split(" ")[0])).size, 2);
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
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: FIXTURE_ENV });
  execFileSync("git", ["add", "-A"], { cwd: root, env: FIXTURE_ENV });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root, env: FIXTURE_ENV });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env: FIXTURE_ENV,
    encoding: "utf8",
  }).trim();
  const originRoot = scratch(t);
  const origin = join(originRoot, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin], { env: FIXTURE_ENV });
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"], { env: FIXTURE_ENV });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: root, env: FIXTURE_ENV });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: root, env: FIXTURE_ENV });
  return { root, head };
};

// No fixture may block. The dispatcher's default patience is an hour, which is
// right for an operator waiting on a real queue and absurd inside a test, and a
// spawnSync with no timeout promotes that wait into a suite that never returns
// — the shape a leaked AGENTOS_GATE_SERVER produced here. Every dispatcher run
// therefore goes through this helper and carries both bounds: the dispatcher
// gives up first, so the failure is a readable 75 rather than a kill, and the
// timeout is the backstop for a dispatcher that never gets that far. Cases that
// are about the wait itself pass their own --timeout-minutes, which wins.
const DISPATCH_KILL_MS = 120_000;

const runDispatch = (repo, cache, args, env = {}) =>
  spawnSync("bash", [join(repo.root, "scripts/gate-worker/gate-dispatch.sh"), ...args], {
    cwd: repo.root,
    encoding: "utf8",
    timeout: DISPATCH_KILL_MS,
    env: {
      ...FIXTURE_ENV,
      XDG_CACHE_HOME: cache,
      GATE_DISPATCH_POLL_SECONDS: "1",
      GATE_DISPATCH_TIMEOUT_MINUTES: "1",
      ...env,
    },
  });

// A cache root with the named slots already taken, so a case states its queue
// as a precondition instead of racing one into place.
const busyCache = (t, busySlots = []) => {
  const cache = join(scratch(t), "cache");
  const slots = join(cache, "gate-dispatch");
  mkdirSync(slots, { recursive: true });
  for (const slot of busySlots) writeFileSync(join(slots, `${slot}.slot`), `${process.pid}\n`);
  return cache;
};

const dispatch = (t, repo, args, env = {}, busySlots = []) =>
  runDispatch(repo, busyCache(t, busySlots), args, env);

test("the fixture environment carries no host gate configuration", () => {
  // The guard for the leak itself. Nothing below states which servers exist or
  // how long to wait unless it says so, so a host that is configured to reach a
  // real gate worker cannot silently rewrite the topology these cases assert
  // on — which is how this suite once blocked for the dispatcher's full hour
  // instead of failing.
  const leaked = Object.keys(FIXTURE_ENV).filter(
    (key) => key.startsWith("AGENTOS_GATE_") || key.startsWith("GATE_DISPATCH_"),
  );
  assert.deepEqual(leaked, [], `host gate configuration reached the fixtures: ${leaked.join(", ")}`);
});

test("an explicitly enabled local PASS comes back as 0 with the gate's own verdict line", (t) => {
  const repo = fixtureRepo(t, {});
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"], {}, ["remote-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
});

test("an explicitly enabled local FAIL comes back as 1, unchanged", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "MERGE GATE: FAIL (stub)\\n"; exit 1',
  });
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"], {}, ["remote-1"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MERGE GATE: FAIL/);
});

test("NOT AUTHORITATIVE keeps its own code", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "MERGE GATE: NOT AUTHORITATIVE\\n"; exit 3',
  });
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"], {}, ["remote-1"]);
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

test("dispatch tries the remote slot before an eligible local slot", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "LOCAL SHOULD NOT RUN\\n"; exit 1',
    remoteGate: 'printf "MERGE GATE: PASS remote-first\\n"; exit 0',
  });
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote-first/);
  assert.doesNotMatch(result.stdout, /LOCAL SHOULD NOT RUN/);
  assert.match(result.stderr, /running on primary/);
});

test("dispatch uses local only when it is explicit and the selected remote is busy", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "MERGE GATE: PASS local-spillover\\n"; exit 0',
    remoteGate: 'printf "REMOTE SHOULD NOT RUN\\n"; exit 1',
  });
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"], {}, ["remote-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local-spillover/);
  assert.doesNotMatch(result.stdout, /REMOTE SHOULD NOT RUN/);
  assert.match(result.stderr, /local slot/);
});

test("the remote path's exit code is passed through unchanged", (t) => {
  const repo = fixtureRepo(t, {
    remoteGate: 'printf "GATE NOT RUN: stub precondition\\n"; exit 76',
  });
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head, "--server", "primary"]);
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stdout, /GATE NOT RUN/);
});

test("the remote path receives the exact candidate and frozen baseline", (t) => {
  const repo = fixtureRepo(t, {
    mirrorPush: 'printf "mirror args: %s\\n" "$*" >&2',
    remoteGate: 'printf "remote args: %s\\n" "$*" >&2; printf "MERGE GATE: PASS stub\\n"',
  });
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`mirror args: .*--candidate ${repo.head} --baseline ${repo.head}`));
  assert.match(result.stderr, new RegExp(`remote args: .*${repo.head} --master ${repo.head}`));
});

test("origin HEAD discovery retries transient git failures before dispatch", (t) => {
  const repo = fixtureRepo(t, {});
  const shim = scratch(t);
  const counter = join(shim, "ls-remote-count");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitShim = join(shim, "git");
  writeFileSync(gitShim, `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$3" = "ls-remote" ]; then
  count=0
  [ ! -f "$GATE_GIT_COUNTER" ] || count="$(cat "$GATE_GIT_COUNTER")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$GATE_GIT_COUNTER"
  [ "$count" -gt 2 ] || exit 1
fi
exec "$REAL_GIT" "$@"
`);
  chmodSync(gitShim, 0o755);
  const result = dispatch(t, repo, [repo.head], {
    PATH: `${shim}:${process.env.PATH}`,
    REAL_GIT: realGit,
    GATE_GIT_COUNTER: counter,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(counter, "utf8").trim(), "4");
  assert.match(result.stderr, /origin HEAD read failed; retrying attempt=2\/3/u);
  assert.match(result.stderr, /origin HEAD read failed; retrying attempt=3\/3/u);
});

test("origin default-ref fetch retries transient git failures before dispatch", (t) => {
  const repo = fixtureRepo(t, {});
  const shim = scratch(t);
  const counter = join(shim, "fetch-count");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitShim = join(shim, "git");
  writeFileSync(gitShim, `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$3" = "fetch" ]; then
  count=0
  [ ! -f "$GATE_FETCH_COUNTER" ] || count="$(cat "$GATE_FETCH_COUNTER")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$GATE_FETCH_COUNTER"
  [ "$count" -gt 2 ] || exit 1
fi
exec "$REAL_GIT" "$@"
`);
  chmodSync(gitShim, 0o755);
  const result = dispatch(t, repo, [repo.head], {
    PATH: `${shim}:${process.env.PATH}`,
    REAL_GIT: realGit,
    GATE_FETCH_COUNTER: counter,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(counter, "utf8").trim(), "3");
  assert.match(result.stderr, /origin ref fetch failed; retrying attempt=2\/3/u);
  assert.match(result.stderr, /origin ref fetch failed; retrying attempt=3\/3/u);
});

test("a configured single server is consumed by the dispatcher before child tools", (t) => {
  const repo = fixtureRepo(t, {
    mirrorPush: 'test -z "${AGENTOS_GATE_SERVER:-}"; test "$1" = agentos-gate; printf "MIRROR PUSH: OK\\n"',
    remoteGate: 'test -z "${AGENTOS_GATE_SERVER:-}"; test "$1" = agentos-gate; printf "MERGE GATE: PASS single-server\\n"',
  });
  const result = dispatch(t, repo, [repo.head], { AGENTOS_GATE_SERVER: "agentos-gate" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS single-server/u);
  assert.match(result.stderr, /primary agentos-gate\(1\)/u);
  assert.doesNotMatch(result.stderr, /fallback/u);
});

test("an ssh transport failure retries the exact gate on the fallback", (t) => {
  const repo = fixtureRepo(t, {
    remoteGate:
      'if [ "$1" = ci-desktop-worker ]; then printf "GATE NOT RUN: ssh dropped\\n"; exit 255; fi; printf "MERGE GATE: PASS fallback\\n"',
  });
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^MERGE GATE: PASS fallback$/m);
  assert.doesNotMatch(result.stdout, /GATE NOT RUN/);
  assert.match(result.stderr, /trying fallback capacity/);
  assert.match(result.stderr, /running on fallback/);
});

test("a primary FAIL is final and never falls back", (t) => {
  const repo = fixtureRepo(t, {
    remoteGate:
      'if [ "$1" = ci-desktop-worker ]; then printf "MERGE GATE: FAIL (candidate)\\n"; exit 1; fi; printf "FALLBACK SHOULD NOT RUN\\n"',
  });
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /MERGE GATE: FAIL/);
  assert.doesNotMatch(result.stdout + result.stderr, /FALLBACK SHOULD NOT RUN/);
});

test("every slot busy times out at 75 with no verdict", (t) => {
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t, ["remote-1", "remote-1-2", "remote-2"]);
  const result = runDispatch(repo, cache, [repo.head, "--timeout-minutes", "0"]);
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stdout, /GATE DISPATCH: NO SLOT/);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
});

test("locks that cannot be operated are 76 at once, not 75 after the timeout", (t) => {
  // The regression, and the reason 75 and 76 exist separately. Every slot lock
  // here is unusable — the slot root is read-only — and the old helper answered
  // "busy" for that, so the dispatcher polled until its timeout and then said
  // GATE DISPATCH: NO SLOT, which told the operator to come back later for a
  // slot that was never going to open. There is nothing to wait for, so this
  // must come back immediately and say what to clear.
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t);
  const slots = join(cache, "gate-dispatch");
  chmodSync(slots, 0o555);
  const started = Date.now();
  // One minute: long enough that polling would be unmistakable in the elapsed
  // time, short enough that a regression here fails the suite instead of
  // hanging it.
  const result = runDispatch(repo, cache, [repo.head, "--timeout-minutes", "1"]);
  chmodSync(slots, 0o755);
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: /m);
  assert.doesNotMatch(result.stdout, /GATE DISPATCH: NO SLOT/);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
  // It did not wait: a --timeout-minutes 1 run that returns in seconds is the
  // observable difference between "nothing can be locked" and "everything is
  // busy".
  assert.ok(Date.now() - started < 20_000, "it polled instead of answering at once");
});

test("one busy desktop slot uses the second desktop slot before fallback", (t) => {
  const repo = fixtureRepo(t, {});
  const result = runDispatch(repo, busyCache(t, ["remote-1"]), [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
  assert.match(result.stderr, /running on primary/);
  assert.doesNotMatch(result.stderr, /running on fallback/);
});

test("two busy desktop slots spill onto the fallback without using the Mac", (t) => {
  const repo = fixtureRepo(t, {});
  const result = runDispatch(repo, busyCache(t, ["remote-1", "remote-1-2"]), [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
  assert.match(result.stderr, /running on fallback/);
  assert.doesNotMatch(result.stderr, /local slot/);
});

test("busy plus broken waits out the timeout and then reports 76, not 75", (t) => {
  // The mixed case. One slot is genuinely busy, so waiting is justified and the
  // dispatch must not give up early — but when the wait ends empty, the answer
  // is not "the queue was full": one of the three slots was never available to
  // anybody, and 75 would send the operator to re-dispatch into the same broken
  // locks. Nothing may be taken here either, so the capacity limit holds.
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t, ["remote-1", "remote-1-2"]);
  const slots = join(cache, "gate-dispatch");
  mkdirSync(join(slots, "remote-2.lock"));
  const result = runDispatch(repo, cache, [repo.head, "--timeout-minutes", "0"]);
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: /m);
  assert.doesNotMatch(result.stdout, /GATE DISPATCH: NO SLOT/);
  assert.equal(readFileSync(join(slots, "remote-1.slot"), "utf8").trim(), String(process.pid));
});

test("remote processes that die without a verdict exhaust fallback as 76", (t) => {
  const repo = fixtureRepo(t, { remoteGate: "exit 137" });
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 76);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
  assert.match(result.stdout, /^GATE NOT RUN:/m);
});

test("the dispatcher releases its slot when the gate ends", (t) => {
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t);
  const result = runDispatch(repo, cache, [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  const check = spawnSync("test", ["-e", join(cache, "gate-dispatch", "remote-1.slot")]);
  assert.notEqual(check.status, 0, "the remote slot was not released");
});

test("a destination that is not an ssh destination is refused before anything is sent", (t) => {
  const repo = fixtureRepo(t, {});
  const result = dispatch(t, repo, [repo.head, "--server", "host; rm -rf /"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a usable primary ssh destination/);
});

// --- the global merge lease -------------------------------------------------

const leaseFixture = (t) => {
  const parent = scratch(t);
  const origin = join(parent, "origin.git");
  const root = join(parent, "source");
  execFileSync("git", ["init", "-q", "--bare", origin], { env: FIXTURE_ENV });
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(mergeLeasePath, join(root, "scripts", "merge-lease.sh"));
  chmodSync(join(root, "scripts", "merge-lease.sh"), 0o755);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: FIXTURE_ENV });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: root, env: FIXTURE_ENV });
  return { root, origin };
};

const runLease = (fixture, args, holder = "machine@fixture") =>
  spawnSync("bash", [join(fixture.root, "scripts", "merge-lease.sh"), ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...FIXTURE_ENV, MERGE_LEASE_HOLDER: holder },
  });

const installLease = (fixture, lease) => {
  const body = `${JSON.stringify(lease)}\n`;
  const sha = execFileSync("git", ["-C", fixture.root, "hash-object", "-w", "--stdin"], {
    env: FIXTURE_ENV,
    encoding: "utf8",
    input: body,
  }).trim();
  execFileSync("git", ["-C", fixture.root, "push", "-q", "origin", `+${sha}:refs/merge-lease/holder`], {
    env: FIXTURE_ENV,
  });
  return { ...lease, sha };
};

const readLease = (fixture) => {
  const sha = execFileSync("git", ["--git-dir", fixture.origin, "rev-parse", "refs/merge-lease/holder"], {
    env: FIXTURE_ENV,
    encoding: "utf8",
  }).trim();
  const body = execFileSync("git", ["--git-dir", fixture.origin, "cat-file", "blob", sha], {
    env: FIXTURE_ENV,
    encoding: "utf8",
  });
  return { sha, lease: JSON.parse(body) };
};

const runLeaseAsync = (fixture, args, holder) =>
  new Promise((resolve) => {
    const child = spawn("bash", [join(fixture.root, "scripts", "merge-lease.sh"), ...args], {
      cwd: fixture.root,
      env: { ...FIXTURE_ENV, MERGE_LEASE_HOLDER: holder },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });

test("merge lease acquire is mutually exclusive and release removes the lease", (t) => {
  const fixture = leaseFixture(t);
  const first = runLease(
    fixture,
    ["acquire", "--reason", "First merge", "--task", "chain-1"],
    "first@fixture",
  );
  assert.equal(first.status, 0, first.stdout + first.stderr);

  const second = runLease(
    fixture,
    ["acquire", "--reason", "Second merge", "--task", "chain-2", "--timeout-minutes", "0"],
    "second@fixture",
  );
  assert.equal(second.status, 75, second.stdout + second.stderr);
  assert.equal(readLease(fixture).lease.holder, "first@fixture");

  const released = runLease(fixture, ["release", "--force"], "first@fixture");
  assert.equal(released.status, 0, released.stdout + released.stderr);
  const status = runLease(fixture, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /no lease held/u);
});

test("merge lease acquire is reentrant only for the same task", (t) => {
  const fixture = leaseFixture(t);
  const first = runLease(
    fixture,
    ["acquire", "--reason", "First chain tail", "--task", "chain-42"],
    "first@fixture",
  );
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const original = readLease(fixture);

  const reentrant = runLease(
    fixture,
    ["acquire", "--reason", "Retried chain tail", "--task", "chain-42", "--timeout-minutes", "0"],
    "second@fixture",
  );
  assert.equal(reentrant.status, 0, reentrant.stdout + reentrant.stderr);
  assert.match(reentrant.stdout, /already held for task chain-42/u);
  assert.deepEqual(readLease(fixture), original, "reentry must not rewrite the lease object");

  const other = runLease(
    fixture,
    ["acquire", "--reason", "Other chain tail", "--task", "chain-43", "--timeout-minutes", "0"],
    "second@fixture",
  );
  assert.equal(other.status, 75, other.stdout + other.stderr);
  assert.deepEqual(readLease(fixture), original);
});

test("merge lease task release ignores holder identity and skips a different task", (t) => {
  const fixture = leaseFixture(t);
  const acquired = runLease(
    fixture,
    ["acquire", "--reason", "Chain tail", "--task", "chain-42"],
    "runner@fixture",
  );
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const original = readLease(fixture);

  const skipped = runLease(fixture, ["release", "--task", "chain-43"], "api@fixture");
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.match(skipped.stdout, /release skipped/u);
  assert.deepEqual(readLease(fixture), original);

  const released = runLease(fixture, ["release", "--task", "chain-42"], "api@fixture");
  assert.equal(released.status, 0, released.stdout + released.stderr);
  assert.match(runLease(fixture, ["status"]).stdout, /no lease held/u);
});

test("merge lease release refuses a caller that does not hold the lease", (t) => {
  const fixture = leaseFixture(t);
  const held = {
    holder: "holder@fixture",
    acquiredAt: new Date().toISOString(),
    reason: "Active merge",
    token: "holder-token",
  };
  installLease(fixture, held);

  const refused = runLease(fixture, ["release", "--force"], "stranger@fixture");
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /held by holder@fixture, not stranger@fixture/u);
  assert.deepEqual(readLease(fixture).lease, held);

  const released = runLease(fixture, ["release", "--force"], "holder@fixture");
  assert.equal(released.status, 0, released.stdout + released.stderr);
  const status = runLease(fixture, ["status"]);
  assert.match(status.stdout, /no lease held/u);
});

test("merge lease acquire without --task is refused so every lease records its task", (t) => {
  const fixture = leaseFixture(t);
  const refused = runLease(fixture, ["acquire", "--reason", "Missing task"], "agent@mac");
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /acquire requires --task/u);
  assert.match(runLease(fixture, ["status"]).stdout, /no lease held/u);
});

test("merge lease release without --task is refused rather than freeing a sibling window", (t) => {
  const fixture = leaseFixture(t);
  // Both windows are the same user on the same machine, so the holder string is
  // identical and cannot tell them apart. Only the task id can.
  const acquired = runLease(
    fixture,
    ["acquire", "--reason", "Window A merge", "--task", "chain-42"],
    "agent@mac",
  );
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const original = readLease(fixture);

  const refused = runLease(fixture, ["release"], "agent@mac");
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /release requires --task/u);
  assert.deepEqual(readLease(fixture), original);
});

test("merge lease acquire restamps acquiredAt on every attempt while it queues", async (t) => {
  const fixture = leaseFixture(t);
  const blocking = {
    holder: "blocker@fixture",
    acquiredAt: new Date().toISOString(),
    reason: "Long merge",
    token: "blocker-token",
  };
  installLease(fixture, blocking);

  const waiter = runLeaseAsync(
    fixture,
    ["acquire", "--reason", "Queued merge", "--task", "chain-99", "--poll-seconds", "1"],
    "waiter@fixture",
  );
  // Let the first attempt lose and the poll loop turn over at least once, so the
  // blob the winner installs is not the one it built at the head of the queue.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const queuedFor = Date.now();
  execFileSync("git", ["--git-dir", fixture.origin, "update-ref", "-d", "refs/merge-lease/holder"], {
    env: FIXTURE_ENV,
  });

  const result = await waiter;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const acquiredAt = Date.parse(readLease(fixture).lease.acquiredAt);
  assert.ok(
    acquiredAt >= queuedFor - 1000,
    `acquiredAt ${new Date(acquiredAt).toISOString()} must be stamped when the lease was won, not when queueing began`,
  );
});

test("merge lease status prints every field of the current holder", (t) => {
  const fixture = leaseFixture(t);
  const acquired = runLease(
    fixture,
    ["acquire", "--reason", "Inspect status", "--task", "task-42"],
    "status@fixture",
  );
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const secondRoot = join(dirname(fixture.root), "second-source");
  mkdirSync(join(secondRoot, "scripts"), { recursive: true });
  cpSync(mergeLeasePath, join(secondRoot, "scripts", "merge-lease.sh"));
  chmodSync(join(secondRoot, "scripts", "merge-lease.sh"), 0o755);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: secondRoot, env: FIXTURE_ENV });
  execFileSync("git", ["remote", "add", "origin", fixture.origin], { cwd: secondRoot, env: FIXTURE_ENV });
  const status = runLease({ root: secondRoot, origin: fixture.origin }, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  const lease = JSON.parse(status.stdout);
  assert.equal(lease.holder, "status@fixture");
  assert.equal(lease.task, "task-42");
  assert.equal(lease.reason, "Inspect status");
  assert.match(lease.acquiredAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(lease.token, /^[0-9a-f-]{36}$/u);
});

test("machine steal is refused through 45 minutes and allowed only after it", (t) => {
  const fixture = leaseFixture(t);
  const recent = {
    holder: "recent@fixture",
    acquiredAt: new Date(Date.now() - 44 * 60 * 1000).toISOString(),
    reason: "Recent merge",
    token: "recent-token",
  };
  installLease(fixture, recent);
  const refused = runLease(fixture, ["steal", "--reason", "Machine recovery"], "machine@fixture");
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /has not exceeded 2700s/u);
  assert.equal(readLease(fixture).lease.holder, "recent@fixture");

  const stale = {
    ...recent,
    acquiredAt: new Date(Date.now() - 46 * 60 * 1000).toISOString(),
    token: "stale-token",
  };
  installLease(fixture, stale);
  const stolen = runLease(fixture, ["steal", "--reason", "Machine recovery"], "machine@fixture");
  assert.equal(stolen.status, 0, stolen.stdout + stolen.stderr);
  assert.match(stolen.stderr, /stealing lease from/u);
  const current = readLease(fixture).lease;
  assert.equal(current.holder, "machine@fixture");
  assert.deepEqual(current.stolenFrom, stale);
});

test("an explicit human steal replaces a fresh lease immediately", (t) => {
  const fixture = leaseFixture(t);
  const original = {
    holder: "active@fixture",
    acquiredAt: new Date().toISOString(),
    reason: "Active merge",
    token: "active-token",
  };
  installLease(fixture, original);
  const stolen = runLease(
    fixture,
    ["steal", "--human", "--reason", "Human override", "--task", "incident-7"],
    "leo@fixture",
  );
  assert.equal(stolen.status, 0, stolen.stdout + stolen.stderr);
  const current = readLease(fixture).lease;
  assert.equal(current.holder, "leo@fixture");
  assert.equal(current.task, "incident-7");
  assert.deepEqual(current.stolenFrom, original);
});

test("two concurrent steals compare-and-swap the observed holder so exactly one wins", async (t) => {
  const fixture = leaseFixture(t);
  const original = {
    holder: "abandoned@fixture",
    acquiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    reason: "Abandoned merge",
    token: "abandoned-token",
  };
  installLease(fixture, original);
  const hook = join(fixture.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/usr/bin/env bash\nsleep 0.4\n");
  chmodSync(hook, 0o755);

  const results = await Promise.all([
    runLeaseAsync(fixture, ["steal", "--reason", "First recovery"], "first@fixture"),
    runLeaseAsync(fixture, ["steal", "--reason", "Second recovery"], "second@fixture"),
  ]);
  assert.equal(results.filter((result) => result.status === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.status === 1).length, 1, JSON.stringify(results));
  assert.match(results.find((result) => result.status === 1).stderr, /compare-and-swap refused/u);
  const current = readLease(fixture).lease;
  assert.ok(["first@fixture", "second@fixture"].includes(current.holder));
  assert.deepEqual(current.stolenFrom, original);
});
