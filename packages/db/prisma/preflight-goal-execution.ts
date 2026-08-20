/**
 * Goal 5a0 migration preflight — fail closed before any schema or data mutation.
 *
 * Spec §12.1 and plan Step 3.1. This is the *first* of three independent guards
 * on the same ambiguity: this script refuses to let the migration start, the
 * backfill's own WHERE clause refuses to touch an ambiguous row, and the
 * deferred `Run_goal_lineage_all_or_none_check` validation aborts the migration
 * if one survived anyway. Only the first is the contract; the other two are
 * backstops.
 *
 * It prints IDs and counts and nothing else: no prompt, output, token, or secret
 * ever reaches its stdout.
 *
 *   DATABASE_URL=... GOAL5A0_MASTER_SHA=... GOAL5A0_CONTROL_PLANE_A_SHA=... \
 *     npm run db:preflight-goal-execution
 *
 * A first run has no Goal lineage to be ambiguous about, because it has no
 * tables at all. Set `GOAL5A0_FRESH_TARGET` to the schema `DATABASE_URL` names
 * to declare that, and this script confirms the schema really is empty before
 * it treats the data conditions as vacuous. Both halves are required: the
 * declaration alone proves nothing, and an empty schema nobody declared is more
 * likely a wrong target than a fresh install. Every other condition — authority,
 * pgcrypto, the explicit schema — runs exactly as it does on an existing
 * database.
 *
 * Exit 0 means, and only means, that the conditions checked here are all
 * negative. It grants no authority to migrate a production database; that is a
 * separate, human decision recorded in the runbook.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  bindingOf,
  type GitProbe,
  hashFile,
  parseReleaseAuthority,
  readFileManifest,
  readMigrationSet,
  readPublicKey,
  RELEASE_AUTHORITY_FILE,
  RELEASE_AUTHORITY_PUBLIC_KEY,
  REVALIDATION_DOCUMENT_PATH,
  verifyReleaseAuthority,
  verifyRevalidationDocument,
} from "../src/release-authority.js";
import {
  censusFromRow,
  type CensusRow,
  censusObjectCount,
  describeCensus,
  SCHEMA_CENSUS_SQL,
  type SchemaCensus,
  schemaIsEmpty,
} from "../src/schema-census.js";

// Resolved from this file, not from the working directory: the npm script runs
// with the workspace as its cwd, so a repository-relative path would never find
// the evidence and the authority check would stop for the wrong reason.
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const REVALIDATION_DOCUMENT = join(repositoryRoot, REVALIDATION_DOCUMENT_PATH);
// The second path, for trees the revalidation document cannot reach: the public
// snapshot excludes all of `docs/reviews`. See `src/release-authority.ts`.
const AUTHORITY_ATTESTATION = join(repositoryRoot, RELEASE_AUTHORITY_FILE);
// The trust anchor: tracked, reviewed and gated source, unlike the attestation
// it verifies. That asymmetry is what the second path rests on.
const AUTHORITY_PUBLIC_KEY = join(repositoryRoot, RELEASE_AUTHORITY_PUBLIC_KEY);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

interface Failure { condition: string; detail: string }

const failures: Failure[] = [];
/** Which evidence answered for this run — printed, so the log says which. */
let authorityPath = "none";
let attestationBinding = "";
const fail = (condition: string, detail: string): void => { failures.push({ condition, detail }); };
const count = (rows: Array<{ count: bigint }>): number => Number(rows[0]?.count ?? 0n);
/** IDs only, capped, so a large corrupt set never turns the report into a dump. */
const ids = (rows: Array<{ id: string }>): string => rows.slice(0, 20).map((row) => row.id).join(",");

const argument = (name: string, index: number): string | undefined =>
  process.env[name] ?? process.argv[2 + index];

// `stderr: "pipe"` rather than the default inherit: several of these are
// questions whose "no" is a normal answer — a published snapshot is *expected*
// not to hold the attested commit — and git says no by printing `fatal:`. That
// belongs in this function's return value, not in the operator's log above a
// line that says PASS.
const git = (...args: string[]): { ok: boolean; out: string } => {
  try {
    return {
      ok: true,
      out: execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    };
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) };
  }
};

const gitProbe: GitProbe = {
  commitExists: (sha) => git("cat-file", "-e", `${sha}^{commit}`).ok,
  isAncestor: (ancestor, descendant) => git("merge-base", "--is-ancestor", ancestor, descendant).ok,
  blobAt: (path) => { const result = git("rev-parse", `HEAD:${path}`); return result.ok ? result.out : null; },
};

/** A checkout with history, or null — an exported tree has none. */
const historyProbe = (): GitProbe | null => (git("rev-parse", "--git-dir").ok ? gitProbe : null);

