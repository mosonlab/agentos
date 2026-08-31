# Anneal — migrations, refusals, and what recovery does not cover

Two commands in this repository change a database schema, and they are not
alternatives. This page says which is which, what each one refuses and why, and
— just as importantly — what this release does **not** give you when something
has already gone wrong.

## The two paths

| Command | What it is | Preflight |
| --- | --- | --- |
| `npm run db:migrate` | `prisma migrate dev`. A **development** command: it invents migrations from schema drift and will happily rewrite history. | **None.** |
| `npm run db:migrate:release -- --fresh` | The release path. Proves its target, proves the target is empty, proves the migration set is the recorded candidate, then runs the composed migration. | **Yes** — the composed `npm run db:migrate-goal-execution`, which is `db:preflight-goal-execution && prisma migrate deploy`. |

`npm run db:migrate` is development only. Never point it at a database you would
miss. It is not a faster release path; it is a different thing that happens to
end with a schema.

**One mode is supported on the release path: `npm run db:migrate:release --
--fresh`.** The wrapper also contains an executable `--existing` consumer, but
this repository does not ship the backup producer required to create its input,
so that mode is not an end-to-end supported workflow. The wrapper never reaches
Prisma directly — it composes `npm run db:migrate-goal-execution`, which is exactly
`npm run db:preflight-goal-execution && prisma migrate deploy`. That composed
command is the floor: every migration on a release path runs through the
preflight, and `db:migrate-goal-execution` is itself supported for the case where
you are running the guarded migration without the release-path target and
emptiness proofs around it. Anything below that floor is a bypass, named as such
in the next section.

### Which commands run the preflight, and which do not

Guarded — the migration preflight runs and can stop the migration:

- `npm run db:migrate:release -- --fresh`
- `npm run db:migrate:release -- --existing --backup-bundle …`
- `npm run db:migrate-goal-execution` (the composed command itself)

Not guarded — these reach the same migrations with no preflight at all:

- `npm run db:migrate`
- a direct `prisma migrate deploy`

**That bypass is procedural, not technically closed.** Nothing in this release
prevents someone from running `prisma migrate deploy` against a database by
hand. Saying otherwise would be the more comfortable sentence and the false one.
Closing it is successor work.

## Fresh versus existing

`--fresh` and `--existing` are mutually exclusive and one of them is required.

**Fresh** means: this schema has no migration history and no user objects, and
you are declaring that deliberately. Both halves are required. The declaration
alone proves nothing, and an empty schema nobody declared is more likely a wrong
target than a first install — so the command declares the intent and the
preflight independently re-checks that the schema really is empty.

**Existing** means: there is data, and the safety story is a verified backup plus
an exclusive maintenance lock held across the deploy. Its invocation is:

```sh
npm run db:migrate:release -- --existing --backup-bundle /ABSOLUTE/PATH/TO/BUNDLE
```

The path must be absolute; a relative one is refused before anything else
happens.

> **Status.** The `--existing` consumer is implemented: after target identity it
> validates the bundle, attested target, maintenance lock, WAL fingerprint and
> migration history before it can deploy. The repository does not ship the
> backup producer or a supported runbook that creates such a bundle. Therefore
> no end-to-end existing-install migration is supported in any preview, even though
> the consumer is executable. It does not emit an `interface unavailable`
> condition; supplying an absent, malformed or mismatched bundle reaches the
> corresponding refusal below.
>
> `--fresh` is the supported path. It acquires the exclusive maintenance lock
> before it inspects any schema state and holds it across the emptiness census,
> the migration-set check, the preflight, the deploy, the status check and the
> drift check, so `maintenance-lock-unavailable` means a real contention or a
> lost lock rather than an unimplemented interface.

## Reading a refusal

Both paths print stable, machine-readable lines. No URL, password, database
name, container id, path, or raw subprocess output appears in them.

```text
STOP release-migrate <condition>: <reason>
STOP preflight <condition>: <detail>
```

### `release-migrate` conditions

