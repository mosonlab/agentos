# PostgreSQL backup and isolated restore

> **Hard boundary:** never restore over production. This procedure requires a separately created, empty database whose name and database comment identify it as disposable. It does not authorize launchd activation, a production migration or restart, public publication, or Control-plane, Goal, or Inbox product work.

## Operating contract

The committed scripts use libpq service aliases. They do not accept a connection URL, print connection diagnostics, delete a database, or guess a cleanup target.

Prerequisites:

- PostgreSQL client tools compatible with the server (`pg_dump`, `pg_restore`, and `psql`)
- an absolute backup directory with adequate free space
- a libpq service file outside the repository, readable only by the operator
- a separate passfile outside the repository when password authentication is required
- permission to create one new isolated target through a maintenance service

Create the service and pass files without putting a credential in shell history:

```sh
install -m 600 /dev/null /ABSOLUTE/PATH/TO/pg_service.conf
install -m 600 /dev/null /ABSOLUTE/PATH/TO/pgpass
```

The service file contains sections such as `[agentos-backup]`, `[agentos-maintenance]`, and `[agentos-restore-<OPAQUE>]`. Put the host, port, user, database name, TLS policy, and absolute passfile path in those sections using libpq syntax. Put the credential only in the mode-0600 passfile. Do not paste either file into tickets, logs, or evidence.

## Create and validate a backup

Run from the repository root:

```sh
PGSERVICE=agentos-backup \
PGSERVICEFILE=/ABSOLUTE/PATH/TO/pg_service.conf \
AGENTOS_BACKUP_DIR=/ABSOLUTE/PATH/TO/backups \
deploy/backup-postgres.sh
```

The script creates a mode-0600 hidden temporary file in the backup directory, writes a custom-format archive, validates its table of contents, and atomically renames it to `agentos-<UTC>-<PID>.dump`. A failed dump or failed validation exits nonzero and removes the hidden temporary file; it never leaves a final-looking archive. After publication it keeps the 14 newest matching regular files and leaves unrelated entries untouched.

Stable backup exits:

| Exit | Meaning |
|---:|---|
| 0 | Valid archive published and retention completed |
| 64 | Required configuration or PostgreSQL tools unavailable |
| 65 | Produced archive failed custom-format validation |
| 70 | Dump command failed |
| 73 | Temporary file, publication, or retention operation failed |

Record the exit class, not raw stderr or environment contents. Obtain a checksum without retaining the filename in evidence:

```sh
shasum -a 256 /ABSOLUTE/PATH/TO/agentos-ARCHIVE.dump | awk '{print $1}'
```

## Provision exactly one isolated target

Choose a brand-new name beginning with `agentos_restore_`. Create it from a separately configured maintenance alias, owned by the restore role, then apply the exact marker:

```sh
createdb --maintenance-db=service=agentos-maintenance \
  --owner=<RESTORE_ROLE> <agentos_restore_OPAQUE>

PGSERVICE=agentos-maintenance \
PGSERVICEFILE=/ABSOLUTE/PATH/TO/pg_service.conf \
psql --set=ON_ERROR_STOP=1 \
  --command="COMMENT ON DATABASE <agentos_restore_OPAQUE> IS 'agentos:isolated-restore-target'"
```

Add an `[agentos-restore-<OPAQUE>]` section to the service file that resolves only to that new target. The restore script mechanically requires all of the following before it invokes `pg_restore`:

- the service alias begins with `agentos-restore-`
- the connected database name begins with `agentos_restore_`
- `AGENTOS_RESTORE_CONFIRM` exactly equals `restore:<CONNECTED_DATABASE_NAME>`
- the database comment exactly equals `agentos:isolated-restore-target`
- the target has no user relations, functions, domains, enums, ranges, or non-default user schemas
- the archive has a readable custom-format table of contents

Any mismatch exits before restore. A source database, an unmarked target, or a target containing even one representative user object is refused.

## Restore and verify

Set only aliases and paths in the command:

