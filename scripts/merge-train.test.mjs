import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { coordinateMergeTrain } from "./merge-train.mjs";

const execFileAsync = promisify(execFile);

const command = async (file, args, cwd) => {
  const { stdout } = await execFileAsync(file, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

const git = (cwd, ...args) => command("git", args, cwd);

const makeFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentos-merge-train-test-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "init", "--initial-branch=main", repo);
  await git(repo, "config", "user.name", "Merge Train Test");
  await git(repo, "config", "user.email", "merge-train@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "base.txt"), "base\n");
  await writeFile(path.join(repo, "shared.txt"), "base\n");
  await git(repo, "add", "base.txt", "shared.txt");
  await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-u", "origin", "main");
  const baseSha = await git(repo, "rev-parse", "HEAD");

  const candidate = async (pullRequest, files, start = baseSha) => {
    const checkout = path.join(root, `candidate-${pullRequest}`);
    await git(repo, "worktree", "add", "-b", `candidate-${pullRequest}`, checkout, start);
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(checkout, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-m", `candidate ${pullRequest}`);
    const headSha = await git(checkout, "rev-parse", "HEAD");
    await git(checkout, "push", "origin", `${headSha}:refs/pull/${pullRequest}/head`);
    await git(repo, "worktree", "remove", "--force", checkout);
    return { pullRequest, headSha };
  };

  const remoteMain = () => command("git", ["--git-dir", origin, "rev-parse", "refs/heads/main"], root);
  const remoteContains = async (headSha) => {
    const main = await remoteMain();
    try {
      await command("git", ["--git-dir", origin, "merge-base", "--is-ancestor", headSha, main], root);
      return true;
    } catch {
      return false;
    }
  };
  const readPullRequest = (candidates) => async (_repoRoot, pullRequest) => {
    const found = candidates.find((value) => value.pullRequest === pullRequest);
    assert.ok(found, `unknown fixture PR #${pullRequest}`);
    const merged = await remoteContains(found.headSha);
    return { state: merged ? "MERGED" : "OPEN", headSha: found.headSha };
  };
  const cleanup = async () => rm(root, { recursive: true, force: true });

  return { baseSha, candidate, cleanup, origin, readPullRequest, remoteContains, remoteMain, repo, root };
};

const passGate = async (_repoRoot, prefix) => ({
  status: "pass",
  code: 0,
  output: `MERGE GATE: PASS ${prefix.oid}\n`,
});

const noLease = (events = []) => ({
  acquireLease: async () => events.push("lease-acquire"),
  releaseLease: async () => events.push("lease-release"),
});

test("three cumulative prefixes gate concurrently and publish in FIFO order", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      await fixture.candidate(301, { "a.txt": "a\n", ".chain/private.txt": "private\n" }),
      await fixture.candidate(302, { "b.txt": "b\n" }),
      await fixture.candidate(303, { "c.txt": "c\n" }),
    ];
    const events = [];
    let activeGates = 0;
    let maximumActiveGates = 0;
    const result = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "clean-three",
      candidates,
      adapters: {
        ...noLease(events),
        gate: async (_repoRoot, prefix) => {
          events.push(`gate-${prefix.index}`);
          activeGates += 1;
          maximumActiveGates = Math.max(maximumActiveGates, activeGates);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeGates -= 1;
          return passGate(_repoRoot, prefix);
        },
        readPullRequest: fixture.readPullRequest(candidates),
        sleep: async () => {},
      },
    });

    assert.equal(result.status, "published-all");
    assert.equal(result.published.length, 3);
    assert.equal(maximumActiveGates, 3);
    assert.ok(events.indexOf("lease-acquire") > events.indexOf("gate-3"));
    assert.equal(events.at(-1), "lease-release");
    assert.equal(await fixture.remoteMain(), result.prefixes[2].oid);
    for (const candidate of candidates) assert.equal(await fixture.remoteContains(candidate.headSha), true);
    const internalPaths = await git(fixture.repo, "ls-tree", "-r", "--name-only", result.prefixes[0].oid, "--", ".chain");
    assert.equal(internalPaths, "");
  } finally {
    await fixture.cleanup();
  }
});

