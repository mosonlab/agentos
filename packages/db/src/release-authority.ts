/**
 * The release authority attestation: how a tree with no `docs/reviews` — and,
 * after an export, no git history either — proves the migration set it carries
 * was reviewed, and that it is the tree that was reviewed.
 *
 * The Goal 5a0 preflight requires recorded authority before a migration may
 * start, and reads it from `docs/reviews/goal-5a0-current-master-revalidation.md`.
 * The public snapshot excludes every file under `docs/reviews`, so on a public
 * tree that document is absent and the release path stops — correctly, but
 * permanently, and for a reason no operator of that tree can clear.
 *
 * `release-authority.json` is the second path, and it has to carry its own
 * trust. Three things make it more than a self-consistent JSON file:
 *
 *  1. **A signature over a canonical payload**, verified against
 *     `release-authority.pub` — a public key that is *tracked, reviewed and
 *     gated source*, not a generated file. That asymmetry is the whole point:
 *     an exported tarball's holder can write any JSON they like into it, but
 *     they cannot produce a signature that the reviewed key verifies. Without
 *     the key file, or with a signature that does not verify, the attestation
 *     is refused outright.
 *  2. **A closed file manifest that is recomputed, never trusted.** The
 *     attestation names every release-path file and every migration file, by
 *     sha256 *and* by git blob object id. The verifier recomputes both from the
 *     tree it is standing in and requires the sets to be equal — no missing
 *     entry, no extra entry, no differing digest. An attestation minted for a
 *     different tree does not verify against this one.
 *  3. **The release path is required to be committed, at the attested bytes.**
 *     The attested commit and tree ids belong to the pre-cutover assembly
 *     lineage and are covered by the signature, so they are attested rather
 *     than merely asserted; they are not looked for in this repository's
 *     history, which no longer contains them. What a checkout with history is
 *     asked instead is whether it committed the release path it is standing
 *     on, every file at the attested bytes. With no history at all — an export,
 *     a tarball — even that cannot be asked. See `AuthorityBinding`: the
 *     preflight prints which of the two answered, so the log says what was
 *     proved rather than leaving it to be assumed.
 *
 * Parsing is closed: unknown fields at any level are a refusal, not something
 * ignored. The two SHAs always come from the operator; the attestation can only
 * agree or disagree with them, never supply them.
 *
 * What it deliberately does not carry: raw git commit objects. Those contain
 * author addresses and internal review text, and this file is public snapshot
 * material.
 */
import { createHash, createPublicKey, type KeyObject, verify as verifySignature } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const RELEASE_AUTHORITY_FILE = "release-authority.json";
export const RELEASE_AUTHORITY_PUBLIC_KEY = "release-authority.pub";
export const RELEASE_AUTHORITY_VERSION = 2;
export const RELEASE_AUTHORITY_ALGORITHM = "ed25519";
export const REVALIDATION_DOCUMENT_PATH = "docs/reviews/goal-5a0-current-master-revalidation.md";
export const MIGRATIONS_PATH = "packages/db/prisma/migrations";

export const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

/**
 * The files whose exact bytes the release path's authority depends on: the
 * preflight, the modules it decides with, the schema, the trust anchor itself,
 * and — added at run time — every migration file. The list is closed on purpose.
 * A manifest that omits one of these, or names anything else, is refused.
 */
export const RELEASE_EVIDENCE_FILES = [
  "packages/db/prisma/preflight-goal-execution.ts",
  "packages/db/prisma/release-migrate.ts",
  "packages/db/prisma/schema.prisma",
  "packages/db/src/release-authority.ts",
  "packages/db/src/release-migrate.ts",
  "packages/db/src/schema-census.ts",
  RELEASE_AUTHORITY_PUBLIC_KEY,
] as const;

export interface FileEntry { path: string; sha256: string; blob: string }
export interface EvidenceEntry { path: string; sha256: string }
export interface MigrationSet { count: number; terminal: string; sha256: string }
export interface Signature { algorithm: string; publicKeySha256: string; value: string }

