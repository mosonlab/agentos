import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { filesystemKey, realpathNative } from "./alias.js";
import { createLocalFileStore } from "./local.js";
import type { FileStore } from "./store.js";

const stores = new Map<string, Promise<FileStore>>();

export const resolveFilesRoot = (): string => process.env.FILES_ROOT ?? join(homedir(), "Documents", "agentos");

export const getFileStore = (): Promise<FileStore> => {
  const root = resolve(resolveFilesRoot());
  const existing = stores.get(root);
  if (existing) return existing;
  // Evict on failure: caching the rejected promise replayed the same EACCES or realpath
  // error on every later request, so a fixed permission needed an API restart to take.
  const created = createLocalFileStore(root).catch((error: unknown) => {
    if (stores.get(root) === created) stores.delete(root);
    throw error;
  });
  stores.set(root, created);
  return created;
};

export const resetFileStores = (): void => stores.clear();

/**
 * The same key the store enforces in, resolved without creating the root, so grant
 * administration can reject alias collisions before any file operation exists.
 */
export const filesRootGrantKey = async (normalized: string): Promise<string | null> => {
  const root = resolve(resolveFilesRoot());
  const canonical = await realpathNative(root).catch(() => root);
  return filesystemKey(canonical, normalized);
};

const nearestRealPath = async (input: string): Promise<string> => {
  let candidate = resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      return join(await realpath(candidate), ...missing.reverse());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return candidate;
      missing.push(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      candidate = parent;
    }
  }
};

/**
 * LocalFileStore's containment holds against a caller who can only speak paths, not
 * against one who can write inside the Files Root: a hardlink or a post-walk directory
 * swap both need nothing more than write access there. Agents have full write access to
 * their run workspaces, so any overlap between the two roots hands them exactly that.
 * Refuse to start rather than serve a store whose stated threat model is already void.
 */
export const assertFilesRootIsolated = async (filesRoot: string, workspaceRoot: string): Promise<void> => {
  const [files, workspace] = await Promise.all([nearestRealPath(filesRoot), nearestRealPath(workspaceRoot)]);
  const overlaps = files === workspace
    || files.startsWith(`${workspace}${sep}`)
    || workspace.startsWith(`${files}${sep}`);
  if (!overlaps) return;
  throw new Error(
    `FILES_ROOT (${filesRoot}) overlaps RUNNER_WORKSPACE_ROOT (${workspaceRoot}). Agents can write anywhere in a run workspace, `
    + "so an overlap turns the Files Root into arbitrary host read/write. Point the two at disjoint directories.",
  );
};

/**
 * The threat model names OS isolation as the backstop for the post-walk swap it cannot
 * close. Nothing checked that the backstop exists, and the shipped default is the
 * configuration in which it does not.
 */
export const warnIfRunnerSharesPrincipal = (filesRoot: string): void => {
  if ((process.env.RUNNER_RUN_AS_PREFIX ?? "").trim() !== "") return;
  console.warn(
    `RUNNER_RUN_AS_PREFIX is empty, so model CLIs run as this OS user and can write ${filesRoot} directly. `
    + "LocalFileStore's post-walk-swap gap is only covered by a separate low-privilege principal; without one it is open.",
  );
};

export const warnIfICloudPath = async (root: string): Promise<void> => {
  try {
    const [canonical, mobileDocuments] = await Promise.all([
      nearestRealPath(root),
      nearestRealPath(join(homedir(), "Library", "Mobile Documents")),
    ]);
    if (canonical === mobileDocuments || canonical.startsWith(`${mobileDocuments}${sep}`)) {
      console.warn(`FILES_ROOT resolves inside iCloud Drive (${root}); dataless placeholders may make reads fail and writes may be uploaded.`);
    }
  } catch (error: unknown) {
    console.warn(`Could not inspect FILES_ROOT for iCloud placement (${root}); continuing.`, error);
  }
};
