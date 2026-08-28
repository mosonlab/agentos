import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/regression-verification.sh");
const SHA = /^[0-9a-f]{40}$/u;

type Fixture = {
  root: string;
  work: string;
  origin: string;
  baseSha: string;
  branchSha: string;
  env: NodeJS.ProcessEnv;
  output: string;
  leaseLog: string;
  gateLog: string;
  argvLog: string;
};

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "regression-fixture",
    GIT_AUTHOR_EMAIL: "regression@example.invalid",
    GIT_COMMITTER_NAME: "regression-fixture",
    GIT_COMMITTER_EMAIL: "regression@example.invalid",
  },
}).trim();

const executable = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
};

const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "agentos-regression-script-"));
  const seed = join(root, "seed");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "base.txt"), "base\n");
  git(seed, "add", "base.txt");
  git(seed, "commit", "-m", "base");
  git(seed, "init", "--bare", origin);
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main");
  const baseSha = git(seed, "rev-parse", "HEAD");
  git(seed, "switch", "-c", "feature");
  writeFileSync(join(seed, "feature.txt"), "feature\n");
  git(seed, "add", "feature.txt");
  git(seed, "commit", "-m", "feature");
  git(seed, "push", "origin", "feature");
  const branchSha = git(seed, "rev-parse", "HEAD");
  git(root, "clone", "--branch", "feature", origin, work);
  writeFileSync(join(work, ".git", "info", "exclude"), "\n/.agentos/\n", { flag: "a" });

  const bin = join(root, "bin");
  const output = join(work, ".agentos", "regression-output.json");
  const leaseLog = join(root, "lease.log");
  const gateLog = join(root, "gate.log");
  const argvLog = join(root, "argv.log");
  for (const path of [leaseLog, gateLog, argvLog]) writeFileSync(path, "");
  executable(join(bin, "node"), `#!/bin/sh
printf 'node %s\\n' "$*" >> "$REGRESSION_FIXTURE_ARGV_LOG"
exec "$REGRESSION_FIXTURE_NODE" "$@"
`);
  executable(join(bin, "merge-lease"), `#!/bin/sh
printf '%s\\n' "$*" >> "$REGRESSION_FIXTURE_LEASE_LOG"
exit "${"$"}{REGRESSION_FIXTURE_LEASE_EXIT:-0}"
`);
  executable(join(bin, "gate-dispatch"), `#!/bin/sh
printf '%s\\n' "$*" >> "$REGRESSION_FIXTURE_GATE_LOG"
[ -z "${"$"}{REGRESSION_FIXTURE_GATE_NOISE:-}" ] || printf '%s\\n' "$REGRESSION_FIXTURE_GATE_NOISE"
printf '%s\\n' "${"$"}{REGRESSION_FIXTURE_GATE_PROOF:-MERGE GATE: PASS $1}"
exit "${"$"}{REGRESSION_FIXTURE_GATE_EXIT:-0}"
`);
  return {
    root, work, origin, baseSha, branchSha, output, leaseLog, gateLog, argvLog,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AGENTOS_RUN_ID: "run-1",
      AGENTOS_WORKSPACE_PATH: work,
      AGENTOS_CHAIN_ID: "chain-1",
      AGENTOS_PULL_REQUEST_BASE: "main",
      REGRESSION_MERGE_LEASE: join(bin, "merge-lease"),
      REGRESSION_GATE_DISPATCH: join(bin, "gate-dispatch"),
      REGRESSION_FIXTURE_LEASE_LOG: leaseLog,
      REGRESSION_FIXTURE_GATE_LOG: gateLog,
      REGRESSION_FIXTURE_ARGV_LOG: argvLog,
      REGRESSION_FIXTURE_NODE: process.execPath,
      GIT_AUTHOR_NAME: "regression-fixture",
      GIT_AUTHOR_EMAIL: "regression@example.invalid",
      GIT_COMMITTER_NAME: "regression-fixture",
      GIT_COMMITTER_EMAIL: "regression@example.invalid",
    },
  };
};

const run = (seeded: Fixture, ...args: string[]) => spawnSync("bash", [script, ...args], {
  cwd: seeded.work,
  env: seeded.env,
  encoding: "utf8",
});

type Handoff = {
  schemaVersion: number;
  runId: string;
  kind: string;
  body: string;
  commitSha: string;
};

