import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Side-effect import for test files: provisions an isolated, disposable
// workspace root for this test process unless the test configured one itself.
// test-app refuses to start without a root and refuses production/owned roots
// outright; this helper is the sanctioned way to satisfy that requirement.
if (!process.env.RUNNER_WORKSPACE_ROOT) {
  process.env.RUNNER_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "agentos-test-root-"));
}

export {};
