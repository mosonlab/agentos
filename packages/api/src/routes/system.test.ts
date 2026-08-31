import "../test-workspace-root.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Prisma, type PrismaClient } from "@anneal/db";

import { createApp } from "../test-app.js";
import { isStarterMountPath, isValidBranchName, onboardingInput, parseRepoRemote, slugify } from "../onboarding.js";
import { RepositoryPreflightError } from "../onboarding-preflight.js";
import {
  onboardingBody,
  postOnboarding,
  untouchableDatabase,
  withTokens,
} from "./test-support.js";

test("a repo remote may be a location and may never be a credential", () => {
  for (const remote of [
    "https://github.com/owner/name.git",
    "ssh://git@github.com/owner/name.git",
    "git@github.com:owner/name.git",
    "github.com:owner/name.git",
    "file:///tmp/agentos-rehearsal/origin.git",
  ]) {
    assert.deepEqual(parseRepoRemote(remote), { ok: true, remoteUrl: remote }, remote);
  }
  for (const [remote, reason] of [
    ["https://user:password@github.com/owner/name.git", "embedded-credentials"],
    ["https://ghp_exampletoken@github.com/owner/name.git", "embedded-credentials"],
    ["https://x-access-token:token@github.com/owner/name.git", "embedded-credentials"],
    ["ssh://git:secret@github.com/owner/name.git", "embedded-credentials"],
    ["https://github.com/owner/name.git?access_token=abc", "query-or-fragment"],
    ["https://github.com/owner/name.git#token", "query-or-fragment"],
    ["http://github.com/owner/name.git", "unsupported-scheme"],
    ["git://github.com/owner/name.git", "unsupported-scheme"],
    ["ext::sh -c evil", "whitespace"],
    ["https://github.com/owner/name.git\nrm -rf /", "control-characters"],
    ["https://github.com/", "missing-path"],
    ["file://host/tmp/origin.git", "missing-host"],
    ["-oProxyCommand=evil:path", "option-like"],
    ["--upload-pack=evil:path", "option-like"],
    // A token pasted where a login belongs is still a token in the column, in
    // the manifest and in `git remote -v`, whether or not SSH would accept it.
    ["ghp_exampletoken@github.com:owner/name.git", "unsupported-ssh-account"],
    ["ssh://ghp_exampletoken@github.com/owner/name.git", "unsupported-ssh-account"],
    ["ssh://x-access-token@github.com/owner/name.git", "unsupported-ssh-account"],
    ["oauth2@gitlab.com:owner/name.git", "unsupported-ssh-account"],
    // Leading and trailing, not only interior: trimming first would accept both.
    ["\nhttps://github.com/owner/name.git", "control-characters"],
    ["https://github.com/owner/name.git\t", "control-characters"],
    [" https://github.com/owner/name.git", "whitespace"],
    ["https://github.com/owner/name.git ", "whitespace"],
    [`https://github.com/${"a".repeat(4096)}`, "too-long"],
  ] as const) {
    assert.deepEqual(parseRepoRemote(remote), { ok: false, reason }, remote);
  }
});

test("the shared remote table is the one the control plane enforces", () => {
  // The browser has its own copy of this policy so a bad remote is explained
  // beside the field instead of becoming a 400 — and so a remote carrying a
  // credential never leaves the page at all. Two implementations drift unless
  // something holds them to one table: both suites read this file and compare
  // the exact reason code, not merely accepted-or-not.
  const cases = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../../scripts/fixtures/onboarding-remote-cases.json", import.meta.url)), "utf8",
  )) as {
    accepted: Array<{ description: string; value: string }>;
    rejected: Array<{ description: string; value: string; reason: string }>;
  };
  assert.ok(cases.accepted.length > 0 && cases.rejected.length > 0);
  for (const accepted of cases.accepted) {
    assert.deepEqual(parseRepoRemote(accepted.value), { ok: true, remoteUrl: accepted.value }, accepted.description);
  }
  for (const rejected of cases.rejected) {
    assert.deepEqual(parseRepoRemote(rejected.value), { ok: false, reason: rejected.reason }, rejected.description);
  }
});

