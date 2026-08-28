import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { UNSTAMPED, buildInfoFromVersionDocument, buildSha, formatBuildLine, isEntryPoint, readBuildInfo, reconcile } from "./index.mjs";

const OID = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

const stamped = (overrides = {}) => ({
  stamped: true,
  commit: OID,
  dirty: false,
  packageName: "@anneal/api",
  version: "0.0.0",
  builtAt: "2026-08-18T00:00:00.000Z",
  ...overrides,
});

const withStampDirectory = (contents, callback) => {
  const directory = mkdtempSync(join(tmpdir(), "agentos-build-info-"));
  try {
    if (contents !== null) writeFileSync(join(directory, "build-info.json"), contents);
    callback(pathToFileURL(`${directory}/`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("a dist with no stamp reads as unbuilt rather than as a commit", () => {
  withStampDirectory(null, (directory) => {
    assert.deepEqual(readBuildInfo(directory), UNSTAMPED);
    assert.equal(buildSha(readBuildInfo(directory)), "unbuilt");
  });
});

test("a stamp round-trips through the reader", () => {
  withStampDirectory(JSON.stringify(stamped()), (directory) => {
    const info = readBuildInfo(directory);
    assert.equal(info.stamped, true);
    assert.equal(info.commit, OID);
    assert.equal(info.dirty, false);
    assert.equal(info.packageName, "@anneal/api");
    assert.equal(info.builtAt, "2026-08-18T00:00:00.000Z");
  });
});

test("a malformed or truncated stamp is unbuilt, never a half-believed commit", () => {
  const rejected = [
    "{",
    "null",
    "[]",
    JSON.stringify({ ...stamped(), commit: "abc" }),
    JSON.stringify({ ...stamped(), commit: OID.toUpperCase() }),
    JSON.stringify({ ...stamped(), dirty: "no" }),
    JSON.stringify({ ...stamped(), version: undefined }),
    JSON.stringify({ ...stamped(), builtAt: 17 }),
  ];
  for (const contents of rejected) {
    withStampDirectory(contents, (directory) => {
      assert.deepEqual(readBuildInfo(directory), UNSTAMPED, contents);
    });
  }
});

test("a build with no commit is readable but never reads as a commit", () => {
  withStampDirectory(JSON.stringify(stamped({ commit: null })), (directory) => {
    const info = readBuildInfo(directory);
    assert.equal(info.stamped, true);
    assert.equal(info.commit, null);
    assert.equal(buildSha(info), "unknown");
  });
});

test("a dirty build never renders as the bare commit", () => {
  assert.equal(buildSha(stamped({ dirty: true })), `${OID}-dirty`);
  assert.equal(buildSha(stamped()), OID);
});

test("the startup line names the sha, the package and when it was built", () => {
  assert.equal(
    formatBuildLine(stamped()),
    `sha=${OID} package=@anneal/api@0.0.0 builtAt=2026-08-18T00:00:00.000Z`,
  );
  assert.equal(formatBuildLine(UNSTAMPED), "sha=unbuilt package=unknown@unknown builtAt=unknown");
});

test("reconciliation accepts only the exact approved commit from a clean tree", () => {
  assert.equal(reconcile(stamped(), OID).ok, true);
  assert.equal(reconcile(stamped(), OID.toUpperCase()).ok, true);

  const wrongCommit = reconcile(stamped(), OTHER);
  assert.equal(wrongCommit.ok, false);
  assert.match(wrongCommit.reason, /built from 0123456789/);

  const dirty = reconcile(stamped({ dirty: true }), OID);
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason, /uncommitted changes/);

  const unstamped = reconcile(UNSTAMPED, OID);
  assert.equal(unstamped.ok, false);
  assert.match(unstamped.reason, /never built/);

  const noCommit = reconcile(stamped({ commit: null }), OID);
  assert.equal(noCommit.ok, false);
  assert.match(noCommit.reason, /outside a git worktree/);
});

test("an expected commit that is not a full object id is refused, not prefix-matched", () => {
  for (const expected of ["0123456", "", "not-an-oid", `${OID}0`]) {
    const result = reconcile(stamped(), expected);
    assert.equal(result.ok, false, expected);
    assert.match(result.reason, /full 40-character object id/);
  }
});

test("the wrong package is refused even when the commit is right", () => {
  assert.equal(reconcile(stamped(), OID, "@anneal/api").ok, true);
  const swapped = reconcile(stamped(), OID, "@anneal/runner");
  assert.equal(swapped.ok, false);
  assert.match(swapped.reason, /holds a @agentos\/api build, expected @agentos\/runner/);
  // Unbound is still allowed, and says so rather than implying it checked.
  assert.match(reconcile(stamped(), OID).reason, /package identity unchecked/);
});

test("a running service's version document reads back into the same shape as a stamp", () => {
  const document = { service: "@anneal/api", version: "0.0.0", buildSha: OID, commit: OID, dirty: false, stamped: true, builtAt: "t" };
  assert.deepEqual(buildInfoFromVersionDocument(document), {
    service: "@anneal/api",
    info: { stamped: true, commit: OID, dirty: false, packageName: "@anneal/api", version: "0.0.0", builtAt: "t" },
  });

  // A process running from source, and anything malformed, read as unstamped —
  // never as a commit that could satisfy a deployment check.
  assert.deepEqual(buildInfoFromVersionDocument({ ...document, stamped: false, commit: null }).info, UNSTAMPED);
  for (const broken of [null, "{}", 7, {}, { ...document, commit: "abc" }, { ...document, dirty: "no" }, { ...document, service: 1 }]) {
    assert.deepEqual(buildInfoFromVersionDocument(broken).info, UNSTAMPED, JSON.stringify(broken));
  }
});

test("a CLI reached through a symlink still knows it is the entry point", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentos-entry-"));
  try {
    const real = join(directory, "real.mjs");
    const link = join(directory, "link.mjs");
    writeFileSync(real, "export const x = 1;\n");
    symlinkSync(real, link);
    const realUrl = pathToFileURL(real).href;
    // The failure this guards is silent: a CLI whose body is skipped exits 0
    // having checked nothing, which for a deployment check is a fail-open.
    assert.equal(isEntryPoint(realUrl, link), true);
    assert.equal(isEntryPoint(realUrl, real), true);
    assert.equal(isEntryPoint(realUrl, join(directory, "other.mjs")), false);
    assert.equal(isEntryPoint(realUrl, undefined), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
