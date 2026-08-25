// Fixtures for the gate worker's harness and for the values its local-side
// scripts are allowed to send.
//
// Three things are proved here, and each is something that has already been
// wrong once.
//
// 1. Credentials are not a worker precondition. Provisioning and gate execution
//    must not fail merely because the trusted operator VM carries credentials.
//
// 2. Repository names, gate homes, ssh destinations and ref names become part
//    of a command string a remote login shell parses. `.` and `..` were
//    accepted as repository names; `--gate-home` was not checked at all. These
//    are the allowlists, tested as allowlists: what is refused matters more
//    than what is accepted.
//
// 3. `run-gate.sh` must not report the worker's own state as a verdict about a
//    commit. A missing mirror or a commit that was never pushed is not something
//    the gate decided, and each is
//    checked to exit 76 with a GATE NOT RUN line rather than 1 with a
//    MERGE GATE: FAIL line.
//
// 4. What the worker's isolation is claimed to be. Leo's ruling of 2026-08-20
//    is that no network egress control is required: the deterministic boundary
//    is the exact pushed objects, no mirror remote and no merge authority; the box is NOT
//    network-isolated. The failure mode this guards is a document drifting back
//    into "the worker cannot reach GitHub", which would be an isolation claim
//    nothing enforces.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const libPath = join(here, "lib.sh");
const runGatePath = join(here, "run-gate.sh");
const dispatchPath = join(here, "gate-dispatch.sh");
const mirrorPushPath = join(here, "mirror-push.sh");
const provisionPath = join(here, "provision.sh");
const runbookPath = join(here, "..", "..", "docs", "runbooks", "gate-worker.md");

const test = (name, body) => nodeTest(name, { concurrency: true }, body);

// The dispatcher and the gate read their topology and their sizing out of the
// environment: `AGENTOS_GATE_SERVER` alone collapses the dispatcher to a single
// server with an empty fallback (gate-dispatch.sh), which turns a case that
// pre-fills the desktop slots into a wait for a slot that cannot open. A
// session configured to reach a real gate worker exports that variable, so a
// fixture that inherits the host environment tests the host's topology instead
// of the one it declares. The host's Git identity was already neutralised here
// for the same reason; behaviour belongs on the same list. The dispatcher's own
// namespace is stripped by prefix so a variable added to it later cannot
// reintroduce the leak.
const HOST_GATE_PREFIXES = ["AGENTOS_GATE_", "GATE_DISPATCH_"];
// run-gate.sh's two are not prefixed but are read the same way: GATE_HOME
// relocates the whole gate directory a fixture built for itself — at the real
// worker's mirror, worktrees and logs — and STALE_WORKTREE_MINUTES decides what
// its sweep reclaims. XDG_CACHE_HOME is deliberately NOT on this list: every
// case that needs it sets it, and removing it would point a dispatcher at the
// real slot locks under $HOME/.cache instead.
const HOST_GATE_NAMES = ["GATE_HOME", "STALE_WORKTREE_MINUTES"];
const isHostGateConfig = (key) =>
  HOST_GATE_PREFIXES.some((prefix) => key.startsWith(prefix)) || HOST_GATE_NAMES.includes(key);

const hostNeutralEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !isHostGateConfig(key)),
);

