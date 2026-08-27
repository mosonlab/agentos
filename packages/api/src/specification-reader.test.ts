import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMirrorBackedSpecificationReader,
  repoMirrorPath,
  type MirrorGitResult,
} from "./specification-reader.js";
import { verifyPreparedSpecification } from "./specification-fidelity.js";

const commit = "a".repeat(40);
const path = ".chain/feat/spec/spec.md";
const repository = "acme/repo";
const remoteUrl = "git@github.com:acme/repo.git";
const bytes = new TextEncoder().encode("the local specification\n");

const result = (stdout: Uint8Array | string = "", code = 0): MirrorGitResult => ({
  code,
  stdout: typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout,
  stderr: code === 0 ? "" : "git failed",
});

const mirrorGit = (calls: string[][]): ((mirror: string, args: readonly string[], signal: AbortSignal, input?: Uint8Array) => Promise<MirrorGitResult>) => (
  async (_mirror, args, _signal, input) => {
    calls.push([...args, ...(input ? [`input:${new TextDecoder().decode(input)}`] : [])]);
    if (args[0] === "rev-parse") return result("true\n");
    if (args[0] === "config") return result(`${remoteUrl}\n`);
    if (args[0] === "cat-file" && args[1] === "--batch-check=%(objectname) %(objecttype)") {
      return result(`${commit} commit\n${"b".repeat(40)} blob ${bytes.length}\n`);
    }
    if (args[0] === "cat-file" && args[1] === "blob") return result(bytes);
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  }
);

test("serves the pinned file from the exact runner mirror key before GitHub", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-"));
  try {
    const mirror = repoMirrorPath(root, remoteUrl);
    await mkdir(mirror, { recursive: true });
    const calls: string[][] = [];
    let githubCalls = 0;
    const reader = createMirrorBackedSpecificationReader({
      readFileAtCommit: async () => {
        githubCalls += 1;
        return new TextEncoder().encode("from GitHub");
      },
    }, { mirrorRoot: root, runGit: mirrorGit(calls) });

    const actual = await reader.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl);

    assert.deepEqual(actual, bytes);
    assert.equal(githubCalls, 0);
    assert.equal(calls.some((call) => call[0] === "cat-file" && call[1] === "blob"), true);

    const verification = {
      key: "same-verification",
      repository,
      remoteUrl,
      path,
      implementationHeadSha: commit,
      authoritativeBytes: bytes,
    };
    const githubVerdict = await verifyPreparedSpecification(
      verification,
      { readFileAtCommit: async () => bytes },
      new AbortController().signal,
    );
    const mirrorVerdict = await verifyPreparedSpecification(
      verification,
      reader,
      new AbortController().signal,
    );
    assert.equal(mirrorVerdict, githubVerdict);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an empty blob served by the mirror instead of falling back", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-empty-"));
  try {
    const mirror = repoMirrorPath(root, remoteUrl);
    await mkdir(mirror, { recursive: true });
    let githubCalls = 0;
    const empty = new Uint8Array();
    const reader = createMirrorBackedSpecificationReader({
      readFileAtCommit: async () => {
        githubCalls += 1;
        return new TextEncoder().encode("GitHub fallback");
      },
    }, { mirrorRoot: root, runGit: async (_mirror, args) => {
      if (args[0] === "rev-parse") return result("true\n");
      if (args[0] === "config") return result(`${remoteUrl}\n`);
      if (args[0] === "cat-file" && args[1] === "--batch-check=%(objectname) %(objecttype)") {
        return result(`${commit} commit\n${"b".repeat(40)} blob 0\n`);
      }
      if (args[0] === "cat-file" && args[1] === "blob") return result(empty);
      throw new Error("unexpected git call");
    } });

    assert.deepEqual(
      await reader.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl),
      empty,
    );
    assert.equal(githubCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to GitHub when the exact mirror is absent or lacks the pinned object", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-miss-"));
  try {
    let githubCalls = 0;
    const github = {
      readFileAtCommit: async () => {
        githubCalls += 1;
        return new TextEncoder().encode("from GitHub");
      },
    };
    const absent = createMirrorBackedSpecificationReader(github, {
      mirrorRoot: root,
      runGit: async () => result("", 128),
    });
    assert.deepEqual(
      await absent.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl),
      new TextEncoder().encode("from GitHub"),
    );

    const mirror = repoMirrorPath(root, remoteUrl);
    await mkdir(mirror, { recursive: true });
    const missingObject = async (_mirror: string, args: readonly string[]): Promise<MirrorGitResult> => {
      if (args[0] === "rev-parse") return result("true\n");
      if (args[0] === "config") return result(`${remoteUrl}\n`);
      if (args[0] === "cat-file") return result(`${commit} missing\n${commit}:${path} missing\n`);
      throw new Error("unexpected git call");
    };
    const withMissingObject = createMirrorBackedSpecificationReader(github, { mirrorRoot: root, runGit: missingObject });
    assert.deepEqual(
      await withMissingObject.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl),
      new TextEncoder().encode("from GitHub"),
    );
    assert.equal(githubCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to GitHub when mirror metadata or local git is unreadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-corrupt-"));
  try {
    const mirror = repoMirrorPath(root, remoteUrl);
    await writeFile(mirror, "not a directory");
    let githubCalls = 0;
    const reader = createMirrorBackedSpecificationReader({
      readFileAtCommit: async () => {
        githubCalls += 1;
        return new TextEncoder().encode("from GitHub");
      },
    }, {
      mirrorRoot: root,
      runGit: async () => { throw new Error("corrupt mirror"); },
    });

    assert.deepEqual(
      await reader.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl),
      new TextEncoder().encode("from GitHub"),
    );
    assert.equal(githubCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
