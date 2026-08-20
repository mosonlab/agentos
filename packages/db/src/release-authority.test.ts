/**
 * The attestation's format and verdict rules, without a database.
 *
 * `release-authority.dbtest.ts` proves the preflight behaves this way end to
 * end, against a real minted attestation and a real export; these cases pin the
 * rules themselves, including the ones a real tree makes awkward to construct.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, sign as signPayload } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  bindingOf,
  blobOid,
  canonicalise,
  type FileEntry,
  type GitProbe,
  parseReleaseAuthority,
  publicKeyFingerprint,
  type PublicKeyResult,
  readFileManifest,
  readMigrationSet,
  readPublicKey,
  RELEASE_AUTHORITY_ALGORITHM,
  RELEASE_AUTHORITY_FILE,
  RELEASE_AUTHORITY_PUBLIC_KEY,
  RELEASE_AUTHORITY_VERSION,
  RELEASE_EVIDENCE_FILES,
  type ReleaseAuthority,
  releaseFilePaths,
  REVALIDATION_DOCUMENT_PATH,
  signedPayload,
  verifyReleaseAuthority,
  verifyRevalidationDocument,
} from "./release-authority.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/+$/u, "");

const MASTER = "485fb118db96e3977006a2edc866a38b751ff0e2";
const CONTROL_PLANE_A = "c671439831b075568420b92f4494227fa7fc392b";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TREE = "89abcdef0123456789abcdef0123456789abcdef";

const keyPair = generateKeyPairSync(RELEASE_AUTHORITY_ALGORITHM);
const anchor: PublicKeyResult = readPublicKey(keyPair.publicKey.export({ type: "spki", format: "pem" }) as string);
const fingerprint = publicKeyFingerprint(keyPair.publicKey);

const migrations = { count: 19, terminal: "20260818210000_terminal", sha256: "b".repeat(64) };
const files: FileEntry[] = [
  { path: "a.ts", sha256: "1".repeat(64), blob: "a".repeat(40) },
  { path: "b.ts", sha256: "2".repeat(64), blob: "e".repeat(40) },
];
const manifest = { entries: files, unreadable: [] as string[] };
/** What a repository that committed this release path answers for it. */
const committed = (path: string): string | null => files.find((entry) => entry.path === path)?.blob ?? null;

/** A real signature over the payload, so only the case under test can fail. */
const sealed = (overrides: Partial<ReleaseAuthority> = {}): ReleaseAuthority => {
  const unsigned: ReleaseAuthority = {
    schemaVersion: RELEASE_AUTHORITY_VERSION,
    commit: COMMIT,
    tree: TREE,
    masterSha: MASTER,
    controlPlaneASha: CONTROL_PLANE_A,
    evidence: [{ path: REVALIDATION_DOCUMENT_PATH, sha256: "c".repeat(64) }],
    files,
    migrations,
    signature: { algorithm: RELEASE_AUTHORITY_ALGORITHM, publicKeySha256: fingerprint, value: "" },
    ...overrides,
  };
  const value = signPayload(null, Buffer.from(signedPayload(unsigned), "utf8"), keyPair.privateKey).toString("base64");
  return { ...unsigned, signature: { ...unsigned.signature, value } };
};

const verify = (overrides: Partial<Parameters<typeof verifyReleaseAuthority>[0]> = {}): string[] =>
  verifyReleaseAuthority({
    authority: sealed(),
    masterSha: MASTER,
    controlPlaneASha: CONTROL_PLANE_A,
    publicKey: anchor,
    manifest,
    migrations,
    evidenceOnDisk: new Map(),
    git: null,
    ...overrides,
  });