const handoff = (seeded: Fixture): Handoff =>
  JSON.parse(readFileSync(seeded.output, "utf8")) as Handoff;

test("prepare refreshes before semantic review without acquiring the merge lease", () => {
  const seeded = fixture();
  const prepared = run(seeded, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /^REGRESSION PREPARE: ready [0-9a-f]{40} [0-9a-f]{40}\n$/u);
  assert.equal(git(seeded.work, "merge-base", "--is-ancestor", seeded.baseSha, "HEAD"), "");
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "", "prepare held no lease");
  assert.equal(existsSync(seeded.output), false, "prepare emitted no final output");
});

test("finalize publishes the dispatch PASS handoff before readiness acquires the lease", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_NOISE = "verbose gate detail that stays platform-side";
  seeded.env.REGRESSION_FIXTURE_LEASE_EXIT = "99";
  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const headSha = git(seeded.work, "rev-parse", "HEAD");
  assert.match(headSha, SHA);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "", "Regression never touches the merge lease");
  assert.equal(readFileSync(seeded.gateLog, "utf8").trim(), `${headSha} --master ${seeded.baseSha}`);
  const published = handoff(seeded);
  const verdict = JSON.parse(published.body) as Record<string, unknown>;
  assert.deepEqual(verdict, {
    schemaVersion: 2,
    outcome: "pass",
    headSha,
    baseHeadSha: seeded.baseSha,
    gateVerdict: "PASS",
    gateProof: `MERGE GATE: PASS ${headSha}`,
  });
  assert.deepEqual(published, {
    schemaVersion: 1,
    runId: "run-1",
    kind: "regression-verification-v2",
    body: JSON.stringify(verdict),
    commitSha: headSha,
  });
  assert.equal(statSync(seeded.output).mode & 0o077, 0, "handoff is private to the Run user");
  assert.equal(finalized.stdout, `REGRESSION FINALIZE: pass ${headSha}\n`);
  assert.doesNotMatch(finalized.stdout, /verbose gate detail/u);
});

test("the mechanical handoff requires no session or fencing credentials", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  assert.equal(run(seeded, "review-fail", "review summary").status, 0);
  const argv = readFileSync(seeded.argvLog, "utf8");
  assert.doesNotMatch(argv, /session-token|fence-1/u);
  assert.equal(seeded.env.AGENTOS_SESSION_TOKEN, undefined);
  assert.equal(seeded.env.AGENTOS_FENCING_TOKEN, undefined);
});

test("an unreachable target fails prepare and finalize without persisting output", () => {
  const prepareFixture = fixture();
  git(prepareFixture.work, "remote", "set-url", "origin", join(prepareFixture.root, "missing.git"));
  const prepared = run(prepareFixture, "prepare");
  assert.notEqual(prepared.status, 0);
  assert.match(prepared.stderr, /target fetch failed after 3 attempts/u);
  assert.doesNotMatch(prepared.stdout, /refresh-conflict/u);
  assert.equal(existsSync(prepareFixture.output), false);

  const finalizeFixture = fixture();
  assert.equal(run(finalizeFixture, "prepare").status, 0);
  git(finalizeFixture.work, "remote", "set-url", "origin", join(finalizeFixture.root, "missing.git"));
  const finalized = run(finalizeFixture, "finalize");
  assert.notEqual(finalized.status, 0);
  assert.match(finalized.stderr, /target fetch failed after 3 attempts/u);
  assert.doesNotMatch(finalized.stdout, /refresh-conflict/u);
  assert.equal(existsSync(finalizeFixture.output), false);
});

test("finalize refreshes drift outside the lease and requires semantic recheck", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  const main = join(seeded.root, "main");
  git(seeded.root, "clone", "--branch", "main", seeded.origin, main);
  writeFileSync(join(main, "drift.txt"), "drift\n");
  git(main, "add", "drift.txt");
  git(main, "commit", "-m", "drift");
  git(main, "push", "origin", "main");

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 77, finalized.stderr);
  assert.match(finalized.stdout, /^REGRESSION FINALIZE: semantic-stale /u);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "", "drift was detected before acquire");
  assert.equal(readFileSync(seeded.gateLog, "utf8"), "");
  assert.equal(existsSync(seeded.output), false);
  assert.equal(readFileSync(join(seeded.work, "drift.txt"), "utf8"), "drift\n");
});

