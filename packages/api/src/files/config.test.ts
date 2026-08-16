import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertFilesRootIsolated, getFileStore, resetFileStores } from "./config.js";

const withTemp = async (run: (base: string) => Promise<void>): Promise<void> => {
  const base = await mkdtemp(join(tmpdir(), "agentos-files-config-"));
  try {
    await run(base);
  } finally {
    await chmod(base, 0o700).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
};

test("startup refuses a Files Root that overlaps the run workspace root", async () => withTemp(async (base) => {
  const files = join(base, "files");
  const workspaces = join(base, "workspaces");
  await Promise.all([mkdir(files), mkdir(workspaces)]);

  await assertFilesRootIsolated(files, workspaces);

  // Agents can write anywhere in a workspace, which is the precondition every remaining
  // containment gap (hardlinks, post-walk swaps) needs. Overlap in any direction is fatal.
  const overlapping: Array<[string, string]> = [
    [files, files],
    [join(workspaces, "shared"), workspaces],
    [workspaces, join(workspaces, "shared")],
  ];
  for (const [filesRoot, workspaceRoot] of overlapping) {
    await assert.rejects(
      assertFilesRootIsolated(filesRoot, workspaceRoot),
      /overlaps RUNNER_WORKSPACE_ROOT/u,
    );
  }

  // A shared prefix that is not a path prefix is not an overlap.
  await assertFilesRootIsolated(`${workspaces}-files`, workspaces);
}));

test("a Files Root that fails to open is retried instead of cached as a rejection", async () => withTemp(async (base) => {
  const previous = process.env.FILES_ROOT;
  const denied = join(base, "denied");
  await mkdir(denied);
  await chmod(denied, 0o500);
  process.env.FILES_ROOT = join(denied, "root");
  resetFileStores();
  try {
    await assert.rejects(getFileStore());
    await chmod(denied, 0o700);
    // Without eviction this replays the first EACCES until the API is restarted.
    assert.equal(typeof (await getFileStore()).list, "function");
  } finally {
    resetFileStores();
    if (previous === undefined) delete process.env.FILES_ROOT;
    else process.env.FILES_ROOT = previous;
  }
}));
