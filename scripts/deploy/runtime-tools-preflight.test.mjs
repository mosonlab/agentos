import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  D2_BUILD_SHA,
  deployedRuntimeToolsPreflight,
  preflightBeforeMutation,
} from "./runtime-tools-preflight.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const D1_BUILD_SHA = "7adfea4af2f4914ae47b0383cb52d4d67e4c23cc";

const versionFor = (buildSha) => ({
  service: "@anneal/api",
  version: "0.6.0",
  buildSha,
  commit: buildSha,
  dirty: false,
  stamped: true,
  builtAt: "2026-09-01T00:00:00.000Z",
});

const respondWith = (document) => async () => ({
  ok: true,
  status: 200,
  json: async () => document,
});

const git = (...args) => execFileSync("git", ["-C", REPOSITORY_ROOT, ...args], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

const withVersionServer = async (document, callback) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(document));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

test("the deployed D2 build passes the fixed ancestry preflight and prints both identities", async () => {
  const output = [];
  const result = await deployedRuntimeToolsPreflight({
    apiUrl: "http://api",
    repositoryRoot: REPOSITORY_ROOT,
    fetchImplementation: respondWith(versionFor(D2_BUILD_SHA)),
    output: (line) => output.push(line),
  });

  assert.deepEqual(result, {
    baseSha: D2_BUILD_SHA,
    deployedBuildSha: D2_BUILD_SHA,
    endpoint: "http://api/version",
  });
  assert.deepEqual(output, [
    `deployed API buildSha=${D2_BUILD_SHA}`,
    `required ancestry base=${D2_BUILD_SHA}`,
    `deployment preflight: ${D2_BUILD_SHA} descends from ${D2_BUILD_SHA}`,
  ]);
  assert.equal(git("merge-base", "--is-ancestor", D2_BUILD_SHA, D2_BUILD_SHA), "");
});

test("the under-deployed D1 build fails nonzero before mutation", async () => {
  let mutations = 0;
  await assert.rejects(
    () => preflightBeforeMutation({
      apiUrl: "http://api",
      repositoryRoot: REPOSITORY_ROOT,
      fetchImplementation: respondWith(versionFor(D1_BUILD_SHA)),
      mutate: async () => { mutations += 1; },
    }),
    (error) => {
      assert.equal(error.code, "deployed-build-not-descendant");
      assert.match(error.message, new RegExp(`${D1_BUILD_SHA}.*${D2_BUILD_SHA}`, "u"));
      return true;
    },
  );
  assert.equal(mutations, 0, "a rejected deployment may not reach the mutation action");
});

test("the command-line preflight has a zero/nonzero boundary for deployed D2 and D1", async () => {
  const cli = fileURLToPath(new URL("runtime-tools-preflight.mjs", import.meta.url));
  const run = (apiUrl) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--url", apiUrl, "--repository-root", REPOSITORY_ROOT], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });

  await withVersionServer(versionFor(D2_BUILD_SHA), async (apiUrl) => {
    const result = await run(apiUrl);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`deployed API buildSha=${D2_BUILD_SHA}`, "u"));
    assert.match(result.stdout, new RegExp(`descends from ${D2_BUILD_SHA}`, "u"));
  });
  await withVersionServer(versionFor(D1_BUILD_SHA), async (apiUrl) => {
    const result = await run(apiUrl);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, new RegExp(`deployed API buildSha=${D1_BUILD_SHA}`, "u"));
    assert.match(result.stderr, /deployed-build-not-descendant/u);
  });
});

test("malformed, dirty, unreachable, and wrong-package API identities refuse before mutation", async () => {
  const cases = [
    ["malformed", { ...versionFor("not-a-commit") }, "deployed-build-sha-invalid"],
    ["dirty", { ...versionFor(`${D2_BUILD_SHA}-dirty`), commit: D2_BUILD_SHA, dirty: true }, "deployed-build-sha-invalid"],
    ["wrong package", { ...versionFor(D2_BUILD_SHA), service: "@anneal/runner", commit: D2_BUILD_SHA }, "deployed-api-identity-invalid"],
    ["unresolvable", { ...versionFor("0123456789abcdef0123456789abcdef01234567") }, "deployed-build-unresolvable"],
  ];

  for (const [label, document, code] of cases) {
    let mutations = 0;
    await assert.rejects(
      () => preflightBeforeMutation({
        apiUrl: "http://api",
        repositoryRoot: REPOSITORY_ROOT,
        fetchImplementation: respondWith(document),
        mutate: async () => { mutations += 1; },
      }),
      (error) => error.code === code,
      label,
    );
    assert.equal(mutations, 0, `${label}: mutation must not run`);
  }
});
