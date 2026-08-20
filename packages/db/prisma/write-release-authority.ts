/**
 * `npm run snapshot:authority` — mint `release-authority.json`.
 *
 * The public snapshot excludes every file under `docs/reviews`, so the evidence
 * the Goal 5a0 preflight reads is not on a public tree. This script writes the
 * attestation that stands in for it, and it writes one only when the private
 * evidence is present here and already passes: same document, same two SHAs,
 * same ancestry, checked by the same function the preflight calls.
 *
 *   RELEASE_AUTHORITY_KEY=~/.agentos-keys/release-authority.ed25519 \
 *   GOAL5A0_MASTER_SHA=... GOAL5A0_CONTROL_PLANE_A_SHA=... npm run snapshot:authority
 *
 * The signing key is the operator's and lives outside the repository; its
 * public half is the tracked, reviewed `release-authority.pub`. Minting refuses
 * unless the two halves match, so an attestation can only ever be produced by
 * whoever holds the key this repository has committed to trusting.
 *
 * It refuses on any tree that is not exactly HEAD — including untracked files.
 * The attestation names an exact commit and hashes the files at it; a file that
 * is on disk but not in that commit would be attested to a commit that does not
 * contain it.
 */
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, type KeyObject, sign as signPayload } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type GitProbe,
  hashFile,
  parseReleaseAuthority,
  publicKeyFingerprint,
  readFileManifest,
  readMigrationSet,
  readPublicKey,
  RELEASE_AUTHORITY_ALGORITHM,
  RELEASE_AUTHORITY_FILE,
  RELEASE_AUTHORITY_PUBLIC_KEY,
  RELEASE_AUTHORITY_VERSION,
  type ReleaseAuthority,
  REVALIDATION_DOCUMENT_PATH,
  SHA1_PATTERN,
  signedPayload,
  verifyReleaseAuthority,
  verifyRevalidationDocument,
} from "../src/release-authority.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/+$/u, "");

// `stderr: "pipe"`: a "no" from git is data here, not something to print. The
// mint reports its own refusals, in its own words, as `STOP release-authority`.
const git = (...args: string[]): { ok: boolean; out: string } => {
  try {
    return {
      ok: true,
      out: execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    };
  } catch {
    return { ok: false, out: "" };
  }
};
const gitProbe: GitProbe = {
  commitExists: (sha) => git("cat-file", "-e", `${sha}^{commit}`).ok,
  isAncestor: (ancestor, descendant) => git("merge-base", "--is-ancestor", ancestor, descendant).ok,
  treeOf: (sha) => { const result = git("rev-parse", `${sha}^{tree}`); return result.ok ? result.out : null; },
  blobAt: (path) => { const result = git("rev-parse", `HEAD:${path}`); return result.ok ? result.out : null; },
};

const stop = (detail: string): never => {
  console.error(`STOP release-authority ${detail}`);
  process.exit(1);
};

const stopAll = (details: string[]): never => {
  for (const detail of details) console.error(`STOP release-authority ${detail}`);
  process.exit(1);
};

const signingKey = (): KeyObject => {
  const path = process.env["RELEASE_AUTHORITY_KEY"];
  if (!path) {
    stop("RELEASE_AUTHORITY_KEY must name the operator's signing key; run `npm run snapshot:authority-keygen` to create one");
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(path as string, "utf8"));
  } catch {
    stop(`RELEASE_AUTHORITY_KEY does not name a readable private key: ${path}`);
  }
  if (key!.asymmetricKeyType !== RELEASE_AUTHORITY_ALGORITHM) {
    stop(`the signing key is ${key!.asymmetricKeyType ?? "unknown"}, not ${RELEASE_AUTHORITY_ALGORITHM}`);
  }
  return key!;
};