export interface ReleaseAuthority {
  schemaVersion: number;
  /** The private-checkout commit this attestation was minted at. */
  commit: string;
  /** That commit's root tree object id. */
  tree: string;
  masterSha: string;
  controlPlaneASha: string;
  /** The private evidence, by content: checked wherever the file is present. */
  evidence: EvidenceEntry[];
  /** Closed and exact; recomputed by the verifier, never trusted. */
  files: FileEntry[];
  migrations: MigrationSet;
  signature: Signature;
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** git's own object id for a file's content: sha1("blob <length>\0" + bytes). */
export const blobOid = (content: Buffer): string =>
  createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

export const hashFile = (absolutePath: string): string => sha256(readFileSync(absolutePath));

/** Deterministic bytes to sign: sorted keys, no insignificant whitespace. */
export const canonicalise = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalise(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** The signed payload: everything the attestation claims, minus the signature. */
export const signedPayload = (authority: ReleaseAuthority): string => {
  const { signature: _signature, ...payload } = authority;
  return canonicalise(payload);
};

const listFiles = (root: string, directory: string): string[] => {
  const absolute = join(root, directory);
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(root, relative(root, child)));
    else if (entry.isFile()) found.push(relative(root, child));
  }
  return found;
};

/** Every migration file, sorted, relative to the repository root. */
export const listMigrationFiles = (root: string): string[] => listFiles(root, MIGRATIONS_PATH);

/**
 * The migration set as one digest: every directory, every file, by name and
 * content, in a fixed order. Adding, removing, renaming or editing a migration
 * changes it.
 */
export const readMigrationSet = (root: string): MigrationSet => {
  const files = listMigrationFiles(root);
  // Only nested paths name a migration; `migration_lock.toml` sits beside them
  // and is hashed into the digest without being counted as one.
  const directories = [...new Set(
    files.map((file) => file.split("/")).filter((parts) => parts.length === 6).map((parts) => parts[4] as string),
  )].sort();
  const lines = files.map((file) => `${relative(MIGRATIONS_PATH, file)}:${sha256(readFileSync(join(root, file)))}`);
  return { count: directories.length, terminal: directories.at(-1) ?? "", sha256: sha256(lines.join("\n")) };
};

/** The paths an attestation must account for, in this tree, exactly. */
export const releaseFilePaths = (root: string): string[] =>
  [...RELEASE_EVIDENCE_FILES, ...listMigrationFiles(root)].sort();

/** Those paths, hashed from disk. Missing files are reported, not thrown. */
export const readFileManifest = (root: string): { entries: FileEntry[]; unreadable: string[] } => {
  const entries: FileEntry[] = [];
  const unreadable: string[] = [];
  for (const path of releaseFilePaths(root)) {
    try {
      const content = readFileSync(join(root, path));
      entries.push({ path, sha256: sha256(content), blob: blobOid(content) });
    } catch {
      unreadable.push(path);
    }
  }
  return { entries, unreadable };
};

// ---------------------------------------------------------------------------
// Parsing: closed, so an unknown field is a refusal rather than a silence.
// ---------------------------------------------------------------------------

type Reason = string;

const closedObject = (value: unknown, keys: readonly string[], label: string): Reason | Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `${label} must be a JSON object`;
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !keys.includes(key)).sort();
  if (unexpected.length > 0) return `${label} carries unknown field(s): ${unexpected.join(", ")}`;
  const missing = keys.filter((key) => !(key in record));
  if (missing.length > 0) return `${label} is missing field(s): ${missing.join(", ")}`;
  return record;
};

type Checked = { ok: true; value: string } | { ok: false; reason: Reason };

const hex = (record: Record<string, unknown>, key: string, pattern: RegExp, label: string): Checked => {
  const value = record[key];
  const kind = pattern === SHA256_PATTERN ? "64-hex digest" : "40-hex object id";
  if (typeof value !== "string" || !pattern.test(value)) return { ok: false, reason: `${label} must be a ${kind}` };
  return { ok: true, value };
};

export type ParseResult = { ok: true; authority: ReleaseAuthority } | { ok: false; reason: Reason };

const failed = (value: unknown): value is Reason => typeof value === "string";

