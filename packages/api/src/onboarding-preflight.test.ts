import assert from "node:assert/strict";
import test from "node:test";

import type { OnboardingInput } from "./onboarding.js";
import {
  preflightOnboardingRepository,
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
    if (args.includes("user.name")) return { code: 0, stdout: "AgentOS Runner\n" };
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