test("a failed middle prefix cuts publication even when the last prefix passes", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      await fixture.candidate(311, { "a.txt": "a\n" }),
      await fixture.candidate(312, { "b.txt": "b\n" }),
      await fixture.candidate(313, { "c.txt": "c\n" }),
    ];
    const result = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "middle-fails",
      candidates,
      adapters: {
        ...noLease(),
        gate: async (repoRoot, prefix) =>
          prefix.index === 2
            ? { status: "fail", code: 1, output: "MERGE GATE: FAIL (fixture)\n" }
            : passGate(repoRoot, prefix),
        readPullRequest: fixture.readPullRequest(candidates),
        sleep: async () => {},
      },
    });

    assert.equal(result.status, "published-prefix");
    assert.deepEqual(result.published.map((prefix) => prefix.candidate.pullRequest), [311]);
    assert.equal(await fixture.remoteContains(candidates[0].headSha), true);
    assert.equal(await fixture.remoteContains(candidates[1].headSha), false);
    assert.equal(await fixture.remoteContains(candidates[2].headSha), false);
  } finally {
    await fixture.cleanup();
  }
});

test("a mechanical conflict ends the batch without inventing a resolution", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      await fixture.candidate(321, { "shared.txt": "first\n" }),
      await fixture.candidate(322, { "shared.txt": "second\n" }),
      await fixture.candidate(323, { "later.txt": "later\n" }),
    ];
    const result = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "conflict",
      candidates,
      adapters: {
        ...noLease(),
        gate: passGate,
        readPullRequest: fixture.readPullRequest(candidates),
        sleep: async () => {},
      },
    });

    assert.equal(result.status, "published-prefix");
    assert.equal(result.blocked.pullRequest, 322);
    assert.equal(result.blocked.reason, "merge conflict");
    assert.deepEqual(result.blocked.files, ["shared.txt"]);
    assert.deepEqual(result.published.map((prefix) => prefix.candidate.pullRequest), [321]);
  } finally {
    await fixture.cleanup();
  }
});

test("main drift after gates publishes nothing", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [await fixture.candidate(331, { "a.txt": "a\n" })];
    let drifted = false;
    const result = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "drift",
      candidates,
      adapters: {
        ...noLease(),
        gate: async (repoRoot, prefix) => {
          if (!drifted) {
            drifted = true;
            const checkout = path.join(fixture.root, "drift");
            await git(fixture.repo, "worktree", "add", "-b", "drift", checkout, fixture.baseSha);
            await writeFile(path.join(checkout, "drift.txt"), "drift\n");
            await git(checkout, "add", "drift.txt");
            await git(checkout, "commit", "-m", "drift main");
            await git(checkout, "push", "origin", "HEAD:main");
            await git(fixture.repo, "worktree", "remove", "--force", checkout);
          }
          return passGate(repoRoot, prefix);
        },
        readPullRequest: fixture.readPullRequest(candidates),
        sleep: async () => {},
      },
    });

    assert.equal(result.status, "stale-base");
    assert.deepEqual(result.published, []);
    assert.notEqual(await fixture.remoteMain(), fixture.baseSha);
    assert.equal(await fixture.remoteContains(candidates[0].headSha), false);
  } finally {
    await fixture.cleanup();
  }
});

test("rerun reads live main, skips an earlier published head, and rebuilds the rest", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      await fixture.candidate(341, { "a.txt": "a\n" }),
      await fixture.candidate(342, { "b.txt": "b\n" }),
      await fixture.candidate(343, { "c.txt": "c\n" }),
    ];
    const adapters = {
      ...noLease(),
      readPullRequest: fixture.readPullRequest(candidates),
      sleep: async () => {},
    };
    const first = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "recovery-one",
      candidates,
      adapters: {
        ...adapters,
        gate: async (repoRoot, prefix) =>
          prefix.index === 2
            ? { status: "fail", code: 1, output: "MERGE GATE: FAIL (fixture)\n" }
            : passGate(repoRoot, prefix),
      },
    });
    assert.deepEqual(first.published.map((prefix) => prefix.candidate.pullRequest), [341]);

    const second = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "recovery-two",
      candidates,
      adapters: { ...adapters, gate: passGate },
    });
    assert.equal(second.status, "published-all");
    assert.deepEqual(second.alreadyDelivered.map((candidate) => candidate.pullRequest), [341]);
    assert.deepEqual(second.published.map((prefix) => prefix.candidate.pullRequest), [342, 343]);
    for (const candidate of candidates) assert.equal(await fixture.remoteContains(candidate.headSha), true);
  } finally {
    await fixture.cleanup();
  }
});
