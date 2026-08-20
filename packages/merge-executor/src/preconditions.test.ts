import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { test } from "node:test";

import { REFUSED_ENVIRONMENT_NAMES, evaluatePreconditions, type PreconditionDeps } from "./preconditions.js";

const TOKEN = `ghp_${"A".repeat(36)}`;

const statsFor = (mode: number, uid: number): Stats => ({ mode, uid } as Stats);

const deps = (overrides: {
  env?: Record<string, string | undefined>;
  username?: string;
  uid?: number;
  fileMode?: number;
  fileUid?: number;
  directoryMode?: number;
  content?: string;
} = {}): PreconditionDeps => {
  const uid = overrides.uid ?? 501;
  return {
    env: {
      MERGE_EXECUTOR_OS_USER: "agentos-merge",
      MERGE_EXECUTOR_PEER_USERS: "agentos-api,agentos-runner",
      MERGE_INTEGRATOR_TOKEN_FILE: "/Users/agentos-merge/secrets/merge.token",
      ...overrides.env,
    },
    stat: (path) => path.endsWith(".token")
      ? statsFor(overrides.fileMode ?? 0o100600, overrides.fileUid ?? uid)
      : statsFor(overrides.directoryMode ?? 0o40700, uid),
    readFile: () => overrides.content ?? TOKEN,
    currentUser: () => ({ username: overrides.username ?? "agentos-merge", uid }),
    homeDirectory: () => "/Users/agentos-merge",
  };
};

test("a correctly isolated deployment passes and yields the token", () => {
  const result = evaluatePreconditions(deps());
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.token, TOKEN);
});

test("running as the runner's OS user is refused, and the token is not read", () => {
  let read = false;
  const base = deps({ username: "agentos-runner" });
  const result = evaluatePreconditions({ ...base, readFile: () => { read = true; return TOKEN; } });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failures.some((failure) => failure.includes("runs as agentos-runner")));
  // Nothing below check 4 runs once check 1 fails on identity — but the point
  // this test pins is the one that matters: the credential is not loaded.
  assert.equal(read, false);
});

test("a deployment that has not separated the principals cannot start", () => {
  const missing = evaluatePreconditions(deps({ env: { MERGE_EXECUTOR_PEER_USERS: "" } }));
  assert.ok(!missing.ok && missing.failures.some((failure) => failure.includes("MERGE_EXECUTOR_PEER_USERS")));

  const overlapping = evaluatePreconditions(deps({ env: { MERGE_EXECUTOR_PEER_USERS: "agentos-api,agentos-merge" } }));
  assert.ok(!overlapping.ok && overlapping.failures.some((failure) => failure.includes("not separated")));
});

test("a GitHub credential in the process environment is refused, under every honoured name", () => {
  for (const name of REFUSED_ENVIRONMENT_NAMES) {
    const result = evaluatePreconditions(deps({ env: { [name]: "ghp_whatever" } }));
    assert.equal(result.ok, false, name);
    assert.ok(!result.ok && result.failures.some((failure) => failure.startsWith(name)), name);
  }
});

test("a group-readable token file, a foreign owner, and a writable parent directory are each refused", () => {
  const mode644 = evaluatePreconditions(deps({ fileMode: 0o100644 }));
  assert.ok(!mode644.ok && mode644.failures.some((failure) => failure.includes("mode 644")));

  const foreign = evaluatePreconditions(deps({ fileUid: 0 }));
  assert.ok(!foreign.ok && foreign.failures.some((failure) => failure.includes("owned by uid 0")));

  const writableDirectory = evaluatePreconditions(deps({ directoryMode: 0o40777 }));
  assert.ok(!writableDirectory.ok && writableDirectory.failures.some((failure) => failure.includes("group- or world-writable")));
});

test("an unset token file, an unreadable one, and a wrong-shaped one are refused at startup", () => {
  const unset = evaluatePreconditions(deps({ env: { MERGE_INTEGRATOR_TOKEN_FILE: "" } }));
  assert.ok(!unset.ok && unset.failures.some((failure) => failure.includes("MERGE_INTEGRATOR_TOKEN_FILE is not set")));

  const base = deps();
  const unreadable = evaluatePreconditions({ ...base, stat: () => { throw new Error("ENOENT"); } });
  assert.ok(!unreadable.ok && unreadable.failures.some((failure) => failure.includes("unreadable")));

  const wrongShape = evaluatePreconditions(deps({ content: "CHANGE_ME" }));
  assert.ok(!wrongShape.ok && wrongShape.failures.some((failure) => failure.includes("expected shape")));
  // The refusal never quotes the value it rejected.
  assert.ok(!wrongShape.ok && wrongShape.failures.every((failure) => !failure.includes("CHANGE_ME")));
});

test("the directory walk stops at the executor's home rather than climbing to /", () => {
  const seen: string[] = [];
  const base = deps();
  evaluatePreconditions({
    ...base,
    stat: (path) => {
      if (!path.endsWith(".token")) seen.push(path);
      return path.endsWith(".token") ? statsFor(0o100600, 501) : statsFor(0o40700, 501);
    },
  });
  assert.deepEqual(seen, ["/Users/agentos-merge/secrets", "/Users/agentos-merge"]);
});
