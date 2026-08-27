import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  requests: string;
  leaseLog: string;
  gateLog: string;
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

  const bin = join(root, "bin");
  const requests = join(root, "requests.ndjson");
  const leaseLog = join(root, "lease.log");
  const gateLog = join(root, "gate.log");
  for (const path of [requests, leaseLog, gateLog]) writeFileSync(path, "");
  executable(join(bin, "merge-lease"), `#!/bin/sh
printf '%s\\n' "$*" >> "$REGRESSION_FIXTURE_LEASE_LOG"
exit 0
`);
  executable(join(bin, "gate-dispatch"), `#!/bin/sh
printf '%s\\n' "$*" >> "$REGRESSION_FIXTURE_GATE_LOG"
printf '%s\\n' "${"$"}{REGRESSION_FIXTURE_GATE_PROOF:-MERGE GATE: PASS $1}"
exit "${"$"}{REGRESSION_FIXTURE_GATE_EXIT:-0}"
`);
  executable(join(bin, "api"), `#!/bin/sh
body=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--data-binary" ]; then shift; body="$1"; fi
  shift
done
printf '%s\\n' "$body" >> "$REGRESSION_FIXTURE_REQUESTS"
printf '{"ok":true}\\n'
`);
  return {
    root, work, origin, baseSha, branchSha, requests, leaseLog, gateLog,
    env: {
      ...process.env,
      AGENTOS_API_URL: "http://agentos.invalid",
      AGENTOS_SESSION_TOKEN: "session-token",
      AGENTOS_RUN_ID: "run-1",
      AGENTOS_FENCING_TOKEN: "fence-1",
      AGENTOS_WORKSPACE_PATH: work,
      AGENTOS_CHAIN_ID: "chain-1",
      AGENTOS_PULL_REQUEST_BASE: "main",
      REGRESSION_MERGE_LEASE: join(bin, "merge-lease"),
      REGRESSION_GATE_DISPATCH: join(bin, "gate-dispatch"),
      REGRESSION_API_CLIENT: join(bin, "api"),
      REGRESSION_FIXTURE_REQUESTS: requests,
      REGRESSION_FIXTURE_LEASE_LOG: leaseLog,
      REGRESSION_FIXTURE_GATE_LOG: gateLog,
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

const requestBodies = (seeded: Fixture): Array<Record<string, unknown>> => readFileSync(seeded.requests, "utf8")
  .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

test("prepare refreshes before semantic review without acquiring the merge lease", () => {
  const seeded = fixture();
  const prepared = run(seeded, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /^REGRESSION PREPARE: ready [0-9a-f]{40} [0-9a-f]{40}\n$/u);
  assert.equal(git(seeded.work, "merge-base", "--is-ancestor", seeded.baseSha, "HEAD"), "");
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "", "prepare held no lease");
  assert.equal(readFileSync(seeded.requests, "utf8"), "", "prepare emitted no final output");
});

test("finalize persists the dispatch PASS line verbatim and retains the lease", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const headSha = git(seeded.work, "rev-parse", "HEAD");
  assert.match(headSha, SHA);
  assert.equal(readFileSync(seeded.leaseLog, "utf8").trim().split("\n").length, 1);
  assert.match(readFileSync(seeded.leaseLog, "utf8"), /^acquire --task chain-1 /u);
  assert.equal(readFileSync(seeded.gateLog, "utf8").trim(), `${headSha} --master ${seeded.baseSha}`);
  const [request] = requestBodies(seeded);
  const verdict = JSON.parse(String(request?.body)) as Record<string, unknown>;
  assert.deepEqual(verdict, {
    schemaVersion: 2,
    outcome: "pass",
    headSha,
    baseHeadSha: seeded.baseSha,
    gateVerdict: "PASS",
    gateProof: `MERGE GATE: PASS ${headSha}`,
  });
  assert.equal(request?.kind, "regression-verification-v2");
  assert.equal(request?.commitSha, headSha);
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
  assert.equal(readFileSync(seeded.requests, "utf8"), "");
  assert.equal(readFileSync(join(seeded.work, "drift.txt"), "utf8"), "drift\n");
});

test("review-fail is emitted mechanically without acquiring or dispatching", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  const failed = run(seeded, "review-fail", "RF-2 remains open");
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.equal(readFileSync(seeded.gateLog, "utf8"), "");
  const [request] = requestBodies(seeded);
  const verdict = JSON.parse(String(request?.body)) as Record<string, unknown>;
  assert.equal(verdict.outcome, "review-fail");
  assert.equal(verdict.summary, "RF-2 remains open");
  assert.equal(verdict.baseHeadSha, seeded.baseSha);
});

test("gate FAIL preserves its proof and releases immediately", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "MERGE GATE: FAIL (runner package tests)";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "1";
  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const leases = readFileSync(seeded.leaseLog, "utf8").trim().split("\n");
  assert.equal(leases.length, 2);
  assert.match(leases[0]!, /^acquire --task chain-1 /u);
  assert.equal(leases[1], "release --task chain-1");
  const [request] = requestBodies(seeded);
  assert.deepEqual(JSON.parse(String(request?.body)), {
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
  const [request] = requestBodies(seeded);
  const verdict = JSON.parse(String(request?.body)) as Record<string, unknown>;
  assert.equal(verdict.outcome, "refresh-conflict");
  assert.equal(verdict.headSha, preRefreshHead);
  assert.equal(verdict.summary, "base.txt");
});
