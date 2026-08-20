import { realpath as realpathCallback } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

/** fs/promises has no realpath.native; only the callback form exposes it. */
export const realpathNative = promisify(realpathCallback.native) as (path: string) => Promise<string>;

/**
 * Grants are byte strings; filesystems are not. On APFS -- the supported platform, which
 * is case-insensitive and normalization-insensitive by default -- `protected` and
 * `Protected`, or an NFC and an NFD spelling of `café`, name one physical directory. A
 * grant model that compares spellings therefore lets a single subtree carry several
 * grants whose capabilities merge invisibly: the console renders the rows identically.
 *
 * This key is the filesystem's own answer rather than a guess about the volume.
 * realpath.native returns the on-disk spelling (a lowercase query yields `Protected`; an
 * NFD query yields the NFC name), and on a case-sensitive volume it reports the two
 * spellings as the two different paths they really are, with no per-platform branch here.
 *
 * Two deliberate constraints. Components that do not exist yet carry no filesystem
 * opinion, so they are kept verbatim. And the key is always rebuilt as a root-relative
 * path with anything resolving outside the root returning null: this must not decay into
 * comparing a caller-supplied absolute path against the root as a string, which is the
 * containment bug class the store does not currently have.
 */
export const filesystemKey = async (canonicalRoot: string, normalized: string): Promise<string | null> => {
  const missing: string[] = [];
  let candidate = normalized === "" ? canonicalRoot : join(canonicalRoot, normalized);
  while (true) {
    let real: string;
    try {
      real = await realpathNative(candidate);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      missing.push(basename(candidate));
      candidate = parent;
      continue;
    }
    const resolved = missing.length === 0 ? real : join(real, ...missing.reverse());
    if (resolved === canonicalRoot) return "";
    if (!resolved.startsWith(`${canonicalRoot}${sep}`)) return null;
    return relative(canonicalRoot, resolved).split(sep).join("/");
  }
};
