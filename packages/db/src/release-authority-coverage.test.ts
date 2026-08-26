import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { attestationCoverage } from "./release-authority-coverage.js";
import {
  parseReleaseAuthority,
  readFileManifest,
  readMigrationSet,
  RELEASE_AUTHORITY_FILE,
  type FileEntry,
  type MigrationSet,
} from "./release-authority.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/+$/u, "");

const digest = (seed: string): string => seed.repeat(64).slice(0, 64);
const entry = (path: string, seed: string): FileEntry => ({ path, sha256: digest(seed), blob: seed.repeat(40).slice(0, 40) });
const migrations: MigrationSet = { count: 2, terminal: "20260101000000_two", sha256: digest("m") };
const files = [entry("packages/db/prisma/schema.prisma", "1"), entry("release-authority.pub", "2")];

test("a tree that matches the attestation is covered", () => {
  assert.deepEqual(
    attestationCoverage({ authority: { files, migrations }, manifest: [...files], migrations }),
    { covered: true },
  );
});

test("an edited, added or removed attested file is named in both directions", () => {
  const edited = attestationCoverage({
    authority: { files, migrations },
    manifest: [entry("packages/db/prisma/schema.prisma", "9"), files[1]!],
    migrations,
  });
  assert.deepEqual(edited, { covered: false, moved: ["edited packages/db/prisma/schema.prisma"] });

  const added = attestationCoverage({
    authority: { files, migrations },
    manifest: [...files, entry("packages/db/prisma/migrations/20260102000000_three/migration.sql", "3")],
    migrations,
  });
  assert.deepEqual(added, {
    covered: false,
    moved: ["added packages/db/prisma/migrations/20260102000000_three/migration.sql"],
  });

  const removed = attestationCoverage({ authority: { files, migrations }, manifest: [files[0]!], migrations });
  assert.deepEqual(removed, { covered: false, moved: ["removed release-authority.pub"] });
});

test("a moved migration set is reported even when every attested file still matches", () => {
  const moved = attestationCoverage({
    authority: { files, migrations },
    manifest: [...files],
    migrations: { count: 3, terminal: "20260102000000_three", sha256: digest("n") },
  });
  assert.deepEqual(moved, {
    covered: false,
    moved: ["migration set 2/20260101000000_two -> 3/20260102000000_three"],
  });
});

test("this repository's tracked attestation covers this tree", () => {
  // The condition the chain checks before every gate, asserted here so a
  // re-signature that was forgotten fails by name rather than inside the
  // migration preflight's own dbtest.
  const parsed = parseReleaseAuthority(readFileSync(`${repositoryRoot}/${RELEASE_AUTHORITY_FILE}`, "utf8"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const manifest = readFileManifest(repositoryRoot);
  assert.deepEqual(manifest.unreadable, []);
  assert.deepEqual(
    attestationCoverage({
      authority: parsed.authority,
      manifest: manifest.entries,
      migrations: readMigrationSet(repositoryRoot),
    }),
    { covered: true },
  );
});
