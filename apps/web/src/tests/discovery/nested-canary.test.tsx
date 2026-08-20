import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** A canary, and nothing else. It sits one directory below `src/tests` because
 *  the package's test script used to hand its `**` glob to the shell unquoted,
 *  and `sh` without `globstar` reads `**` as `*` — so exactly one directory
 *  level was ever searched and any deeper test file was skipped in silence,
 *  which reads exactly like a pass.
 *
 *  `test-discovery.test.tsx` is the assertion that catches that; this file is
 *  what keeps it from being vacuous, and its own presence in the run count is
 *  the visible half of the same evidence. Do not move it up a level, and do not
 *  delete it without deleting the guard. */
test("a test file below src/tests is reached by the package test script", () => {
  const path = fileURLToPath(import.meta.url);
  assert.match(path, /\/src\/tests\/discovery\/nested-canary\.test\.tsx$/);
});