test("a first-run installation mounts only at repo, and branch names stay Git-legal", () => {
  // Not "any safe relative path": plan Step 4 fixes the created shape down to
  // this one mount, so a well-formed alternative is still not an installation.
  assert.equal(isStarterMountPath("repo"), true);
  for (const mount of ["src/repo", "a.b-c_d", "/repo", "../repo", "repo/..", ".", "", "repo//app", "C:\\repo"]) {
    assert.equal(isStarterMountPath(mount), false, mount);
  }
  for (const branch of ["main", "master", "release/v0.1.0"]) assert.equal(isValidBranchName(branch), true, branch);
  for (const branch of ["-main", "main..next", "main~1", "feature/.hidden", "main.lock", "with space", "a@{0}", ""]) {
    assert.equal(isValidBranchName(branch), false, branch);
  }
});

test("onboarding input derives a missing slug and refuses one it cannot", () => {
  const derived = onboardingInput.safeParse(JSON.parse(onboardingBody({ project: { name: "My Project" } })));
  assert.equal(derived.success, true);
  assert.equal(derived.success && derived.data.project.slug, undefined);
  assert.equal(slugify("My Project"), "my-project");
  const undeclarable = onboardingInput.safeParse(JSON.parse(onboardingBody({ project: { name: "!!!" } })));
  assert.equal(undeclarable.success, false);
});

test("onboarding refuses an unacknowledged host-execution disclosure before any write", async () => {
  await withTokens(async () => {
    const response = await postOnboarding(untouchableDatabase(), onboardingBody({ acknowledgedHostExecution: false }));
    assert.equal(response.status, 400);
  });
});

test("onboarding refuses a credential-bearing remote, an illegal mount and an illegal branch before any write", async () => {
  await withTokens(async () => {
    for (const body of [
      onboardingBody({ repo: { name: "app", remoteUrl: "https://token@github.com/owner/name.git" } }),
      onboardingBody({ repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", mountPath: "../escape" } }),
      onboardingBody({ repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", mountPath: "src/repo" } }),
      onboardingBody({ repo: { name: "app", remoteUrl: "ghp_exampletoken@github.com:owner/name.git" } }),
      onboardingBody({ repo: { name: "app", remoteUrl: "\nhttps://github.com/owner/name.git" } }),
      onboardingBody({ repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "bad branch" } }),
    ]) {
      const response = await postOnboarding(untouchableDatabase(), body);
      assert.equal(response.status, 400);
      const payload = await response.json() as { error: string };
      assert.equal(payload.error, "Validation failed");
      // The rejected remote is never echoed: an error body is evidence, and that
      // string is the one most likely to hold a token.
      assert.equal(JSON.stringify(payload).includes("token@github.com"), false);
    }
  });
});

test("onboarding reports a repository preflight refusal before any database write", async () => {
  await withTokens(async () => {
    const response = await createApp(untouchableDatabase(), {
      onboardingRepositoryPreflight: async () => { throw new RepositoryPreflightError("push-not-authorized"); },
    }).request("/onboarding", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: onboardingBody(),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: "Repository preflight failed",
      code: "repository-preflight-failed",
      reason: "push-not-authorized",
    });
  });
});

test("a runner principal cannot read or create an installation", async () => {
  await withTokens(async () => {
    for (const method of ["GET", "POST"]) {
      const response = await createApp(untouchableDatabase()).request("/onboarding", {
        method,
        headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
        ...(method === "POST" ? { body: onboardingBody() } : {}),
      });
      assert.equal(response.status, 403);
    }
  });
});

test("a serialization or unique failure from a concurrent installer becomes the same stable 409", async () => {
  await withTokens(async () => {
    for (const code of ["P2034", "P2002"]) {
      const database = {
        $transaction: async () => {
          throw new Prisma.PrismaClientKnownRequestError("concurrent installation", { code, clientVersion: "6.19.0" });
        },
      } as unknown as PrismaClient;
      const response = await postOnboarding(database, onboardingBody());
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "An installation already exists", code: "existing-installation" });
    }
  });
});