const FIXTURE_ENV = {
  ...hostNeutralEnv,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "gate-worker-fixture",
  GIT_AUTHOR_EMAIL: "gate-worker-fixture",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "gate-worker-fixture",
  GIT_COMMITTER_EMAIL: "gate-worker-fixture",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

const scratch = (t) => {
  const root = mkdtempSync(join(tmpdir(), "gate-worker-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: FIXTURE_ENV }).trim();

// --- worker provisioning contract -------------------------------------------

test("provisioning includes the native Node build/runtime dependencies and Git identity", () => {
  const source = readFileSync(provisionPath, "utf8");
  for (const pkg of ["python3", "build-essential", "libatomic1"]) {
    assert.match(source, new RegExp(`for pkg in [^\\n]*\\b${pkg}\\b`), `${pkg} is not provisioned`);
  }
  assert.match(source, /git config --global user\.name/);
  assert.match(source, /git config --global user\.email/);
  assert.match(source, /vmware-toolbox-cmd timesync disable/);
  assert.match(source, /timedatectl set-ntp true/);
  assert.doesNotMatch(source, /SECRET_VARS=/);
  assert.doesNotMatch(readFileSync(runGatePath, "utf8"), /SECRET_VARS=/);
});

// --- what may reach a remote shell -------------------------------------------

const lib = (call) =>
  spawnSync("bash", ["-c", `set -uo pipefail\n. "${libPath}"\n${call}`], { encoding: "utf8" });

const accepts = (fn, value) => lib(`${fn} '${value.replace(/'/g, "'\\''")}'`);

test("gate_valid_home refuses everything that is not a plain relative path", () => {
  for (const good of ["gate", "gate/nested", "srv.gates/agentos_1", "a-b/c.d"]) {
    assert.equal(accepts("gate_valid_home", good).status, 0, `rejected ${good}`);
  }
  for (const bad of [
    "",
    "/absolute",
    "-flag",
    "..",
    "../escape",
    "gate/..",
    "gate/../..",
    ".",
    "gate/./x",
    "gate//x",
    "gate/",
    "gate home",
    "gate;id",
    "gate$(id)",
    "gate`id`",
    'gate"x',
    "gate&&id",
    "gate|id",
    "gate\nid",
  ]) {
    assert.equal(accepts("gate_valid_home", bad).status, 1, `accepted ${JSON.stringify(bad)}`);
  }
});

test("gate_valid_server refuses everything that is not an ssh destination", () => {
  for (const good of ["agentos-gate", "user@host", "host.example.com", "u_1@10.0.0.1"]) {
    assert.equal(accepts("gate_valid_server", good).status, 0, `rejected ${good}`);
  }
  for (const bad of ["", "-oProxyCommand=id", "host;id", "host:path", "host $(id)", "host|id"]) {
    assert.equal(accepts("gate_valid_server", bad).status, 1, `accepted ${JSON.stringify(bad)}`);
  }
});

test("gate_valid_ref refuses anything that is not a plain branch ref", () => {
  for (const good of ["refs/heads/main", "refs/heads/release/v1.2", "refs/heads/a_b.c-d"]) {
    assert.equal(accepts("gate_valid_ref", good).status, 0, `rejected ${good}`);
  }
  for (const bad of [
    "",
    "main",
    "refs/heads/",
    "refs/tags/v1",
    "refs/heads/..",
    "refs/heads/a/../b",
    "refs/heads/a b",
    "refs/heads/a;id",
    "refs/heads/-x",
  ]) {
    assert.equal(accepts("gate_valid_ref", bad).status, 1, `accepted ${JSON.stringify(bad)}`);
  }
});

// gate_repo_name reads the name off origin's URL, so the cases are URLs.
const repoNameOf = (t, originUrl) => {
  const root = scratch(t);
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", originUrl);
  return spawnSync("bash", ["-c", `set -uo pipefail\n. "${libPath}"\ngate_repo_name "${root}"`], {
    encoding: "utf8",
  });
};

test("gate_repo_name takes an ordinary repository name off origin", (t) => {
  const result = repoNameOf(t, "https://github.com/mosonlab/agentos-public.git");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "agentos-public");
});

test("gate_repo_name refuses a name that is a path segment with a meaning", (t) => {
  // `https://host/..git` reduces to `.`, which would collapse a repository's
  // directory onto the gate root and fold every repository's mirror together.
  assert.equal(repoNameOf(t, "https://example.com/..git").status, 1);
  // `https://host/...git` reduces to `..`, which walks out of the gate root.
  assert.equal(repoNameOf(t, "https://example.com/...git").status, 1);
});

test("gate_repo_name refuses a name carrying remote shell syntax", (t) => {
  for (const url of [
    "https://example.com/a;id.git",
    "https://example.com/a b.git",
    "https://example.com/$(id).git",
    "https://example.com/-x.git",
  ]) {
    assert.equal(repoNameOf(t, url).status, 1, `accepted ${url}`);
  }
});

test("a first-deployment mirror dry-run describes creation without pushing into an absent mirror", (t) => {
  const root = scratch(t);
  const repo = join(root, "source");
  mkdirSync(join(repo, "scripts", "gate-worker"), { recursive: true });
  writeFileSync(join(repo, "scripts", "merge-gate.sh"), "#!/usr/bin/env bash\nexit 0\n");
  cpSync(mirrorPushPath, join(repo, "scripts", "gate-worker", "mirror-push.sh"));
  cpSync(libPath, join(repo, "scripts", "gate-worker", "lib.sh"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", "https://example.invalid/mosonlab/agentos-public.git");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  const oid = git(repo, "rev-parse", "HEAD");

  const fakeHome = join(root, "worker-home");
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "ssh"),
    `#!/usr/bin/env bash
set -uo pipefail
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-o|-i|-F) shift 2 ;;
    -n|-T|-x) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || exit 2
shift
cd "$FAKE_SSH_HOME"
exec bash -c "$*"
`,
  );
  chmodSync(join(fakeBin, "ssh"), 0o755);

  const result = spawnSync(
    "bash",
    [join(repo, "scripts", "gate-worker", "mirror-push.sh"), "fake", "--candidate", oid, "--baseline", oid, "--dry-run"],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...FIXTURE_ENV,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_SSH_HOME: fakeHome,
      },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /would create the bare mirror/);
  assert.match(result.stdout, /MIRROR PUSH: DRY RUN OK/);
  assert.equal(existsSync(join(fakeHome, "gate", "agentos-public", "mirror.git")), false);
});

test("mirror push retries two transient push failures before succeeding", (t) => {
  const root = scratch(t);
  const repo = join(root, "source");
  mkdirSync(join(repo, "scripts", "gate-worker"), { recursive: true });
  writeFileSync(join(repo, "scripts", "merge-gate.sh"), "#!/usr/bin/env bash\nexit 0\n");
  for (const name of ["mirror-push.sh", "run-gate.sh", "lib.sh"]) {
    cpSync(join(here, name), join(repo, "scripts", "gate-worker", name));
  }
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", "https://example.invalid/mosonlab/retry.git");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  const oid = git(repo, "rev-parse", "HEAD");

  const fakeHome = join(root, "worker-home");
  const mirror = join(fakeHome, "gate", "retry", "mirror.git");
  mkdirSync(join(fakeHome, "gate", "retry"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", mirror], { env: FIXTURE_ENV });

  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "ssh"), `#!/usr/bin/env bash
set -uo pipefail
if [ "\${1:-}" = "-G" ]; then exit 1; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-o|-i|-F) shift 2 ;;
    -n|-T|-x) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || exit 2
shift
cd "$FAKE_SSH_HOME"
exec bash -c "$*"
`);
  writeFileSync(join(fakeBin, "scp"), `#!/usr/bin/env bash
set -uo pipefail
while [ $# -gt 0 ]; do
  case "$1" in
    -P|-o) shift 2 ;;
    -q) shift ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || exit 2
destination="\${2#*:}"
cp "$1" "$FAKE_SSH_HOME/$destination"
`);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const pushCounter = join(root, "push-count");
  writeFileSync(join(fakeBin, "git"), `#!/usr/bin/env bash
is_push=0
for argument in "$@"; do
  [ "$argument" = push ] && is_push=1
done
if [ "$is_push" -eq 1 ]; then
  count=0
  [ ! -f "$PUSH_COUNTER" ] || count="$(cat "$PUSH_COUNTER")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$PUSH_COUNTER"
  [ "$count" -gt 2 ] || exit 1
fi
exec "$REAL_GIT" "$@"
`);
  for (const name of ["ssh", "scp", "git"]) chmodSync(join(fakeBin, name), 0o755);

  const result = spawnSync(
    "bash",
    [join(repo, "scripts", "gate-worker", "mirror-push.sh"), "fake", "--candidate", oid, "--baseline", oid],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...FIXTURE_ENV,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_SSH_HOME: fakeHome,
        REAL_GIT: realGit,
        PUSH_COUNTER: pushCounter,
      },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(pushCounter, "utf8").trim(), "3");
  assert.match(result.stderr, /exact-ref push failed; retrying attempt=2\/3/u);
  assert.match(result.stderr, /exact-ref push failed; retrying attempt=3\/3/u);
  assert.equal(git(mirror, "rev-parse", `refs/gate/candidates/${oid}^{commit}`), oid);
  assert.equal(git(mirror, "rev-parse", `refs/gate/baselines/${oid}^{commit}`), oid);
});

// --- exact-ref transport -----------------------------------------------------

test("dispatch transports a detached candidate and current baseline without mirroring an incomplete ref namespace", (t) => {
  const root = scratch(t);
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin], { env: FIXTURE_ENV });
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"], { env: FIXTURE_ENV });

  const source = join(root, "source");
  mkdirSync(join(source, "scripts", "gate-worker"), { recursive: true });
  for (const name of ["gate-dispatch.sh", "mirror-push.sh", "remote-gate.sh", "run-gate.sh", "lib.sh"]) {
    cpSync(join(here, name), join(source, "scripts", "gate-worker", name));
  }
  writeFileSync(
    join(source, "scripts", "merge-gate.sh"),
    '#!/usr/bin/env bash\nprintf "MERGE GATE: PASS %s\\n" "$(git rev-parse HEAD)"\n',
  );
  chmodSync(join(source, "scripts", "merge-gate.sh"), 0o755);
  git(source, "init", "-q", "-b", "main");
  git(source, "remote", "add", "origin", origin);
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const oldMain = git(source, "rev-parse", "HEAD");
  git(source, "push", "-q", "origin", "main");

  git(source, "checkout", "-q", "-b", "feature");
  writeFileSync(join(source, "candidate.txt"), "candidate\n");
  git(source, "add", "candidate.txt");
  git(source, "commit", "-q", "-m", "candidate");
  const candidate = git(source, "rev-parse", "HEAD");
  git(source, "push", "-q", "origin", "feature");

  git(source, "checkout", "-q", "main");
  writeFileSync(join(source, "baseline.txt"), "current baseline\n");
  git(source, "add", "baseline.txt");
  git(source, "commit", "-q", "-m", "advance baseline");
  const baseline = git(source, "rev-parse", "HEAD");
  git(source, "push", "-q", "origin", "main");

  const checkout = join(root, "checkout");
  execFileSync("git", ["clone", "-q", "--single-branch", "--branch", "feature", origin, checkout], { env: FIXTURE_ENV });
  git(checkout, "checkout", "-q", "--detach", candidate);
  git(checkout, "branch", "-D", "feature");
  git(checkout, "update-ref", "-d", "refs/remotes/origin/feature");
  assert.equal(git(checkout, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"), "");

  const fakeHome = join(root, "worker-home");
  const mirror = join(fakeHome, "gate", "origin", "mirror.git");
  mkdirSync(join(fakeHome, "gate", "origin"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", mirror], { env: FIXTURE_ENV });
  execFileSync("git", ["-C", mirror, "symbolic-ref", "HEAD", "refs/heads/main"], { env: FIXTURE_ENV });
  git(source, "push", "-q", mirror, `${oldMain}:refs/heads/main`);

  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "ssh"), `#!/usr/bin/env bash
set -uo pipefail
if [ "\${1:-}" = "-G" ]; then exit 1; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-o|-i|-F) shift 2 ;;
    -n|-T|-x) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || exit 2
shift
cd "$FAKE_SSH_HOME"
exec bash -c "$*"
`);
  writeFileSync(join(fakeBin, "scp"), `#!/usr/bin/env bash
set -uo pipefail
while [ $# -gt 0 ]; do
  case "$1" in
    -P|-o) shift 2 ;;
    -q) shift ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || exit 2
destination="\${2#*:}"
cp "$1" "$FAKE_SSH_HOME/$destination"
`);
  chmodSync(join(fakeBin, "ssh"), 0o755);
  chmodSync(join(fakeBin, "scp"), 0o755);

  const cache = join(root, "cache");
  const result = spawnSync("bash", [dispatchPath.replace(here, join(checkout, "scripts", "gate-worker")), candidate, "--server", "fake"], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...FIXTURE_ENV,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_SSH_HOME: fakeHome,
      XDG_CACHE_HOME: cache,
      OPERATOR_TOKEN: "",
      RUNNER_TOKEN: "",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`MERGE GATE: PASS ${candidate}`));
  assert.equal(git(mirror, "rev-parse", `refs/gate/candidates/${candidate}^{commit}`), candidate);
  assert.equal(git(mirror, "rev-parse", `refs/gate/baselines/${baseline}^{commit}`), baseline);
  assert.equal(git(mirror, "rev-parse", "refs/heads/main^{commit}"), oldMain, "transport rewrote or deleted the worker's main ref");
  assert.equal(git(mirror, "remote"), "", "the worker cache acquired a remote");
  assert.equal(readFileSync(join(fakeHome, "gate", "origin", "run-gate.sh"), "utf8"), readFileSync(runGatePath, "utf8"));
});