export const parseReleaseAuthority = (text: string): ParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "is not valid JSON" };
  }
  const root = closedObject(parsed, [
    "schemaVersion", "commit", "tree", "masterSha", "controlPlaneASha", "evidence", "files", "migrations", "signature",
  ], "the attestation");
  if (failed(root)) return { ok: false, reason: root };

  if (root["schemaVersion"] !== RELEASE_AUTHORITY_VERSION) {
    return { ok: false, reason: `schemaVersion must be ${RELEASE_AUTHORITY_VERSION}` };
  }
  const identifiers: Record<string, string> = {};
  for (const key of ["commit", "tree", "masterSha", "controlPlaneASha"]) {
    const checked = hex(root, key, SHA1_PATTERN, key);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    identifiers[key] = checked.value;
  }

  const evidenceValue = root["evidence"];
  if (!Array.isArray(evidenceValue) || evidenceValue.length === 0) {
    return { ok: false, reason: "evidence must be a non-empty list" };
  }
  const evidence: EvidenceEntry[] = [];
  for (const item of evidenceValue) {
    const entry = closedObject(item, ["path", "sha256"], "an evidence entry");
    if (failed(entry)) return { ok: false, reason: entry };
    if (typeof entry["path"] !== "string" || entry["path"] === "") {
      return { ok: false, reason: "an evidence entry has no path" };
    }
    const digest = hex(entry, "sha256", SHA256_PATTERN, "an evidence entry's sha256");
    if (!digest.ok) return { ok: false, reason: digest.reason };
    evidence.push({ path: entry["path"], sha256: digest.value });
  }

  const filesValue = root["files"];
  if (!Array.isArray(filesValue) || filesValue.length === 0) {
    return { ok: false, reason: "files must be a non-empty list" };
  }
  const files: FileEntry[] = [];
  for (const item of filesValue) {
    const entry = closedObject(item, ["path", "sha256", "blob"], "a file entry");
    if (failed(entry)) return { ok: false, reason: entry };
    if (typeof entry["path"] !== "string" || entry["path"] === "") {
      return { ok: false, reason: "a file entry has no path" };
    }
    const digest = hex(entry, "sha256", SHA256_PATTERN, `the sha256 for ${entry["path"]}`);
    if (!digest.ok) return { ok: false, reason: digest.reason };
    const blob = hex(entry, "blob", SHA1_PATTERN, `the blob object id for ${entry["path"]}`);
    if (!blob.ok) return { ok: false, reason: blob.reason };
    files.push({ path: entry["path"], sha256: digest.value, blob: blob.value });
  }

  const migrations = closedObject(root["migrations"], ["count", "terminal", "sha256"], "migrations");
  if (failed(migrations)) return { ok: false, reason: migrations };
  const count = migrations["count"];
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
    return { ok: false, reason: "migrations.count must be a positive integer" };
  }
  if (typeof migrations["terminal"] !== "string" || migrations["terminal"] === "") {
    return { ok: false, reason: "migrations.terminal must be the last migration directory name" };
  }
  const migrationDigest = hex(migrations, "sha256", SHA256_PATTERN, "migrations.sha256");
  if (!migrationDigest.ok) return { ok: false, reason: migrationDigest.reason };

  const signature = closedObject(root["signature"], ["algorithm", "publicKeySha256", "value"], "signature");
  if (failed(signature)) return { ok: false, reason: signature };
  if (signature["algorithm"] !== RELEASE_AUTHORITY_ALGORITHM) {
    return { ok: false, reason: `signature.algorithm must be ${RELEASE_AUTHORITY_ALGORITHM}` };
  }
  const keyDigest = hex(signature, "publicKeySha256", SHA256_PATTERN, "signature.publicKeySha256");
  if (!keyDigest.ok) return { ok: false, reason: keyDigest.reason };
  const value = signature["value"];
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) {
    return { ok: false, reason: "signature.value must be base64" };
  }

  return {
    ok: true,
    authority: {
      schemaVersion: RELEASE_AUTHORITY_VERSION,
      commit: identifiers["commit"] as string,
      tree: identifiers["tree"] as string,
      masterSha: identifiers["masterSha"] as string,
      controlPlaneASha: identifiers["controlPlaneASha"] as string,
      evidence,
      files,
      migrations: { count, terminal: migrations["terminal"], sha256: migrationDigest.value },
      signature: { algorithm: RELEASE_AUTHORITY_ALGORITHM, publicKeySha256: keyDigest.value, value },
    },
  };
};

// ---------------------------------------------------------------------------
// The trust anchor.
// ---------------------------------------------------------------------------

export const publicKeyFingerprint = (key: KeyObject): string => sha256(key.export({ type: "spki", format: "der" }));

export type PublicKeyResult = { ok: true; key: KeyObject; fingerprint: string } | { ok: false; reason: Reason };

export const readPublicKey = (pem: string): PublicKeyResult => {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    return { ok: false, reason: `${RELEASE_AUTHORITY_PUBLIC_KEY} is not a readable public key` };
  }
  if (key.asymmetricKeyType !== RELEASE_AUTHORITY_ALGORITHM) {
    return { ok: false, reason: `${RELEASE_AUTHORITY_PUBLIC_KEY} is ${key.asymmetricKeyType ?? "unknown"}, not ${RELEASE_AUTHORITY_ALGORITHM}` };
  }
  return { ok: true, key, fingerprint: publicKeyFingerprint(key) };
};

