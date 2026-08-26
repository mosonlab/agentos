/**
 * Does a signed attestation still describe the tree in front of it?
 *
 * This is the question a chain has to answer before it spends a merge gate:
 * moving any attested release-path file, or any migration, invalidates the
 * signature, and only the key holder can restore it. It is deliberately not an
 * authority check — the signature, the recorded SHAs, the ancestry and the
 * private evidence are checked by `verifyReleaseAuthority`, which is what the
 * migration preflight calls and what decides whether a tree may migrate. This
 * says only which attested paths moved, so the request for a new signature can
 * name them.
 *
 * It lives outside `release-authority.ts` because that file is itself attested:
 * editing it to add a diagnostic would invalidate the very attestation the
 * diagnostic reports on.
 */
import type { FileEntry, MigrationSet, ReleaseAuthority } from "./release-authority.js";

export type AttestationCoverage = { covered: true } | { covered: false; moved: string[] };

/**
 * `moved` is sorted and reads as a report: `added|edited|removed <path>` for the
 * file manifest, and one `migration set` line when the digest of the migration
 * set as a whole changed. Both directions are checked — a file the attestation
 * names and the tree no longer holds is as much a re-signature as a new one.
 */
export const attestationCoverage = (input: {
  authority: Pick<ReleaseAuthority, "files" | "migrations">;
  manifest: FileEntry[];
  migrations: MigrationSet;
}): AttestationCoverage => {
  const attested = new Map(input.authority.files.map((entry) => [entry.path, entry.sha256]));
  const present = new Map(input.manifest.map((entry) => [entry.path, entry.sha256]));
  const moved: string[] = [];
  for (const [path, sha256] of present) {
    const before = attested.get(path);
    if (before === undefined) moved.push(`added ${path}`);
    else if (before !== sha256) moved.push(`edited ${path}`);
  }
  for (const path of attested.keys()) {
    if (!present.has(path)) moved.push(`removed ${path}`);
  }
  moved.sort();
  const before = input.authority.migrations;
  const after = input.migrations;
  if (before.count !== after.count || before.terminal !== after.terminal || before.sha256 !== after.sha256) {
    moved.push(`migration set ${before.count}/${before.terminal} -> ${after.count}/${after.terminal}`);
  }
  return moved.length === 0 ? { covered: true } : { covered: false, moved };
};
