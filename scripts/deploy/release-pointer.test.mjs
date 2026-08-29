import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeployFailure } from "./quiet-window-lib.mjs";
import {
  activateReleasePointer,
  inspectReleasePointers,
  rollbackReleasePointer,
} from "./release-pointer.mjs";

const release = (root, name, marker = name) => {
  const path = join(root, "releases", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "version"), marker);
  return path;
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-release-pointer-"));
  mkdirSync(join(root, "releases"));
  const old = release(root, "old-release", "old");
  const older = release(root, "older-release", "older");
  const next = release(root, "next-release", "next");
  symlinkSync("releases/old-release", join(root, "current"));
  symlinkSync("releases/older-release", join(root, "previous"));
  return { root, old, older, next };
};

const cleanup = (root) => rmSync(root, { recursive: true, force: true });

test("activation updates previous before atomically swapping current", () => {
  const { root, next } = fixture();
  try {
    const events = [];
    const result = activateReleasePointer({
      root,
      release: next,
      filesystem: {
        renameSync: (from, to) => {
          events.push({ kind: "rename", from, to, current: readlinkSync(join(root, "current")) });
          return renameSync(from, to);
        },
        fsyncSync: (fd) => {
          events.push({ kind: "fsync" });
          return fsyncSync(fd);
        },
      },
    });

    assert.deepEqual(result, {
      operation: "activate",
      changed: true,
      oldTarget: "old-release",
      newTarget: "next-release",
      previousBefore: "older-release",
      previousTarget: "old-release",
      currentPath: join(root, "current"),
      previousPath: join(root, "previous"),
    });
    assert.equal(readlinkSync(join(root, "current")), "releases/next-release");
    assert.equal(readlinkSync(join(root, "previous")), "releases/old-release");
    assert.equal(lstatSync(join(root, "current")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(root, "previous")).isSymbolicLink(), true);
    assert.equal(events.length, 3);
    assert.equal(events[0].to, join(root, "previous"));
    assert.equal(events[0].current, "releases/old-release");
    assert.equal(events[1].to, join(root, "current"));
    assert.equal(events[1].current, "releases/old-release");
    assert.equal(events[2].kind, "fsync");
    assert.deepEqual(inspectReleasePointers({ root }), {
      current: "next-release",
      previous: "old-release",
    });
  } finally {
    cleanup(root);
  }
});

test("rollback points current at previous and preserves the failed target as previous", () => {
  const { root } = fixture();
  try {
    const events = [];
    const result = rollbackReleasePointer({
      root,
      filesystem: {
        renameSync: (from, to) => {
          events.push(`rename:${to.endsWith("/current") ? "current" : "previous"}`);
          return renameSync(from, to);
        },
        fsyncSync: (fd) => {
          events.push("fsync");
          return fsyncSync(fd);
        },
      },
    });
    assert.deepEqual(result, {
      operation: "rollback",
      changed: true,
      oldTarget: "old-release",
      newTarget: "older-release",
      previousBefore: "older-release",
      previousTarget: "old-release",
      currentPath: join(root, "current"),
      previousPath: join(root, "previous"),
    });
    assert.deepEqual(inspectReleasePointers({ root }), {
      current: "older-release",
      previous: "old-release",
    });
    assert.deepEqual(events, ["rename:previous", "rename:current", "fsync"]);
  } finally {
    cleanup(root);
  }
});

test("a restored failed activation is fsynced before the failure returns", () => {
  const { root } = fixture();
  try {
    const events = [];
    assert.throws(
      () => activateReleasePointer({
        root,
        release: "next-release",
        filesystem: {
          openSync,
          closeSync,
          renameSync: (from, to) => {
            if (to === join(root, "current")) {
              events.push("current-failed");
              const error = new Error("simulated current rename failure");
              error.code = "EIO";
              throw error;
            }
            events.push("previous-renamed");
            return renameSync(from, to);
          },
          fsyncSync: (fd) => {
            events.push("fsync-restored");
            return fsyncSync(fd);
          },
        },
      }),
      (error) => error instanceof DeployFailure && error.reason === "release-pointer-activation-failed",
    );
    assert.deepEqual(events, ["previous-renamed", "current-failed", "previous-renamed", "fsync-restored"]);
  } finally {
    cleanup(root);
  }
});

test("a first activation creates current without ever unlinking it", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-release-pointer-bootstrap-"));
  try {
    mkdirSync(join(root, "releases"));
    const next = release(root, "first-release");
    const observed = [];
    const result = activateReleasePointer({
      root,
      release: "first-release",
      filesystem: {
        renameSync: (from, to) => {
          observed.push({ to, currentExists: existsSync(join(root, "current")) });
          return renameSync(from, to);
        },
      },
    });
    assert.equal(result.oldTarget, null);
    assert.equal(result.newTarget, "first-release");
    assert.equal(result.previousTarget, null);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].to, join(root, "current"));
    assert.equal(observed[0].currentExists, false);
    assert.equal(readlinkSync(join(root, "current")), "releases/first-release");
    assert.equal(next.endsWith("first-release"), true);
  } finally {
    cleanup(root);
  }
});

test("a failed current rename leaves current and previous coherent", () => {
  const { root } = fixture();
  try {
    let currentRename = false;
    assert.throws(
      () => activateReleasePointer({
        root,
        release: "next-release",
        filesystem: {
          renameSync: (from, to) => {
            if (to === join(root, "current")) {
              currentRename = true;
              const error = new Error("simulated current rename failure");
              error.code = "EIO";
              throw error;
            }
            return renameSync(from, to);
          },
        },
      }),
      (error) => error instanceof DeployFailure
        && error.reason === "release-pointer-activation-failed",
    );
    assert.equal(currentRename, true);
    assert.deepEqual(inspectReleasePointers({ root }), {
      current: "old-release",
      previous: "older-release",
    });
  } finally {
    cleanup(root);
  }
});

test("pointer targets must be existing release directories", () => {
  const { root } = fixture();
  try {
    for (const releaseTarget of ["missing-release", "../outside", join(root, "current")]) {
      assert.throws(
        () => activateReleasePointer({ root, release: releaseTarget }),
        (error) => error instanceof DeployFailure && error.reason === "release-pointer-invalid",
        releaseTarget,
      );
    }
    symlinkSync("/tmp", join(root, "releases", "escape-release"));
    assert.throws(
      () => activateReleasePointer({ root, release: "escape-release" }),
      (error) => error instanceof DeployFailure && error.reason === "release-pointer-invalid",
    );
    const currentPath = join(root, "current");
    rmSync(currentPath);
    symlinkSync("releases/missing-release", currentPath);
    assert.throws(
      () => inspectReleasePointers({ root }),
      (error) => error instanceof DeployFailure && error.reason === "release-pointer-invalid",
    );
  } finally {
    cleanup(root);
  }
});

test("rollback requires a valid previous release pointer", () => {
  const { root } = fixture();
  try {
    rmSync(join(root, "previous"));
    assert.throws(
      () => rollbackReleasePointer({ root }),
      (error) => error instanceof DeployFailure
        && error.reason === "release-pointer-rollback-unavailable",
    );
  } finally {
    cleanup(root);
  }
});