// ---------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------

/** The git questions these paths ask. Injected so they can be answered offline. */
export interface GitProbe {
  commitExists(sha: string): boolean;
  isAncestor(ancestor: string, descendant: string): boolean;
  /** The blob object id `HEAD` holds at a path, or null if it holds none. */
  blobAt(path: string): string | null;
}

/**
 * Which of the two questions about object ids this checkout can be asked.
 *
 * `signature-and-content` — no history at all: an export, a tarball, a copied
 * directory. Only the signature attests the commit and tree ids.
 *
 * `signature-content-and-committed-tree` — a checkout with history, which since
 * the single-repository cutover is the only other case. The attested commit is
 * from the pre-cutover assembly lineage and is not asked about; what a checkout
 * can answer is whether it committed the release path it is standing on.
 */
export type AuthorityBinding =
  | "signature-and-content"
  | "signature-content-and-committed-tree";

export const bindingOf = (_authority: ReleaseAuthority, git: GitProbe | null): AuthorityBinding =>
  git === null ? "signature-and-content" : "signature-content-and-committed-tree";

/**
 * The first path, in one place: the private revalidation document records both
 * declared SHAs, both commits are in this checkout, control-plane A is an
 * ancestor of the recorded master, and that master is an ancestor of HEAD.
 *
 * The minting script runs exactly this before it will write an attestation, so
 * the attestation is a record of this check rather than an alternative to it.
 */
export const verifyRevalidationDocument = (input: {
  documentText: string;
  masterSha: string;
  controlPlaneASha: string;
  git: GitProbe;
}): string[] => {
  const failures: string[] = [];
  for (const [label, sha] of [["master", input.masterSha], ["control-plane-A", input.controlPlaneASha]] as const) {
    if (!input.documentText.includes(sha)) {
      failures.push(`the revalidation document does not record the ${label} SHA ${sha}`);
    }
  }
  for (const sha of [input.masterSha, input.controlPlaneASha]) {
    if (!input.git.commitExists(sha)) failures.push(`commit not present in this checkout: ${sha}`);
  }
  if (!input.git.isAncestor(input.controlPlaneASha, input.masterSha)) {
    failures.push(
      `Control-plane A ${input.controlPlaneASha} is not an ancestor of the recorded master ${input.masterSha}`,
    );
  }
  if (!input.git.isAncestor(input.masterSha, "HEAD")) {
    failures.push(`the recorded master ${input.masterSha} is not an ancestor of the current HEAD`);
  }
  return failures;
};

export interface VerifyInput {
  authority: ReleaseAuthority;
  /** What the operator declared. The attestation must agree, never replace. */
  masterSha: string;
  controlPlaneASha: string;
  /** The trust anchor, read from this tree's tracked `release-authority.pub`. */
  publicKey: PublicKeyResult | null;
  /** Recomputed from this tree: the closed file manifest and the migration set. */
  manifest: { entries: FileEntry[]; unreadable: string[] };
  migrations: MigrationSet;
  /** Present only where the private evidence file is in this checkout. */
  evidenceOnDisk: Map<string, string>;
  /** Null only where there is no history at all; see `AuthorityBinding`. */
  git: GitProbe | null;
}

const describeSet = (values: string[]): string =>
  values.length <= 3 ? values.join(", ") : `${values.slice(0, 3).join(", ")} and ${values.length - 3} more`;

