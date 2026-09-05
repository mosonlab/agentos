import assert from "node:assert/strict";
import test from "node:test";

import { classifyDiff } from "./merge-gate-profile.mjs";

const changes = (...entries) => Buffer.from(`${entries.flat().join("\0")}\0`);

test("modified allowlisted prose selects docs-only", () => {
  assert.equal(classifyDiff({ nameStatus: changes("M", "AGENTS.md") }), "docs-only");
  for (const path of [
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "docs/BRIEF-TEMPLATE.md",
    "docs/public-snapshot.md",
  ]) {
    assert.equal(classifyDiff({ nameStatus: changes("M", path) }), "docs-only", path);
  }
  assert.equal(
    classifyDiff({
      nameStatus: changes(
        "M", "docs/governance/task-routing-v1.md",
        "M", "docs/runbooks/gate-worker.md",
      ),
    }),
    "docs-only",
  );
  assert.equal(
    classifyDiff({ nameStatus: changes("M", "docs/reviews/2026-08-23-review.md") }),
    "docs-only",
  );
});

test("runtime-coupled documentation selects the full gate", () => {
  for (const path of [
    "README.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "docs/release/v0.2.0-release-notes.md",
    "docs/demos/templates-release-demo.md",
    "docs/runbooks/merge-executor.md",
    "docs/runbooks/quiet-window-auto-deploy.md",
    "agents/roles/senior-dev-astra-medium.md",
  ]) {
    assert.equal(classifyDiff({ nameStatus: changes("M", path) }), "full", path);
  }
});

test("code, configuration, and gate changes select the full gate", () => {
  for (const path of [
    "package.json",
    "public-snapshot.json",
    "scripts/merge-gate.sh",
    "scripts/merge-gate-profile.mjs",
    "packages/api/src/app.ts",
  ]) {
    assert.equal(classifyDiff({ nameStatus: changes("M", path) }), "full", path);
  }
});

test("structural changes and empty ranges select the full gate", () => {
  assert.equal(classifyDiff({ nameStatus: Buffer.alloc(0) }), "full");
  assert.equal(classifyDiff({ nameStatus: changes("A", "AGENTS.md") }), "full");
  assert.equal(classifyDiff({ nameStatus: changes("D", "AGENTS.md") }), "full");
  assert.equal(
    classifyDiff({ nameStatus: changes("R100", "AGENTS.md", "docs/AGENTS.md") }),
    "full",
  );
  assert.equal(
    classifyDiff({ nameStatus: changes("M", "AGENTS.md"), summary: " mode change 100644 => 100755 AGENTS.md\n" }),
    "full",
  );
});

test("one non-prose path makes a mixed diff full", () => {
  assert.equal(
    classifyDiff({ nameStatus: changes("M", "AGENTS.md", "M", "packages/api/src/app.ts") }),
    "full",
  );
});