/** Condition 5: authority evidence, ancestry, and the current HEAD. */
const checkAuthority = (): void => {
  const masterSha = argument("GOAL5A0_MASTER_SHA", 0);
  const controlPlaneASha = argument("GOAL5A0_CONTROL_PLANE_A_SHA", 1);
  if (!masterSha || !SHA_PATTERN.test(masterSha)) {
    fail("authority", "GOAL5A0_MASTER_SHA (or argv[1]) must be a recorded 40-hex commit");
    return;
  }
  if (!controlPlaneASha || !SHA_PATTERN.test(controlPlaneASha)) {
    fail("authority", "GOAL5A0_CONTROL_PLANE_A_SHA (or argv[2]) must be a recorded 40-hex commit");
    return;
  }

  // Two evidence paths, neither optional when present. The revalidation
  // document is the private tree's; the attestation is the snapshot's. A tree
  // carrying both must satisfy both — having one more form of evidence has
  // never been a reason to check less of it.
  const documentPresent = existsSync(REVALIDATION_DOCUMENT);
  const attestationPresent = existsSync(AUTHORITY_ATTESTATION);
  if (!documentPresent && !attestationPresent) {
    fail("authority",
      `no authority evidence in this checkout: neither ${REVALIDATION_DOCUMENT} nor ${AUTHORITY_ATTESTATION}`,
    );
    return;
  }

  if (documentPresent) {
    for (const detail of verifyRevalidationDocument({
      documentText: readFileSync(REVALIDATION_DOCUMENT, "utf8"),
      masterSha,
      controlPlaneASha,
      git: gitProbe,
    })) {
      fail("authority", detail);
    }
  }

  if (attestationPresent) checkAttestation(masterSha, controlPlaneASha);

  authorityPath = documentPresent
    ? (attestationPresent ? "revalidation-document+attestation" : "revalidation-document")
    : "attestation";
};

/**
 * Condition 5, second path: `release-authority.json` at the repository root.
 *
 * Strict and closed. The attestation must parse with no unknown field, must
 * carry a signature that verifies against this tree's tracked
 * `release-authority.pub`, must record the same two SHAs the operator declared,
 * and must account for exactly the release-path files and migrations this tree
 * holds — every digest recomputed here, never read back from the file it is
 * checking. On top of that, whichever object-id binding this checkout can carry
 * is required of it: the private ancestry in the lineage the attestation was
 * minted in, and a committed release path in a published snapshot, which is
 * that export committed into a fresh repository. The printed `binding=` says
 * which one answered.
 */
const checkAttestation = (masterSha: string, controlPlaneASha: string): void => {
  const parsed = parseReleaseAuthority(readFileSync(AUTHORITY_ATTESTATION, "utf8"));
  if (!parsed.ok) {
    fail("authority", `${RELEASE_AUTHORITY_FILE} ${parsed.reason}`);
    return;
  }
  const { authority } = parsed;

  const publicKey = existsSync(AUTHORITY_PUBLIC_KEY)
    ? readPublicKey(readFileSync(AUTHORITY_PUBLIC_KEY, "utf8"))
    : null;

  let manifest;
  let migrations;
  try {
    manifest = readFileManifest(repositoryRoot);
    migrations = readMigrationSet(repositoryRoot);
  } catch {
    fail("authority", `${RELEASE_AUTHORITY_FILE} cannot be checked: this tree has no migration set to hash`);
    return;
  }

  const evidenceOnDisk = new Map<string, string>();
  for (const entry of authority.evidence) {
    const absolute = join(repositoryRoot, entry.path);
    if (existsSync(absolute)) evidenceOnDisk.set(entry.path, hashFile(absolute));
  }

  const history = historyProbe();
  for (const detail of verifyReleaseAuthority({
    authority, masterSha, controlPlaneASha, publicKey, manifest, migrations, evidenceOnDisk, git: history,
  })) {
    fail("authority", detail);
  }
  attestationBinding = bindingOf(authority, history);
};

/** Step 2.6: pgcrypto must be usable in schema public, or installable there. */
const checkPgcrypto = async (db: PrismaClient): Promise<void> => {
  const installed = await db.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto'`,
  );
  if (installed.length > 0) {
    if (installed[0]!.nspname !== "public") {
      fail("pgcrypto", `pgcrypto is installed in schema ${installed[0]!.nspname}, not public; CREATE EXTENSION IF NOT EXISTS will not relocate it`);
    }
    return;
  }
  const [privileges] = await db.$queryRawUnsafe<Array<{ database: boolean; publicschema: boolean }>>(
    `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS database,
            has_schema_privilege(current_user, 'public', 'CREATE') AS publicschema`,
  );
  if (!privileges?.database || !privileges?.publicschema) {
    fail("pgcrypto", `pgcrypto is absent and the migration role lacks CREATE (database=${privileges?.database}, public=${privileges?.publicschema})`);
  }
};

