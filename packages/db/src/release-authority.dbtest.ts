/**
 * The second authority path, end to end: a real repository is built, a real
 * attestation is minted into it by the real minting script, a real snapshot is
 * taken of it — no `.git`, no `docs/reviews` — and the real preflight is run
 * against a real PostgreSQL on both sides of every boundary.
 *
 * Nothing here stubs the parts that matter. The signing key is generated per
 * fixture, the mint refuses or succeeds on its own terms, and the preflight is
 * the same file `npm run db:migrate-goal-execution` runs.
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @agentos/db
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign as signPayload } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  parseReleaseAuthority,
  publicKeyFingerprint,
  readFileManifest,
  readMigrationSet,
  RELEASE_AUTHORITY_ALGORITHM,
  RELEASE_AUTHORITY_FILE,
  RELEASE_AUTHORITY_PUBLIC_KEY,
  RELEASE_EVIDENCE_FILES,
  type ReleaseAuthority,
  REVALIDATION_DOCUMENT_PATH,
  signedPayload,
} from "./release-authority.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/+$/u, "");

const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchServer();
const token = randomBytes(4).toString("hex");
const schemas: string[] = [];
const directories: string[] = [];

const scratchSchema = (name: string): string => {
  const schema = `authority_${name}_${token}`;
  schemas.push(schema);
  return schema;
};

const urlFor = (schema: string): string => {
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return url.href;
};

const temporary = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

const write = (root: string, path: string, contents: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents, "utf8");
};

// ---------------------------------------------------------------------------
// A repository shaped like this one, small enough to build per test.
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  masterSha: string;
  controlPlaneASha: string;
  head: string;
  keyPath: string;
  git: (...args: string[]) => string;
}

const gitIn = (root: string) => (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      // Identity without an address: this repository is scanned for the public
      // snapshot, and a fixture has no reason to put a mail-shaped string in
      // tracked source. Git does not require one.
      GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture",
      GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture",
    },
  }).trim();

/**
 * A private-style checkout: this repository's release-path files and migration
 * set, its own history, its own signing key, and a revalidation document
 * recording two of its own commits as the recorded master and control-plane A.
 */
const fixtureRepository = (): Fixture => {
  const root = temporary("release-authority-repo-");
  symlinkSync(`${repositoryRoot}/node_modules`, join(root, "node_modules"), "dir");
  write(root, "package.json", `${JSON.stringify({ name: "fixture-tree", private: true }, null, 2)}\n`);
  write(root, ".gitignore", `node_modules/\n${RELEASE_AUTHORITY_FILE}\n`);
  const git = gitIn(root);
  git("init", "--quiet", "--initial-branch=main");

  write(root, "docs/reviews/placeholder.md", "seed\n");
  git("add", "--all");
  git("commit", "--quiet", "--message", "control plane A");
  const controlPlaneASha = git("rev-parse", "HEAD");

  mkdirSync(join(root, "packages/db/prisma"), { recursive: true });
  mkdirSync(join(root, "packages/db/src"), { recursive: true });
  for (const path of RELEASE_EVIDENCE_FILES) {
    if (path === RELEASE_AUTHORITY_PUBLIC_KEY) continue;
    cpSync(join(repositoryRoot, path), join(root, path));
  }
  cpSync(`${packageRoot}/prisma/migrations`, join(root, "packages/db/prisma/migrations"), { recursive: true });
  cpSync(`${packageRoot}/prisma/write-release-authority.ts`, join(root, "packages/db/prisma/write-release-authority.ts"));
  cpSync(`${packageRoot}/src/local-release-target.ts`, join(root, "packages/db/src/local-release-target.ts"));
  git("add", "--all");
  git("commit", "--quiet", "--message", "recorded master");
  const masterSha = git("rev-parse", "HEAD");

  // The signing key: generated here, its public half committed like any other
  // reviewed file, its private half outside the tree.
  const { privateKey, publicKey } = generateKeyPairSync(RELEASE_AUTHORITY_ALGORITHM);
  const keyPath = join(temporary("release-authority-key-"), "signing.pem");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
  write(root, RELEASE_AUTHORITY_PUBLIC_KEY, publicKey.export({ type: "spki", format: "pem" }) as string);
  write(root, REVALIDATION_DOCUMENT_PATH,
    `# fixture revalidation\n\nmaster ${masterSha}\ncontrol-plane A ${controlPlaneASha}\n`);
  git("add", "--all");
  git("commit", "--quiet", "--message", "trust anchor and revalidation evidence");

  return { root, masterSha, controlPlaneASha, head: git("rev-parse", "HEAD"), keyPath, git };
};

