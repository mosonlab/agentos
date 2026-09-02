#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "../../packages/build-info/index.mjs";

/** The deployed build must include the D2 source-resolution contract. */
export const D2_BUILD_SHA = "b2e971c2877ec54ba7a0374080f863cb44e84023";

const SHA = /^[0-9a-f]{40}$/u;
const API_SERVICE = "@anneal/api";
const REPOSITORY_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

export class RuntimeToolsPreflightError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "RuntimeToolsPreflightError";
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, detail) => {
  throw new RuntimeToolsPreflightError(code, detail);
};

const cleanBaseUrl = (apiUrl) => {
  if (typeof apiUrl !== "string" || apiUrl.trim() === "") fail("deployed-api-url-invalid", "a non-empty API URL is required");
  return apiUrl.replace(/\/+$/u, "");
};

const defaultOutput = (line) => process.stdout.write(`${line}\n`);

const defaultRunGit = (gitBinary, repositoryRoot, args) => execFileSync(
  gitBinary,
  ["-C", repositoryRoot, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

const readApiBuildSha = async ({ endpoint, fetchImplementation }) => {
  let response;
  try {
    response = await fetchImplementation(endpoint, { headers: { accept: "application/json" } });
  } catch (error) {
    fail("deployed-api-unreachable", error instanceof Error ? error.message : String(error));
  }
  if (!response?.ok) fail("deployed-api-unreachable", `${endpoint} answered HTTP ${response?.status ?? "unknown"}`);

  let document;
  try {
    document = await response.json();
  } catch (error) {
    fail("deployed-api-response-invalid", error instanceof Error ? error.message : String(error));
  }
  if (document?.service !== API_SERVICE) fail("deployed-api-identity-invalid", `expected ${API_SERVICE}`);
  if (document?.stamped !== true || document?.dirty !== false) {
    fail("deployed-build-sha-invalid", "the API must report one clean stamped build");
  }
  const deployedBuildSha = document?.buildSha;
  if (!SHA.test(deployedBuildSha) || document.commit !== deployedBuildSha) {
    fail("deployed-build-sha-invalid", "buildSha and commit must be the same lowercase 40-character object id");
  }
  return deployedBuildSha;
};

/**
 * Check that the live API was built from a commit at or after D2.
 *
 * This is intentionally independent of a checkout's source paths. The only
 * identity accepted from the service is its `/version` buildSha, and the only
 * repository fact consulted afterward is Git object ancestry. A caller can use
 * the returned proof as the guard immediately before a filesystem mutation.
 */
export const deployedRuntimeToolsPreflight = async ({
  apiUrl,
  repositoryRoot = REPOSITORY_ROOT,
  baseSha = D2_BUILD_SHA,
  gitBinary = "git",
  fetchImplementation = fetch,
  runGit = (args) => defaultRunGit(gitBinary, repositoryRoot, args),
  output = defaultOutput,
} = {}) => {
  if (!SHA.test(baseSha)) fail("preflight-base-invalid", "the required D2 base is not a full lowercase 40-character object id");
  const endpoint = `${cleanBaseUrl(apiUrl)}/version`;
  const deployedBuildSha = await readApiBuildSha({ endpoint, fetchImplementation });

  output(`deployed API buildSha=${deployedBuildSha}`);
  output(`required ancestry base=${baseSha}`);

  let resolvedDeployed;
  try {
    resolvedDeployed = runGit(["rev-parse", "--verify", `${deployedBuildSha}^{commit}`]);
  } catch (error) {
    fail("deployed-build-unresolvable", error instanceof Error ? error.message : String(error));
  }
  if (resolvedDeployed !== deployedBuildSha) {
    fail("deployed-build-unresolvable", `Git resolved ${deployedBuildSha} as ${resolvedDeployed || "nothing"}`);
  }

  let resolvedBase;
  try {
    resolvedBase = runGit(["rev-parse", "--verify", `${baseSha}^{commit}`]);
  } catch (error) {
    fail("preflight-base-unresolvable", error instanceof Error ? error.message : String(error));
  }
  if (resolvedBase !== baseSha) {
    fail("preflight-base-unresolvable", `Git resolved ${baseSha} as ${resolvedBase || "nothing"}`);
  }

  try {
    runGit(["merge-base", "--is-ancestor", baseSha, deployedBuildSha]);
  } catch (error) {
    fail("deployed-build-not-descendant", `${deployedBuildSha} does not descend from ${baseSha}`);
  }

  output(`deployment preflight: ${deployedBuildSha} descends from ${baseSha}`);
  return Object.freeze({ baseSha, deployedBuildSha, endpoint });
};

/** Run a caller's mutation only after the deployment identity has passed. */
export const preflightBeforeMutation = async ({ mutate, ...options }) => {
  if (typeof mutate !== "function") fail("mutation-action-invalid", "a mutation callback is required");
  const proof = await deployedRuntimeToolsPreflight(options);
  await mutate(proof);
  return proof;
};

export const parseArguments = (argv) => {
  let apiUrl;
  let repositoryRoot = REPOSITORY_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = (flag) => {
      const inline = argument.startsWith(`${flag}=`) ? argument.slice(flag.length + 1) : undefined;
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined) return null;
      index += 1;
      return next;
    };
    if (argument === "--url" || argument.startsWith("--url=")) {
      const value = take("--url");
      if (value === null) return { error: "--url needs a value" };
      apiUrl = value;
    } else if (argument === "--repository-root" || argument.startsWith("--repository-root=")) {
      const value = take("--repository-root");
      if (value === null) return { error: "--repository-root needs a value" };
      repositoryRoot = resolve(value);
    } else {
      return { error: `unknown argument ${argument}` };
    }
  }
  if (apiUrl === undefined) return { error: "--url <deployed API base> is required" };
  return { apiUrl, repositoryRoot };
};

if (isEntryPoint(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`runtime-tools-preflight: ${parsed.error}\n`);
    process.exit(2);
  }
  try {
    await deployedRuntimeToolsPreflight(parsed);
  } catch (error) {
    const failure = error instanceof RuntimeToolsPreflightError
      ? error
      : new RuntimeToolsPreflightError("preflight-failed", error instanceof Error ? error.message : String(error));
    process.stderr.write(`runtime-tools-preflight: ${failure.message}\n`);
    process.exit(1);
  }
}