describe("parsing an attestation", () => {
  it("accepts a complete one", () => {
    const parsed = parseReleaseAuthority(JSON.stringify(sealed()));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.authority.commit, COMMIT);
  });

  it("is closed: an unknown field at any level is a refusal, not a silence", () => {
    const authority = sealed();
    const cases: Array<[string, string]> = [
      [JSON.stringify({ ...authority, unexpected: 1 }), "the attestation carries unknown field(s): unexpected"],
      [JSON.stringify({ ...authority, files: [{ ...files[0], extra: 1 }] }), "a file entry carries unknown field(s): extra"],
      [JSON.stringify({ ...authority, evidence: [{ path: "x", sha256: "c".repeat(64), extra: 1 }] }),
        "an evidence entry carries unknown field(s): extra"],
      [JSON.stringify({ ...authority, migrations: { ...migrations, extra: 1 } }), "migrations carries unknown field(s): extra"],
      [JSON.stringify({ ...authority, signature: { ...authority.signature, extra: 1 } }),
        "signature carries unknown field(s): extra"],
    ];
    for (const [text, reason] of cases) {
      const parsed = parseReleaseAuthority(text);
      assert.equal(parsed.ok, false, `expected a refusal mentioning ${reason}`);
      if (!parsed.ok) assert.equal(parsed.reason, reason);
    }
  });

  it("rejects every incomplete or malformed shape", () => {
    const authority = sealed();
    const without = (key: keyof ReleaseAuthority): string => {
      const { [key]: _removed, ...rest } = authority;
      return JSON.stringify(rest);
    };
    const cases: Array<[string, string]> = [
      ["{", "is not valid JSON"],
      ["[]", "the attestation must be a JSON object"],
      ["null", "the attestation must be a JSON object"],
      [without("tree"), "is missing field(s): tree"],
      [without("signature"), "is missing field(s): signature"],
      [JSON.stringify({ ...authority, schemaVersion: 1 }), "schemaVersion must be 2"],
      [JSON.stringify({ ...authority, commit: COMMIT.toUpperCase() }), "commit must be a 40-hex object id"],
      [JSON.stringify({ ...authority, masterSha: "485fb11" }), "masterSha must be a 40-hex object id"],
      [JSON.stringify({ ...authority, evidence: [] }), "evidence must be a non-empty list"],
      [JSON.stringify({ ...authority, files: [] }), "files must be a non-empty list"],
      [JSON.stringify({ ...authority, files: [{ path: "a.ts", sha256: "1".repeat(64), blob: "short" }] }),
        "the blob object id for a.ts must be a 40-hex object id"],
      [JSON.stringify({ ...authority, migrations: { ...migrations, count: 0 } }), "migrations.count must be a positive integer"],
      [JSON.stringify({ ...authority, signature: { ...authority.signature, algorithm: "rsa" } }),
        "signature.algorithm must be ed25519"],
      [JSON.stringify({ ...authority, signature: { ...authority.signature, value: "not base64!" } }),
        "signature.value must be base64"],
    ];
    for (const [text, reason] of cases) {
      const parsed = parseReleaseAuthority(text);
      assert.equal(parsed.ok, false, `expected a refusal for ${text.slice(0, 50)}`);
      if (!parsed.ok) assert.ok(parsed.reason.includes(reason), `${parsed.reason} should mention ${reason}`);
    }
  });
});