// --- run-gate.sh: the worker's state is never a verdict ----------------------

// A gate home the way mirror-push.sh leaves one: run-gate.sh beside a bare
// mirror, deriving its own GATE_HOME from where it was installed.
const gateHome = (t, { verdict, workerRoot, name = "home" } = {}) => {
  const root = workerRoot ?? scratch(t);
  const work = join(root, `${name}-work`);
  const home = join(root, name);
  mkdirSync(join(work, "scripts"), { recursive: true });
  writeFileSync(
    join(work, "scripts", "merge-gate.sh"),
    `#!/usr/bin/env bash\n${verdict ?? 'printf "MERGE GATE: PASS fixture\\n"; exit 0'}\n`,
  );
  chmodSync(join(work, "scripts", "merge-gate.sh"), 0o755);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "fixture");
  const oid = git(work, "rev-parse", "HEAD");

  mkdirSync(home, { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", work, join(home, "mirror.git")], { env: FIXTURE_ENV });
  writeFileSync(join(home, "run-gate.sh"), readFileSync(runGatePath));
  chmodSync(join(home, "run-gate.sh"), 0o755);
  return { root, home, oid };
};

// Bounded like every other fixture that runs a real script: a harness that
// waits on something is a failing test, never a suite that stops returning.
const runGate = (home, args, env = {}) =>
  spawnSync("bash", [join(home, "run-gate.sh"), ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...FIXTURE_ENV, ...env },
  });

