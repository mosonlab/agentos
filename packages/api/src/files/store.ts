export type FileStat = { path: string; kind: "file" | "dir"; size: number; modifiedAt: Date };

export interface FileStore {
  list(dir: string): Promise<FileStat[]>;
  stat(path: string): Promise<FileStat | null>;
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer): Promise<FileStat>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
}

export class InvalidPathError extends Error {}
export class SymlinkError extends InvalidPathError {}
export class NotFoundError extends Error {}
export class NotADirectoryError extends InvalidPathError {}
