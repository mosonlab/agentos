import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DeployFailure } from "./quiet-window-lib.mjs";

/** The two names are intentionally fixed: launchd and operators consume them. */
export const RELEASE_POINTER_NAMES = Object.freeze({ current: "current", previous: "previous" });

const RELEASE_NAME = /^(?!\.\.?$)[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

const invalid = (detail) => {
  throw new DeployFailure("release-pointer-invalid", detail);
};

const filesystemFrom = (overrides) => ({
  lstatSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  ...(overrides ?? {}),
});

const statusAt = (filesystem, path, label) => {
  try {
    return filesystem.lstatSync(path);
  } catch (error) {
    invalid(`${label}-${error?.code === "ENOENT" ? "missing" : "unreadable"}`);
  }
};

const assertDirectory = (filesystem, path, label) => {
  const status = statusAt(filesystem, path, label);
  if (status.isSymbolicLink() || !status.isDirectory()) invalid(`${label}-not-a-directory`);
};

const withinDirectory = (directory, path, label) => {
  const relativePath = relative(directory, path);
  if (
    relativePath === ""
    || isAbsolute(relativePath)
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || relativePath.includes(sep)
  ) invalid(`${label}-outside-releases`);
  return relativePath;
};

const prepareLayout = ({ root, filesystem }) => {
  if (typeof root !== "string" || root.length === 0) invalid("root-missing");
  const rootPath = resolve(root);
  assertDirectory(filesystem, rootPath, "root");
  const releasesPath = join(rootPath, "releases");
  assertDirectory(filesystem, releasesPath, "releases");
  let releasesRealPath;
  try {
    releasesRealPath = filesystem.realpathSync(releasesPath);
  } catch (error) {
    invalid(`releases-${error?.code === "ENOENT" ? "missing" : "unreadable"}`);
  }
  return Object.freeze({ rootPath, releasesPath, releasesRealPath });
};

const releaseFromPath = (layout, path, label) => {
  const candidate = resolve(path);
  const name = withinDirectory(layout.releasesPath, candidate, label);
  if (!RELEASE_NAME.test(name)) invalid(`${label}-name-invalid`);
  const status = statusAt(layout.filesystem, candidate, label);
  if (status.isSymbolicLink() || !status.isDirectory()) invalid(`${label}-not-a-release-directory`);
  let realPath;
  try {
    realPath = layout.filesystem.realpathSync(candidate);
  } catch (error) {
    invalid(`${label}-${error?.code === "ENOENT" ? "missing" : "unreadable"}`);
  }
  const realName = withinDirectory(layout.releasesRealPath, realPath, label);
  if (realName !== name) invalid(`${label}-resolved-outside-releases`);
  return Object.freeze({ name, path: candidate });
};

const releaseFromInput = (layout, value) => {
  if (typeof value !== "string" || value.length === 0) invalid("release-missing");
  const rootPrefix = `releases${sep}`;
  const candidate = isAbsolute(value)
    ? value
    : value === "releases" || value.startsWith(rootPrefix)
      ? join(layout.rootPath, value)
      : join(layout.releasesPath, value);
  return releaseFromPath(layout, candidate, "release");
};

const pointerAt = (layout, pointerName) => {
  const path = join(layout.rootPath, pointerName);
  let status;
  try {
    status = layout.filesystem.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    invalid(`${pointerName}-unreadable`);
  }
  if (!status.isSymbolicLink()) invalid(`${pointerName}-not-a-symlink`);
  let link;
  try {
    link = layout.filesystem.readlinkSync(path);
  } catch (error) {
    invalid(`${pointerName}-${error?.code === "ENOENT" ? "missing" : "unreadable"}`);
  }
  if (typeof link !== "string" || link.length === 0) invalid(`${pointerName}-target-invalid`);
  return releaseFromPath(layout, resolve(dirname(path), link), `${pointerName}-target`);
};

const pointersAt = (layout) => Object.freeze({
  current: pointerAt(layout, RELEASE_POINTER_NAMES.current),
  previous: pointerAt(layout, RELEASE_POINTER_NAMES.previous),
});

const temporaryPointerPath = (layout, pointerName) => join(
  layout.rootPath,
  `.${pointerName}.${process.pid}.${randomUUID()}.tmp`,
);

/** Replace one pointer with one rename(2), leaving an existing pointer in place
 * until the kernel swaps the prepared symlink into its name. */
const replacePointer = (layout, pointerName, target) => {
  const path = join(layout.rootPath, pointerName);
  const temporary = temporaryPointerPath(layout, pointerName);
  const link = relative(dirname(path), target.path);
  let installed = false;
  try {
    layout.filesystem.symlinkSync(link, temporary, "dir");
    layout.filesystem.renameSync(temporary, path);
    installed = true;
  } finally {
    if (!installed) {
      try {
        layout.filesystem.rmSync(temporary, { force: true });
      } catch {
        // Preserve the operation's original failure; a best-effort temporary
        // cleanup cannot make the pointer transition safe.
      }
    }
  }
};

const removePointer = (layout, pointerName) => {
  const path = join(layout.rootPath, pointerName);
  try {
    layout.filesystem.unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const failureDetail = (error) => error?.code ?? (error instanceof Error ? error.message : String(error));

const transition = ({ operation, changed, oldTarget, newTarget, previousBefore, previousTarget, layout }) =>
  Object.freeze({
    operation,
    changed,
    oldTarget,
    newTarget,
    previousBefore,
    previousTarget,
    currentPath: join(layout.rootPath, RELEASE_POINTER_NAMES.current),
    previousPath: join(layout.rootPath, RELEASE_POINTER_NAMES.previous),
  });

const restorePrevious = (layout, previousBefore) => {
  if (previousBefore === null) removePointer(layout, RELEASE_POINTER_NAMES.previous);
  else replacePointer(layout, RELEASE_POINTER_NAMES.previous, releaseFromInput(layout, previousBefore));
};

const activate = (layout, release) => {
  const pointers = pointersAt(layout);
  const target = releaseFromInput(layout, release);
  const oldTarget = pointers.current?.name ?? null;
  const previousBefore = pointers.previous?.name ?? null;
  if (oldTarget === target.name) {
    return transition({
      operation: "activate",
      changed: false,
      oldTarget,
      newTarget: target.name,
      previousBefore,
      previousTarget: previousBefore,
      layout,
    });
  }

  let previousUpdated = false;
  try {
    if (pointers.current) {
      replacePointer(layout, RELEASE_POINTER_NAMES.previous, pointers.current);
      previousUpdated = true;
    }
    replacePointer(layout, RELEASE_POINTER_NAMES.current, target);
  } catch (error) {
    if (previousUpdated) {
      try {
        restorePrevious(layout, previousBefore);
      } catch (restoreError) {
        throw new DeployFailure(
          "release-pointer-activation-failed",
          `${failureDetail(error)}-restore-${failureDetail(restoreError)}`,
        );
      }
    }
    throw new DeployFailure("release-pointer-activation-failed", failureDetail(error));
  }
  return transition({
    operation: "activate",
    changed: true,
    oldTarget,
    newTarget: target.name,
    previousBefore,
    previousTarget: oldTarget,
    layout,
  });
};

const rollback = (layout) => {
  const pointers = pointersAt(layout);
  if (!pointers.current || !pointers.previous) {
    throw new DeployFailure("release-pointer-rollback-unavailable", "current-or-previous-missing");
  }
  if (pointers.current.name === pointers.previous.name) {
    throw new DeployFailure("release-pointer-rollback-unavailable", "current-and-previous-match");
  }

  let previousUpdated = false;
  try {
    replacePointer(layout, RELEASE_POINTER_NAMES.previous, pointers.current);
    previousUpdated = true;
    replacePointer(layout, RELEASE_POINTER_NAMES.current, pointers.previous);
  } catch (error) {
    if (previousUpdated) {
      try {
        replacePointer(layout, RELEASE_POINTER_NAMES.previous, pointers.previous);
      } catch (restoreError) {
        throw new DeployFailure(
          "release-pointer-rollback-failed",
          `${failureDetail(error)}-restore-${failureDetail(restoreError)}`,
        );
      }
    }
    throw new DeployFailure("release-pointer-rollback-failed", failureDetail(error));
  }
  return transition({
    operation: "rollback",
    changed: true,
    oldTarget: pointers.current.name,
    newTarget: pointers.previous.name,
    previousBefore: pointers.previous.name,
    previousTarget: pointers.current.name,
    layout,
  });
};

/** Read and validate both stable pointers. Missing pointers are represented as
 * null; a dangling pointer or a target outside releases/ fails closed. */
export const inspectReleasePointers = ({ root, filesystem: overrides } = {}) => {
  const filesystem = filesystemFrom(overrides);
  const layout = { ...prepareLayout({ root, filesystem }), filesystem };
  const pointers = pointersAt(layout);
  return Object.freeze({
    current: pointers.current?.name ?? null,
    previous: pointers.previous?.name ?? null,
  });
};

/** Atomically activate a verified release. The previous pointer is prepared
 * first, then current is replaced with exactly one rename boundary. */
export const activateReleasePointer = ({ root, release, filesystem: overrides } = {}) => {
  const filesystem = filesystemFrom(overrides);
  const layout = { ...prepareLayout({ root, filesystem }), filesystem };
  return activate(layout, release);
};

/** Point current back to previous and preserve the failed target as previous. */
export const rollbackReleasePointer = ({ root, filesystem: overrides } = {}) => {
  const filesystem = filesystemFrom(overrides);
  const layout = { ...prepareLayout({ root, filesystem }), filesystem };
  return rollback(layout);
};

/** Convenience facade for deploy hosts that keep one pointer transaction. */
export const createReleasePointer = ({ root, filesystem: overrides } = {}) => {
  const options = { root, filesystem: overrides };
  return Object.freeze({
    inspect: () => inspectReleasePointers(options),
    activate: (release) => activateReleasePointer({ ...options, release }),
    rollback: () => rollbackReleasePointer(options),
  });
};

// Short aliases keep the primitive usable by hosts whose terminology is
// already "activate"/"rollback" while the explicit names document the paths.
export const activateRelease = activateReleasePointer;
export const rollbackRelease = rollbackReleasePointer;