test("the fixture environment carries no host gate configuration", () => {
  // The guard for the leak: a host configured to reach a real gate worker must
  // not be able to rewrite what these cases run against. Stated in both
  // gate-worker fixture files because each builds its own environment.
  const leaked = Object.keys(FIXTURE_ENV).filter(isHostGateConfig);
  assert.deepEqual(leaked, [], `host gate configuration reached the fixtures: ${leaked.join(", ")}`);
});

test("a gate that passes is reported as the gate's own verdict", (t) => {
  const fixture = gateHome(t);
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
});

test("a gate that fails is 1 and says MERGE GATE: FAIL", (t) => {
  const fixture = gateHome(t, { verdict: 'printf "MERGE GATE: FAIL (fixture)\\n"; exit 1' });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MERGE GATE: FAIL/);
});

test("a credential in the trusted worker environment does not block the gate", (t) => {
  const fixture = gateHome(t);
  const result = runGate(fixture.home, [fixture.oid], { FEISHU_APP_SECRET: "x" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
});

test("a commit the mirror does not have is not a FAIL", (t) => {
  const fixture = gateHome(t);
  const absent = "0".repeat(40);
  const result = runGate(fixture.home, [absent]);
  assert.equal(result.status, 76, result.stdout + result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: /m);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
});

test("a missing mirror is not a FAIL", (t) => {
  const fixture = gateHome(t);
  rmSync(join(fixture.home, "mirror.git"), { recursive: true, force: true });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 76);
  assert.match(result.stdout, /^GATE NOT RUN: no mirror at /m);
});

test("a gate that dies without printing a verdict is not a FAIL", (t) => {
  // merge-gate.sh killed, or out of memory, or crashed inside a step. Nothing
  // judged the commit, so nothing may be recorded as a judgement of it.
  const fixture = gateHome(t, { verdict: 'printf "no verdict here\\n"; exit 137' });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 76);
  assert.match(result.stdout, /^GATE NOT RUN: the gate produced no verdict line/m);
});