describe("the trust anchor", () => {
  it("refuses to verify at all when the tree carries no public key", () => {
    const failures = verify({ publicKey: null });
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /release-authority.pub is absent/u);
  });

  it("refuses a key of the wrong kind, and unreadable key material", () => {
    const unreadable = readPublicKey("not a key");
    assert.equal(unreadable.ok, false);
    if (!unreadable.ok) assert.match(unreadable.reason, /is not a readable public key/u);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const result = readPublicKey(rsa.publicKey.export({ type: "spki", format: "pem" }) as string);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /is rsa, not ed25519/u);
  });

  it("refuses an attestation signed for a different key than this tree carries", () => {
    const stranger = generateKeyPairSync(RELEASE_AUTHORITY_ALGORITHM);
    const strangerAnchor = readPublicKey(stranger.publicKey.export({ type: "spki", format: "pem" }) as string);
    const failures = verify({ publicKey: strangerAnchor });
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /was signed for key [0-9a-f]{16}…/u);
  });

  it("refuses a signature that does not verify, including one over a tampered payload", () => {
    const tampered = { ...sealed(), commit: "f".repeat(40) };
    const failures = verify({ authority: tampered });
    assert.match(failures[0] ?? "", /signature does not verify/u);

    const garbage = { ...sealed(), signature: { ...sealed().signature, value: Buffer.from("nope").toString("base64") } };
    assert.match(verify({ authority: garbage })[0] ?? "", /signature does not verify/u);
  });

  it("signs a payload that does not include the signature itself", () => {
    const authority = sealed();
    assert.equal(signedPayload(authority).includes(authority.signature.value), false);
    assert.equal(canonicalise({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  });
});

describe("verifying an attestation against a tree", () => {
  it("accepts one that agrees with the declaration, the files, and the migration set", () => {
    assert.deepEqual(verify(), []);
  });

  it("refuses to supply SHAs the operator did not declare", () => {
    assert.match(verify({ masterSha: "d".repeat(40) })[0] ?? "", /records master/u);
    assert.match(verify({ controlPlaneASha: "e".repeat(40) })[0] ?? "", /records control-plane-A/u);
  });

  it("compares the file manifest as a set, in both directions", () => {
    const extra = [...files, { path: "c.ts", sha256: "3".repeat(64), blob: "b".repeat(40) }];
    assert.match(verify({ authority: sealed({ files: extra }) })[0] ?? "", /names file\(s\) this tree does not have: c.ts/u);
    assert.match(
      verify({ authority: sealed({ files: [files[0] as FileEntry] }) })[0] ?? "",
      /does not account for: b.ts/u,
    );
  });

  it("refuses a digest or blob id that differs from what this tree holds", () => {
    const changedDigest = [{ ...(files[0] as FileEntry), sha256: "9".repeat(64) }, files[1] as FileEntry];
    assert.match(verify({ authority: sealed({ files: changedDigest }) })[0] ?? "", /content differs from the attestation for: a.ts/u);
    const changedBlob = [{ ...(files[0] as FileEntry), blob: "9".repeat(40) }, files[1] as FileEntry];
    assert.match(verify({ authority: sealed({ files: changedBlob }) })[0] ?? "", /content differs from the attestation for: a.ts/u);
  });

  it("reports a tree that is missing a release-path file at all", () => {
    const failures = verify({ manifest: { entries: files, unreadable: ["packages/db/src/schema-census.ts"] } });
    assert.match(failures[0] ?? "", /missing release-path file\(s\): packages\/db\/src\/schema-census.ts/u);
  });

  it("refuses a migration set it was not minted for", () => {
    const failures = verify({ migrations: { ...migrations, sha256: "f".repeat(64) } });
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /different migration set/u);
  });

  it("checks the private evidence digest wherever the file is on disk", () => {
    assert.deepEqual(verify({ evidenceOnDisk: new Map([[REVALIDATION_DOCUMENT_PATH, "c".repeat(64)]]) }), []);
    const failures = verify({ evidenceOnDisk: new Map([[REVALIDATION_DOCUMENT_PATH, "0".repeat(64)]]) });
    assert.match(failures[0] ?? "", /records a different docs\/reviews/u);
  });

  it("checks the commit and tree object ids wherever there is history", () => {
    const git: GitProbe = { commitExists: () => true, isAncestor: () => true, treeOf: () => TREE, blobAt: committed };
    assert.deepEqual(verify({ git }), []);
    assert.match(
      verify({ git: { ...git, treeOf: () => "9".repeat(40) } })[0] ?? "",
      /does not have the attested tree/u,
    );
    assert.match(verify({ git: { ...git, isAncestor: () => false } }).join("\n"), /is not an ancestor of the current HEAD/u);
    assert.match(
      verify({ git: { ...git, isAncestor: (ancestor) => ancestor !== MASTER } }).join("\n"),
      /the recorded master .* is not an ancestor of the attested commit/u,
    );
  });

  it("asks a different lineage the question it can answer: is this release path committed here", () => {
    // A published snapshot is the export committed into a fresh repository. It
    // has history, but none of the attested commits — so the ancestry questions
    // are unanswerable there and the committed-tree question replaces them.
    const published: GitProbe = {
      commitExists: () => false,
      isAncestor: () => false,
      treeOf: () => null,
      blobAt: committed,
    };
    assert.deepEqual(verify({ git: published }), []);

    // Loose on disk rather than committed, committed as something else, or one
    // file of the two. Each names exactly the files this checkout cannot show.
    const cases: Array<[GitProbe["blobAt"], RegExp]> = [
      [() => null, /attested bytes for: a\.ts, b\.ts/u],
      [() => "f".repeat(40), /attested bytes for: a\.ts, b\.ts/u],
      [(path) => (path === "a.ts" ? null : committed(path)), /attested bytes for: a\.ts —/u],
    ];
    for (const [blobAt, expected] of cases) {
      assert.match(verify({ git: { ...published, blobAt } }).join("\n"), expected);
    }
  });

  it("does not let a different lineage skip anything the minting lineage is asked", () => {
    // The substitution is only of the ancestry questions. Everything else —
    // signature, declaration, manifest, migration set — refuses the same way in
    // a lineage that has none of the attested commits.
    const published: GitProbe = { commitExists: () => false, isAncestor: () => false, treeOf: () => null, blobAt: committed };
    assert.match(verify({ git: published, publicKey: null }).join("\n"), /cannot be checked/u);
    assert.match(verify({ git: published, masterSha: "9".repeat(40) }).join("\n"), /not the declared/u);
    assert.match(
      verify({ git: published, migrations: { ...migrations, sha256: "9".repeat(64) } }).join("\n"),
      /minted for a different migration set/u,
    );
    assert.match(
      verify({ git: published, manifest: { entries: files.slice(1), unreadable: ["b.ts"] } }).join("\n"),
      /missing release-path file/u,
    );
  });

  it("names which of the three object-id bindings a checkout can carry", () => {
    const git: GitProbe = { commitExists: () => true, isAncestor: () => true, treeOf: () => TREE, blobAt: committed };
    assert.equal(bindingOf(sealed(), null), "signature-and-content");
    assert.equal(bindingOf(sealed(), git), "signature-content-and-history");
    assert.equal(bindingOf(sealed(), { ...git, commitExists: () => false }), "signature-content-and-published-tree");
  });
});

