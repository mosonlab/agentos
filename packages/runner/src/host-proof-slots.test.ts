import assert from "node:assert/strict";
import { chmod, chown, lstat, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hostProofSlotDirectory, prepareHostProofSlots } from "./host-proof-slots.js";

const mode = (value: number): number => value & 0o7777;
const mkdirOwned = async (path: string): Promise<void> => {
  await mkdir(path, { mode: 0o755 });
  await chmod(path, 0o755);
  await chown(path, process.getuid!(), process.getgid!());
};

test("host proof slot startup preparation is concurrent and idempotent", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "host-proof-slots-"));
  try {
    const config = { workspaceRoot, hostProofSlots: 3 };
    await Promise.all(Array.from({ length: 12 }, async () => prepareHostProofSlots(config)));

    const directory = hostProofSlotDirectory(config);
    const directoryInfo = await lstat(directory);
    assert.equal(directoryInfo.isDirectory(), true);
    assert.equal(directoryInfo.isSymbolicLink(), false);
    assert.equal(mode(directoryInfo.mode), 0o755);
    assert.equal(directoryInfo.uid, process.getuid!());
    assert.equal(directoryInfo.gid, process.getgid!());

    for (let slot = 1; slot <= config.hostProofSlots; slot += 1) {
      const info = await lstat(join(directory, `slot-${slot}.lock`));
      assert.equal(info.isFile(), true);
      assert.equal(info.isSymbolicLink(), false);
      assert.equal(mode(info.mode), 0o666);
      assert.equal(info.uid, process.getuid!());
      assert.equal(info.gid, process.getgid!());
      // World read/write is the contract that lets two unrelated run-as
      // principals open the persistent inode without either owning its parent.
      assert.equal(mode(info.mode) & 0o006, 0o006);
    }

    // Separate run-as principals are simulated by independent clients: neither
    // owns the shared inode, and both need read/write opens before lockf can
    // coordinate them. Exact world permissions above are the cross-UID part.
    const sharedSlot = join(directory, "slot-1.lock");
    const clients = await Promise.all([open(sharedSlot, "r+"), open(sharedSlot, "r+")]);
    await Promise.all(clients.map(async (client) => client.close()));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("host proof slot startup refuses symlinks and wrong filesystem types", async (context) => {
  await context.test("slot directory symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-proof-slots-symlink-"));
    const target = join(root, "target");
    await mkdir(target);
    await symlink(target, join(root, ".host-proof-slots"));
    await assert.rejects(prepareHostProofSlots({ workspaceRoot: root, hostProofSlots: 1 }), /not a non-symlink directory/u);
    await rm(root, { recursive: true, force: true });
  });

  await context.test("slot directory regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-proof-slots-file-"));
    await writeFile(join(root, ".host-proof-slots"), "wrong type");
    await assert.rejects(prepareHostProofSlots({ workspaceRoot: root, hostProofSlots: 1 }), /not a non-symlink directory/u);
    await rm(root, { recursive: true, force: true });
  });

  await context.test("slot file symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-proof-slot-symlink-"));
    const directory = join(root, ".host-proof-slots");
    await mkdirOwned(directory);
    await symlink(join(root, "missing"), join(directory, "slot-1.lock"));
    await assert.rejects(prepareHostProofSlots({ workspaceRoot: root, hostProofSlots: 1 }), /not a non-symlink regular file/u);
    await rm(root, { recursive: true, force: true });
  });

  await context.test("slot file directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-proof-slot-directory-"));
    const directory = join(root, ".host-proof-slots");
    await mkdirOwned(directory);
    await mkdir(join(directory, "slot-1.lock"));
    await assert.rejects(prepareHostProofSlots({ workspaceRoot: root, hostProofSlots: 1 }), /not a non-symlink regular file/u);
    await rm(root, { recursive: true, force: true });
  });
});

test("host proof slot startup refuses mode mismatches instead of repairing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-proof-slot-mode-"));
  try {
    const directory = join(root, ".host-proof-slots");
    await mkdirOwned(directory);
    await chmod(directory, 0o700);
    await assert.rejects(
      prepareHostProofSlots({ workspaceRoot: root, hostProofSlots: 1 }),
      /mode 0700; expected 0755/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host proof slot startup refuses an existing slot file with the wrong mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-proof-slot-file-mode-"));
  try {
    const directory = join(root, ".host-proof-slots");
    const slot = join(directory, "slot-1.lock");
    await mkdirOwned(directory);
    await writeFile(slot, "");
    await chmod(slot, 0o600);
    await assert.rejects(
      prepareHostProofSlots({ workspaceRoot: root, hostProofSlots: 1 }),
      /mode 0600; expected 0666/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
