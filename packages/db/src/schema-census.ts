/**
 * One definition of "this schema is empty", for every command that has to
 * decide it.
 *
 * Two commands ask the question and they must not be able to answer it
 * differently: `db:migrate:release -- --fresh` asks before it will compose the
 * migration, and the Goal 5a0 preflight asks before it will treat the lineage
 * conditions as vacuous. OSS-F0 Fixed Decision 7 permits reaching the release
 * migration through `npm run db:migrate-goal-execution` directly, in which case
 * the preflight's answer is the *only* one — so a narrower copy inside it would
 * be the whole gate, not a second opinion. This module exists so there is
 * nothing to copy.
 *
 * "Empty" means no Prisma migration history and no user object of any
 * schema-scoped class. Not "no object that could collide with this migration
 * set": OSS-B0 plan Step 3 says a fresh target carries no user objects, so a
 * lone collation is a stop.
 *
 * Extension-owned objects (`pg_depend.deptype = 'e'`) are excluded from every
 * class, consistently. A `public` schema whose only contents are pgcrypto's
 * functions and operators is exactly the empty target fresh mode accepts, and
 * that is the state a fresh install on managed Postgres actually arrives in.
 */

export interface SchemaCensus {
  /** Prisma's history table: present means this schema has been migrated. */
  migrationsTable: boolean;
  /** Tables, partitioned tables, views, matviews, sequences, foreign tables, indexes. */
  relations: number;
  /** Enums, domains, standalone composites, ranges, multiranges. */
  types: number;
  /** Functions and procedures. */
  routines: number;
  /**
   * Every remaining schema-scoped class: collations, operators, operator
   * classes and families, conversions, text-search dictionaries,
   * configurations, parsers and templates, extended statistics — and default
   * privileges, which are not an object but are schema-scoped, user-controlled,
   * and inherited by every object the migration is about to create.
   */
  others: number;
}

/** Takes the schema name as `$1`. Use with `$queryRawUnsafe(SQL, schema)`. */
export const SCHEMA_CENSUS_SQL = `
  WITH target AS (SELECT oid FROM pg_namespace WHERE nspname = $1),
       own AS (SELECT objid, classid FROM pg_depend WHERE deptype = 'e')
  SELECT
    to_regclass(format('%I._prisma_migrations', $1)) IS NOT NULL AS "migrationsTable",
    (SELECT count(*)::int FROM pg_class c
       WHERE c.relnamespace IN (SELECT oid FROM target)
         AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'i', 'I')
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = c.oid AND o.classid = 'pg_class'::regclass)) AS "relations",
    (SELECT count(*)::int FROM pg_type t
       WHERE t.typnamespace IN (SELECT oid FROM target)
         AND t.typtype IN ('e', 'd', 'c', 'r', 'm')
         -- A relation's implicit row type is counted as the relation, not twice.
         -- The exception is 'c': a standalone CREATE TYPE ... AS (...) also
         -- gets a pg_class entry, and relkind 'c' is not in the relation list
         -- above, so excluding it here too would let a composite type fall
         -- between both counts and read as an empty schema.
         AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid AND c.relkind <> 'c')
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = t.oid AND o.classid = 'pg_type'::regclass)) AS "types",
    (SELECT count(*)::int FROM pg_proc p
       WHERE p.pronamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = p.oid AND o.classid = 'pg_proc'::regclass)) AS "routines",
    (
      (SELECT count(*)::int FROM pg_collation x WHERE x.collnamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = x.oid AND o.classid = 'pg_collation'::regclass))
    + (SELECT count(*)::int FROM pg_operator x WHERE x.oprnamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = x.oid AND o.classid = 'pg_operator'::regclass))
    + (SELECT count(*)::int FROM pg_opclass x WHERE x.opcnamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = x.oid AND o.classid = 'pg_opclass'::regclass))
    + (SELECT count(*)::int FROM pg_opfamily x WHERE x.opfnamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = x.oid AND o.classid = 'pg_opfamily'::regclass))
    + (SELECT count(*)::int FROM pg_conversion x WHERE x.connamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = x.oid AND o.classid = 'pg_conversion'::regclass))
    + (SELECT count(*)::int FROM pg_ts_dict x WHERE x.dictnamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = x.oid AND o.classid = 'pg_ts_dict'::regclass))
    + (SELECT count(*)::int FROM pg_ts_config x WHERE x.cfgnamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = x.oid AND o.classid = 'pg_ts_config'::regclass))
    + (SELECT count(*)::int FROM pg_ts_parser x WHERE x.prsnamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = x.oid AND o.classid = 'pg_ts_parser'::regclass))
    + (SELECT count(*)::int FROM pg_ts_template x WHERE x.tmplnamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = x.oid AND o.classid = 'pg_ts_template'::regclass))
    + (SELECT count(*)::int FROM pg_statistic_ext x WHERE x.stxnamespace IN (SELECT oid FROM target)
         AND NOT EXISTS (SELECT 1 FROM own o WHERE o.objid = x.oid AND o.classid = 'pg_statistic_ext'::regclass))
    + (SELECT count(*)::int FROM pg_default_acl x WHERE x.defaclnamespace IN (SELECT oid FROM target))
    )::int AS "others"
`;

/** Every catalog the census reads, so a test can prove none was dropped. */
export const CENSUS_CATALOGUES = [
  "pg_class", "pg_type", "pg_proc",
  "pg_collation", "pg_operator", "pg_opclass", "pg_opfamily", "pg_conversion",
  "pg_ts_dict", "pg_ts_config", "pg_ts_parser", "pg_ts_template",
  "pg_statistic_ext", "pg_default_acl",
] as const;

export interface CensusRow {
  migrationsTable: boolean;
  relations: number;
  types: number;
  routines: number;
  others: number;
}

export const censusFromRow = (row: CensusRow | undefined): SchemaCensus | null => (
  row === undefined ? null : {
    migrationsTable: row.migrationsTable,
    relations: Number(row.relations),
    types: Number(row.types),
    routines: Number(row.routines),
    others: Number(row.others),
  }
);

/** How many user objects the census found, across every class. */
export const censusObjectCount = (census: SchemaCensus): number =>
  census.relations + census.types + census.routines + census.others;

/** The one definition of empty: no migration history, and no user object. */
export const schemaIsEmpty = (census: SchemaCensus): boolean =>
  !census.migrationsTable && censusObjectCount(census) === 0;

/** Stable, secret-free wording for a log line or a stop detail. */
export const describeCensus = (census: SchemaCensus): string =>
  `migrations-table=${String(census.migrationsTable)} relations=${census.relations}`
  + ` types=${census.types} routines=${census.routines} others=${census.others}`;