```sh
PGSERVICE=agentos-restore-<OPAQUE> \
PGSERVICEFILE=/ABSOLUTE/PATH/TO/pg_service.conf \
AGENTOS_RESTORE_CONFIRM=restore:<agentos_restore_OPAQUE> \
deploy/restore-postgres.sh /ABSOLUTE/PATH/TO/agentos-ARCHIVE.dump

PGSERVICE=agentos-restore-<OPAQUE> \
PGSERVICEFILE=/ABSOLUTE/PATH/TO/pg_service.conf \
deploy/verify-postgres-restore.sh
```

The restore excludes ownership and privilege replay and runs with exit-on-error inside one transaction. If archive processing fails after recognition, PostgreSQL rolls back the schema and data written by that attempt. The script reports a stable class and retains the exact isolated target for inspection; it does not delete or recreate it.

Stable restore exits:

| Exit | Meaning |
|---:|---|
| 0 | Transactional restore completed |
| 64 | Arguments, aliases, files, or tools are invalid |
| 65 | Archive table-of-contents validation failed |
| 69 | Target identity, marker, or emptiness could not be queried |
| 70 | Transactional restore failed |
| 78 | Alias, target namespace, confirmation, marker, or emptiness safety check refused the target |

The verifier checks the representative schema, exact Project, Agent, Task, Run, and Inbox fixture rows, and every committed Prisma migration. During the disposable rehearsal it also compares migration and fixture fingerprints with the isolated source. Re-running restore against the now-populated target must be refused.

## One-command disposable rehearsal

```sh
zsh deploy/rehearse-postgres-backup-restore.sh
```

The rehearsal creates one uniquely labelled PostgreSQL 16 container, only the synthetic source and three named restore targets inside it, and mode-0600 temporary connection material. It exercises dump failure, archive-validation failure, exact 14-file retention, all target refusals, a table-of-contents-readable corrupted archive, one-transaction rollback, a valid restore, source comparison, and post-restore refusal.

The rehearsal performs `npm run db:validate` internally while its synthetic environment is alive. Operators do not provide or print a URL; evidence records only `schema-validation: pass`. All unsanitized tool output remains inside the owned temporary directory and is deleted. Before printing, the script scans its evidence for the per-run connection sentinel and every generated connection field.

## Cleanup and failure handling

The restore command owns only its temporary diagnostics and removes them on exit. It intentionally leaves the isolated target intact for inspection. Retain a failed target or have a human explicitly remove that exact disposable database after confirming its identity; the scripts never perform database deletion.

The rehearsal removes only its exact container ID after confirming both the expected name and unique `com.agentos.ossd-rehearsal` label. It then removes only the temporary root containing its matching ownership marker. If either identity check fails, stop and inspect that exact ID and label. Never widen the deletion target or use a blanket cleanup command.

## Redacted result template

Persist only this shape:

```text
commit: <SHA>
postgres-client-major: <MAJOR>
postgres-server-major: <MAJOR>
schema-validation: pass
backup-failure-cleanup: pass
archive-toc: pass
retention-selection: pass
unsafe-target-refusals: pass
transactional-failure-atomicity: pass
schema-shape: pass
project-row: pass
agent-row: pass
task-row: pass
run-row: pass
inbox-row: pass
migration-state: pass
source-comparison: pass
post-restore-nonempty-refusal: pass
archive-sha256: <SHA256>
migration-count: <COUNT>
row-assertions: project-row,agent-row,task-row,run-row,inbox-row
retention-count: 14
cleanup: pass
```

Do not include service-file contents, passfile contents, environment dumps, URLs, host/user/database values, raw database errors, filenames, or command tracing.

## Rollback

Before any activation, revert the OSS-D commits and leave existing `.dump` files untouched. Repository implementation and rehearsal touch only disposable databases, so code rollback requires no SQL or service action. It must not delete backups, modify production data, load or unload launchd jobs, restart services, or reconcile production migrations.

After a failed isolated restore, retain the exact target for inspection or arrange explicit human deletion of that one disposable database. Reverting the implementation does not clean or alter any database.