test("finalize refuses a PASS when the target moves during the gate", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  const main = join(seeded.root, "main-during-gate");
  git(seeded.root, "clone", "--branch", "main", seeded.origin, main);
  const driftGate = join(seeded.root, "bin", "drift-gate");
  executable(driftGate, `#!/bin/sh
printf 'drift during gate\n' > '${main}/during-gate.txt'
git -C '${main}' add during-gate.txt
git -C '${main}' commit -m 'drift during gate' >/dev/null
git -C '${main}' push origin main >/dev/null
printf 'MERGE GATE: PASS %s\n' "$1"
`);
  seeded.env.REGRESSION_GATE_DISPATCH = driftGate;

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 77, finalized.stderr);
  assert.match(finalized.stdout, /^REGRESSION FINALIZE: semantic-stale /u);
  assert.equal(existsSync(seeded.output), false);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.equal(readFileSync(join(seeded.work, "during-gate.txt"), "utf8"), "drift during gate\n");
});

test("review-fail is emitted mechanically without acquiring or dispatching", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  const failed = run(seeded, "review-fail", "RF-2 remains open");
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.equal(readFileSync(seeded.gateLog, "utf8"), "");
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  assert.equal(verdict.outcome, "review-fail");
  assert.equal(verdict.summary, "RF-2 remains open");
  assert.equal(verdict.baseHeadSha, seeded.baseSha);
});

test("gate FAIL preserves its proof without touching the merge lease", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "MERGE GATE: FAIL (runner package tests)";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "1";
  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.deepEqual(JSON.parse(handoff(seeded).body), {
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: git(seeded.work, "rev-parse", "HEAD"),
    baseHeadSha: seeded.baseSha,
    gateVerdict: "FAIL",
    gateProof: "MERGE GATE: FAIL (runner package tests)",
    summary: "runner package tests",
  });
});

test("prepare emits refresh-conflict mechanically and leaves a deliverable workspace", () => {
  const seeded = fixture();
  const main = join(seeded.root, "main-conflict");
  git(seeded.root, "clone", "--branch", "main", seeded.origin, main);
  writeFileSync(join(main, "base.txt"), "main change\n");
  git(main, "add", "base.txt");
  git(main, "commit", "-m", "main conflict");
  git(main, "push", "origin", "main");
  writeFileSync(join(seeded.work, "base.txt"), "feature change\n");
  git(seeded.work, "add", "base.txt");
  git(seeded.work, "commit", "-m", "feature conflict");
  const preRefreshHead = git(seeded.work, "rev-parse", "HEAD");

  const prepared = run(seeded, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /REGRESSION PREPARE: refresh-conflict base\.txt/u);
  assert.equal(git(seeded.work, "rev-parse", "HEAD"), preRefreshHead);
  assert.equal(git(seeded.work, "status", "--porcelain"), "");
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  assert.equal(verdict.outcome, "refresh-conflict");
  assert.equal(verdict.headSha, preRefreshHead);
  assert.equal(verdict.summary, "base.txt");
});

test("a non-conflict merge failure aborts loudly without persisting output", () => {
  const seeded = fixture();
  const main = join(seeded.root, "main-hook-failure");
  git(seeded.root, "clone", "--branch", "main", seeded.origin, main);
  writeFileSync(join(main, "drift.txt"), "drift\n");
  git(main, "add", "drift.txt");
  git(main, "commit", "-m", "drift");
  git(main, "push", "origin", "main");
  executable(join(seeded.work, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nprintf 'fixture hook refused merge\\n' >&2\nexit 1\n");

  const prepared = run(seeded, "prepare");
  assert.notEqual(prepared.status, 0);
  assert.match(prepared.stderr, /fixture hook refused merge/u);
  assert.match(prepared.stderr, /merge failed without conflicts/u);
  assert.equal(existsSync(seeded.output), false);
  assert.equal(git(seeded.work, "status", "--porcelain"), "");
});

test("a gate without a verdict dies loudly without publishing a handoff or taking a lease", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "gate exited before verdict";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "143";

  const finalized = run(seeded, "finalize");
  assert.notEqual(finalized.status, 0);
  assert.match(finalized.stderr, /no admissible PASS\/FAIL verdict after 1 attempt\(s\) \(exit 143\)/u);
  assert.doesNotMatch(finalized.stdout, /gate exited before verdict/u);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.equal(existsSync(seeded.output), false);
});