test("a malformed STALE_WORKTREE_MINUTES is refused rather than passed to find", (t) => {
  const fixture = gateHome(t);
  const result = runGate(fixture.home, [fixture.oid], { STALE_WORKTREE_MINUTES: "-1; id" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /STALE_WORKTREE_MINUTES/);
});

test("the default worker capacity serializes gates from different repositories", (t) => {
  const workerRoot = scratch(t);
  const starts = join(workerRoot, "starts");
  const release = join(workerRoot, "release");
  const verdict = `
    printf '%s\\n' "$$" >> "$WORKER_LOCK_STARTS"
    while [ ! -f "$WORKER_LOCK_RELEASE" ]; do sleep 0.05; done
    printf 'MERGE GATE: PASS fixture\\n'
  `;
  const first = gateHome(t, { verdict, workerRoot, name: "repo-a" });
  const second = gateHome(t, { verdict, workerRoot, name: "repo-b" });
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
        set -uo pipefail
        "$FIRST_HOME/run-gate.sh" "$FIRST_OID" > "$WORKER_ROOT/first.out" 2>&1 &
        first_pid=$!
        for _ in $(seq 1 100); do
          [ -s "$WORKER_LOCK_STARTS" ] && break
          sleep 0.05
        done
        [ -s "$WORKER_LOCK_STARTS" ] || exit 90

        "$SECOND_HOME/run-gate.sh" "$SECOND_OID" > "$WORKER_ROOT/second.out" 2>&1 &
        second_pid=$!
        sleep 0.3
        [ "$(wc -l < "$WORKER_LOCK_STARTS" | tr -d ' ')" = 1 ] || exit 91

        : > "$WORKER_LOCK_RELEASE"
        wait "$first_pid"
        wait "$second_pid"
        cat "$WORKER_ROOT/first.out" "$WORKER_ROOT/second.out"
      `,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...FIXTURE_ENV,
        FIRST_HOME: first.home,
        FIRST_OID: first.oid,
        SECOND_HOME: second.home,
        SECOND_OID: second.oid,
        WORKER_ROOT: workerRoot,
        WORKER_LOCK_STARTS: starts,
        WORKER_LOCK_RELEASE: release,
      },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(starts, "utf8").trim().split("\n").length, 2);
  assert.equal((result.stdout.match(/MERGE GATE: PASS/g) ?? []).length, 2);
});

test("worker capacity two admits exactly two gates and keeps concurrent logs distinct", (t) => {
  const workerRoot = scratch(t);
  const starts = join(workerRoot, "starts");
  const hostShare = join(workerRoot, "host-share");
  const release = join(workerRoot, "release");
  const verdict = `
    printf '%s\n' "$$" >> "$WORKER_LOCK_STARTS"
    printf '%s\n' "\${AGENTOS_GATE_HOST_SHARE:-unset}" >> "$WORKER_HOST_SHARE"
    while [ ! -f "$WORKER_LOCK_RELEASE" ]; do sleep 0.05; done
    printf 'MERGE GATE: PASS fixture\n'
  `;
  const fixture = gateHome(t, { verdict, workerRoot });
  writeFileSync(join(workerRoot, "worker-capacity"), "2\n");
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
        set -uo pipefail
        for run in 1 2 3; do
          "$GATE_HOME/run-gate.sh" "$GATE_OID" > "$WORKER_ROOT/$run.out" 2>&1 &
          eval "pid_$run=$!"
        done
        for _ in $(seq 1 100); do
          [ -s "$WORKER_LOCK_STARTS" ] \
            && [ "$(wc -l < "$WORKER_LOCK_STARTS" | tr -d ' ')" -ge 2 ] \
            && break
          sleep 0.05
        done
        [ "$(wc -l < "$WORKER_LOCK_STARTS" | tr -d ' ')" = 2 ] || exit 90
        sleep 0.3
        [ "$(wc -l < "$WORKER_LOCK_STARTS" | tr -d ' ')" = 2 ] || exit 91

        : > "$WORKER_LOCK_RELEASE"
        wait "$pid_1"
        wait "$pid_2"
        wait "$pid_3"
        cat "$WORKER_ROOT/1.out" "$WORKER_ROOT/2.out" "$WORKER_ROOT/3.out"
      `,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...FIXTURE_ENV,
        GATE_HOME: fixture.home,
        GATE_OID: fixture.oid,
        WORKER_ROOT: workerRoot,
        WORKER_LOCK_STARTS: starts,
        WORKER_HOST_SHARE: hostShare,
        WORKER_LOCK_RELEASE: release,
      },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(starts, "utf8").trim().split("\n").length, 3);
  // Every gate on a two-slot worker is told it has half the host. What it does
  // with that is merge-gate.sh's business; that this reaches it is this one's.
  assert.deepEqual(readFileSync(hostShare, "utf8").trim().split("\n"), ["2", "2", "2"]);
  assert.equal((result.stdout.match(/MERGE GATE: PASS/g) ?? []).length, 3);
  const logs = readdirSync(join(fixture.home, "logs")).filter((name) => name.endsWith(".log"));
  assert.equal(logs.length, 3, `concurrent runs shared a log: ${logs.join(", ")}`);
});

