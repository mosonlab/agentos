import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Side-effect import for test files: provisions isolated disposable roots for
// this test process unless the caller configured them. These paths otherwise
// default to operator-owned locations and can leak state between test runs.
let testRoot: string | null = null;
const isolatedRoot = (name: string): string => {
  testRoot ??= mkdtempSync(join(tmpdir(), "agentos-test-roots-"));
  const path = join(testRoot, name);
  mkdirSync(path);
  return path;
};

if (!process.env.RUNNER_WORKSPACE_ROOT) process.env.RUNNER_WORKSPACE_ROOT = isolatedRoot("workspaces");
if (!process.env.CONTROL_PLANE_STATE_DIR) process.env.CONTROL_PLANE_STATE_DIR = isolatedRoot("state");
if (!process.env.FILES_ROOT) process.env.FILES_ROOT = isolatedRoot("files");

export {};
