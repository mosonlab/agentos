import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_DISTS, parseArguments, verifyDists, verifyUrls } from "./verify-dist.mjs";

const VERIFY_CLI = fileURLToPath(new URL("verify-dist.mjs", import.meta.url));
const OID = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

/** A fake deployment: the same directory layout a restart would start from. */
const withDeployment = (stamps, callback) => {
  const root = mkdtempSync(join(tmpdir(), "agentos-verify-"));
  try {
    for (const [dist, info] of Object.entries(stamps)) {
      mkdirSync(join(root, dist), { recursive: true });
      if (info !== null) writeFileSync(join(root, dist, "build-info.json"), JSON.stringify(info));
    }
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const stamp = (overrides = {}) => ({
  commit: OID,
  dirty: false,
  packageName: "@agentos/api",
  version: "0.0.0",
  builtAt: "2026-08-18T00:00:00.000Z",
  ...overrides,
});

const runnerStamp = (overrides = {}) => stamp({ packageName: "@agentos/runner", ...overrides });

test("the api and the runner are both checked, each bound to the package it must hold", () => {
  assert.deepEqual(DEFAULT_DISTS, [
    { dist: "packages/api/dist", packageName: "@agentos/api", base: "repo" },
    { dist: "packages/runner/dist", packageName: "@agentos/runner", base: "repo" },
  ]);
  assert.deepEqual(parseArguments(["--expected", OID]).dists, DEFAULT_DISTS);
  assert.match(parseArguments([]).error, /--expected/);
  assert.match(parseArguments(["--expected"]).error, /needs a value/);
  assert.match(parseArguments(["-f"]).error, /unknown argument/);
});

test("a caller-named target is anchored to the caller and unbound until --package says otherwise", () => {
  assert.deepEqual(parseArguments([`--expected=${OID}`, "--dist=a", "--dist", "b", "--package", "@agentos/runner"]), {
    expected: OID,
    dists: [
      { dist: "a", packageName: null, base: "cwd" },
      { dist: "b", packageName: "@agentos/runner", base: "cwd" },
    ],
    urls: [],
  });
  assert.deepEqual(parseArguments(["--expected", OID, "--url", "http://x/", "--package", "@agentos/api"]).urls, [
    { url: "http://x", packageName: "@agentos/api" },
  ]);
  assert.match(parseArguments(["--expected", OID, "--package", "@agentos/api"]).error, /must follow the --dist or --url/);
  assert.match(parseArguments(["--expected", OID, "--dist", "a", "--package", "x", "--package", "y"]).error, /given twice/);
});

test("an unbound target says on its own line that nobody checked whose build it is", () => {
  withDeployment({ "some/dist": stamp() }, (root) => {
    const [checked] = verifyDists({ expected: OID, dists: [{ dist: "some/dist", packageName: null, base: "cwd" }], cwd: root });
    assert.equal(checked.ok, true);
    assert.match(checked.reason, /package identity unchecked/);
  });
});

test("a deployment built from the approved commit passes", () => {
  withDeployment({ "packages/api/dist": stamp(), "packages/runner/dist": runnerStamp() }, (root) => {
    const results = verifyDists({ expected: OID, dists: DEFAULT_DISTS, root });
    assert.deepEqual(results.map((result) => result.ok), [true, true]);
  });
});

test("the right commit of the wrong package is refused, not counted as a pass", () => {
  // Both directories hold a clean build of the approved commit; one of them is
  // the api's build sitting where the runner's belongs.
  withDeployment({ "packages/api/dist": stamp(), "packages/runner/dist": stamp() }, (root) => {
    const results = verifyDists({ expected: OID, dists: DEFAULT_DISTS, root });
    assert.deepEqual(results.map((result) => result.ok), [true, false]);
    assert.match(results[1].reason, /holds a @agentos\/api build, expected @agentos\/runner/);
  });
});

test("one stale artefact fails the whole deployment, and is named", () => {
  withDeployment({
    "packages/api/dist": stamp(),
    "packages/runner/dist": runnerStamp({ commit: OTHER }),
  }, (root) => {
    const results = verifyDists({ expected: OID, dists: DEFAULT_DISTS, root });
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.match(results[1].reason, new RegExp(`built from ${OTHER}`));
  });
});

test("an unbuilt or dirty artefact is refused as loudly as a stale one", () => {
  withDeployment({ "packages/api/dist": null, "packages/runner/dist": runnerStamp({ dirty: true }) }, (root) => {
    const results = verifyDists({ expected: OID, dists: DEFAULT_DISTS, root });
    assert.deepEqual(results.map((result) => result.ok), [false, false]);
    assert.match(results[0].reason, /never built/);
    assert.match(results[1].reason, /uncommitted changes/);
  });
});

test("the CLI's exit code is the verdict", () => {
  withDeployment({ "packages/api/dist": stamp(), "packages/runner/dist": runnerStamp() }, (root) => {
    const run = (expected) => {
      try {
        const stdout = execFileSync(process.execPath, [
          VERIFY_CLI, "--expected", expected,
          "--dist", join(root, "packages/api/dist"),
          "--dist", join(root, "packages/runner/dist"),
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { status: 0, stdout };
      } catch (error) {
        return { status: error.status, stdout: error.stdout, stderr: error.stderr };
      }
    };

    const passed = run(OID);
    assert.equal(passed.status, 0);
    assert.match(passed.stdout, /every artefact is/);

    const failed = run(OTHER);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /do not start this deployment/);

    const malformed = run("deadbeef");
    assert.equal(malformed.status, 1);
    assert.match(malformed.stdout, /full 40-character object id/);
  });
});

test("a running service is asked the same question as a directory", async () => {
  const document = { service: "@agentos/api", version: "0.0.0", buildSha: OID, commit: OID, dirty: false, stamped: true, builtAt: "x" };
  const respond = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

  const [matched] = await verifyUrls({
    expected: OID,
    urls: [{ url: "http://api", packageName: "@agentos/api" }],
    fetchImplementation: respond(document),
  });
  assert.equal(matched.ok, true);
  assert.equal(matched.label, "http://api/version");

  const [stale] = await verifyUrls({
    expected: OTHER,
    urls: [{ url: "http://api", packageName: "@agentos/api" }],
    fetchImplementation: respond(document),
  });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, new RegExp(`built from ${OID}`));

  // A service that names itself must be checked against what the caller
  // expected to be on that port, not against its own claim.
  const [impostor] = await verifyUrls({
    expected: OID,
    urls: [{ url: "http://api", packageName: "@agentos/api" }],
    fetchImplementation: respond({ ...document, service: "@agentos/runner" }),
  });
  assert.equal(impostor.ok, false);
  assert.match(impostor.reason, /holds a @agentos\/runner build/);

  const [unbuilt] = await verifyUrls({
    expected: OID,
    urls: [{ url: "http://api", packageName: "@agentos/api" }],
    fetchImplementation: respond({ ...document, stamped: false, commit: null }),
  });
  assert.equal(unbuilt.ok, false);
  assert.match(unbuilt.reason, /never built/);

  const [errored] = await verifyUrls({
    expected: OID,
    urls: [{ url: "http://api", packageName: "@agentos/api" }],
    fetchImplementation: respond({}, 503),
  });
  assert.equal(errored.ok, false);
  assert.match(errored.reason, /HTTP 503/);

  const [unreachable] = await verifyUrls({
    expected: OID,
    urls: [{ url: "http://api", packageName: "@agentos/api" }],
    fetchImplementation: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.reason, /unreachable/);
});