test("the share run-gate states is the one merge-gate sizes from, and nothing recomputes it", () => {
  // 7886fad exported AGENTOS_DBTEST_CONCURRENCY=2 here for a two-slot worker,
  // and merge-gate.sh recomputed that exact variable a few lines into its own
  // run. The bound never took effect: the worker ran eight database files at
  // once while run-gate.sh's log line still said two. Nothing failed, because
  // the fixture above only proved what run-gate.sh exported, never what
  // survived to the gate.
  //
  // The shape of that bug is two files computing one number. So: run-gate.sh
  // states the share and names no fan-out, and merge-gate.sh reads the share
  // and is the only place that turns it into lanes.
  const runGate = readFileSync(runGatePath, "utf8");
  const mergeGate = readFileSync(join(here, "..", "merge-gate.sh"), "utf8");

  assert.match(runGate, /export AGENTOS_GATE_HOST_SHARE="\$WORKER_CAPACITY"/);
  assert.doesNotMatch(
    runGate,
    /AGENTOS_DBTEST_CONCURRENCY|AGENTOS_GATE_UNIT_LANES|AGENTOS_GATE_DB_LANES/,
    "run-gate.sh names a fan-out of its own; it may only state the share",
  );

  assert.match(mergeGate, /GATE_HOST_SHARE="\$\{AGENTOS_GATE_HOST_SHARE:-1\}"/);
  assert.doesNotMatch(
    mergeGate,
    /^\s*export\s+AGENTOS_GATE_HOST_SHARE/m,
    "merge-gate.sh overwrites the share it was given instead of sizing from it",
  );
  // The database wave states its lane count at the point of use. An ambient
  // export is what let run-gate.sh's value silently become something else.
  assert.match(mergeGate, /AGENTOS_DBTEST_CONCURRENCY="\$\{GATE_DB_LANES\}"/);
  assert.doesNotMatch(
    mergeGate,
    /^\s*export\s+AGENTOS_DBTEST_CONCURRENCY/m,
    "merge-gate.sh exports an ambient database fan-out instead of stating it where it is used",
  );
});

