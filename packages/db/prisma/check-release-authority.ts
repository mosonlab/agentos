/**
 * `npm run db:authority-check` — does the tracked attestation still cover this
 * tree?
 *
 * The signature over `release-authority.json` binds every release-path file and
 * the whole migration set. A branch that adds a migration, or edits any of the
 * files `RELEASE_EVIDENCE_FILES` names, therefore invalidates it: the migration
 * preflight refuses that tree, and the merge gate fails on the preflight's own
 * dbtest. Nothing in a chain can repair that, because the signing key is the
 * operator's and never enters a run.
 *
 * So the chain asks this question before it spends a gate on the answer. The
 * comparison itself is `attestationCoverage`; this script is the tree-reading
 * and exit-code shell around it.
 *
 * Exit codes are the contract:
 *   0  the attestation covers this tree
 *   1  a re-signature is required; the moved paths are printed
 *   2  the question could not be answered here
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { attestationCoverage } from "../src/release-authority-coverage.js";
import {
  parseReleaseAuthority,
  readFileManifest,
  readMigrationSet,
  RELEASE_AUTHORITY_FILE,
} from "../src/release-authority.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/+$/u, "");

const unanswerable = (detail: string): never => {
  console.error(`STOP release-authority-check ${detail}`);
  process.exit(2);
};

const main = (): void => {
  const attestationPath = join(repositoryRoot, RELEASE_AUTHORITY_FILE);
  if (!existsSync(attestationPath)) {
    unanswerable(`${RELEASE_AUTHORITY_FILE} is absent from this checkout`);
  }
  const parsed = parseReleaseAuthority(readFileSync(attestationPath, "utf8"));
  if (!parsed.ok) {
    unanswerable(`${RELEASE_AUTHORITY_FILE} ${parsed.reason}`);
    return;
  }
  const { authority } = parsed;

  let manifest;
  let migrations;
  try {
    manifest = readFileManifest(repositoryRoot);
    migrations = readMigrationSet(repositoryRoot);
  } catch {
    unanswerable("this tree has no migration set to hash");
    return;
  }
  if (manifest.unreadable.length > 0) {
    unanswerable(`this checkout is missing release-path file(s): ${manifest.unreadable.join(", ")}`);
    return;
  }

  const coverage = attestationCoverage({ authority, manifest: manifest.entries, migrations });
  if (coverage.covered) {
    console.log(`release-authority-check ok commit=${authority.commit} files=${authority.files.length} migrations=${migrations.count}/${migrations.terminal}`);
    return;
  }

  console.error(`RESIGN release-authority ${RELEASE_AUTHORITY_FILE} does not cover this tree`);
  for (const detail of coverage.moved) console.error(`RESIGN release-authority   ${detail}`);
  process.exit(1);
};

main();