| Condition | What it means |
| --- | --- |
| `arguments` | The flags do not name exactly one mode, or `--backup-bundle` is missing/relative/paired with `--fresh`. `--force`, `--skip-preflight` and `--no-preflight` are refused by name. |
| `env-file`, `compose-file`, `compose-service`, `compose-port` | The checkout's `.env` or `docker-compose.yml` does not describe one PostgreSQL service with one resolved published port. An explicit non-loopback bind is refused; Compose shorthand with no bind emits `compose-publishes-on-every-interface`, while the target URL must still prove a literal loopback host. |
| `target-url` | `DATABASE_URL` is absent, unparsable, or not PostgreSQL. |
| `env-conflict` | An inherited `DATABASE_URL` disagrees with the one in `.env`. |
| `target-schema`, `target-host`, `target-port`, `target-database`, `target-user`, `target-credential` | The URL does not prove the schema, literal loopback host, published port, database, user, and non-placeholder credential declared by this checkout. |
| `compose-identity`, `server-identity` | The database answering is not the Compose database this checkout defines. |
| `backup-bundle`, `backup-target`, `backup-wal` | Existing mode, and the bundle is unreadable/invalid, names another target, or no longer matches the target's WAL fingerprint. These are real consumer checks; this release does not ship the producer needed to create a supported bundle. |
| `target-not-empty` | Fresh mode, and the schema already holds migration history or user objects. The line above it reports the census. |
| `migration-tail` | This checkout's migration set is not the recorded release candidate — shorter or longer. A main checkout between releases stops here by design; the install path is the tagged release. |
| `migration-state`, `files-precheck` | Existing mode, and migration history cannot be proven compatible or the owned-files precheck fails. |
| `maintenance-lock-unavailable` | The exclusive maintenance lock could not be taken, was already held by another session or an active service, or was lost while the migration ran. |
| `migrate-goal-execution`, `migrate-status`, `drift-check` | The composed migration, the status check, or the drift check exited non-zero. |

The argument boundary can be checked without a database or a bundle. This
literal command:

```sh
npm run db:migrate:release -- --existing
```

terminates before environment or target inspection with:

```text
STOP release-migrate arguments: existing-mode-requires---backup-bundle
```

### Preflight conditions

`pgcrypto`, `active-run`, `ambiguous-goal`, `mixed-lineage`, `orphan-goal`,
`orphan-run`, `project-disagreement`, `session-disagreement`,
`first-run-undeclared`, `fresh-declaration`, `fresh-target-not-empty`, `query`.

One deserves explanation:

**`pgcrypto`.** The migration needs `pgcrypto` usable in schema `public`.
`CREATE EXTENSION IF NOT EXISTS … WITH SCHEMA public` does **not** relocate a
`pgcrypto` that is already installed in some other schema, so the preflight stops
instead of letting the migration discover that halfway through.

### If the unguarded path hits the same case

If `pgcrypto` is installed outside `public` and the migration is reached without
the preflight — via `npm run db:migrate` or a direct `prisma migrate deploy` —
the migration **aborts inside its own transaction and rolls back**. There is no
partial schema and no data corruption: the failure is loud and the database is
where it was.

The documented first response is to run the preflight explicitly against the
same `DATABASE_URL`, with the schema named in the URL:

```sh
DATABASE_URL='…?schema=<the schema you targeted>' npm run db:preflight-goal-execution
```

It will name the condition in one line, which is the thing you actually need
before touching anything else.

## What recovery is, and is not

Read this section before you need it.

- **Prisma has no down migration.** There is no command in this repository that
  reverses an applied migration. Do not plan around one.
- **Rolling back code does not roll back the database.** Checking out an earlier
  commit leaves every applied migration applied and every migrated row migrated.
  An older build against a newer schema is its own failure mode, not a recovery.
- **Restore is only ever to an isolated target.** Restoring a backup over a
  database something is still using is not a supported operation of this
  release. The restore interface itself is separate work and is not on this
  release candidate.
- **Production migration, restart, and restore are Unsupported.** Not
  "discouraged" — outside what this release candidate covers, with no evidence
  behind them. The Developer Preview is for a machine you own and data you can
  afford to lose.

## A related refusal that is not a migration

An operator whose installation predates a check often meets it as a startup
refusal rather than a migration one: the API prints `Anneal API startup
configuration refused: <reasons>` and exits 78 (`EX_CONFIG`), before it binds a
socket or touches the database. A `.env` carried over from an older checkout
typically fails on all of `missing:AGENTOS_SECRET_ENCRYPTION_KEY` and a
placeholder or well-known database password, and fixing the password in
`DATABASE_URL` alone then produces `database-credentials-disagree:POSTGRES_PASSWORD`
because Compose reads that variable from the same file.

That refusal is deliberate, it changes nothing, and restarting will not clear it.
The reason codes and the complete fix — including the fact that changing
`POSTGRES_PASSWORD` does not change the password of a database that already
exists — are in the "Startup configuration refusals" section of
[`developer-preview.md`](developer-preview.md).

The honest summary: on the Developer Preview, the recovery story for a database
you care about is *do not put it here yet*.