test("a worker capacity other than one or two is refused without a verdict", (t) => {
  const fixture = gateHome(t);
  writeFileSync(join(fixture.root, "worker-capacity"), "3\n");
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 76, result.stdout + result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: worker capacity .* must be exactly 1 or 2/m);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
});

// --- the stale-worktree sweep ------------------------------------------------

const abandonedWorktree = (home, pid) => {
  const dir = join(home, "worktrees", `gate-${"a".repeat(40)}-20260101T000000Z-${pid}`);
  mkdirSync(dir, { recursive: true });
  // Older than any sweep window: `find -mmin` reads the directory's own mtime.
  const longAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
  utimesSync(dir, longAgo, longAgo);
  return dir;
};

test("the sweep reclaims a worktree whose gate is gone", (t) => {
  const fixture = gateHome(t);
  const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  const dir = abandonedWorktree(fixture.home, dead);
  const result = runGate(fixture.home, [fixture.oid], { STALE_WORKTREE_MINUTES: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(dir), false, "an abandoned worktree survived the sweep");
});

test("the sweep leaves a worktree whose gate is still running", (t) => {
  // The regression: age alone used to decide, so a gate stuck on a hung
  // registry for longer than the window had its tree deleted by the next run —
  // turning one box's infrastructure problem into a different dispatch's FAIL.
  const fixture = gateHome(t);
  const dir = abandonedWorktree(fixture.home, String(process.pid));
  const result = runGate(fixture.home, [fixture.oid], { STALE_WORKTREE_MINUTES: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(dir), true, "the sweep deleted a running gate's worktree");
  assert.match(result.stderr, /still running/);
});

// --- the scripts themselves --------------------------------------------------

test("every gate-worker script parses", () => {
  for (const name of [
    "lib.sh",
    "gate-dispatch.sh",
    "mirror-push.sh",
    "remote-gate.sh",
    "run-gate.sh",
    "provision.sh",
    "bench-postgres.sh",
    "bench-dbtest-concurrency.sh",
  ]) {
    const result = spawnSync("bash", ["-n", join(here, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test("a usage error is 2 everywhere the exit-code table applies", () => {
  // The table has one row for a usage error. remote-gate.sh documented 2 and
  // exited sysexits' 64 in every one of its argument checks, which is two
  // numbers for one meaning and a case a caller does not handle.
  const remoteGate = spawnSync("bash", [join(here, "remote-gate.sh"), "--port"], {
    encoding: "utf8",
  });
  assert.equal(remoteGate.status, 2, remoteGate.stderr);
  const dispatch = spawnSync("bash", [join(here, "gate-dispatch.sh"), "--master"], {
    encoding: "utf8",
  });
  assert.equal(dispatch.status, 2, dispatch.stderr);
});

test("the runbook and the scripts agree on the no-verdict exit code", () => {
  // The contract is only useful if it is written down where an operator reads
  // it, so the runbook naming 76 is part of the fix and not commentary on it.
  const runbook = readFileSync(runbookPath, "utf8");
  assert.match(runbook, /\|\s*`76`\s*\|/);
  assert.match(runbook, /GATE NOT RUN/);
  // 75 and 76 are only useful to an automation if the table says which is
  // which, and a gate the OOM killer takes is 128+N with no line at all — the
  // one case where a reader must not expect stdout to agree with the code.
  assert.match(runbook, /`75` and `76` are not interchangeable/);
  assert.match(runbook, /\|\s*`128\+N`\s*\|/);
  assert.match(runbook, /`137`/);
  for (const path of [runGatePath, join(here, "remote-gate.sh"), join(here, "gate-dispatch.sh")]) {
    assert.match(readFileSync(path, "utf8"), /EXIT_NO_VERDICT=76/, `${path} has no 76`);
  }
});

test("the isolation claim stays the one that is actually enforced", () => {
  // Leo's ruling, 2026-08-20: no egress control, so nothing here may probe a
  // route or make provisioning depend on one, and the runbook has to say plainly
  // that the box is not isolated. Exact inputs and the mirror's lack of a
  // remote stay fail-closed.
  const provision = readFileSync(provisionPath, "utf8");
  assert.doesNotMatch(provision, /\/dev\/tcp/, "provision.sh probes a route again");
  assert.doesNotMatch(provision, /GATE_GITHUB_HOSTS/, "the egress host list is back");

  const runbook = readFileSync(runbookPath, "utf8");
  assert.match(runbook, /not network-isolated/);
  assert.doesNotMatch(runbook, /^\s*ssh [^\n]*nft /m, "the runbook asks for a firewall rule again");

  // Credential presence is deliberately not a provisioning or runtime stop.
  assert.doesNotMatch(provision, /SECRET_VARS=/);
  assert.doesNotMatch(readFileSync(runGatePath, "utf8"), /SECRET_VARS=/);
  assert.match(runbook, /credentials do not block provisioning or gate\s+execution/i);

  // Exact pushed inputs and a mirror with no remote remain enforced.
  assert.match(
    readFileSync(join(here, "mirror-push.sh"), "utf8"),
    /refusing to push into a mirror this check could not inspect/,
  );
});
