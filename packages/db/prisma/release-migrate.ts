/**
 * `npm run db:migrate:release -- --fresh` — CLI entrypoint.
 *
 * Wiring only. Every decision lives in `src/release-migrate.ts` (orchestration)
 * and `src/local-release-target.ts` (target identity), so the refusals can be
 * tested without a Docker daemon or a database.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { normaliseComposeProject, type ServerIdentity } from "../src/local-release-target.js";
import {
  acquireMaintenanceLock,
  inspectMaintenanceLock,
  prismaMaintenanceLockSession,
} from "../src/maintenance-lock.js";
import {
  releaseMigrate,
  type MaintenanceLockOutcome,
  type MaintenanceLockState,
  type MigrationState,
  type ReleaseMigrateHost,
} from "../src/release-migrate.js";
import { ARCHIVE_MEMBER, CUSTOM_FORMAT_MAGIC, type BundleEntry, type BundleFacts } from "../src/backup-bundle.js";
import { censusFromRow, type CensusRow, SCHEMA_CENSUS_SQL } from "../src/schema-census.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/+$/u, "");
const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");

const withClient = async <T>(url: string, work: (db: PrismaClient) => Promise<T>): Promise<T | null> => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    return await work(db);
  } catch {
    // The failure itself is the answer the caller needs; raw driver text can
    // carry the URL and is never printed.
    return null;
  } finally {
    await db.$disconnect();
  }
};

const host: ReleaseMigrateHost = {
  repositoryRoot,
  processEnv: process.env,

  readTextFile: (absolutePath) => {
    try {
      return readFileSync(absolutePath, "utf8");
    } catch {
      return null;
    }
  },

  listMigrationDirectories: () => {
    try {
      return readdirSync(`${packageRoot}/prisma/migrations`, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },

  composeProject: () => process.env["COMPOSE_PROJECT_NAME"] ?? normaliseComposeProject(basename(repositoryRoot)),

  listComposeContainers: (project, service) =>
    new Promise((resolve) => {
      execFile(
        "docker",
        [
          "ps",
          "--filter", `label=com.docker.compose.project=${project}`,
          "--filter", `label=com.docker.compose.service=${service}`,
          "--filter", "status=running",
          "--format", "{{.ID}}",
        ],
        { encoding: "utf8" },
        (error, stdout) => {
          if (error) { resolve([]); return; }
          resolve(stdout.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
        },
      );
    }),

  readServerIdentity: (url) =>
    withClient(url, async (db) => {
      const rows = await db.$queryRaw<Array<{ database: string; user: string; identity: string }>>`
        SELECT current_database() AS "database",
               current_user::text AS "user",
               current_database() || '/' || current_user || '@'
                 || coalesce(host(inet_server_addr()), 'local') || ':' || coalesce(inet_server_port()::text, '') AS "identity"
      `;
      const row = rows[0];
      if (row === undefined) return null;
      const identity: ServerIdentity = {
        database: row.database,
        user: row.user,
        // One-way: the operator can compare two runs without the digest
        // carrying the database name or address it was computed from.
        fingerprint: createHash("sha256").update(row.identity).digest("hex").slice(0, 16),
      };
      return identity;
    }),

  inspectSchema: (url, schema) =>
    withClient(url, async (db) => censusFromRow(
      (await db.$queryRawUnsafe<CensusRow[]>(SCHEMA_CENSUS_SQL, schema))[0],
    )),

  // The OSS-D lock client, wired. The refusal reason is the client's own stable
  // vocabulary — which kind of holder stood in the way — and is printed as the
  // stop's reason, so an operator learns whether to stop a service or to find
  // another maintenance session.
  acquireMaintenanceLock: async (target): Promise<MaintenanceLockOutcome> => {
    const acquired = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    return acquired.ok ? { ok: true, lock: acquired.lock } : { ok: false, reason: acquired.reason };
  },

  inspectMaintenanceLock: (target): Promise<MaintenanceLockState | null> =>
    inspectMaintenanceLock(target, prismaMaintenanceLockSession),

  // The bundle, described rather than trusted. `lstat` throughout: a symlink
  // that resolves to a valid archive is a bundle whose contents can change
  // after it was judged, and a symlinked bundle directory is the same problem
  // one level up.
  inspectBackupBundle: async (absolutePath): Promise<BundleFacts | null> => {
    const empty: BundleFacts = {
      isDirectory: false,
      directoryMode: 0,
      entries: [],
      archive: null,
      attestationText: null,
    };
    try {
      const directory = lstatSync(absolutePath, { throwIfNoEntry: false });
      if (directory === undefined || !directory.isDirectory()) return empty;
      const entries: BundleEntry[] = [];
      for (const name of readdirSync(absolutePath)) {
        const member = lstatSync(`${absolutePath}/${name}`, { throwIfNoEntry: false });
        const kind = member === undefined
          ? "other"
          : member.isSymbolicLink()
            ? "symlink"
            : member.isDirectory()
              ? "directory"
              : member.isFile()
                ? "file"
                : "other";
        entries.push({ name, kind, mode: (member?.mode ?? 0) & 0o7777 });
      }
      let archive: BundleFacts["archive"] = null;
      try {
        const bytes = readFileSync(`${absolutePath}/${ARCHIVE_MEMBER}`);
        archive = {
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          magic: bytes.subarray(0, CUSTOM_FORMAT_MAGIC.length).toString("latin1"),
        };
      } catch {
        archive = null;
      }
      let attestationText: string | null = null;
      try {
        attestationText = readFileSync(`${absolutePath}/attestation.json`, "utf8");
      } catch {
        attestationText = null;
      }
      return { isDirectory: true, directoryMode: directory.mode & 0o7777, entries, archive, attestationText };
    } catch {
      return null;
    }
  },

  // Computed from what the server *is*, not from how it was reached: the
  // backup connects through a service file and the migrator through the
  // published Compose port, and an address-bearing digest would disagree for a
  // reason that has nothing to do with identity. `deploy/backup-postgres.sh`
  // computes the same expression.
  readTargetFingerprint: (url) =>
    withClient(url, async (db) => {
      const rows = await db.$queryRaw<Array<{ fingerprint: string }>>`
        SELECT substr(encode(sha256((
                 'agentos-release-target-v1|'
                 || (SELECT system_identifier::text FROM pg_control_system())
                 || '|' || current_database() || '|' || current_user)::bytea), 'hex'), 1, 32) AS "fingerprint"
      `;
      return rows[0]?.fingerprint ?? null;
    }).then((value) => value ?? null),

  readWalFingerprint: (url) =>
    withClient(url, async (db) => {
      const rows = await db.$queryRaw<Array<{ fingerprint: string }>>`
        SELECT substr(encode(sha256((
                 'agentos-release-wal-v1|' || pg_current_wal_lsn()::text)::bytea), 'hex'), 1, 32) AS "fingerprint"
      `;
      return rows[0]?.fingerprint ?? null;
    }).then((value) => value ?? null),

  readMigrationState: (url, schema): Promise<MigrationState | null> => {
    // The schema reached this far through the target planner, which accepts
    // only `?schema=<name>`; the guard is here as well because this is the one
    // query that has to name it as an identifier rather than pass it as a value.
    if (!/^[A-Za-z0-9_]+$/u.test(schema)) return Promise.resolve(null);
    return withClient(url, async (db) => {
      const presence = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
        `SELECT to_regclass('"${schema}"._prisma_migrations') IS NOT NULL AS "present"`,
      );
      if (presence[0]?.present !== true) return { present: false, applied: [], unresolved: [] };
      const rows = await db.$queryRawUnsafe<Array<{ name: string; unresolved: boolean }>>(
        `SELECT migration_name AS "name",
                (finished_at IS NULL AND rolled_back_at IS NULL) AS "unresolved"
           FROM "${schema}"._prisma_migrations
          ORDER BY started_at, migration_name`,
      );
      return {
        present: true,
        applied: rows.map((row) => row.name),
        unresolved: rows.filter((row) => row.unresolved).map((row) => row.name),
      };
    });
  },

  nowMs: () => Date.now(),

  run: (argv, env, options) =>
    new Promise((resolve) => {
      const [command, ...rest] = argv;
      if (command === undefined) { resolve(1); return; }
      // Argument array, no shell: no value from `.env` can become a token in a
      // command line this process constructs.
      //
      // Its own process group, because the thing that has to be stoppable is
      // not `npm` — it is the `prisma migrate deploy` two levels below it that
      // holds the connection doing the writing. Signalling the direct child
      // leaves that one running, which is the opposite of what an abort means
      // here. The cost of the group is that a terminal's Ctrl-C no longer
      // reaches the child by itself, so this process forwards it: an operator
      // interrupt that killed the lock holder and left the migration running
      // would be exactly the unlocked mutation the lock exists to prevent.
      const child = spawn(command, rest, { cwd: repositoryRoot, env, stdio: "inherit", shell: false, detached: true });
      const group = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined || child.exitCode !== null) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // Already gone, or never started. Either way there is nothing to stop.
        }
      };
      let escalation: NodeJS.Timeout | undefined;
      const terminate = (): void => {
        group("SIGTERM");
        // A migration that ignores SIGTERM still has to stop: the lock it was
        // running under is gone, and waiting politely for it is waiting while
        // it writes.
        escalation ??= setTimeout(() => { group("SIGKILL"); }, 10_000);
        escalation.unref?.();
      };
      const forward = (signal: NodeJS.Signals) => (): void => { group(signal); };
      const onInterrupt = forward("SIGINT");
      const onTerminate = forward("SIGTERM");
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
      const abortSignal = options?.signal;
      if (abortSignal?.aborted === true) terminate();
      abortSignal?.addEventListener("abort", terminate, { once: true });
      const settle = (code: number): void => {
        if (escalation) clearTimeout(escalation);
        abortSignal?.removeEventListener("abort", terminate);
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
        resolve(code);
      };
      child.on("error", () => { settle(1); });
      child.on("close", (code) => { settle(code ?? 1); });
    }),

  wait: (milliseconds, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const onAbort = (): void => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    }),

  log: (line) => { console.log(line); },
  logStop: (line) => { console.error(line); },
};

void releaseMigrate(process.argv.slice(2), host).then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    console.error(`STOP release-migrate unexpected: ${error instanceof Error ? error.name : "non-error-thrown"}`);
    process.exitCode = 1;
  },
);
