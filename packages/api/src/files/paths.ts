import { posix } from "node:path";

import { InvalidPathError } from "./store.js";

// HTTP decoding happens exactly once at the route boundary. Paths below are never decoded.
export const normalizeRelPath = (input: string): string => {
  if (input.length > 4096) throw new InvalidPathError("Path exceeds 4096 characters");
  if (input.includes("\0")) throw new InvalidPathError("Path contains NUL");
  // A backslash is an ordinary character in a POSIX filename, and FILES_ROOT defaults to
  // a human-managed folder where such names occur. Rejecting it made list() hand out
  // paths every other store method then refused: the file was listed and then unreadable,
  // unstattable and undeletable through the API. Containment does not rest on this --
  // resolveContained walks segments and asserts the resolved target is inside the root --
  // and the drive-letter guard below still covers the Windows shapes.
  if (/^[A-Za-z]:/u.test(input)) throw new InvalidPathError("Windows drive paths are not allowed");
  if (input.startsWith("/")) throw new InvalidPathError("Absolute paths are not allowed");

  let normalized = posix.normalize(input);
  if (normalized === ".") normalized = "";
  if (normalized.endsWith("/") && normalized !== "") normalized = normalized.slice(0, -1);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new InvalidPathError("Path escapes the Files Root");
  }
  return normalized;
};

export const isCanonicalRelPath = (input: string): boolean => {
  if (input === "") return false;
  try {
    return normalizeRelPath(input) === input;
  } catch {
    return false;
  }
};

export const contains = (prefix: string, path: string): boolean =>
  prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