/** What an export is: the same files, no history, no `docs/reviews`. */
const snapshotOf = (fixture: Fixture): string => {
  const root = temporary("release-authority-snapshot-");
  cpSync(fixture.root, root, {
    recursive: true,
    dereference: false,
    filter: (source) => !source.includes("/.git") && !source.includes("/docs/reviews"),
  });
  rmSync(join(root, "node_modules"), { force: true, recursive: false });
  symlinkSync(`${repositoryRoot}/node_modules`, join(root, "node_modules"), "dir");
  assert.equal(existsSync(join(root, ".git")), false, "an export carries no history");
  assert.equal(existsSync(join(root, REVALIDATION_DOCUMENT_PATH)), false, "an export carries no docs/reviews");
  return root;
};

/**
 * What a published snapshot actually is: that export, committed into a fresh
 * repository. It has history — every clone of it does — but none of the private
 * commits, so the attestation's ancestry cannot be asked there at all.
 */
const publishedRepositoryOf = (fixture: Fixture): { root: string; git: (...args: string[]) => string } => {
  const root = snapshotOf(fixture);
  const git = gitIn(root);
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  // `.gitignore` ships with the export and names the attestation, so publishing
  // it takes a force-add. Skip this and the minted attestation never reaches the
  // public repository, whose readers then stop at `authority` — the exact
  // failure this path exists to clear.
  git("add", "--force", RELEASE_AUTHORITY_FILE);
  git("commit", "--quiet", "--message", "public snapshot");
  assert.equal(git("ls-files", RELEASE_AUTHORITY_FILE), RELEASE_AUTHORITY_FILE, "the attestation must be published");
  assert.notEqual(git("rev-parse", "HEAD"), fixture.head, "a published snapshot is its own lineage");
  assert.equal(
    spawnSync("git", ["cat-file", "-e", `${fixture.head}^{commit}`], { cwd: root }).status === 0,
    false,
    "the attested commit must be absent here, or this is not the case under test",
  );
  return { root, git };
};

interface Outcome { status: number | null; output: string }