describe("verifying the private revalidation document", () => {
  const git: GitProbe = { commitExists: () => true, isAncestor: () => true, treeOf: () => TREE, blobAt: committed };
  const document = `master ${MASTER} and control-plane A ${CONTROL_PLANE_A}`;

  it("accepts the document that records both declared SHAs", () => {
    assert.deepEqual(
      verifyRevalidationDocument({ documentText: document, masterSha: MASTER, controlPlaneASha: CONTROL_PLANE_A, git }),
      [],
    );
  });

  it("refuses a document that does not record what was declared", () => {
    const failures = verifyRevalidationDocument({
      documentText: `master ${MASTER}`, masterSha: MASTER, controlPlaneASha: CONTROL_PLANE_A, git,
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /does not record the control-plane-A SHA/u);
  });

  it("refuses commits this checkout does not have, and ancestry it cannot show", () => {
    const absent = verifyRevalidationDocument({
      documentText: document, masterSha: MASTER, controlPlaneASha: CONTROL_PLANE_A,
      git: { ...git, commitExists: () => false },
    });
    assert.equal(absent.length, 2);
    assert.match(absent[0] ?? "", /commit not present in this checkout/u);

    const unrelated = verifyRevalidationDocument({
      documentText: document, masterSha: MASTER, controlPlaneASha: CONTROL_PLANE_A,
      git: { ...git, isAncestor: () => false },
    });
    assert.equal(unrelated.length, 2);
    assert.match(unrelated[1] ?? "", /is not an ancestor of the current HEAD/u);
  });
});

describe("what this repository hashes", () => {
  it("computes git's own blob object id", () => {
    // `git hash-object` on an empty file, and on "hello\n" — the well-known
    // values, so a rewrite of this function cannot quietly change meaning.
    assert.equal(blobOid(Buffer.alloc(0)), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    assert.equal(blobOid(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("covers every release-path file and every migration file, and nothing else", () => {
    const paths = releaseFilePaths(repositoryRoot);
    for (const file of RELEASE_EVIDENCE_FILES) assert.ok(paths.includes(file), `${file} must be attested`);
    const migrationFiles = paths.filter((path) => path.startsWith("packages/db/prisma/migrations/"));
    assert.ok(migrationFiles.length >= readMigrationSet(repositoryRoot).count);
    assert.equal(paths.length, RELEASE_EVIDENCE_FILES.length + migrationFiles.length);
    assert.deepEqual(paths, [...paths].sort());
  });

  it("reads what this tree actually holds, and names what it cannot", () => {
    const { entries, unreadable } = readFileManifest(repositoryRoot);
    // Every release-path file, the trust anchor included: this tree is
    // provisioned, so nothing on the list is missing from it.
    assert.deepEqual(unreadable, []);
    assert.equal(entries.length, releaseFilePaths(repositoryRoot).length);
    for (const entry of entries) {
      assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
      assert.match(entry.blob, /^[0-9a-f]{40}$/u);
    }
  });

  it("describes this repository's migrations", () => {
    const set = readMigrationSet(repositoryRoot);
    assert.ok(set.count > 0);
    assert.match(set.sha256, /^[0-9a-f]{64}$/u);
    assert.match(set.terminal, /^\d{14}_/u);
  });
});

describe("the preflight's two paths", () => {
  const source = readFileSync(`${packageRoot}/prisma/preflight-goal-execution.ts`, "utf8");

  it("refuses when neither kind of evidence is present", () => {
    assert.match(source, /if \(!documentPresent && !attestationPresent\) \{/u);
    assert.match(source, /no authority evidence in this checkout/u);
  });

  it("checks the revalidation document whenever it is present, attestation or not", () => {
    // Not `else if`: a tree carrying both must satisfy both, so an attestation
    // can never be the reason the document went unchecked.
    assert.match(source, /if \(documentPresent\) \{\n\s+for \(const detail of verifyRevalidationDocument\(\{/u);
    assert.match(source, /if \(attestationPresent\) checkAttestation\(/u);
  });

  it("uses the same document verifier the minting script runs", () => {
    const minting = readFileSync(`${packageRoot}/prisma/write-release-authority.ts`, "utf8");
    for (const file of [source, minting]) assert.ok(file.includes("verifyRevalidationDocument("));
  });

  it("recomputes the manifest and the migration digest from this tree", () => {
    assert.match(source, /readFileManifest\(repositoryRoot\)/u);
    assert.match(source, /readMigrationSet\(repositoryRoot\)/u);
  });
});

describe("the snapshot manifest", () => {
  const manifestText = readFileSync(`${repositoryRoot}/public-snapshot.json`, "utf8");
  const snapshot = JSON.parse(manifestText) as {
    include: Array<{ glob: string }>; mintedArtifacts: string[];
  };

  it("carries the attestation and its trust anchor", () => {
    for (const glob of [RELEASE_AUTHORITY_FILE, RELEASE_AUTHORITY_PUBLIC_KEY]) {
      assert.ok(snapshot.include.some((rule) => rule.glob === glob), `${glob} must be included in the public snapshot`);
    }
  });

  it("declares the attestation as a minted input, so the scan actually reads it", () => {
    // An include glob alone would only say the file *may* be published. The
    // artifact is gitignored, so without this the scanner would never open it.
    assert.deepEqual(snapshot.mintedArtifacts, [RELEASE_AUTHORITY_FILE]);
  });
});

describe("the trust anchor this repository ships", () => {
  const pem = readFileSync(`${repositoryRoot}/${RELEASE_AUTHORITY_PUBLIC_KEY}`, "utf8");

  it("is a readable Ed25519 public key at the fingerprint this release records", () => {
    const anchorOnDisk = readPublicKey(pem);
    assert.equal(anchorOnDisk.ok, true, `${RELEASE_AUTHORITY_PUBLIC_KEY} must be a readable public key`);
    assert.equal((anchorOnDisk as { ok: true; key: KeyObject }).key.asymmetricKeyType, RELEASE_AUTHORITY_ALGORITHM);
    // Pinned, so replacing the anchor is a visible edit to this file rather than
    // a quiet swap of the key every published snapshot is verified against.
    assert.equal(
      (anchorOnDisk as { ok: true; fingerprint: string }).fingerprint,
      "632a7cd307d0090855ebd79e92ae1e64a65d3cd3e66b53e2dffe3ac5aa39d3f5",
    );
  });

  it("carries the public half only", () => {
    assert.equal(pem.includes("PRIVATE KEY"), false, "the private half must never be tracked");
    assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/u);
  });

  it("is itself a release-path file, so an attestation binds the key it was checked against", () => {
    assert.ok(RELEASE_EVIDENCE_FILES.includes(RELEASE_AUTHORITY_PUBLIC_KEY));
    assert.ok(releaseFilePaths(repositoryRoot).includes(RELEASE_AUTHORITY_PUBLIC_KEY));
  });
});
