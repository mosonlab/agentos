#!/usr/bin/env node
//
// Deployment-side reconciliation: is what is about to run — or what is already
// running — the commit that was approved?
//
//   npm run verify:build-sha -- --expected <40-char oid>
//   node packages/build-info/verify-dist.mjs --expected <oid> --dist <dir> --package <name>
//   node packages/build-info/verify-dist.mjs --expected <oid> --url http://127.0.0.1:3000
//
// Exit 0 means every artefact checked was built from exactly that commit, from
// a clean worktree, and is the package it was supposed to be. Anything else is
// a non-zero exit and a named reason.
//
// This is the check; the operator's deployment entry point is what makes it
// binding. Running this by hand answers the question, but a restart that is not
// routed through the script can still ignore the answer — which is why the
// runbook restarts nothing directly.
//
// It reads build stamps and one HTTP endpoint, and nothing else: it starts no
// service, touches no database and writes nothing.
//
// Pair it with the merge gate. The gate says "this object id passed"; this says
// "this object id is what is on disk, and what is answering the port". The
// 2026-08-17 incident lived in the gap between those three sentences.

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildInfoFromVersionDocument, buildSha, isEntryPoint, readBuildInfo, reconcile } from "./index.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");

/** The two artefacts a restart actually starts, each bound to the package it is
 *  supposed to hold. Named here rather than left to the caller, because a check
 *  that silently verifies fewer things than the operator assumes is worse than
 *  no check. */
export const DEFAULT_DISTS = [
  { dist: "packages/api/dist", packageName: "@anneal/api", base: "repo" },
  { dist: "packages/runner/dist", packageName: "@anneal/runner", base: "repo" },
];

export const parseArguments = (argv) => {
  let expected;
  const dists = [];
  const urls = [];
  // `--package` describes whichever target it follows, so an operator can bind
  // an identity to a directory and to a port with one spelling.
  let lastTarget = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const inlineValue = (flag) => (argument.startsWith(`${flag}=`) ? argument.slice(flag.length + 1) : undefined);
    const takeValue = (flag) => {
      const inline = inlineValue(flag);
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined) return null;
      index += 1;
      return next;
    };
    if (argument === "--expected" || argument.startsWith("--expected=")) {
      const value = takeValue("--expected");
      if (value === null) return { error: "--expected needs a value" };
      expected = value;
    } else if (argument === "--dist" || argument.startsWith("--dist=")) {
      const value = takeValue("--dist");
      if (value === null) return { error: "--dist needs a value" };
      // Unbound by default: a directory the caller named is a directory whose
      // identity this command cannot infer. `--package` is how the caller says
      // what it is supposed to hold.
      // Anchored to the caller's working directory, the way every other
      // command treats a path it was handed. The defaults are anchored to the
      // repository instead, so `npm run verify:build-sha` means the same thing
      // from anywhere.
      lastTarget = { dist: value, packageName: null, base: "cwd" };
      dists.push(lastTarget);
    } else if (argument === "--package" || argument.startsWith("--package=")) {
      const value = takeValue("--package");
      if (value === null) return { error: "--package needs a value" };
      if (!lastTarget) return { error: "--package must follow the --dist or --url it describes" };
      if (lastTarget.packageName) return { error: `--package given twice for ${lastTarget.dist ?? lastTarget.url}` };
      lastTarget.packageName = value;
    } else if (argument === "--url" || argument.startsWith("--url=")) {
      const value = takeValue("--url");
      if (value === null) return { error: "--url needs a value" };
      lastTarget = { url: value.replace(/\/+$/, ""), packageName: null };
      urls.push(lastTarget);
    } else {
      return { error: `unknown argument ${argument}` };
    }
  }
  if (expected === undefined) return { error: "--expected <oid> is required" };
  if (dists.length === 0 && urls.length === 0) return { expected, dists: DEFAULT_DISTS, urls };
  return { expected, dists, urls };
};

/**
 * A dist directory holds its stamp beside the modules that read it, so the
 * check reads exactly the file the running process will read — not a rebuilt
 * copy, not a parallel record that could drift from it.
 */
export const verifyDists = ({ expected, dists, root = repoRoot, cwd = process.cwd() }) => dists.map(({ dist, packageName, base }) => {
  const directory = resolve(base === "cwd" ? cwd : root, dist);
  // The trailing slash makes this a directory URL, so `build-info.json`
  // resolves inside it rather than beside it.
  const info = readBuildInfo(pathToFileURL(`${directory}/`));
  return { kind: "dist", label: dist, directory, info, ...reconcile(info, expected, packageName) };
});

/**
 * The same question asked of a process instead of a directory.
 *
 * A dist that reconciles is not yet a deployment that reconciles: the service
 * may still be running the previous build until it is actually restarted, and
 * on 2026-08-17 that was the whole of the problem. The service names itself in
 * the document, so the answer is bound to the package that answered rather than
 * to whatever the caller assumed was on that port.
 */
export const verifyUrls = async ({ expected, urls, fetchImplementation = fetch }) => Promise.all(
  urls.map(async ({ url, packageName }) => {
    const endpoint = `${url}/version`;
    try {
      const response = await fetchImplementation(endpoint, { headers: { accept: "application/json" } });
      if (!response.ok) {
        return { kind: "url", label: endpoint, info: undefined, ok: false, reason: `${endpoint} answered HTTP ${response.status}` };
      }
      const { info, service } = buildInfoFromVersionDocument(await response.json());
      // Checked against what the caller expected to be on that port, never
      // against the document's own claim about itself: a service that names
      // itself and is then compared with its own answer has not been checked.
      return { kind: "url", label: endpoint, info, service, ...reconcile(info, expected, packageName) };
    } catch (error) {
      // Unreachable is a refusal, not a pass. A restart that never came back is
      // exactly the state this check exists to catch.
      return { kind: "url", label: endpoint, info: undefined, ok: false, reason: `${endpoint} is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }),
);

export const verify = async (parsed) => [
  ...verifyDists(parsed),
  ...await verifyUrls(parsed),
];

if (isEntryPoint(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`verify-build-sha: ${parsed.error}\n\n${[
      "usage: verify-dist.mjs --expected <oid> [--dist <dir>|--url <base> [--package <name>]]...",
      "",
      "With no --dist and no --url, checks packages/api/dist and packages/runner/dist,",
      "each bound to the package it must hold. --package binds the target before it to",
      "an identity; without one, a --dist or --url is checked for commit and cleanliness",
      "only, because nothing establishes whose build is supposed to be there, and the",
      "output says so on the line.",
    ].join("\n")}\n`);
    process.exit(2);
  }
  const results = await verify(parsed);
  for (const result of results) {
    const detail = result.ok ? result.reason : `${result.reason}${result.info ? ` [${buildSha(result.info)}]` : ""}`;
    process.stdout.write(`${result.ok ? "ok   " : "FAIL "} ${result.label}: ${detail}\n`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    process.stderr.write(`\nverify-build-sha: ${failed.length} of ${results.length} artefact(s) are not ${parsed.expected}; do not start this deployment\n`);
    process.exit(1);
  }
  process.stdout.write(`\nverify-build-sha: every artefact is ${parsed.expected}\n`);
}
