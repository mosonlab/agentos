import assert from "node:assert/strict";
import test from "node:test";

import type { OnboardingInput } from "./onboarding.js";
import {
  preflightOnboardingRepository,
  preflightRepository,
  RepositoryPreflightError,
  type RepositoryPreflightCommand,
} from "./onboarding-preflight.js";

const input: OnboardingInput = {
  project: { name: "Project", slug: "project" },
  repo: { name: "app", remoteUrl: "https://github.com/owner/repo.git", defaultBranch: "main", mountPath: "repo" },
  acknowledgedHostExecution: true,
};

test("repository preflight checks identity, exact head, fetch, and dry-run push in order", async () => {
  const calls: string[][] = [];
  const run: RepositoryPreflightCommand = async (_executable, args) => {
    calls.push(args);
    if (args.includes("user.name")) return { code: 0, stdout: "Anneal Runner\n" };
    if (args.includes("user.email")) return { code: 0, stdout: "runner@example.com\n" };
    if (args[0] === "ls-remote") return { code: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
    return { code: 0, stdout: "" };
  };

  await preflightOnboardingRepository(input, run);

  assert.deepEqual(calls.map((args) => args[0]), ["config", "config", "ls-remote", "init", "fetch", "push"]);
  assert.deepEqual(calls[2], ["ls-remote", "--exit-code", "--heads", input.repo.remoteUrl, "refs/heads/main"]);
  assert.equal(calls[5]?.[0], "push");
  assert.equal(calls[5]?.[1], "--dry-run");
  assert.equal(calls[5]?.[2], input.repo.remoteUrl);
  assert.match(calls[5]?.[3] ?? "", /^FETCH_HEAD:refs\/heads\/agentos-preflight-[0-9a-f]{16}$/u);
});

test("repository preflight classifies a missing branch and never attempts a write", async () => {
  const calls: string[][] = [];
  const run: RepositoryPreflightCommand = async (_executable, args) => {
    calls.push(args);
    if (args[0] === "config") return { code: 0, stdout: "configured\n" };
    return { code: 2, stdout: "" };
  };

  await assert.rejects(
    preflightOnboardingRepository(input, run),
    (error) => error instanceof RepositoryPreflightError && error.reason === "default-branch-missing",
  );
  assert.equal(calls.some((args) => args[0] === "push"), false);
});

test("repository preflight refuses missing Git identity before touching the remote", async () => {
  const calls: string[][] = [];
  const run: RepositoryPreflightCommand = async (_executable, args) => {
    calls.push(args);
    return { code: 1, stdout: "" };
  };

  await assert.rejects(
    preflightOnboardingRepository(input, run),
    (error) => error instanceof RepositoryPreflightError && error.reason === "git-identity-missing",
  );
  assert.deepEqual(calls.map((args) => args[0]), ["config"]);
});

test("NPM_CI checks the fetched commit for a root lockfile before dry-run push", async () => {
  const calls: string[][] = [];
  const run: RepositoryPreflightCommand = async (_executable, args) => {
    calls.push(args);
    if (args[0] === "config") return { code: 0, stdout: "configured\n" };
    if (args[0] === "ls-remote") return { code: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
    if (args[0] === "ls-tree") return { code: 0, stdout: "" };
    return { code: 0, stdout: "" };
  };

  await assert.rejects(
    preflightRepository({ ...input.repo, dependencyProvisioning: "NPM_CI" }, run),
    (error) => error instanceof RepositoryPreflightError && error.reason === "package-lock-missing",
  );
  assert.deepEqual(calls.map((args) => args[0]), ["config", "config", "ls-remote", "init", "fetch", "ls-tree"]);
  assert.equal(calls.filter((args) => args[0] === "fetch").length, 1);
  assert.equal(calls.some((args) => args[0] === "push"), false);
});

test("NPM_CI reports a failed lockfile probe as a remote failure", async () => {
  const calls: string[][] = [];
  const run: RepositoryPreflightCommand = async (_executable, args) => {
    calls.push(args);
    if (args[0] === "config") return { code: 0, stdout: "configured\n" };
    if (args[0] === "ls-remote") return { code: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
    if (args[0] === "ls-tree") return { code: 128, stdout: "" };
    return { code: 0, stdout: "" };
  };

  await assert.rejects(
    preflightRepository({ ...input.repo, dependencyProvisioning: "NPM_CI" }, run),
    (error) => error instanceof RepositoryPreflightError && error.reason === "remote-unreachable",
  );
  assert.equal(calls.some((args) => args[0] === "push"), false);
});

test("NPM_CI accepts a regular root lockfile and NONE skips the lockfile probe", async () => {
  const calls: string[][] = [];
  const run: RepositoryPreflightCommand = async (_executable, args) => {
    calls.push(args);
    if (args[0] === "config") return { code: 0, stdout: "configured\n" };
    if (args[0] === "ls-remote") return { code: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
    if (args[0] === "ls-tree") return { code: 0, stdout: `100644 blob ${"b".repeat(40)}\tpackage-lock.json\0` };
    return { code: 0, stdout: "" };
  };
  await preflightRepository({ ...input.repo, dependencyProvisioning: "NPM_CI" }, run);
  assert.equal(calls.some((args) => args[0] === "push"), true);

  calls.length = 0;
  await preflightRepository({ ...input.repo, dependencyProvisioning: "NONE" }, run);
  assert.equal(calls.some((args) => args[0] === "ls-tree"), false);
  assert.equal(calls.some((args) => args[0] === "push"), true);
});
