// Loaded with --import into every process node:test starts for a test file, so
// it runs before the file — and before anything the file imports — reads the
// environment. That is the only hook node:test offers per test file, and per
// test file is exactly the granularity the isolation needs: the runner planned
// one database and one set of roots for each, and this hands them over.
//
// In the runner's own process there is no plan in the environment, so this is a
// no-op. Where there is a plan there must be an assignment: a plan means files
// are running at the same time, and a process that ran anyway would run them
// against the database and the directories everybody else is using. Failing
// here costs one obvious red; failing open costs an intermittent one, somewhere
// else, on a day when the paths happen not to match.

import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { assignmentFor, environmentForAssignment, planEnvironmentVariable } from "../src/dbtest-plan.ts";
import { formatTimingLine, timingsEnvironmentVariable } from "../src/dbtest-timings.ts";

const planPath = process.env[planEnvironmentVariable];

if (planPath) {
  const entry = process.argv[1];
  const resolved = entry === undefined ? undefined : resolve(entry);
  // The plan is keyed by both spellings of each file, so either answers; asking
  // for the real path first is what survives a checkout reached through a
  // symlink.
  let canonical = resolved;
  try {
    if (resolved !== undefined) canonical = realpathSync(resolved);
  } catch {
    canonical = resolved;
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const assignment = assignmentFor(plan, canonical);
  Object.assign(process.env, environmentForAssignment(assignment));
}

// The other thing per-test-file granularity is good for. node:test runs the
// tests inside one file in order, so this process's own lifetime is the file's
// contribution to the wave, and the wave drains at the pace of its longest
// file. Written on exit rather than reported through node:test, because the
// reporter sees tests and this needs to see files.
const timingsPath = process.env[timingsEnvironmentVariable];
if (timingsPath) {
  const startedAt = Date.now();
  const entry = process.argv[1];
  process.on("exit", () => {
    try {
      appendFileSync(
        timingsPath,
        // The whole path, not the basename: two packages contribute
        // same-named files to one pool, and the report has to tell them apart.
        formatTimingLine({ file: entry === undefined ? "unknown" : resolve(entry), ms: Date.now() - startedAt }),
      );
    } catch {
      // A run that produced a verdict must not be failed by its own bookkeeping.
    }
  });
}
