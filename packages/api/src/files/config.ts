import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { createLocalFileStore } from "./local.js";
import type { FileStore } from "./store.js";

const stores = new Map<string, Promise<FileStore>>();

export const resolveFilesRoot = (): string => process.env.FILES_ROOT ?? join(homedir(), "Documents", "agentos");

export const getFileStore = (): Promise<FileStore> => {
  const root = resolve(resolveFilesRoot());
  const existing = stores.get(root);
  if (existing) return existing;
  const created = createLocalFileStore(root);
  stores.set(root, created);
  return created;
};

export const resetFileStores = (): void => stores.clear();

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
