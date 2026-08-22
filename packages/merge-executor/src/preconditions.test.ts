import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { test } from "node:test";

import { REFUSED_ENVIRONMENT_NAMES, evaluatePreconditions, type PreconditionDeps } from "./preconditions.js";

const statsFor = (mode: number, uid: number): Stats => ({ mode, uid } as Stats);

const deps = (overrides: {
  env?: Record<string, string | undefined>;
  username?: string;
  uid?: number;
  fileMode?: number;
  fileUid?: number;
  directoryMode?: number;
} = {}): PreconditionDeps => {
  const uid = overrides.uid ?? 501;
  return {
    env: {
      MERGE_EXECUTOR_OS_USER: "agentos-merge",
      MERGE_EXECUTOR_PEER_USERS: "agentos-api,agentos-runner",
      MERGE_EXECUTOR_GITHUB_APP_PRIVATE_KEY_FILE: "/Users/agentos-merge/secrets/github-app.pem",
      ...overrides.env,
    },
    stat: (path) => path.endsWith(".pem")
      ? statsFor(overrides.fileMode ?? 0o100600, overrides.fileUid ?? uid)
      : statsFor(overrides.directoryMode ?? 0o40700, uid),
    currentUser: () => ({ username: overrides.username ?? "agentos-merge", uid }),
    homeDirectory: () => "/Users/agentos-merge",
  };
};

test("a correctly isolated deployment passes and yields only the private-key path", () => {
  const result = evaluatePreconditions(deps());
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.privateKeyFile, "/Users/agentos-merge/secrets/github-app.pem");
});

test("running as the runner's OS user is refused", () => {
  const result = evaluatePreconditions(deps({ username: "agentos-runner" }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failures.some((failure) => failure.includes("runs as agentos-runner")));
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

test("a group-readable private-key file, a foreign owner, and a writable parent directory are each refused", () => {
  const mode644 = evaluatePreconditions(deps({ fileMode: 0o100644 }));
  assert.ok(!mode644.ok && mode644.failures.some((failure) => failure.includes("mode 644")));

  const foreign = evaluatePreconditions(deps({ fileUid: 0 }));
  assert.ok(!foreign.ok && foreign.failures.some((failure) => failure.includes("owned by uid 0")));

  const writableDirectory = evaluatePreconditions(deps({ directoryMode: 0o40777 }));
  assert.ok(!writableDirectory.ok && writableDirectory.failures.some((failure) => failure.includes("group- or world-writable")));
});

test("an unset or unreadable private-key file is refused at startup", () => {
  const unset = evaluatePreconditions(deps({ env: { MERGE_EXECUTOR_GITHUB_APP_PRIVATE_KEY_FILE: "" } }));
  assert.ok(!unset.ok && unset.failures.some((failure) => failure.includes("GITHUB_APP_PRIVATE_KEY_FILE is not set")));

  const base = deps();
  const unreadable = evaluatePreconditions({ ...base, stat: () => { throw new Error("ENOENT"); } });
  assert.ok(!unreadable.ok && unreadable.failures.some((failure) => failure.includes("unreadable")));

});

test("the directory walk stops at the executor's home rather than climbing to /", () => {
  const seen: string[] = [];
  const base = deps();
  evaluatePreconditions({
    ...base,
    stat: (path) => {
      if (!path.endsWith(".pem")) seen.push(path);
      return path.endsWith(".pem") ? statsFor(0o100600, 501) : statsFor(0o40700, 501);
    },
  });
  assert.deepEqual(seen, ["/Users/agentos-merge/secrets", "/Users/agentos-merge"]);
});
