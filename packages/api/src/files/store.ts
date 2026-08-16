export type FileStat = { path: string; kind: "file" | "dir"; size: number; modifiedAt: Date };
export type DirEntry = { path: string; kind: "file" | "dir" | "symlink" };

export interface FileStore {
  list(dir: string): Promise<FileStat[]>;
  /**
   * Every child of `dir`, including the symlinks `list` hides. Recursive delete needs the
   * hidden ones: enumerating with `list` empties a directory of everything it can see and
   * then fails on rmdir, destroying real files and leaving the tree undeletable.
   */
  entries(dir: string): Promise<DirEntry[]>;
  /**
   * The filesystem's own spelling of an already-normalized path, root-relative, or null
   * when it is not addressable inside the root. Grant enforcement compares in this key so
   * a grant and a request cannot name one physical subtree with two different spellings.
   */
  grantKey(normalized: string): Promise<string | null>;
  stat(path: string): Promise<FileStat | null>;
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer): Promise<FileStat>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
}

export class InvalidPathError extends Error {}
export class SymlinkError extends InvalidPathError {}
/** A regular file whose inode is also reachable from outside the Files Root. */
export class HardLinkError extends InvalidPathError {}
export class NotFoundError extends Error {}
export class NotADirectoryError extends InvalidPathError {}