/** Every reason this attestation does not authorise this tree. Empty means it does. */
export const verifyReleaseAuthority = (input: VerifyInput): string[] => {
  const { authority } = input;
  const failures: string[] = [];

  // 1. The trust anchor. Without it there is nothing to verify against, and an
  //    attestation that verifies against no key authorises nothing.
  if (input.publicKey === null) {
    failures.push(`${RELEASE_AUTHORITY_PUBLIC_KEY} is absent, so the attestation's signature cannot be checked`);
  } else if (!input.publicKey.ok) {
    failures.push(input.publicKey.reason);
  } else if (authority.signature.publicKeySha256 !== input.publicKey.fingerprint) {
    failures.push(
      `the attestation was signed for key ${authority.signature.publicKeySha256.slice(0, 16)}…,`
      + ` and this tree's ${RELEASE_AUTHORITY_PUBLIC_KEY} is ${input.publicKey.fingerprint.slice(0, 16)}…`,
    );
  } else {
    let valid = false;
    try {
      valid = verifySignature(
        null,
        Buffer.from(signedPayload(authority), "utf8"),
        input.publicKey.key,
        Buffer.from(authority.signature.value, "base64"),
      );
    } catch {
      valid = false;
    }
    if (!valid) failures.push("the attestation's signature does not verify against this tree's release-authority.pub");
  }

  // 2. The operator's declaration. The attestation agrees or disagrees; it
  //    never supplies.
  if (authority.masterSha !== input.masterSha) {
    failures.push(`the attestation records master ${authority.masterSha}, not the declared ${input.masterSha}`);
  }
  if (authority.controlPlaneASha !== input.controlPlaneASha) {
    failures.push(
      `the attestation records control-plane-A ${authority.controlPlaneASha}, not the declared ${input.controlPlaneASha}`,
    );
  }

  // 3. The file manifest, recomputed from this tree and compared as a set.
  if (input.manifest.unreadable.length > 0) {
    failures.push(`this tree is missing release-path file(s): ${describeSet(input.manifest.unreadable)}`);
  }
  const attested = new Map(authority.files.map((entry) => [entry.path, entry]));
  const actual = new Map(input.manifest.entries.map((entry) => [entry.path, entry]));
  const missing = [...actual.keys()].filter((path) => !attested.has(path)).sort();
  const extra = [...attested.keys()].filter((path) => !actual.has(path)).sort();
  if (missing.length > 0) failures.push(`the attestation does not account for: ${describeSet(missing)}`);
  if (extra.length > 0) failures.push(`the attestation names file(s) this tree does not have: ${describeSet(extra)}`);
  const changed = [...actual.entries()]
    .filter(([path, entry]) => {
      const claim = attested.get(path);
      return claim !== undefined && (claim.sha256 !== entry.sha256 || claim.blob !== entry.blob);
    })
    .map(([path]) => path)
    .sort();
  if (changed.length > 0) failures.push(`this tree's content differs from the attestation for: ${describeSet(changed)}`);

  // 4. The migration set, recomputed the same way.
  if (authority.migrations.sha256 !== input.migrations.sha256) {
    failures.push("the attestation was minted for a different migration set than this checkout holds");
  }
  if (authority.migrations.count !== input.migrations.count || authority.migrations.terminal !== input.migrations.terminal) {
    failures.push(
      `the attestation names ${authority.migrations.count} migration(s) ending ${authority.migrations.terminal},`
      + ` this checkout holds ${input.migrations.count} ending ${input.migrations.terminal}`,
    );
  }

  // 5. The private evidence, wherever this tree actually has it.
  for (const entry of authority.evidence) {
    const onDisk = input.evidenceOnDisk.get(entry.path);
    if (onDisk !== undefined && onDisk !== entry.sha256) {
      failures.push(`the attestation records a different ${entry.path} than this checkout holds`);
    }
  }

  // 6. The object ids, against the tree this checkout has actually committed.
  //
  // The attested commit belongs to the private assembly lineage this project
  // was built in. Since the single-repository cutover that lineage is not this
  // repository's history, and asking whether it is present decides nothing
  // about the tree: an operator checkout that still holds those objects would
  // be verified by a different rule than the fresh clone standing on the same
  // commit. So the attested commit and tree are attested by the signature
  // alone, and what is required here is the question every checkout can answer
  // — every release-path file is *committed here*, at `HEAD`, with the bytes
  // hashed above. A tree whose release path is loose on disk, or committed as
  // something else, does not pass on the strength of an attestation minted
  // somewhere else.
  //
  // Short term: the attestation still names the pre-cutover commit, which is
  // why the ancestry questions cannot be asked at all. It is re-signed against
  // this repository's own history in v0.1.1, and they can come back with it.
  const history = input.git;
  if (history !== null) {
    const loose = input.manifest.entries
      .filter((entry) => history.blobAt(entry.path) !== entry.blob)
      .map((entry) => entry.path)
      .sort();
    if (loose.length > 0) {
      failures.push(
        `this checkout's HEAD does not hold the attested bytes for: ${describeSet(loose)}`
        + " — a checkout must commit the release path it stands on,"
        + " and an exported tree must not sit inside an unrelated checkout",
      );
    }
  }

  return failures;
};