const main = (): void => {
  const masterSha = process.env["GOAL5A0_MASTER_SHA"] ?? process.argv[2];
  const controlPlaneASha = process.env["GOAL5A0_CONTROL_PLANE_A_SHA"] ?? process.argv[3];
  if (!masterSha || !SHA1_PATTERN.test(masterSha)) {
    stop("GOAL5A0_MASTER_SHA (or argv[1]) must be a recorded 40-hex commit");
  }
  if (!controlPlaneASha || !SHA1_PATTERN.test(controlPlaneASha)) {
    stop("GOAL5A0_CONTROL_PLANE_A_SHA (or argv[2]) must be a recorded 40-hex commit");
  }

  // Untracked files included: `readFileManifest` reads the disk, and a file on
  // disk that is not in HEAD cannot honestly be attested to HEAD. The output
  // file itself is `.gitignore`d, so re-minting is not a dirty tree.
  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  if (!status.ok) stop("this is not a git checkout, so there is no commit to attest to");
  if (status.out !== "") {
    stopAll([
      "the worktree does not match HEAD; commit or remove before minting:",
      ...status.out.split("\n").slice(0, 10).map((line) => `  ${line}`),
    ]);
  }

  const key = signingKey();
  const anchorPath = join(repositoryRoot, RELEASE_AUTHORITY_PUBLIC_KEY);
  if (!existsSync(anchorPath)) {
    stop(`${RELEASE_AUTHORITY_PUBLIC_KEY} is absent; the operator must commit the public half of the signing key first`);
  }
  const anchor = readPublicKey(readFileSync(anchorPath, "utf8"));
  if (!anchor.ok) stop(anchor.reason);
  const minted = publicKeyFingerprint(createPublicKey(key));
  if (!anchor.ok || minted !== anchor.fingerprint) {
    stop(`RELEASE_AUTHORITY_KEY is not the private half of the tracked ${RELEASE_AUTHORITY_PUBLIC_KEY}`);
  }

  const documentPath = join(repositoryRoot, REVALIDATION_DOCUMENT_PATH);
  if (!existsSync(documentPath)) {
    stop(`the private evidence is absent: ${REVALIDATION_DOCUMENT_PATH}. Mint only from a private checkout.`);
  }
  const documentFailures = verifyRevalidationDocument({
    documentText: readFileSync(documentPath, "utf8"),
    masterSha: masterSha!,
    controlPlaneASha: controlPlaneASha!,
    git: gitProbe,
  });
  if (documentFailures.length > 0) stopAll(documentFailures);

  const head = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  if (!head.ok || !SHA1_PATTERN.test(head.out)) stop("HEAD does not resolve to a commit");
  if (!tree.ok || !SHA1_PATTERN.test(tree.out)) stop("HEAD does not resolve to a tree");

  const manifest = readFileManifest(repositoryRoot);
  if (manifest.unreadable.length > 0) {
    stopAll(["this checkout is missing release-path file(s):", ...manifest.unreadable.map((path) => `  ${path}`)]);
  }
  // Every attested file must be *in* the attested commit, with the bytes this
  // mint hashed. `git status` alone would miss a file that is ignored rather
  // than untracked, and the manifest reads the disk either way. This is also
  // exactly what a published snapshot's own repository is asked for later, so
  // an attestation that gets past here is one that tree can satisfy.
  const notInCommit = manifest.entries.filter((entry) => gitProbe.blobAt(entry.path) !== entry.blob);
  if (notInCommit.length > 0) {
    stopAll([
      `these file(s) are not in HEAD with the bytes on disk, so they cannot be attested to ${head.out}:`,
      ...notInCommit.map((entry) => `  ${entry.path}`),
    ]);
  }

  const migrations = readMigrationSet(repositoryRoot);
  const unsigned = {
    schemaVersion: RELEASE_AUTHORITY_VERSION,
    commit: head.out,
    tree: tree.out,
    masterSha: masterSha!,
    controlPlaneASha: controlPlaneASha!,
    evidence: [{ path: REVALIDATION_DOCUMENT_PATH, sha256: hashFile(documentPath) }],
    files: manifest.entries,
    migrations,
  };
  const authority: ReleaseAuthority = {
    ...unsigned,
    signature: {
      algorithm: RELEASE_AUTHORITY_ALGORITHM,
      publicKeySha256: minted,
      value: signPayload(null, Buffer.from(signedPayload({ ...unsigned, signature: {
        algorithm: RELEASE_AUTHORITY_ALGORITHM, publicKeySha256: minted, value: "",
      } }), "utf8"), key).toString("base64"),
    },
  };

  // Read back through the same parser and verifier the preflight uses: what is
  // written here is only useful if that code accepts it.
  const written = `${JSON.stringify(authority, null, 2)}\n`;
  const parsed = parseReleaseAuthority(written);
  if (!parsed.ok) stop(`refusing to write an attestation this repository's own parser rejects: ${parsed.reason}`);
  const rejected = verifyReleaseAuthority({
    authority: (parsed as { ok: true; authority: ReleaseAuthority }).authority,
    masterSha: masterSha!,
    controlPlaneASha: controlPlaneASha!,
    publicKey: anchor,
    manifest,
    migrations,
    evidenceOnDisk: new Map([[REVALIDATION_DOCUMENT_PATH, hashFile(documentPath)]]),
    git: gitProbe,
  });
  if (rejected.length > 0) {
    stopAll(["refusing to write an attestation this repository's own verifier rejects:", ...rejected.map((r) => `  ${r}`)]);
  }

  writeFileSync(join(repositoryRoot, RELEASE_AUTHORITY_FILE), written, "utf8");
  console.log(`release-authority wrote ${RELEASE_AUTHORITY_FILE}`);
  console.log(`release-authority commit=${authority.commit} tree=${authority.tree}`);
  console.log(`release-authority files=${authority.files.length} key=${minted.slice(0, 16)}`);
  console.log(`release-authority migrations count=${migrations.count} terminal=${migrations.terminal}`);
  console.log(`release-authority migrations sha256=${migrations.sha256}`);
};

main();