interface TargetShape {
  census: SchemaCensus;
  /** How many of Run/Goal/Task/Session exist; 4 means the data checks can run. */
  lineageTables: number;
}

/**
 * What the target schema currently holds, asked of the catalog rather than of
 * the caller. This is the half of the first-run decision that cannot be
 * declared: `GOAL5A0_FRESH_TARGET` says what the operator believes, and this
 * says what is true.
 *
 * The emptiness half is `SCHEMA_CENSUS_SQL` — the same query, from the same
 * module, that `db:migrate:release -- --fresh` runs before it will compose this
 * command. It is shared rather than reimplemented because Fixed Decision 7
 * allows reaching the migration through `db:migrate-goal-execution` directly,
 * and then this is the only census there is. A narrower copy here would be a
 * hole, not a second opinion.
 */
const inspectTarget = async (db: PrismaClient, schema: string): Promise<TargetShape> => {
  const [censusRow] = await db.$queryRawUnsafe<CensusRow[]>(SCHEMA_CENSUS_SQL, schema);
  const census = censusFromRow(censusRow);
  if (census === null) throw new Error("schema census returned no row");
  const [lineage] = await db.$queryRawUnsafe<Array<{ lineageTables: number }>>(
    `SELECT count(*)::int AS "lineageTables" FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
        AND c.relname IN ('Run', 'Goal', 'Task', 'Session')`,
    schema,
  );
  return { census, lineageTables: Number(lineage?.lineageTables ?? 0) };
};

const checkData = async (db: PrismaClient): Promise<Record<string, number>> => {
  // Condition 1: a Task whose Runs name more than one Goal.
  const multiGoal = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT r."taskId" AS id FROM "Run" r WHERE r."taskId" IS NOT NULL
     GROUP BY r."taskId" HAVING COUNT(DISTINCT r."goalId") > 1`,
  );
  if (multiGoal.length > 0) fail("ambiguous-goal", `${multiGoal.length} Task(s) whose Runs name different Goals: ${ids(multiGoal)}`);

  // Condition 1, second form: a Task with a mix of null and non-null Run.goalId.
  // The backfill never fills a formerly null Run from a sibling, so this is an
  // abort and not a repair.
  const mixed = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT r."taskId" AS id FROM "Run" r WHERE r."taskId" IS NOT NULL
     GROUP BY r."taskId"
     HAVING COUNT(*) FILTER (WHERE r."goalId" IS NULL) > 0
        AND COUNT(*) FILTER (WHERE r."goalId" IS NOT NULL) > 0`,
  );
  if (mixed.length > 0) fail("mixed-lineage", `${mixed.length} Task(s) with both null and non-null Run.goalId: ${ids(mixed)}`);

  // Condition 2: a Goal-linked Run with no Task.
  const orphanRuns = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT r."id" FROM "Run" r WHERE r."goalId" IS NOT NULL AND r."taskId" IS NULL`,
  );
  if (orphanRuns.length > 0) fail("orphan-run", `${orphanRuns.length} Goal-linked Run(s) with no Task: ${ids(orphanRuns)}`);

  // Condition 3: an inferred Goal-linked Task with an active Run.
  const activeRuns = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT r."id" FROM "Run" r WHERE r."goalId" IS NOT NULL
       AND r."status" IN ('queued', 'claimed', 'provisioning', 'running', 'waiting-inbox')`,
  );
  if (activeRuns.length > 0) fail("active-run", `${activeRuns.length} active Goal-linked Run(s); drain or cancel before backfill: ${ids(activeRuns)}`);

  // Condition 4: project disagreement across Goal, Task, and Run.
  const projectMismatch = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT r."id" FROM "Run" r
       JOIN "Goal" g ON g."id" = r."goalId"
       LEFT JOIN "Task" t ON t."id" = r."taskId"
     WHERE r."goalId" IS NOT NULL
       AND (g."projectId" <> r."projectId" OR (t."id" IS NOT NULL AND t."projectId" <> g."projectId"))`,
  );
  if (projectMismatch.length > 0) fail("project-disagreement", `${projectMismatch.length} Run(s) whose Goal/Task/Run projects disagree: ${ids(projectMismatch)}`);

  // Condition 4, orphan form: a Run naming a Goal that does not exist.
  const orphanGoal = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT r."id" FROM "Run" r LEFT JOIN "Goal" g ON g."id" = r."goalId"
     WHERE r."goalId" IS NOT NULL AND g."id" IS NULL`,
  );
  if (orphanGoal.length > 0) fail("orphan-goal", `${orphanGoal.length} Run(s) naming a missing Goal: ${ids(orphanGoal)}`);

  // Condition 4, Session form: a Session whose identity disagrees with its Run.
  const sessionMismatch = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT s."id" FROM "Session" s JOIN "Run" r ON r."id" = s."runId"
     WHERE s."projectId" <> r."projectId"
        OR s."goalId" IS DISTINCT FROM r."goalId"
        OR s."taskId" IS DISTINCT FROM r."taskId"`,
  );
  if (sessionMismatch.length > 0) fail("session-disagreement", `${sessionMismatch.length} Session(s) disagreeing with their Run: ${ids(sessionMismatch)}`);

  const [goalLinkedRuns] = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM "Run" WHERE "goalId" IS NOT NULL`,
  );
  const [backfillTasks] = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM (
       SELECT r."taskId" FROM "Run" r WHERE r."taskId" IS NOT NULL
       GROUP BY r."taskId"
       HAVING COUNT(*) FILTER (WHERE r."goalId" IS NULL) = 0 AND COUNT(DISTINCT r."goalId") = 1
     ) AS unambiguous`,
  );
  const [goals] = await db.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT COUNT(*)::bigint AS count FROM "Goal"`);
  return {
    goals: count([goals!]),
    goalLinkedRuns: count([goalLinkedRuns!]),
    tasksToBackfill: count([backfillTasks!]),
  };
};

