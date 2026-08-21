import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveCliExecutable } from "./availability.js";

test("CLI resolution follows configured PATH order and requires execute permission", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cli-resolution-"));
  const first = join(root, "first");
  const second = join(root, "second");
  try {
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, "codex"), "not executable\n");
    await writeFile(join(second, "codex"), "#!/bin/sh\nexit 0\n");
    await chmod(join(first, "codex"), 0o644);
    await chmod(join(second, "codex"), 0o755);

    assert.equal(await resolveCliExecutable("codex", `${first}:${second}`), join(second, "codex"));
    assert.equal(await resolveCliExecutable(join(first, "codex"), `${second}:${first}`), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
