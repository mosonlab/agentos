import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertWorkingDirectory, buildPrompt } from "./adapters.js";
import type { ClaimedTask } from "./api.js";

const claim: ClaimedTask = {
  task: { id: "task-1", name: "Ship it", description: "Do the work", workingDirectory: "/tmp/work" },
  agent: { id: "agent-1", name: "senior-dev", foundationalPrompt: "Foundation", rolePrompt: "Implement" },
  session: { id: "session-1" },
  runner: "CODEX",
};

test("buildPrompt combines foundational, role, and task context", () => {
  assert.match(buildPrompt(claim), /Foundation[\s\S]*Role \(senior-dev\): Implement[\s\S]*Task: Ship it[\s\S]*Do the work/);
});

test("assertWorkingDirectory accepts directories and rejects missing paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-runner-"));
  assert.equal(await assertWorkingDirectory(directory), directory);
  await assert.rejects(assertWorkingDirectory(join(directory, "missing")));
});