const main = async (): Promise<number> => {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    console.error("STOP preflight DATABASE_URL is required");
    return 1;
  }
  // Plan Step 3.4: operate on the URL's schema, never an implicit public one.
  // An operator who does not say which schema is being migrated has not stated
  // the target, and a preflight that guesses proves nothing about it.
  const schema = new URL(rawUrl).searchParams.get("schema");
  if (!schema) {
    console.error("STOP preflight DATABASE_URL must name the target schema explicitly (?schema=...)");
    return 1;
  }

  // The first-run declaration must name the schema it is about. A bare boolean
  // exported once and forgotten would follow the operator to the next database;
  // a schema name cannot, because it stops being true the moment the target
  // changes.
  const declaration = process.env["GOAL5A0_FRESH_TARGET"];
  const declaredFresh = declaration !== undefined && declaration === schema;
  if (declaration !== undefined && !declaredFresh) {
    fail("fresh-declaration", `GOAL5A0_FRESH_TARGET names ${declaration}, but DATABASE_URL targets ${schema}`);
  }

  checkAuthority();

  const db = new PrismaClient({ datasources: { db: { url: rawUrl } } });
  let counts: Record<string, number> = {};
  let mode = "existing";
  try {
    await checkPgcrypto(db);
    const target = await inspectTarget(db, schema);
    if (declaredFresh) {
      // Declared *and* confirmed. A first run has no rows, so every data
      // condition below is vacuously satisfied — but only because this schema
      // was just proven to hold nothing, not because the caller said so.
      if (!schemaIsEmpty(target.census)) {
        fail("fresh-target-not-empty",
          `declared a first run, but schema ${schema} holds`
            + ` ${censusObjectCount(target.census)} user object(s): ${describeCensus(target.census)}`,
        );
      } else {
        mode = "first-run";
        counts = { goals: 0, goalLinkedRuns: 0, tasksToBackfill: 0 };
      }
    } else if (target.lineageTables < 4) {
      // Previously this surfaced as `query: relation "Run" does not exist`, an
      // accident of the first failing query rather than a statement about the
      // target. Naming it says which of the two situations it is, and refuses
      // both until the operator says which one they are in.
      fail("first-run-undeclared",
        `schema ${schema} has ${target.lineageTables} of the 4 Goal lineage tables;`
          + ` if this is a first run on an empty target, declare it with GOAL5A0_FRESH_TARGET=${schema}`,
      );
    } else {
      counts = await checkData(db);
    }
  } catch (error) {
    fail("query", error instanceof Error ? error.message : String(error));
  } finally {
    await db.$disconnect();
  }

  console.log(`preflight schema=${schema}`);
  console.log(`preflight authority=${authorityPath}${attestationBinding === "" ? "" : ` binding=${attestationBinding}`}`);
  console.log(`preflight mode=${mode}${mode === "first-run" ? " target=confirmed-empty" : ""}`);
  for (const [key, value] of Object.entries(counts)) console.log(`preflight count ${key}=${value}`);
  for (const failure of failures) console.error(`STOP preflight ${failure.condition}: ${failure.detail}`);
  console.log(failures.length === 0 ? "preflight PASS" : `preflight STOP (${failures.length} condition(s))`);
  return failures.length === 0 ? 0 : 1;
};

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error(`STOP preflight ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