const mint = (fixture: Fixture, extra: Record<string, string> = {}): Outcome => {
  const result = spawnSync("npx", ["tsx", "prisma/write-release-authority.ts"], {
    cwd: join(fixture.root, "packages/db"),
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_AUTHORITY_KEY: fixture.keyPath,
      GOAL5A0_MASTER_SHA: fixture.masterSha,
      GOAL5A0_CONTROL_PLANE_A_SHA: fixture.controlPlaneASha,
      ...extra,
    },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const runPreflight = (root: string, fixture: Fixture, schema: string, extra: Record<string, string> = {}): Outcome => {
  const result = spawnSync("npx", ["tsx", "prisma/preflight-goal-execution.ts"], {
    cwd: join(root, "packages/db"),
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: urlFor(schema),
      GOAL5A0_MASTER_SHA: fixture.masterSha,
      GOAL5A0_CONTROL_PLANE_A_SHA: fixture.controlPlaneASha,
      ...extra,
    },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const migrateDeploy = (schema: string): Outcome => {
  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: urlFor(schema) },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const readAuthority = (root: string): ReleaseAuthority => {
  const parsed = parseReleaseAuthority(readFileSync(join(root, RELEASE_AUTHORITY_FILE), "utf8"));
  assert.equal(parsed.ok, true, "the minted attestation must parse");
  return (parsed as { ok: true; authority: ReleaseAuthority }).authority;
};

/** Re-sign a tampered attestation with the fixture's own key, so the case under
 *  test is the tampering and not a signature that trivially fails. */
const reseal = (root: string, keyPath: string, authority: ReleaseAuthority): void => {
  const unsigned = { ...authority, signature: { ...authority.signature, value: "" } };
  const value = signPayload(null, Buffer.from(signedPayload(unsigned), "utf8"),
    { key: readFileSync(keyPath, "utf8") }).toString("base64");
  write(root, RELEASE_AUTHORITY_FILE, `${JSON.stringify({ ...authority, signature: { ...authority.signature, value } }, null, 2)}\n`);
};

let admin: PrismaClient;
const sql = async (statement: string): Promise<void> => { await admin.$executeRawUnsafe(statement); };
const quoted = (schema: string): string => `"${schema.replaceAll('"', '""')}"`;

before(async () => {
  admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  await admin.$connect();
});

after(async () => {
  for (const schema of schemas) await sql(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`);
  await admin.$disconnect();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("minting an attestation", () => {
  it("writes one from a clean checkout, and the preflight accepts it there", async () => {
    const fixture = fixtureRepository();
    const minted = mint(fixture);
    assert.equal(minted.status, 0, minted.output);
    assert.match(minted.output, new RegExp(`release-authority commit=${fixture.head}`, "u"));

    const authority = readAuthority(fixture.root);
    assert.equal(authority.commit, fixture.head);
    assert.equal(authority.tree, fixture.git("rev-parse", "HEAD^{tree}"));
    assert.equal(authority.files.length, readFileManifest(fixture.root).entries.length);
    assert.deepEqual(authority.migrations, readMigrationSet(fixture.root));

    const schema = scratchSchema("mint_private");
    await sql(`CREATE SCHEMA ${quoted(schema)}`);
    const outcome = runPreflight(fixture.root, fixture, schema, { GOAL5A0_FRESH_TARGET: schema });
    assert.equal(outcome.status, 0, outcome.output);
    assert.match(outcome.output, /preflight authority=revalidation-document\+attestation binding=signature-content-and-history/u);
  });

  it("refuses an untracked migration, which HEAD does not contain", () => {
    const fixture = fixtureRepository();
    write(fixture.root, "packages/db/prisma/migrations/99999999999999_untracked/migration.sql", "SELECT 1;\n");
    const minted = mint(fixture);
    assert.notEqual(minted.status, 0, minted.output);
    assert.match(minted.output, /the worktree does not match HEAD/u);
    assert.equal(existsSync(join(fixture.root, RELEASE_AUTHORITY_FILE)), false, "nothing may be written");
  });

  it("refuses a migration that is present but ignored, which git status would not show", () => {
    const fixture = fixtureRepository();
    write(fixture.root, ".gitignore", `node_modules/\n${RELEASE_AUTHORITY_FILE}\n99999999999999_ignored_migration/\n`);
    fixture.git("add", "--all");
    fixture.git("commit", "--quiet", "--message", "ignore a migration name");
    write(fixture.root, "packages/db/prisma/migrations/99999999999999_ignored_migration/migration.sql", "SELECT 1;\n");
    assert.equal(fixture.git("status", "--porcelain=v1", "--untracked-files=all"), "", "git must consider this clean");

    const minted = mint(fixture);
    assert.notEqual(minted.status, 0, minted.output);
    assert.match(minted.output, /are not in HEAD with the bytes on disk/u);
  });

  it("refuses a tracked release-path file that was edited after HEAD", () => {
    const fixture = fixtureRepository();
    write(fixture.root, "packages/db/src/schema-census.ts", "// edited\n");
    const minted = mint(fixture);
    assert.notEqual(minted.status, 0, minted.output);
    assert.match(minted.output, /the worktree does not match HEAD/u);
  });

  it("refuses a key that is not the private half of the tracked public key", () => {
    const fixture = fixtureRepository();
    const other = join(temporary("release-authority-otherkey-"), "other.pem");
    writeFileSync(other, generateKeyPairSync(RELEASE_AUTHORITY_ALGORITHM).privateKey
      .export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    const minted = mint(fixture, { RELEASE_AUTHORITY_KEY: other });
    assert.notEqual(minted.status, 0, minted.output);
    assert.match(minted.output, /not the private half of the tracked release-authority.pub/u);
  });

  it("refuses with no key at all, and refuses when the trust anchor is absent", () => {
    const fixture = fixtureRepository();
    const keyless = mint(fixture, { RELEASE_AUTHORITY_KEY: "" });
    assert.notEqual(keyless.status, 0, keyless.output);
    assert.match(keyless.output, /RELEASE_AUTHORITY_KEY must name the operator's signing key/u);

    rmSync(join(fixture.root, RELEASE_AUTHORITY_PUBLIC_KEY));
    fixture.git("add", "--all");
    fixture.git("commit", "--quiet", "--message", "remove the trust anchor");
    const anchorless = mint(fixture);
    assert.notEqual(anchorless.status, 0, anchorless.output);
    assert.match(anchorless.output, /release-authority.pub is absent/u);
  });

  it("refuses when the revalidation document does not record the declared SHAs", () => {
    const fixture = fixtureRepository();
    const minted = mint(fixture, { GOAL5A0_MASTER_SHA: "a".repeat(40) });
    assert.notEqual(minted.status, 0, minted.output);
    assert.match(minted.output, /does not record the master SHA/u);
  });
});

describe("an exported snapshot: no history, no docs/reviews", () => {
  it("admits a declared, confirmed first run on the strength of the attestation alone", async () => {
    const fixture = fixtureRepository();
    assert.equal(mint(fixture).status, 0);
    const snapshot = snapshotOf(fixture);
    const schema = scratchSchema("snapshot_first_run");
    await sql(`CREATE SCHEMA ${quoted(schema)}`);

    const outcome = runPreflight(snapshot, fixture, schema, { GOAL5A0_FRESH_TARGET: schema });
    assert.equal(outcome.status, 0, outcome.output);
    assert.match(outcome.output, /preflight authority=attestation binding=signature-and-content/u);
    assert.match(outcome.output, /preflight mode=first-run target=confirmed-empty/u);
    assert.match(outcome.output, /preflight PASS/u);
  });

  it("still runs every lineage condition on an existing database", async () => {
    const fixture = fixtureRepository();
    assert.equal(mint(fixture).status, 0);
    const snapshot = snapshotOf(fixture);
    const schema = scratchSchema("snapshot_existing");
    await sql(`CREATE SCHEMA ${quoted(schema)}`);
    assert.equal(migrateDeploy(schema).status, 0);

    const clean = runPreflight(snapshot, fixture, schema);
    assert.equal(clean.status, 0, clean.output);
    assert.match(clean.output, /preflight mode=existing/u);

    // Authority by attestation is authority to *check*, not to pass. The
    // constraint exists to stop this data being written, so the disposable
    // fixture drops the one that would — which is the case the condition
    // backstops.
    const s = quoted(schema);
    await sql(`ALTER TABLE ${s}."Run" DROP CONSTRAINT IF EXISTS "Run_goal_lineage_all_or_none_check"`);
    for (const statement of [
      `INSERT INTO ${s}."Project"(id,name,slug,"updatedAt") VALUES ('p1','P','p1',now())`,
      `INSERT INTO ${s}."Environment"(id,"projectId",name,"updatedAt") VALUES ('e1','p1','E',now())`,
      `INSERT INTO ${s}."Agent"(id,"projectId","environmentId",name,title,model,"foundationalPrompt","rolePrompt","updatedAt")
         VALUES ('a1','p1','e1','A','T','m','f','r',now())`,
      `INSERT INTO ${s}."Goal"(id,"projectId",title,spec,"updatedAt") VALUES ('g1','p1','G1','S',now()),('g2','p1','G2','S',now())`,
      `INSERT INTO ${s}."Task"(id,"projectId",name,description,"updatedAt") VALUES ('t1','p1','T1','D',now())`,
      `INSERT INTO ${s}."Run"(id,"projectId","taskId","goalId","agentId","runNumber","dedupeKey",runner,model,"promptHash",status,"updatedAt")
         VALUES ('r1','p1','t1','g1','a1',1,'d1','claude','m','h','succeeded',now()),
                ('r2','p1','t1','g2','a1',2,'d2','claude','m','h','succeeded',now())`,
    ]) await sql(statement);

    const stopped = runPreflight(snapshot, fixture, schema);
    assert.notEqual(stopped.status, 0, stopped.output);
    assert.match(stopped.output, /STOP preflight ambiguous-goal/u);
  });
});

describe("an exported snapshot the attestation does not authorise", () => {
  let fixture: Fixture;
  let snapshot: string;
  let schema: string;

  before(async () => {
    fixture = fixtureRepository();
    assert.equal(mint(fixture).status, 0);
    snapshot = snapshotOf(fixture);
    schema = scratchSchema("snapshot_refusals");
    await sql(`CREATE SCHEMA ${quoted(schema)}`);
  });

  const refuses = (expected: RegExp): void => {
    const outcome = runPreflight(snapshot, fixture, schema, { GOAL5A0_FRESH_TARGET: schema });
    assert.notEqual(outcome.status, 0, outcome.output);
    assert.match(outcome.output, /STOP preflight authority:/u);
    assert.match(outcome.output, expected);
    assert.doesNotMatch(outcome.output, /preflight PASS/u);
  };

  it("refuses when there is no evidence of either kind", () => {
    rmSync(join(snapshot, RELEASE_AUTHORITY_FILE));
    refuses(/no authority evidence in this checkout/u);
    assert.equal(mint(fixture).status, 0);
    cpSync(join(fixture.root, RELEASE_AUTHORITY_FILE), join(snapshot, RELEASE_AUTHORITY_FILE));
  });

  it("refuses an unsigned or resigned-by-a-stranger attestation", () => {
    const authority = readAuthority(snapshot);
    const stranger = join(temporary("release-authority-stranger-"), "stranger.pem");
    writeFileSync(stranger, generateKeyPairSync(RELEASE_AUTHORITY_ALGORITHM).privateKey
      .export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    reseal(snapshot, stranger, authority);
    refuses(/signature does not verify against this tree's release-authority.pub/u);
  });

  it("refuses when the trust anchor this tree carries is a different key", () => {
    const authority = readAuthority(fixture.root);
    write(snapshot, RELEASE_AUTHORITY_FILE, `${JSON.stringify(authority, null, 2)}\n`);
    write(snapshot, RELEASE_AUTHORITY_PUBLIC_KEY, generateKeyPairSync(RELEASE_AUTHORITY_ALGORITHM).publicKey
      .export({ type: "spki", format: "pem" }) as string);
    refuses(/was signed for key [0-9a-f]{16}…, and this tree's release-authority.pub is/u);
    cpSync(join(fixture.root, RELEASE_AUTHORITY_PUBLIC_KEY), join(snapshot, RELEASE_AUTHORITY_PUBLIC_KEY));
  });

  it("refuses when the trust anchor is missing entirely", () => {
    rmSync(join(snapshot, RELEASE_AUTHORITY_PUBLIC_KEY));
    refuses(/release-authority.pub is absent, so the attestation's signature cannot be checked/u);
    cpSync(join(fixture.root, RELEASE_AUTHORITY_PUBLIC_KEY), join(snapshot, RELEASE_AUTHORITY_PUBLIC_KEY));
  });

  it("refuses a forged but syntactically valid commit id, resigned by a stranger's key", () => {
    // The review's exact case: any 40-hex object id, self-consistent JSON. The
    // signature is what refuses it — there is no key that both this tree trusts
    // and a forger holds.
    const authority = readAuthority(fixture.root);
    const stranger = join(temporary("release-authority-forge-"), "forge.pem");
    writeFileSync(stranger, generateKeyPairSync(RELEASE_AUTHORITY_ALGORITHM).privateKey
      .export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    reseal(snapshot, stranger, { ...authority, commit: "0".repeat(40), tree: "1".repeat(40) });
    refuses(/signature does not verify/u);
  });

  it("refuses a forged evidence path or digest, even resigned by the real key", () => {
    // Re-signed with the fixture's own key, so what refuses it is the manifest
    // comparison rather than the signature. This is the case the review said
    // the evidence list did not participate in.
    const authority = readAuthority(fixture.root);
    reseal(snapshot, fixture.keyPath, {
      ...authority,
      files: authority.files.map((entry, index) =>
        index === 0 ? { ...entry, sha256: "a".repeat(64) } : entry),
    });
    refuses(/this tree's content differs from the attestation for/u);
  });

  it("refuses an attestation that does not account for every release-path file", () => {
    const authority = readAuthority(fixture.root);
    reseal(snapshot, fixture.keyPath, { ...authority, files: authority.files.slice(1) });
    refuses(/the attestation does not account for/u);
  });

  it("refuses an attestation naming a file this tree does not have", () => {
    const authority = readAuthority(fixture.root);
    reseal(snapshot, fixture.keyPath, {
      ...authority,
      files: [...authority.files, { path: "invented/file.ts", sha256: "b".repeat(64), blob: "c".repeat(40) }],
    });
    refuses(/names file\(s\) this tree does not have/u);
  });

  it("refuses once a release-path file in the tree is edited after minting", () => {
    write(snapshot, "packages/db/src/schema-census.ts", `${readFileSync(join(snapshot, "packages/db/src/schema-census.ts"), "utf8")}\n// edited\n`);
    refuses(/this tree's content differs from the attestation for: packages\/db\/src\/schema-census.ts/u);
    cpSync(join(fixture.root, "packages/db/src/schema-census.ts"), join(snapshot, "packages/db/src/schema-census.ts"));
  });

  it("refuses once a migration file in the tree is edited after minting", () => {
    const terminal = readMigrationSet(snapshot).terminal;
    write(snapshot, `packages/db/prisma/migrations/${terminal}/migration.sql`, "-- edited\nSELECT 1;\n");
    refuses(/different migration set/u);
    cpSync(join(fixture.root, `packages/db/prisma/migrations/${terminal}/migration.sql`),
      join(snapshot, `packages/db/prisma/migrations/${terminal}/migration.sql`));
  });

  it("refuses SHAs the operator did not declare", () => {
    const authority = readAuthority(fixture.root);
    reseal(snapshot, fixture.keyPath, { ...authority, masterSha: "d".repeat(40) });
    refuses(/records master d{40}, not the declared/u);
  });

  it("refuses unknown fields, malformed JSON, and the wrong schema version", () => {
    const authority = readAuthority(fixture.root);
    for (const [contents, expected] of [
      [JSON.stringify({ ...authority, unexpected: "no" }, null, 2), /carries unknown field\(s\): unexpected/u],
      [JSON.stringify({ ...authority, schemaVersion: 99 }, null, 2), /schemaVersion must be 2/u],
      [JSON.stringify({ ...authority, files: authority.files.map((entry) => ({ ...entry, extra: 1 })) }, null, 2),
        /a file entry carries unknown field\(s\): extra/u],
      [JSON.stringify({ ...authority, evidence: authority.evidence.map((entry) => ({ ...entry, extra: 1 })) }, null, 2),
        /an evidence entry carries unknown field\(s\): extra/u],
      [JSON.stringify({ ...authority, signature: { ...authority.signature, extra: 1 } }, null, 2),
        /signature carries unknown field\(s\): extra/u],
      ["{ not json", /is not valid JSON/u],
      ["[]", /the attestation must be a JSON object/u],
    ] as Array<[string, RegExp]>) {
      write(snapshot, RELEASE_AUTHORITY_FILE, `${contents}\n`);
      refuses(expected);
    }
  });
});

describe("a published snapshot: the export committed into a fresh repository", () => {
  it("admits a declared first run, on the binding this lineage can actually prove", async () => {
    const fixture = fixtureRepository();
    assert.equal(mint(fixture).status, 0);
    const published = publishedRepositoryOf(fixture);
    const schema = scratchSchema("published_first_run");
    await sql(`CREATE SCHEMA ${quoted(schema)}`);

    const outcome = runPreflight(published.root, fixture, schema, { GOAL5A0_FRESH_TARGET: schema });
    assert.equal(outcome.status, 0, outcome.output);
    assert.match(outcome.output, /preflight authority=attestation binding=signature-content-and-published-tree/u);
    assert.match(outcome.output, /preflight mode=first-run target=confirmed-empty/u);
    assert.match(outcome.output, /preflight PASS/u);
    // Asking a lineage whether it holds a commit it is expected not to hold is
    // a normal question with a normal answer. A passing install must not print
    // git's `fatal:` twice on its way to saying PASS.
    assert.doesNotMatch(outcome.output, /fatal:/u);
  });

  it("refuses a release-path file this repository does not have committed", async () => {
    const fixture = fixtureRepository();
    assert.equal(mint(fixture).status, 0);
    const published = publishedRepositoryOf(fixture);
    // The bytes on disk are still the attested ones, so every content check
    // passes. What fails is that this repository is not standing on them.
    published.git("rm", "--cached", "--quiet", "packages/db/src/schema-census.ts");
    published.git("commit", "--quiet", "--message", "drop a release-path file from the tree");
    const schema = scratchSchema("published_uncommitted");
    await sql(`CREATE SCHEMA ${quoted(schema)}`);

    const outcome = runPreflight(published.root, fixture, schema, { GOAL5A0_FRESH_TARGET: schema });
    assert.notEqual(outcome.status, 0, outcome.output);
    assert.match(outcome.output, /STOP preflight authority:/u);
    assert.match(outcome.output, /HEAD does not hold the attested bytes for: packages\/db\/src\/schema-census.ts/u);
    assert.doesNotMatch(outcome.output, /preflight PASS/u);
  });

  it("refuses every tampering an export refuses, in the same lineage", async () => {
    const fixture = fixtureRepository();
    assert.equal(mint(fixture).status, 0);
    const published = publishedRepositoryOf(fixture);
    const schema = scratchSchema("published_refusals");
    await sql(`CREATE SCHEMA ${quoted(schema)}`);
    const refuses = (expected: RegExp): void => {
      const outcome = runPreflight(published.root, fixture, schema, { GOAL5A0_FRESH_TARGET: schema });
      assert.notEqual(outcome.status, 0, outcome.output);
      assert.match(outcome.output, /STOP preflight authority:/u);
      assert.match(outcome.output, expected);
      assert.doesNotMatch(outcome.output, /preflight PASS/u);
    };

    // Committed here, so this repository's own HEAD agrees with its worktree —
    // and it still refuses, because the attestation does not.
    write(published.root, "packages/db/src/schema-census.ts", "// edited\n");
    published.git("add", "--all");
    published.git("commit", "--quiet", "--message", "edit a release-path file");
    refuses(/content differs from the attestation for: packages\/db\/src\/schema-census.ts/u);
    cpSync(join(fixture.root, "packages/db/src/schema-census.ts"), join(published.root, "packages/db/src/schema-census.ts"));
    published.git("add", "--all");
    published.git("commit", "--quiet", "--message", "restore");

    const stranger = join(temporary("release-authority-published-stranger-"), "stranger.pem");
    writeFileSync(stranger, generateKeyPairSync(RELEASE_AUTHORITY_ALGORITHM).privateKey
      .export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    reseal(published.root, stranger, readAuthority(published.root));
    refuses(/signature does not verify against this tree's release-authority.pub/u);

    reseal(published.root, fixture.keyPath, { ...readAuthority(fixture.root), masterSha: "d".repeat(40) });
    refuses(/records master d{40}, not the declared/u);

    rmSync(join(published.root, RELEASE_AUTHORITY_FILE));
    refuses(/no authority evidence in this checkout/u);
  });
});

describe("the private evidence digest, where the file is present", () => {
  it("refuses an attestation recording a different revalidation document", async () => {
    const fixture = fixtureRepository();
    assert.equal(mint(fixture).status, 0);
    const authority = readAuthority(fixture.root);
    reseal(fixture.root, fixture.keyPath, {
      ...authority,
      evidence: [{ path: REVALIDATION_DOCUMENT_PATH, sha256: "e".repeat(64) }],
    });
    const schema = scratchSchema("evidence_digest");
    await sql(`CREATE SCHEMA ${quoted(schema)}`);

    const outcome = runPreflight(fixture.root, fixture, schema, { GOAL5A0_FRESH_TARGET: schema });
    assert.notEqual(outcome.status, 0, outcome.output);
    assert.match(outcome.output, /records a different docs\/reviews\/goal-5a0-current-master-revalidation.md/u);
  });
});

describe("the attestation and the tree it was minted from", () => {
  it("is tracked in this repository, which is both where it is minted and where it is released from", () => {
    // It was ignored while a separate private repository was the development
    // one and this was only ever an export target. Since the single-repository
    // cutover there is one tree, so the attestation is reviewed and gated like
    // the key that verifies it, and is re-signed when the migration set moves.
    const tracked = execFileSync("git", ["ls-files", RELEASE_AUTHORITY_FILE], { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(tracked.trim(), RELEASE_AUTHORITY_FILE, `${RELEASE_AUTHORITY_FILE} must be a tracked file`);
  });

  it("names the public key as a release-path file, so the anchor is bound too", () => {
    assert.ok(RELEASE_EVIDENCE_FILES.includes(RELEASE_AUTHORITY_PUBLIC_KEY));
    assert.equal(publicKeyFingerprint(generateKeyPairSync(RELEASE_AUTHORITY_ALGORITHM).publicKey).length, 64);
  });

  it("is tracked in this repository, as the anchor the attestation is verified against", () => {
    // The anchor goes through review and the merge gate. The attestation is
    // generated, and only worth something because this key is not.
    const tracked = execFileSync("git", ["ls-files", RELEASE_AUTHORITY_PUBLIC_KEY], { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(tracked.trim(), RELEASE_AUTHORITY_PUBLIC_KEY, `${RELEASE_AUTHORITY_PUBLIC_KEY} must be a tracked file`);
  });
});
