# PLAN — Batch 4 FIXES: session usage correctness, migration safety

Implements [`docs/specs/batch-4-fixes-usage-correctness.md`](../specs/batch-4-fixes-usage-correctness.md)
(committed `95937bc`). Written against that spec's tree state and re-verified anchor by anchor at
`95937bc` on branch `agentos/cmswjrnbw0t4ampyj86lr3ymb/run-1`.

**Revision R1 (2026-08-16)** — revised against
[`docs/reviews/2026-08-16-batch-4-fixes-plan-review.md`](../reviews/2026-08-16-batch-4-fixes-plan-review.md)
(review of `3720d74`, verdict FAIL: six must-fix, two should-fix). **All eight findings are adopted;
none is rejected.** §0.4 records what each one changed and where. Two of the review's findings rest on
probes it ran against a live scratch schema (`agentos_test`); this revision could not re-run them — the
revision workspace has no `.env` and no generated Prisma client — so §0.4 marks them *adopted on the
reviewer's evidence, confirm on first run*, and §13 says how the implementer confirms each.

**How to read this.** §0 is the shape of the change and the corrections where the code contradicts
the spec — read it before opening a file. WI-1…WI-9 are the ordered work items; each names its files
with line anchors, what changes, its own verification command, and its rollback. §10 maps every spec
requirement to a work item. §11 is the order, the migration steps and the restart steps. §13 is where
this plan is guessing — the implementer must confirm those by running, not by reading.

**The implementer does not run the production migration and does not restart the platform.** §11.3
writes down what the operator will type; this chain never types it, never touches launchd, never
touches the runner.

---

## 0. Approach summary

Five defects, one file at the centre of four of them (`packages/db/src/usage.ts`), and no schema
change. The work splits into three independent tracks that meet only in the test suite:

1. **Correctness of the derived value** (MF-2, SF-1) — `extractUsage` learns CLAUDE's `modelUsage`
   breakdown and stops accepting values PostgreSQL cannot store. Pure functions, unit-testable,
   no database.
2. **Correctness under concurrency** (MF-1) — `recomputeSessionUsage` becomes one interactive
   transaction whose first two statements are `SET LOCAL lock_timeout` and
   `pg_advisory_xact_lock(class, hash(sessionId))`. Signature, return type and semantics unchanged.
   Proven by a new `.dbtest` that fails when the lock statement is deleted.
3. **Deployability** (MF-3b, MF-3) — two characters of SQL (`IF NOT EXISTS`) plus a runbook. The
   enabling fact, re-verified: **both indexes are on pre-existing columns**, so they can be built out
   of band before the migration with no ordering dependency on the `ALTER TABLE`.

Track 1 and track 2 both edit `usage.ts`; do them in the order WI-1 → WI-2 → WI-3 so each edit lands
on a file that still compiles. Track 3 (WI-7, WI-8) is independent of both and can be done at any
point; it is placed late only so the runbook can quote the finished code.

The backfill (WI-4) is refactored the way batch 2.5 already refactored `backfillTaskSource`: the
logic becomes an exported function in `packages/db/src/`, and `prisma/backfill-session-usage.ts`
becomes a thin CLI wrapper. That is not gold-plating — it is the only way §7.2 item 5 of the spec
(a `.dbtest` asserting `scanned 3, updated 2, failed 1`) is implementable at all (§0.2 C3).

**Diff surface** (spec §5, unchanged by this plan except where §0.2 says so):

| file | work item |
|---|---|
| `packages/db/src/usage.ts` | WI-1, WI-2, WI-3, WI-4, WI-9 |
| `packages/db/prisma/backfill-session-usage.ts` | WI-4 |
| `packages/db/prisma/migrations/20260816165548_batch4_session_usage/migration.sql` | WI-7 |
| `packages/api/src/usage.test.ts` | WI-5, WI-9 |
| `packages/api/src/app.test.ts` | WI-5 (**addition — see §0.2 C2**) |
| `packages/api/src/usage.dbtest.ts` *(new)* | WI-6 |
| `docs/runbooks/batch-4-rollback.md` *(new)* | WI-8 |
| `docs/specs/batch-4-sessions-viewer.md`, `docs/plans/batch-4-sessions-viewer-plan.md` | WI-9 |

`packages/db/src/index.ts` needs **no edit**: it already does `export * from "./usage.js"`, so the new
lock constant, the hash helper and `backfillSessionUsage` are exported by that line alone.
`packages/api/src/app.ts` gets **no behavioural change** (spec A3); its comment block at 2507-2518 may
gain one sentence. `apps/web` must not appear in the diff. `schema.prisma` must not appear in the diff.

---

## 0.1 What was verified in the tree

Every anchor the spec cites, re-opened at `95937bc`. All held; the two the spec already corrected
(the ingest call site and the missing review file) are confirmed corrected.

| claim | anchor | result |
|---|---|---|
| unserialised read-modify-write, three awaits | `packages/db/src/usage.ts:138-152` | ✅ exact |
| false invariant in the doc comment | `packages/db/src/usage.ts:133-136` | ✅ exact |
| false invariant in the batch 4 plan | `docs/plans/batch-4-sessions-viewer-plan.md:478-482` | ✅ exact |
| live ingest call site | `packages/api/src/app.ts:2519` (inside `try/catch` at 2517-2521) | ✅ exact — the brief's "~1790" is stale |
| backfill caller, no per-session catch | `packages/db/prisma/backfill-session-usage.ts:21-25` | ✅ exact |
| `finite` accepts anything finite | `packages/db/src/usage.ts:23-24` | ✅ exact |
| migration is 11 lines, `ALTER TABLE` + 2 plain `CREATE INDEX` | `…/20260816165548_batch4_session_usage/migration.sql:1-11` | ✅ exact |
| both indexes are on **pre-existing** columns | `schema.prisma` `Session` (`projectId`, `requestedAt` present since phase 0), `SessionEvent` (`runId`, `seq`) | ✅ — this is what makes MF-3b's split legal |
| `Session.costUsd` predates this migration | only match for `costUsd` in `migrations/` is `20260815000000_phase0_init` | ✅ — the runbook's "do not drop `costUsd`" warning is load-bearing |
| index names match Prisma's convention | `schema.prisma` `@@index([projectId, requestedAt])` (Session:47), `@@index([runId, seq])` (SessionEvent) → `Session_projectId_requestedAt_idx`, `SessionEvent_runId_seq_idx` | ✅ identical in schema, migration and runbook |
| drift-check compares live schema, not history | `packages/db/scripts/check-drift.mjs` → `migrate diff --from-url $DATABASE_URL --to-schema-datamodel` | ✅ — out-of-band indexes satisfy it; a checksum change does not affect it |
| spec §10 items 4-5 wrong about indexes and "write-only-to-null" | `docs/specs/batch-4-sessions-viewer.md:659-665` | ✅ exact |
| spec §9 item 9 backfill expectation | `docs/specs/batch-4-sessions-viewer.md:634-635` | ✅ exact |
| "fixtures pasted from samples" comment | `packages/api/src/usage.test.ts:6-7` | ✅ exact |
| the unit stub lacks `$transaction` | `packages/api/src/usage.test.ts:42-56` | ✅ exact |
| `.dbtest` harness, refuses `public`, resets its own schema | `packages/api/src/testdb.ts:12-14, 31-55` | ✅ exact |
| `test:db` runs `src/*.dbtest.ts` at concurrency 1 | `packages/api/package.json` | ✅ exact |

**The MF-2 numbers were re-derived independently** by parsing the untrimmed captures, not taken from
the spec:

| capture | Σ `modelUsage` in | out | cacheRead+cacheCreation | total | Σ per-model `costUSD` | `total_cost_usd` |
|---|---|---|---|---|---|---|
| `claude-tool-event.stdout` | **545** | **98** | **8768** | **643** | 0.049117 | 0.049117 |
| `claude-start-safe-mode.stdout` | **535** | **20** | **2969** | **555** | 0.030392999999999996 | 0.030392999999999996 |

Both captures carry exactly two models (`claude-haiku-4-5-20251001`, `claude-opus-5`); in both, the
top-level `usage` object equals the `claude-opus-5` entry field for field, so **adding the two sources
double-counts the primary model** — the spec's rule "derive exclusively from `modelUsage`" is correct.
Per-model `costUSD` sums to `total_cost_usd` to the last digit in both, so cost needs no change.
Entry field names confirmed camelCase: `inputTokens`, `outputTokens`, `cacheReadInputTokens`,
`cacheCreationInputTokens`, `costUSD`.

**Prior art that this plan reuses rather than reinvents** (all verified present):

- `packages/db/src/task-source.ts:36` — `backfillTaskSource(db)` exported from `src/`, thin script at
  `prisma/backfill-task-source.ts`, tested via `import { backfillTaskSource } from "@agentos/db"` at
  `packages/api/src/migration.dbtest.ts:141`. **This is the template for WI-4.**
- `packages/api/src/chain.dbtest.ts:214-239` — a `Proxy` over the client intercepting `$transaction`,
  wrapping the `tx`, intercepting one delegate's read to stall between read and write, with two
  promises as gates. **This is the template for WI-6's stalling wrapper**; do not invent Prisma client
  extensions.
- `packages/db/src/workflow.ts:82-90` — `tx.$queryRaw` inside an interactive transaction (`FOR UPDATE`
  row lock). Raw SQL on a transaction client is proven in this repo.
- `packages/db/src/workflow.ts:380-382` — `$executeRawUnsafe` feature-detected because unit stubs lack
  it. Relevant to §0.2 C2's decision.
- `packages/api/src/chain.dbtest.ts:41-49` + `packages/api/src/scheduler.dbtest.ts:15-24` — the
  project → environment → agent → repo → task → run → session seed chain. **WI-6 copies this
  verbatim**; it is not guessing at required fields.
- `tsconfig.base.json` — `strict`, `noUnusedLocals`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. Three consequences appear in the work items below.

---

## 0.2 Corrections — where the code contradicts or under-specifies the spec

These are binding on the implementer. Each states the mechanism, not a preference.

### C1 — the transaction must be `ReadCommitted`, and `SET LOCAL lock_timeout` must come *before* the lock

The spec (§4.1.2) says the advisory lock is "the **first** statement inside" the transaction and
separately says to "also issue `SET LOCAL lock_timeout = '3s'` inside the transaction". Those two
sentences cannot both be satisfied usefully: a `lock_timeout` set *after* a lock acquisition cannot
bound that acquisition. **Order: `SET LOCAL lock_timeout` first, then the advisory lock, then any
read.** The spec's intent — nothing touches session data before the lock — is preserved.

More consequential, and absent from the spec: **the transaction must pass
`isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted` explicitly.** Under `RepeatableRead`
the transaction snapshot is established by the *first* data-reading statement — which is the
`SELECT pg_advisory_xact_lock(…)` itself, i.e. **before** the lock is granted. A caller that queues on
the lock would then read the pre-lock snapshot and recompute from the event set as it was *before* the
other writer committed, writing a stale absolute value with the lock held. The fix would be defeated
by its own lock. Prisma's default is the server default (`ReadCommitted` on PostgreSQL), so today this
works by accident; the repo convention is to state it (`workflow.ts:578`, `app.ts:1863` and eight more
sites all pass `isolationLevel` explicitly). State it.

### C2 — three more stubs break, not just the one the spec names

Spec §4.1.5 says the stub at `packages/api/src/usage.test.ts:42-56` will need `$transaction`. It also
misses `packages/api/src/app.test.ts:1089-1104` — the `ingestDatabase` stub shared by **three** tests
(`app.test.ts:1123`, `:1143`, `:1154`) that exercise the ingest wiring through `createApp`. That stub
has no `$transaction` either, so all three fail with `db.$transaction is not a function` the moment
WI-3 lands. `app.test.ts` is therefore **in this batch's diff**, contrary to spec §5's file list.

Its fixture (`app.test.ts:1080-1084`) is trimmed but *deliberately* — the comment says "trimmed to the
fields `extractUsage` reads" — and carries no `modelUsage`, so under WI-2 it takes the fallback branch
and its assertions (4 / 77 / 8820 / 81 / `0.0491`) stay correct **unchanged**. Only the stub needs
scaffolding, plus one comment line saying it now deliberately covers the fallback branch. If any of
those three assertions has to change, that is a defect in WI-2, not in the test.

Rejected alternative: feature-detecting the raw calls the way `workflow.ts:380` feature-detects
`$executeRawUnsafe`. That would let a stub silently skip the lock — and a typo in the lock statement
would then silently ship an unlocked recompute to production. Explicit stub scaffolding is the safer
side of that trade.

### C3 — §7.2 item 5 is not implementable against the script as it stands

The backfill is a `tsx` script with top-level `await` and a module-scope `new PrismaClient()`. A
`.dbtest` cannot call it without spawning a subprocess and cannot point it at `TEST_DATABASE_URL`
without also inheriting `.env`. **WI-4 extracts `backfillSessionUsage(db)` into
`packages/db/src/usage.ts` and reduces the script to a wrapper** — exactly the shape batch 2.5 gave
`backfillTaskSource`. This is a structural change the spec does not mention but its own acceptance
criterion requires.

**R1/MF-4 extends this.** Extracting the *scan* alone still leaves the summary, the 20-id cap and the
exit code inside untestable script text — and the spec's acceptance criterion is about the **exit
code**. So WI-4 extracts a second function, `runBackfillSessionUsageCli({db, log, error})`, which
returns the exit code instead of assigning it; the script keeps only what a test genuinely cannot
reach. Spawning is then no longer the *only* way to check the exit code, but it is still worth doing
once for the success path (WI-6 test 4), because the three surviving lines are exactly where an import
or `finally` regression would hide.

### C4 — after SF-1, no payload can make a recompute throw, so the failure must be injected

Spec §7.2 item 5 asks for a `.dbtest` "seeding three sessions where the middle one's stored payload
forces a failure". Once WI-1 lands, an out-of-range value is written as `null` rather than thrown —
which is the whole point of SF-1. A payload can no longer force a write failure. **The failing session
must be produced by an instrumented client** (a `Proxy` whose `session.update` throws for one session
id), the same technique `app.test.ts:1088-1103` already offers via `ingestDatabase`'s `onUpdate`. The test
then proves what it is actually for: the *scan* survives a failing session, reports it, and exits
non-zero. Written as the spec words it, the test would pass vacuously.

**And the `Proxy` must wrap the inner transaction client, not the outer one (R1/MF-3).**
WI-3 puts the write on `tx.session.update` inside `db.$transaction`, so an outer-client `session.update`
is never called by the code under test — the test would inject nothing and assert `failed: 1` against a
run where nothing failed. That is a second way to pass vacuously, and it is more insidious than the
first because the test *looks* instrumented. WI-6 test 3 spells out the correct shape.

### C5 — "usable `modelUsage`" is one pass, not a probe plus a pass

Spec §4.2.1 rule 1 defines usability (at least one entry with at least one valid token field) and rule
2 defines the accumulation. Implementing them as two traversals invites them to diverge. They are the
same predicate: **accumulate once; `modelUsage` was usable iff at least one of the three totals came
back non-null.** `{"m": {}}` yields three nulls → not usable → falls back to top-level `usage`, which
is exactly §7.4's first break-attempt.

### C6 — the §4.6 correction table is missing two entries

- `packages/api/src/app.test.ts:1078-1079` — a second "values are the captured shape from
  `spikes/cli-capabilities/samples/`" comment on a trimmed fixture. Not false in the same way (it says
  "trimmed" out loud), but after WI-2 it should say *why* it stays trimmed. Folded into WI-5.
- `docs/plans/batch-4-sessions-viewer-plan.md:492` (and `:136`) — the ingest call site is cited there
  as `packages/api/src/app.ts:1770-1787` / `:1770-1783`. That stale pointer is where the brief's
  "~1790" came from. Two one-line fixes while WI-9 is already in that file. Beyond the spec's letter;
  cheap, and it stops the next reader repeating the error.

### C7 — the dbtest's own wait must stay well under `lock_timeout`

WI-6 stalls writer A while writer B queues on the advisory lock. If B queues for longer than the
`SET LOCAL lock_timeout = '3s'` that WI-3 installs, B aborts with `55P03` and the test fails for a
reason that has nothing to do with the bug. **The bounded poll gets a 2 000 ms deadline and a 20 ms
interval**, and the test releases A as soon as B is observed blocked *or* observed finished. That
also keeps the no-lock branch deterministic: without the lock B never blocks, it finishes, the poll
sees it finish, and A's stale write lands last.

### C8 — the cost range guard belongs on the *rounded* Decimal

`Decimal(12, 4)` holds `99999999.9999`. A raw value of `99999999.99999` is below `10^8` but rounds to
`100000000.0000` and still fails the write. Guard after `toDecimalPlaces(4)`, not before.

### C9 — `finite` must be deleted, not left behind

`noUnusedLocals: true` is on. Once WI-1 replaces the token and cost uses of `finite`, nothing calls it
and `npm run typecheck` fails. Delete it in the same edit.

---

## 0.3 Disposition of the spec's assumptions

| assumption | disposition |
|---|---|
| **A1** — retro review file unavailable | **Carried forward unresolved.** The file is still absent from the working tree and from `origin/master` at `95937bc`. Every finding was re-verified here as well as in the spec; the plan does not depend on it. Recorded again in §14. Per the chain's standing rules, not blocking. |
| **A2** — cost gets the same range guard | **Adopted.** WI-1, with C8's refinement. |
| **A3** — no behavioural change to `app.ts` | **Adopted**, and re-verified: `app.ts:2519` passes the app-level `PrismaClient`, not a transaction client, so `recomputeSessionUsage` opening its own transaction introduces no nesting. Only its comment is touched. |
| **A4** — edit the migration in place | **Adopted.** WI-7. The `.dbtest` harness is unaffected (it drops the whole schema, including `_prisma_migrations`, before every `migrate deploy` — `testdb.ts:31-47`), and `db:drift-check` never inspects checksums. The only cost is the local dev database's one-time re-record, which WI-8 writes into the runbook. **Implementation-time consequence: do not run `npm run db:migrate` after WI-7 lands** — use `npm run test:db`. |
| **A5** — hash the lock key in TypeScript | **Adopted.** WI-3. |
| **A6** — MF-1 test in `packages/api/src/usage.dbtest.ts` | **Adopted.** WI-6, which also absorbs the backfill-resilience test (C3/C4) rather than standing up a second file. |
| **A7** — fallback branch preserves today's behaviour exactly | **Adopted**, and made checkable: every existing CODEX/PI/partial/totality assertion in `usage.test.ts` must pass **unmodified**. |
| **A8** — failed `CREATE INDEX CONCURRENTLY` retried by hand | **Adopted.** WI-8. |

---

## 0.4 Disposition of the plan review (R1)

The review of `3720d74` returned **FAIL** with six must-fix and two should-fix findings.
**Every one is adopted. Nothing was rejected, and nothing was dropped silently.** If a later reader
finds a finding with no corresponding change below, that is a defect in this revision, not a decision.

| # | finding, in one line | adopted as | re-verified here? |
|---|---|---|---|
| **MF-1** | `$queryRaw` cannot deserialize `pg_advisory_xact_lock`'s `void` return under Prisma 6.19.0 → `P2010`, so **every** recompute would throw | WI-3's raw statement now casts: `pg_advisory_xact_lock(…)::text AS locked`. New WI-6 **test 0** exercises the real call against a real database as the first thing in the file. §13 item 2 split into two distinct failure modes. | Anchors yes (Prisma `6.19.0` pinned at `packages/db/package.json:29,34`). **Probe no** — adopted on the reviewer's evidence; test 0 confirms it on first run. |
| **MF-2** | `costAmount` accepted any finite ≥ 0, deferring the range check until after summation, so one absurd event erased a valid sibling's cost | WI-1: the `Decimal(12,4)` storable-range check moves **into `costAmount`**, on the rounded value (C8), so an invalid event is omitted *before* `sumUsage`. `costColumn` keeps an aggregate guard for overflow across individually-valid events. WI-5 gains a mixed invalid-plus-valid regression. | Yes — spec `:356-361` requires per-value rejection; `sumUsage` (`packages/db/src/usage.ts:72-79`) folds costs into one number exactly as described. |
| **MF-3** | WI-6 test 3 proxied `session.update` on the **outer** client, but WI-3 moved the write onto `tx` — the injected failure would never fire | WI-6 test 3 rewritten to the repo's proven `Proxy`-over-`$transaction` shape (`chain.dbtest.ts:218-239`): intercept `$transaction`, wrap the callback's `tx`, replace the delegate on the **inner** client. | Yes — `chain.dbtest.ts:218-239` is exactly that shape, and WI-3 does put the write on `tx`. |
| **MF-4** | traceability claimed the backfill's non-zero exit was verified while WI-6 declined to execute it ("covered by reading it") | WI-4 extracts an exported, injectable `runBackfillSessionUsageCli` that **returns** the exit code; WI-6 test 3 asserts `1` then `0` through it, and new **test 4** spawns the real script against the scratch schema and asserts a real process exit code. §10's `§4.3.4` row now names both. | Yes — spec `:667-670` demands the exit; the script is a module-scope top-level `tsx` script (`packages/db/prisma/backfill-session-usage.ts:1-29`) invoked by `packages/db/package.json:21`. |
| **MF-5** | "say **not rehearsed** in the header" turned the spec's mandatory rehearsal into an optional disclosure, so an unproven rollback could advance toward production | WI-8's verification now makes an unrun rehearsal a **failed implementation gate**: honest header wording is kept, but the step may not report done — it reports FAIL with the reason. §13 item 5 rewritten to match. | Yes — spec `:672-688` (rehearsal) and `:757-766` DoD item 5 ("rehearsed on a scratch database per §7.3"). The reviewer additionally observed `npm run test:db` rebuild `agentos_test` and apply all 12 migrations, so "unreachable" is not the expected outcome. |
| **MF-6** | `DATABASE_URL="${DATABASE_URL}?options=…"` corrupts any URL that already carries a query — the repo's own convention (`?schema=…`) — silently swallowing `lock_timeout` **and** changing the target schema | WI-8 item 2 and §11.3 now detect an existing query and pick `?`/`&` accordingly, percent-encode the option, and verify the parsed parameter names without printing the URL. Rehearsal must cover both a bare and a `?schema=…` URL. | Yes — `packages/api/src/testdb.ts:6-10` reads a query-bearing URL and parses `schema` explicitly; the swallowing behaviour follows directly from WHATWG URL parsing. |
| **SF-1** | the diff-surface checks used a PCRE lookahead with `grep -E`, and `grep … && echo VIOLATION` exits **zero** on the violation path | §11.2 rewritten: two explicit filters instead of the lookahead, every check exits non-zero on a match and prints the offending paths, and the credential check reports a **count only** (printing the matching line would leak the very secret it guards). | Yes — re-ran the expression in this workspace: `ugrep: error at position 7 … invalid syntax`. `rg` exists here but is not assumed. |
| **SF-2** | WI-6 test 2 (open a transaction, take a lock, count `pg_locks` rows) could not settle the `55P03`-vs-`P2028` question §13 assigned to it | test 2 split: **2a** keeps the granted-lock visibility assertion as a preliminary; **2b** holds the lock and races a real `recomputeSessionUsage`, asserting it rejects and recording the observed error code and elapsed time. §13 item 1 now points at 2b. | Anchors yes (`chain.dbtest.ts:67-92` supplies the two-client lifecycle). **Timing probe no** — the reviewer measured `P2010` wrapping `55P03` at ≈279 ms with `lock_timeout=200ms`; 2b records what it actually observes. |

**Did any finding show the spec is wrong?** No. Every one is a defect in the plan's rendering of the
spec, and five of them (MF-2, MF-4, MF-5 and both should-fix) are the plan drifting *away* from a spec
requirement — adopting them moves the plan back onto the spec. Nothing here re-specifies anything, so
§14 gains no new open question from the review. The spec's own open assumptions (A1 above all) are
unchanged and still carried in §14.

---

## WI-1 — `usage.ts`: validation that actually validates (SF-1)

**Files.** `packages/db/src/usage.ts:20-24` (validators), `:93-103` (`deriveUsageColumns`),
`:45-64` (call sites inside `extractUsage`).

**Change.**

1. Delete `finite` (`:23-24`) — C9.
2. Add, next to `asRecord`:

   ```ts
   /** PostgreSQL INTEGER, the type of all four token columns. */
   const MAX_INT4 = 2_147_483_647;
   /** Decimal(12, 4) holds eight integer digits: 99999999.9999 is the ceiling. */
   const MAX_COST = 100_000_000;

   const render = (value: unknown): string =>
     typeof value === "number" ? String(value) : JSON.stringify(value) ?? String(value);

   /** A value only counts as tokens if PostgreSQL can store it in INTEGER.
    *  Absent is silent (absent is normal, and means "said nothing about it");
    *  present-but-impossible is dropped with a diagnostic, and never throws. */
   const tokenCount = (value: unknown, field: string): number | null => {
     if (value === undefined) return null;
     if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INT4) return value;
     console.warn(`[usage] ignoring ${field}=${render(value)}: not a storable token count`);
     return null;
   };

   /** Cost is Decimal(12, 4). A value the column cannot hold is dropped HERE, per
    *  event, not after summation — otherwise one absurd event poisons the sum and
    *  erases every valid sibling's cost (R1/MF-2). The range test is applied to the
    *  ROUNDED value (C8) because that is what is actually written.
    *  Returns the raw number, not the rounded one: sumUsage must keep adding exact
    *  values and round once at the end, as it does today. */
   const costAmount = (value: unknown): number | null => {
     if (value === undefined) return null;
     if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
       console.warn(`[usage] ignoring total_cost_usd=${render(value)}: not a storable cost`);
       return null;
     }
     if (new Prisma.Decimal(value).toDecimalPlaces(COST_SCALE).greaterThanOrEqualTo(MAX_COST)) {
       console.warn(`[usage] ignoring total_cost_usd=${render(value)}: exceeds Decimal(12, 4)`);
       return null;
     }
     return value;
   };
   ```

   Note the `undefined` early return: an explicit `null` in the payload **is** diagnosed (it is
   present-but-invalid), a missing key is not. Without that split, every PI event would log four
   lines.

   `Prisma` and `COST_SCALE` are already in scope in this module (`deriveUsageColumns` uses both), so
   this adds no import. The `Decimal` construction only happens when a payload actually carries a
   cost, which is the CLAUDE terminal event and nothing else.

   **Why per-event and not only after the sum (R1/MF-2).** `sumUsage` (`:72-79`) folds every surviving
   cost into one number. With the check only at the end, `{total_cost_usd: 1e9}` arriving alongside a
   valid `{total_cost_usd: 0.05}` sums to an out-of-range value and stores `costUsd: null` — the
   session loses a cost it legitimately had, and `extractUsage` returns a value its own specified
   contract (spec §4.3.3: "accept cost only when it is finite, `>= 0` and `< 10^8`; otherwise omit")
   says it must not. Per-event rejection omits the impossible event and keeps the `0.05`.
3. Replace the six `finite(...)` calls in `extractUsage` with `tokenCount(usage.input_tokens,
   "usage.input_tokens")` and friends, and the cost call with `costAmount(event.total_cost_usd)`.
   Nothing else in that branch changes — the CODEX `cached_input_tokens` / CLAUDE read+creation
   precedence at `:53-59` stays exactly as it is.
4. `deriveUsageColumns` re-validates the **summed** values (§4.3.2), because a sum can leave the range
   even when every input was in it:

   ```ts
   const columnValue = (value: number | undefined, field: string): number | null => {
     if (value === undefined) return null;
     if (Number.isInteger(value) && value >= 0 && value <= MAX_INT4) return value;
     console.warn(`[usage] ${field} out of INTEGER range after summing (${render(value)}); storing null`);
     return null;
   };

   // R1/MF-2: this is now the AGGREGATE guard only — it catches a sum that leaves
   // the range even though every contributing event was individually storable
   // (two valid events of 6e7 each). Per-event rejection already happened in
   // costAmount, so by here `value` is a sum of values each < 10^8.
   const costColumn = (value: number | undefined): Prisma.Decimal | null => {
     if (value === undefined) return null;
     if (!Number.isFinite(value) || value < 0) { /* diagnostic */ return null; }
     const rounded = new Prisma.Decimal(value).toDecimalPlaces(COST_SCALE);   // C8: round first
     if (rounded.greaterThanOrEqualTo(MAX_COST)) { /* diagnostic */ return null; }
     return rounded;
   };
   ```

   `totalTokens` keeps its `null`-unless-a-half-was-reported rule from `:99-101`, then goes through
   `columnValue` — so an in-range input plus an in-range output whose sum overflows yields
   `totalTokens: null` while `inputTokens` and `outputTokens` keep their values.

**Do not change.** `sumUsage` (it sums whatever survived extraction), `sameColumns`, `COST_SCALE`,
the `SessionUsage` type, or the absent-≠-zero semantics anywhere.

**Verification.**

```bash
npm run typecheck -w @agentos/db      # C9: fails if `finite` was left behind
npm test -w @agentos/api              # existing suites must be green before WI-5 adds to them
```

Expect **no existing assertion to change** at this step: every current fixture holds only in-range
integers. If one moves, `tokenCount`'s predicate is wrong.

**Rollback.** Self-contained in one file. `git checkout -- packages/db/src/usage.ts` restores
`finite`; nothing else depends on the new helpers until WI-2.

---

## WI-2 — `usage.ts`: the `modelUsage` branch (MF-2)

**Files.** `packages/db/src/usage.ts:26-65` (`extractUsage` and its doc comment).

**Change.** Add, above `extractUsage`:

```ts
type ModelTotals = { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null };

/**
 * CLAUDE's terminal `result` carries a per-model breakdown under `modelUsage`,
 * keyed by model id, whose entries are camelCase — while the top-level `usage`
 * object is snake_case and describes ONE model (the primary one, repeated).
 * Verified against both captures in spikes/cli-capabilities/samples/: adding the
 * two sources double-counts the primary model, so this branch is exclusive.
 * Returns null when nothing usable was found, which is what routes an absent,
 * malformed or empty `modelUsage` back to the top-level branch.
 */
const extractModelUsage = (value: unknown): ModelTotals | null => {
  const models = asRecord(value);
  if (!models) return null;
  const totals: ModelTotals = { inputTokens: null, outputTokens: null, cachedInputTokens: null };
  for (const entry of Object.values(models)) {
    const model = asRecord(entry);
    if (!model) continue;                       // one malformed entry must not discard the others
    const input = tokenCount(model.inputTokens, "modelUsage.inputTokens");
    if (input !== null) totals.inputTokens = (totals.inputTokens ?? 0) + input;
    const output = tokenCount(model.outputTokens, "modelUsage.outputTokens");
    if (output !== null) totals.outputTokens = (totals.outputTokens ?? 0) + output;
    const cacheRead = tokenCount(model.cacheReadInputTokens, "modelUsage.cacheReadInputTokens");
    const cacheCreation = tokenCount(model.cacheCreationInputTokens, "modelUsage.cacheCreationInputTokens");
    if (cacheRead !== null || cacheCreation !== null) {
      totals.cachedInputTokens = (totals.cachedInputTokens ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
    }
  }
  // C5: usable iff the one pass produced something. No separate probe.
  return totals.inputTokens === null && totals.outputTokens === null && totals.cachedInputTokens === null
    ? null : totals;
};
```

and restructure `extractUsage`'s body:

```ts
const models = extractModelUsage(event.modelUsage);
if (models) {
  if (models.inputTokens !== null) result.inputTokens = models.inputTokens;
  if (models.outputTokens !== null) result.outputTokens = models.outputTokens;
  if (models.cachedInputTokens !== null) result.cachedInputTokens = models.cachedInputTokens;
} else if (usage) {
  …today's snake_case block, byte for byte…
}
const cost = costAmount(event.total_cost_usd);   // unchanged by the branch: total_cost_usd is already all-model
if (cost !== null) result.costUsd = cost;
```

**Rules that are easy to get wrong, and are all checked in WI-5.**

- **No shared key list between the branches.** `inputTokens` (camel) and `input_tokens` (snake) are
  two vocabularies in one payload. A single lookup table across both is a bug waiting to happen.
- **Absence survives.** A `modelUsage` reporting only input must leave `outputTokens` **absent**, not
  `0`. `exactOptionalPropertyTypes: true` enforces the mechanism: never assign `undefined`, guard and
  skip.
- **Cost is untouched.** Never sum per-model `costUSD` (spec §6); `total_cost_usd` already equals that
  sum in both captures.
- Update the module doc comment at `:31-37` so the CLAUDE bullet names `modelUsage` as the primary
  source and the top-level `usage` as the fallback.

**Verification.** After WI-5 lands the fixtures:

```bash
npm test -w @agentos/api
```

- `claude-tool-event.stdout` → 545 / 98 / 8768 / 643 / `0.0491`
- `claude-start-safe-mode.stdout` → 535 / 20 / 2969 / 555 / `0.0304`
- CODEX 40764 / 253 / 35072 with no cost, PI `{}`, totality over `unknown`, partial-stays-partial —
  **all unmodified**.

Quick standalone check before the fixtures exist:

```bash
node --import tsx -e 'import("@agentos/db").then(({extractUsage})=>{const fs=require("node:fs");
const r=fs.readFileSync("spikes/cli-capabilities/samples/claude-tool-event.stdout","utf8")
  .split("\n").filter(Boolean).map(JSON.parse).find(o=>o.type==="result");
console.log(extractUsage(r))})'
# expect { inputTokens: 545, outputTokens: 98, cachedInputTokens: 8768, costUsd: 0.049117 }
```

**Rollback.** One file, one function. Reverting `extractUsage` to the pre-WI-2 body restores exactly
today's numbers; nothing downstream (columns, API, UI) changes shape, because MF-2 changes a value,
not a schema. Note the operational asymmetry, which WI-8 records: rolling this back after a backfill
leaves corrected rows in place until the next recompute rewrites them downward.

---

## WI-3 — `usage.ts`: serialise the recompute under an advisory lock (MF-1)

**Files.** `packages/db/src/usage.ts:123-152` (the doc comment and the whole function body).

**Change.** Add the lock identity next to the function, then wrap the body.

```ts
/**
 * Advisory-lock class reserved for session usage recomputes. Registry of classes
 * used anywhere in this repo (keep this list, pick a fresh number, do not reuse):
 *   20260816 — session usage recompute (this module).
 * Batch 2.5's task exclusion uses a Task-row `SELECT … FOR UPDATE` (workflow.ts:82),
 * not an advisory lock, so the two schemes cannot collide.
 */
export const SESSION_USAGE_LOCK_CLASS = 20260816;

/**
 * Deterministic 32-bit FNV-1a of a session id, in signed int4 range so it can be
 * the second argument of pg_advisory_xact_lock(int4, int4). Hashed here rather
 * than by PostgreSQL's hashtext(), which is undocumented and not promised stable
 * across major versions — and which could not be unit-tested.
 *
 * Collisions are harmless: two unrelated sessions serialise against each other
 * for the length of one recompute. Correctness is unaffected; only concurrency
 * is, and the contended population is tiny (one runner per session).
 */
export const sessionUsageLockKey = (sessionId: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = Math.imul(hash ^ sessionId.charCodeAt(index), 0x01000193);
  }
  return hash | 0;
};
```

```ts
export const recomputeSessionUsage = async (db: PrismaClient, sessionId: string): Promise<boolean> =>
  db.$transaction(async (tx) => {
    // C1: the timeout must be installed BEFORE the wait it is meant to bound.
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
    // R1/MF-1: the `::text AS locked` cast is LOAD-BEARING, not style.
    // pg_advisory_xact_lock returns `void`, and Prisma 6.19.0 cannot deserialize a
    // void column — the bare form fails with P2010 "Failed to deserialize column of
    // type 'void'" on EVERY call. Do not "simplify" it away; WI-6 test 0 is what
    // catches it if someone does.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SESSION_USAGE_LOCK_CLASS}::int, ${sessionUsageLockKey(sessionId)}::int)::text AS locked`;

    const rows = await tx.sessionEvent.findMany({ …unchanged… });
    const derived = deriveUsageColumns(sumUsage(rows.map((row) => extractUsage(row.payload))));
    const current = await tx.session.findUnique({ …unchanged… });
    if (!current || sameColumns(current, derived)) return false;
    await tx.session.update({ where: { id: sessionId }, data: derived });
    return true;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,   // C1 — load-bearing, not decoration
    timeout: 15_000,     // backstop: must exceed lock_timeout + the work, so a
    maxWait: 5_000,      // contended caller fails as 55P03, not as an opaque P2028
  });
```

**Replace the false invariant** at `:133-136` (§4.6). Required content, not wording: concurrent
callers are serialised by a transaction-scoped advisory lock keyed by session id, **because absolute
writes computed from different snapshots do not converge** — a caller that read at T1 can commit after
a caller that read at T2 > T1, and `sameColumns` then makes the stale value permanent. Keep the
existing paragraph about events being the source of truth; it is still true.

**Constraints.**

- Signature, return type (`Promise<boolean>`, true iff it wrote) and the missing-session / no-change
  behaviours are unchanged. Both call sites keep compiling untouched.
- The lock is transaction-scoped: commit, rollback or a dead connection all release it. Nothing leaks.
- `app.ts:2517-2521` keeps its `try/catch` (**required** — a throw there 500s the runner's terminal
  flush, and `appendEvents` has no retry, so the runner would record a successful run as failed and
  delete its workspace unpushed). One sentence may be added to that comment naming the new failure
  mode: a lock-wait timeout is absorbed the same way, and the columns are repaired by the next
  `FINAL_OUTPUT` or by `db:backfill-session-usage`.
- **Raw-SQL form — two separate failure modes, do not conflate them (R1/MF-1).**
  `tx.$queryRaw` is proven in this repo at `workflow.ts:87`.
  1. **Return-type deserialization — known to fail, already fixed above.** `pg_advisory_xact_lock`
     returns `void`; Prisma 6.19.0 cannot deserialize a `void` column and raises `P2010`,
     *"Failed to deserialize column of type 'void'"*, before a single event is read. The reviewer
     probed both shapes against the dedicated `agentos_test` schema: bare → `P2010`;
     `pg_advisory_xact_lock(…)::text AS locked` → `{"ok":true,"rows":[{"locked":""}]}`. The cast is
     therefore in the code above, not offered as a contingency. Without it the failure is
     catastrophic-but-quiet: the ingest `try/catch` at `app.ts:2517-2521` swallows every throw, so no
     session's usage is ever cached and the backfill reports *every* session failed.
  2. **Bound-parameter numeric typing — still unverified** (§13 item 2). A JS number may arrive as
     `int8`, `numeric` or `double precision`; all three cast to `int4`, so the `::int` casts should
     suffice. If they are rejected at runtime, the documented fallback is
     `` tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${SESSION_USAGE_LOCK_CLASS}, ${key})`) `` —
     safe from injection because both operands are integers this module computed, never payload data,
     and immune to mode 1 as well since `$executeRaw*` returns a row count rather than deserializing
     columns. **Do not adopt the fallback without first seeing the parameterised form fail** in WI-6.
  3. Do not substitute `` tx.$executeRaw`SELECT pg_advisory_xact_lock(…)` `` for the parameterised
     `$queryRaw` on the grounds that it also dodges mode 1. It probably works, but **it was not
     probed**, and the form above was. Changing it means re-probing it.

**Verification.**

```bash
npm run typecheck -w @agentos/db
npm test -w @agentos/api        # requires WI-5's stub scaffolding to be in place
npm run test:db                 # WI-6 proves the lock; this is the real gate
```

Plus the unit-level check that the key helper is deterministic and in range (WI-5).

**Rollback.** Deleting the two raw statements and the `$transaction` wrapper restores today's
behaviour byte for byte — which is precisely the deletion the reviewer performs to prove WI-6's test
earns its keep. No stored state, no schema, nothing to undo in the database.

---

## WI-4 — the backfill: an exported function, per-session resilience, non-zero exit (SF-1)

**Files.** `packages/db/src/usage.ts` (new export at the end),
`packages/db/prisma/backfill-session-usage.ts` (rewritten as a wrapper).

**Change.** Mirror `backfillTaskSource` (`packages/db/src/task-source.ts:36`) exactly.

In `usage.ts`:

```ts
export type BackfillSessionUsageResult = {
  scanned: number;
  updated: number;
  failed: Array<{ sessionId: string; message: string }>;
};

/**
 * Absolute recompute of every session that has a FINAL_OUTPUT event. It
 * overwrites any populated cache that differs from the recomputed value and
 * writes nothing when they match — it is NOT write-only-to-null. That property
 * is what repairs a lost write, and it is what lets a corrected extractor fix
 * rows that were already populated. Safe to re-run; safe to run while sessions
 * are ingesting (recomputeSessionUsage serialises).
 *
 * One session's failure must never starve the rest of the scan: before this,
 * the first throwing row aborted the run permanently, because a re-run sorts the
 * same way and dies at the same row.
 */
export const backfillSessionUsage = async (db: PrismaClient): Promise<BackfillSessionUsageResult> => {
  const sessions = await db.session.findMany({
    where: { events: { some: { type: "FINAL_OUTPUT" } } },
    select: { id: true },
    orderBy: { requestedAt: "asc" },
  });
  const result: BackfillSessionUsageResult = { scanned: sessions.length, updated: 0, failed: [] };
  for (const session of sessions) {
    try {
      if (await recomputeSessionUsage(db, session.id)) result.updated += 1;
    } catch (error) {
      result.failed.push({ sessionId: session.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
};
```

The `BATCH = 200` constant and the slicing loop at `:5, :21-25` are dropped: they slice an
already-materialised array and still await serially, so they are a no-op. Sequential semantics are
preserved deliberately — 99 live `Session` rows, and a parallel backfill would contend on the new lock
for no gain.

**The reporting half is a second exported function, not inline script text (R1/MF-4).** The spec's
acceptance criterion (§7.2 item 5) requires the process to *exit* non-zero; reading
`process.exitCode = 1` in a source file is not an executable check and catches no wrapper, import or
`finally` regression. So everything except constructing the client and assigning `process.exitCode`
moves behind an injectable seam:

```ts
export type BackfillSessionUsageCliDeps = {
  db: PrismaClient;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

/**
 * The CLI's whole body, minus the two lines a test cannot execute (constructing
 * the client, assigning process.exitCode). Returns the exit code rather than
 * setting it, so `usage.dbtest.ts` can execute the real reporting path and assert
 * on 1 then 0 (R1/MF-4). Injectable log/error so the test reads the summary it
 * asserts on instead of trusting it.
 */
export const runBackfillSessionUsageCli = async (
  { db, log = console.log, error = console.error }: BackfillSessionUsageCliDeps,
): Promise<number> => {
  const result = await backfillSessionUsage(db);
  log(`scanned ${result.scanned}, updated ${result.updated}, failed ${result.failed.length}`);
  if (result.failed.length === 0) return 0;
  for (const failure of result.failed.slice(0, 20)) error(`  ${failure.sessionId}: ${failure.message}`);
  if (result.failed.length > 20) error(`  … and ${result.failed.length - 20} more`);
  return 1;
};
```

and the script becomes three lines that no test needs to reach inside:

```ts
const prisma = new PrismaClient();
try {
  // NOT process.exit(1): the finally block must still $disconnect.
  process.exitCode = await runBackfillSessionUsageCli({ db: prisma });
} finally {
  await prisma.$disconnect();
}
```

`scanned` and `updated` are printed on the failing path too (spec §4.3.4). The 20-id cap exists so a
corrupt-payload *class* failure does not print 70 000 lines.

The seam is deliberately narrow: WI-6 test 3 drives `runBackfillSessionUsageCli` for the failure path
(the injected failure cannot cross a process boundary), and WI-6 test 4 **spawns the real script** for
the success path, so the surviving three lines — the import, the client, the `finally` — are covered by
a real process with a real exit code. Neither test alone is sufficient; that split is the point.

**Verification.**

```bash
npm run typecheck -w @agentos/db
npm run test:db                 # WI-6 test 3 (exit 1, injected) and test 4 (exit 0, spawned)
# and, against the local dev database only, the shape check:
npm run db:backfill-session-usage; echo "exit=$?"    # `;` not `&&`: the exit code is the point
```

**Rollback.** Two files, no stored state. The exported function and the script wrapper revert
together; the script's name, arguments and idempotence never changed, so nothing that calls it (the
runbook, the operator's shell history) needs to know.

---

## WI-5 — unit tests: complete fixtures, stub scaffolding, rejection assertions

**Files.** `packages/api/src/usage.test.ts` (fixtures, stub, new tests),
`packages/api/src/app.test.ts:1090-1104` (stub scaffolding only — C2).

**Change.**

1. **Paste the captures whole.** Replace `CLAUDE_RESULT` (`usage.test.ts:8-20`) with the complete
   `result` object, and add a second fixture from `claude-start-safe-mode.stdout`. Generate them
   rather than retyping them, so nothing is trimmed:

   ```bash
   node -e 'const fs=require("node:fs");for(const f of ["claude-tool-event","claude-start-safe-mode"]){
     const o=fs.readFileSync(`spikes/cli-capabilities/samples/${f}.stdout`,"utf8")
       .split("\n").filter(Boolean).map(JSON.parse).find(x=>x.type==="result");
     console.log(`// ${f}`);console.log(JSON.stringify(o,null,2));}'
   ```

   The comment at `:6-7` becomes true and must say what keeps it true: *complete* objects, nothing
   trimmed, and the captures are evidence that must never be edited to suit the code. The reviewer's
   check (spec §7.2 item 2) is that `modelUsage`, `iterations`, `cache_creation`, `server_tool_use`,
   `service_tier`, `inference_geo` and `speed` are all present in the fixture.

2. **Assertions.** `claude-tool-event` → `{inputTokens: 545, outputTokens: 98, cachedInputTokens: 8768,
   costUsd: 0.049117}`, and through `recomputeSessionUsage`: `totalTokens: 643`, `costUsd` string
   `"0.0491"`. `claude-start-safe-mode` → 535 / 20 / 2969 / 555 / `"0.0304"`.

3. **Stub scaffolding** in `stubDatabase` (`:42-56`) — the smallest thing that satisfies WI-3:

   ```ts
   $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(database),
   $executeRawUnsafe: async () => 0,
   $queryRaw: async () => [],
   ```

   `$transaction` invoking the callback with the stub itself is the pattern already used at
   `packages/inbox/src/events.test.ts:28` and `packages/api/src/scheduler.test.ts:39`. Ignore the
   options argument. Apply the same three lines to `ingestDatabase` (`app.test.ts:1089-1104`) and to
   the inline stub at `usage.test.ts:169-172`.

4. **New unit tests**, all in `usage.test.ts`:

   | test | asserts |
   |---|---|
   | `modelUsage` is exclusive | a payload with both `usage` and `modelUsage` yields the `modelUsage` sums, **not** their sum — no double count of the primary model (spec §7.4 item 2) |
   | empty entries fall back | `{usage: {input_tokens: 4}, modelUsage: {m: {}}}` → `{inputTokens: 4}` (spec §7.4 item 1) |
   | one bad entry does not discard the rest | `{modelUsage: {a: 7, b: {inputTokens: 5}}}` → `{inputTokens: 5}` |
   | absence survives the branch | `{modelUsage: {a: {inputTokens: 5}}}` → `outputTokens` **absent**, not `0` |
   | SF-1 rejection | each of `-7`, `1.5`, `2147483648`, `NaN`, `Infinity`, `"5"`, `null`, `true` in `usage.input_tokens` leaves `inputTokens` absent while a valid `output_tokens` in the same payload still comes through, and a diagnostic is emitted (swap `console.warn` the way `app.test.ts:1166` swaps `console.error`) |
   | summed overflow | two events of `input_tokens: 2_000_000_000` → `inputTokens: null` **and** `totalTokens: null`, with the write not throwing |
   | cost guard | `total_cost_usd` of `-1`, `1e9` and `99999999.99999` each store `costUsd: null` (C8) |
   | **cost rejection is per event** (R1/MF-2) | two events, `{total_cost_usd: 1e9}` and `{total_cost_usd: 0.05}`, through `sumUsage` + `deriveUsageColumns` → `costUsd` is `"0.0500"`, **not** `null`: the impossible event is omitted and the valid one survives. Assert `extractUsage` on the bad event alone returns no `costUsd` key at all. |
   | **aggregate cost overflow still caught** (R1/MF-2) | two events of `total_cost_usd: 6e7` — each individually storable — sum to `1.2e8` → `costUsd: null` from `costColumn`. This is the case the per-event check cannot see, and it is why both guards exist. |
   | lock key | `sessionUsageLockKey` is deterministic, differs across a handful of cuid-shaped ids, and always lies in `[-2147483648, 2147483647]` |

**Verification.**

```bash
npm test -w @agentos/api        # every pre-existing assertion unmodified except the CLAUDE numbers
git diff -U0 packages/api/src/usage.test.ts | grep '^-' | grep -v modelUsage   # review what actually changed
```

If any CODEX, PI, totality, partial, cost-only, resume-accumulation, lost-write-repair or
missing-session assertion needs a *changed expectation*, that is a defect in WI-1/WI-2 (spec §7.2
item 3).

**Rollback.** Tests only. Reverting this file loses the proof, not the behaviour.

---

## WI-6 — `usage.dbtest.ts`: the MF-1 interleaving and the backfill's resilience

**Files.** `packages/api/src/usage.dbtest.ts` (new). Picked up automatically by
`npm run test:db` (`node --test --test-concurrency=1 src/*.dbtest.ts`).

**Header comment — required by spec §7.2 item 1.** State, at the top of the file, that deleting the
`pg_advisory_xact_lock` statement in `packages/db/src/usage.ts` must make **test 1 and test 2b fail,
and nothing outside this file**, and that this is how the next reader checks these tests still earn
their keep.

Say "test 1 and test 2b", not "this test and only this test": once R1/SF-2 gave test 2b a real
contended recompute, removing the lock makes that recompute *succeed*, which 2b asserts against. Two
tests failing for the same deletion is the correct expectation, and a header that claims only one
will fail teaches the next reader to treat a true positive as a broken test. Note also which tests are
*insensitive* to the deletion and why — test 0 never contends, test 2a takes its lock directly rather
than through `recomputeSessionUsage`, test 3 and test 4 inject their own failure — so a reader who
deletes the line and sees them stay green has learned nothing alarming.

**Harness.** Copy `before`/`beforeEach`/`after` from `migration.dbtest.ts:9-12`. Copy the seed chain
verbatim from `scheduler.dbtest.ts:15-24` (project → environment → agent → repo) and
`chain.dbtest.ts:41-49` (task → run → session); do not re-derive the required fields.
`SessionEvent` rows need `{sessionId, runId, seq, source: "CLAUDE", type: "FINAL_OUTPUT", payload}`.

**Holding a lock open while another client contends — use the repo's existing template.**
`packages/api/src/tasks.dbtest.ts:307-326` ("a lock held by a foreign transaction makes start wait
rather than double-run") is the same experiment as test 2b with a row lock instead of an advisory
one: a second `PrismaClient` on `testDatabaseUrl`, a holding `$transaction`, the contended call
raced against it with `Promise.all`, and `finally { await holder.$disconnect(); }`. Copy its shape.
Two numbers in it are load-bearing and are the likeliest way to lose an hour here:

- **`{ timeout: 10_000 }` on the holding transaction.** Prisma's default interactive-transaction
  timeout is 5 s. Test 2b's contended recompute takes ≈3 s to give up (WI-3 sets
  `lock_timeout = '3s'`) and may take up to 15 s if `lock_timeout` turns out not to bound an advisory
  wait at all — which is the very thing 2b is measuring. A holder on the default 5 s can therefore
  time out *first*, releasing the lock and letting the contended recompute succeed: the test then
  fails while reporting the opposite of what happened. Give the holder `timeout: 20_000`.
- **`{ timeout: 20_000 }` on the `test()` itself**, as all four of that file's race tests do. Node's
  default per-test timeout will not accommodate a deliberate 3-15 s wait.

The same applies to test 1's stalling transaction, which C7's 2 000 ms poll keeps well inside the
default — but state the timeout explicitly there too rather than relying on the margin.

**Test 0 — the locked recompute runs at all (R1/MF-1). First test in the file.** Seed one session
with one `FINAL_OUTPUT` event; call `recomputeSessionUsage(db, S)` **once**, against the real
database, with nothing instrumented; assert it returns `true` and that the session's stored columns
match the payload. Then call it a second time and assert `false` (no write when nothing changed).

This is trivial and it is the most valuable test in the file. It is the whole of MF-1's remedy reduced
to its cheapest check: one call exercises `SET LOCAL lock_timeout`, the `::int` parameter casts and the
`::text AS locked` return cast together. Without it, a `void`-deserialization regression surfaces only
as test 1 failing, where the reader will reasonably suspect the interleaving. And because the ingest
path swallows this exact throw (`app.ts:2517-2521`), no other test in the repo would catch it either:
the unit stubs return `[]` from `$queryRaw` and never touch PostgreSQL. It also settles §13 item 2 —
if the parameterised `::int` form is going to be rejected, it is rejected here, in the simplest
possible context.

**Test 1 — the interleaving.**

```
seed session S with FINAL_OUTPUT seq 1, payload {usage:{input_tokens:10}}
A = recomputeSessionUsage(stalling(db), S)      // stalls after its event read, holding the lock
await readIssued                                 // A has read; it saw one event
insert FINAL_OUTPUT seq 2, payload {usage:{input_tokens:20}}   // on the plain client
B = recomputeSessionUsage(db2, S)                // db2 = second PrismaClient on testDatabaseUrl
await (B settled  OR  a non-granted advisory lock appears)      // bounded, 2 000 ms / 20 ms — C7
release A
await both
assert stored inputTokens === 30
```

- The stalling wrapper is the `Proxy`-over-`$transaction` from `chain.dbtest.ts:214-239`, retargeted
  from `tx.run.findFirst` to `tx.sessionEvent.findMany`: call through, signal `readIssued`, `await`
  the gate, return the rows. Everything else on the `tx` passes through by `Reflect.get`.
- The blocked-lock poll filters on **`classid` only**, never `objid`: `pg_locks.classid`/`objid` are
  `oid` (unsigned), so a negative int4 key appears there as a large unsigned number, and comparing it
  naively silently never matches.

  ```sql
  SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = $1
  ```

- B must never reject unhandled: settle it into a variable with `.then(ok, err)` so the promise
  itself never rejects, then assert on the captured outcome after `await`.
- **Expected with the lock: 30.** Expected with the lock deleted:
  `{"expectedInputTokens":30,"storedInputTokens":10,"eventReads":2}` — A's stale absolute write lands
  last and `sameColumns` makes it permanent.
- Disconnect the second client in a `finally` (`chain.dbtest.ts:89-92` does this).

**Test 2a — the lock is actually taken** (cheap, and it localises a failure in test 1): open an
interactive transaction that takes `pg_advisory_xact_lock(CLASS, sessionUsageLockKey(S))` and holds
it; assert `pg_locks` shows one granted advisory lock for that class; release. This is what tells the
reviewer whether test 1 failed because the lock is missing or because the interleaving is wrong, and
it is what settles §13 item 3 (that a lock is visible in `pg_locks` from another connection at all).

**Test 2b — a contended recompute fails, and this is where §13 item 1 is settled (R1/SF-2).**
2a proves a lock is *visible*; it cannot prove a *second recompute* is actually made to wait, nor how
that wait ends — which is the open question §13 item 1 assigns to this test. So:

```
open tx on client 1; take pg_advisory_xact_lock(CLASS, sessionUsageLockKey(S)) directly; hold it
start = performance.now()
outcome = await recomputeSessionUsage(db2, S).then(() => "resolved", (error) => error)
elapsed = performance.now() - start
release client 1's transaction; disconnect db2 in a `finally`
assert outcome is an Error, never the string "resolved"
assert elapsed < 12_000                      // below Prisma's timeout: 15_000, above lock_timeout: 3_000
record, in an assertion message and a code comment, which of these was observed:
  55P03 (possibly wrapped in Prisma's P2010) at ≈3 s  -> lock_timeout DOES bound an advisory wait
  P2028 / transaction timeout at ≈15 s               -> it does NOT; Prisma's timeout is the only backstop
```

- `db2` is a second `PrismaClient` on `testDatabaseUrl`, the two-client shape of
  `chain.dbtest.ts:67-92` and `tasks.dbtest.ts:307-326`, including its
  `finally { await holder.$disconnect(); }` and the two explicit timeouts noted under **Harness**.
- **Assert the class of outcome, record the code.** The test must fail if the second recompute
  *succeeds* — that would mean no serialisation at all. It must **not** hard-assert `55P03`, because
  which code appears is precisely the thing that is unknown; pinning it would encode today's guess as
  tomorrow's requirement. Recording it in a comment is what closes §13 item 1.
- The reviewer measured `P2010` wrapping PostgreSQL `55P03` at ≈279 ms with a deliberately short
  `lock_timeout=200ms`, so the experiment is known to be practical. This test cannot shorten the
  timeout the same way — WI-3's `SET LOCAL lock_timeout = '3s'` runs *inside* the transaction under
  test and overrides any session-level default set beforehand — so it pays the full ≈3 s. That is
  acceptable: `test:db` runs at `--test-concurrency=1` and this is one test.
- Do not attempt to make the timeout injectable to speed this up. A configuration seam whose only
  consumer is a test is how the production value stops being the tested value.

**Test 3 — backfill resilience and the non-zero exit (C3/C4, R1/MF-3, R1/MF-4).** Seed three
sessions, each with a `FINAL_OUTPUT`. Drive **`runBackfillSessionUsageCli`** (not
`backfillSessionUsage` directly) with an instrumented client and captured `log`/`error`, so the
reporting path and the returned exit code are executed rather than read:

```
exit = await runBackfillSessionUsageCli({ db: failingFor(middle.id), log: lines.push, error: lines.push })
assert exit === 1
assert lines[0] === "scanned 3, updated 2, failed 1"
assert lines[1] contains middle.id
exit = await runBackfillSessionUsageCli({ db, log: …, error: … })       // plain client, repair pass
assert exit === 0  and  "scanned 3, updated 1, failed 0"
```

`updated 1` on the repair pass is not a typo: the two sessions that succeeded the first time now match
their stored columns, so `sameColumns` suppresses their writes; only the previously-failed session is
written. That asymmetry is itself evidence the recompute is an absolute repair and not a blind write.

**The injection must wrap the *inner* transaction client (R1/MF-3).** WI-3 moved the write to
`tx.session.update` inside `db.$transaction`, so a `Proxy` that replaces `session.update` on the
**outer** client is bypassed entirely — `recomputeSessionUsage` receives Prisma's native `tx`, no
failure is injected, and the test asserts `failed: 1` against a run in which nothing failed. Use the
repo's proven shape, `chain.dbtest.ts:218-239`, unchanged in structure:

```ts
const failingFor = (targetId: string) => new Proxy(db, { get(target, property, receiver) {
  if (property !== "$transaction") {
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;   // the bind is required
  }
  return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
    const sessionDelegate = new Proxy(tx.session, { get(sessionTarget, sessionProperty, sessionReceiver) {
      if (sessionProperty !== "update") return Reflect.get(sessionTarget, sessionProperty, sessionReceiver);
      return async (args: Parameters<typeof tx.session.update>[0]) => {
        if (args?.where?.id === targetId) throw new Error("value out of range for type integer");
        return tx.session.update(args);
      };
    } });
    const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
      return txProperty === "session" ? sessionDelegate : Reflect.get(txTarget, txProperty, txReceiver);
    } });
    return operation(instrumentedTx);
  }, options as any);
} }) as PrismaClient;
```

Three details that are load-bearing, all inherited from the prior art:

- **`value.bind(target)`** on the pass-through branch. `backfillSessionUsage` calls
  `db.session.findMany` on the outer client for its scan; an unbound delegate method called through a
  `Proxy` receiver breaks Prisma's internals.
- **Filter on `args.where.id`**, not on a call counter. The scan is ordered by `requestedAt`, so a
  counter silently retargets the moment seed timestamps change.
- **The throw rolls its transaction back**, which is exactly why the repair pass has something to
  repair. Do not "helpfully" catch it inside the proxy.

**Test 4 — the real script, a real process, a real exit code (R1/MF-4).** Test 3 proves the reporting
function; it cannot prove the three lines the script still owns (the import, the client construction,
the `finally` that must still `$disconnect`). Seed two sessions with `FINAL_OUTPUT` events, then spawn
the committed script against the scratch schema:

```ts
const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
const result = spawnSync(process.execPath, ["--import", "tsx", "prisma/backfill-session-usage.ts"], {
  cwd: dbDirectory,
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },   // the script's PrismaClient reads DATABASE_URL
  encoding: "utf8",
});
assert.equal(result.status, 0);                              // a REAL exit code, not a read constant
assert.match(result.stdout, /scanned 2, updated 2, failed 0/);
```

- This spawn shape is not invented: `testdb.ts:32-48` already runs `npx prisma` with
  `cwd: packages/db` and `env: { ...process.env, DATABASE_URL: testDatabaseUrl }` in this same
  harness, so both the working directory and the environment override are proven here.
- `beforeEach` truncates every table (`testdb.ts:57-68`), so this test's counts are its own; it does
  not depend on test 3 having run.
- The failure path deliberately is **not** spawned: an injected `Proxy` cannot cross a process
  boundary, and after SF-1 no payload can force a failure (C4). Exit 1 belongs to test 3, exit 0 to
  test 4, and between them the whole of spec §7.2 item 5 is executed.
- If the spawn cannot be made to work in this monorepo layout, that is a finding, not a licence to
  drop it: record what failed in §13 and say plainly in the traceability table that the process exit
  code is unverified. Do not re-describe it as "covered by reading it" — that framing is what R1/MF-4
  rejected.

**Verification.**

```bash
npm run test:db
# then the deletion check, which must be run and then reverted:
#   remove the pg_advisory_xact_lock line from packages/db/src/usage.ts
#   npm run test:db     -> test 1 fails with storedInputTokens 10
#                       -> test 2b fails because the contended recompute now RESOLVES
#                       -> tests 0, 2a, 3, 4 and every other suite stay green
#   git checkout -- packages/db/src/usage.ts
```

Record, in the file's header comment, two things the run tells you and nothing else can: which error
code test 2b actually observed (§13 item 1), and that the parameterised `::int` form was accepted
(§13 item 2). Both are one-line comments and both close an open question.

**Requires.** A reachable PostgreSQL and a `TEST_DATABASE_URL` naming a non-`public` schema
(`testdb.ts:12-14` refuses `public`). The harness drops and re-applies that schema from the committed
migrations — it is never a copy of the live database, and no second API is ever pointed at it.

**Rollback.** New file; deleting it removes the proof and nothing else.

---

## WI-7 — the migration file: `IF NOT EXISTS` (MF-3b)

**Files.** `packages/db/prisma/migrations/20260816165548_batch4_session_usage/migration.sql`.

**Change.** Both `CREATE INDEX` become `CREATE INDEX IF NOT EXISTS`; the `ALTER TABLE` is untouched;
a header comment is added:

```sql
-- Batch 4 columns + two supporting indexes.
--
-- On a production-sized database the two indexes below are built OUT OF BAND with
-- CREATE INDEX CONCURRENTLY *before* this file is applied — see
-- docs/runbooks/batch-4-rollback.md. Prisma wraps each migration file in one
-- transaction and CONCURRENTLY cannot run inside a transaction, so it cannot live
-- here. `IF NOT EXISTS` is what makes this file a clean no-op for the index half on
-- a database where they already exist, keeps it complete for a fresh database, and
-- stops an index that survived a rollback from aborting the whole file on redeploy.
-- Edited after this migration was applied to the local dev database only (production
-- has not applied it); the one-time _prisma_migrations re-record step is in the runbook.
```

**Three things this buys, and one it does not.**

1. One ordinary `prisma migrate deploy` on production applies only the four columns, and Prisma
   records the migration itself — no `migrate resolve --applied` in the happy path.
2. A fresh database (local dev, the `.dbtest` schema, any rebuild) still gets both indexes, built
   instantly against an empty table.
3. The §2.3 redeploy trap is defused.
4. **It does not verify definitions.** `IF NOT EXISTS` matches on **name only**; an index with the
   right name and a wrong definition is silently accepted. `npm run db:drift-check` is what catches
   that, which is why it is a gate and a runbook step.

**Verification.**

```bash
npm run test:db                 # the harness drops the schema and re-applies every migration:
                                # proves the file is still valid on a fresh database
npm run db:drift-check          # must exit 0 (it compares live schema to datamodel; checksums are irrelevant to it)
psql "$TEST_DATABASE_URL" -c '\di'    # optional: both index names present in the test schema
```

**Do not run `npm run db:migrate` after this lands.** `migrate dev`/`migrate deploy` against the
*local dev* database will refuse a migration whose checksum changed after it was applied. That is
expected, is written into the runbook, and does not affect `test:db` (which drops the schema,
`_prisma_migrations` included) or `drift-check` (which never reads checksums).

**Rollback.** Revert the two `IF NOT EXISTS`. Safe **only** while production has still not applied the
file — after production applies it, reverting the text changes the checksum again and re-opens the
redeploy trap. Once applied in production, leave the file alone.

---

## WI-8 — `docs/runbooks/batch-4-rollback.md` (MF-3)

**Files.** `docs/runbooks/batch-4-rollback.md` (new). Follow the shape of
`docs/runbooks/batch-2.5-rollback.md`, whose §"Index locking during `db:migrate`" this document
extends rather than replaces — say so, and say what changed: batch 2.5 accepted a blocking build
because `Task` was small; `SessionEvent` is 70 672 rows / 122 MB with six runner processes streaming
into it, so batch 4 cannot.

**Required contents, in this order** (spec §4.5; contents are prescribed, wording is not):

1. **Version header** — version, the commit it was written against, the date it was last rehearsed,
   and against what (a scratch schema built from migrations — never a dump or clone of live).
2. **Deploy order** — spec §4.4.3 verbatim as the authoritative copy: pre-flight (`db:validate`,
   `\d+ "Session"` shows the four columns absent, `_prisma_migrations` has no `20260816165548` row,
   row counts) → two `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, **one `psql -c` per statement, never
   `psql -1`/`--single-transaction`** → prove `indisvalid` and `indisready` for both, with the
   `DROP INDEX CONCURRENTLY` + retry-when-quieter recovery for a false → `migrate deploy` under a
   `lock_timeout` of 3 s, **built as below**, with the `55P03` retry note and the by-hand
   `ALTER TABLE` + `migrate resolve --applied` fallback → `db:generate` + `db:drift-check` → **restart
   the API onto this batch's fixed code, never onto `2737113`** → `db:backfill-session-usage` twice,
   the second reporting `updated 0`.

   **Building the `lock_timeout` URL — do not append `?options=` (R1/MF-6).** The naive
   `DATABASE_URL="${DATABASE_URL}?options=-c lock_timeout=3s"` is wrong for any URL that already
   carries a query, which is this repo's own convention (`packages/api/src/testdb.ts:6-10` reads
   `?schema=…`). The second `?` is not a delimiter: it is absorbed into the preceding parameter's
   value, so `schema` silently becomes `agentos_test?options=-c lock_timeout=3s` — the timeout is
   never installed **and the migration is aimed at a schema that does not exist**. Detect the query
   first and pick the separator:

   ```bash
   case "$DATABASE_URL" in *\?*) SEP='&';; *) SEP='?';; esac
   MIGRATE_URL="${DATABASE_URL}${SEP}options=-c%20lock_timeout%3D3s"

   # Verify what was actually built, WITHOUT printing the URL (it carries the password):
   MIGRATE_URL="$MIGRATE_URL" node -e '
     const u = new URL(process.env.MIGRATE_URL);
     console.log("params:", [...u.searchParams.keys()].join(","));
     console.log("options:", u.searchParams.get("options"));
     console.log("schema:", u.searchParams.get("schema"));'
   # expect  params: schema,options   (or just `options` on a bare URL)
   #         options: -c lock_timeout=3s      <- decoded, with a real space and a real `=`
   #         schema:  <unchanged, or null>    <- if this grew a `?`, STOP

   DATABASE_URL="$MIGRATE_URL" npx prisma migrate deploy
   ```

   Percent-encode by hand (`%20`, `%3D`) rather than letting `URLSearchParams.set` do it:
   `URLSearchParams` serialises a space as `+`, and a generic URL query parser — which is what
   Prisma's connection-string handling is — does not decode `+` back to a space, so the option would
   reach PostgreSQL as the literal `-c+lock_timeout=3s`. The `case` form is also plainly readable in a
   runbook, which matters more than elegance at 2 a.m.

   `PGOPTIONS` is **not** an alternative here: Prisma connects with its own Rust driver rather than
   libpq, so libpq's environment variables are ignored.
3. **Why the restart order is what it is** — the live ingest path (`app.ts:2519`) uses the same
   extractor, so an API restarted onto the merged-but-unfixed code starts writing under-counted
   totals for every finishing CLAUDE session immediately, and those rows look self-consistent to
   `sameColumns`.
4. **Preferred rollback: revert the code, leave the migration applied.** Stated first and stated as
   the default. Four nullable columns no old code reads are inert; both indexes are on pre-existing
   columns, so old code either benefits from them or ignores them.
5. **The inherited ordering rule** (`docs/specs/batch-4-sessions-viewer.md:652-658`):
   `GET /runs/:runId/events` returns an envelope in batch 4 — revert API and web together, or the API
   alone; **never the web app alone while keeping the new API**.
6. **Exceptional physical rollback** — indexes first with `DROP INDEX CONCURRENTLY IF EXISTS` outside
   any transaction (so a failure leaves the columns intact), then the four columns in one bounded
   `BEGIN; SET LOCAL lock_timeout='3s'; ALTER TABLE … COMMIT;`. **`Session.costUsd` predates this
   migration** (it is in `20260815000000_phase0_init`, not in `20260816165548`'s `ALTER TABLE`) —
   dropping it destroys data no backfill in this batch restores. Say that explicitly, in bold.
7. **`npx prisma migrate resolve --rolled-back 20260816165548_batch4_session_usage`** plus the
   verification `SELECT` showing `rolled_back_at`, and why it is mandatory: without it the next
   `migrate deploy` skips a migration whose objects no longer exist.
8. **Drift after rollback** — against the pre-batch-4 checkout (whose `schema.prisma` declares neither
   the columns nor the two indexes), `db:drift-check` exits 0. State the pairing rule: a physical
   rollback is complete only when the checked-out datamodel and the live schema agree, so the schema
   rollback and the code rollback are one step, not two.
9. **A proven forward redeploy** — re-checkout, re-run deploy steps 1-4, `migrate deploy` applies
   cleanly even if an index survived, thanks to WI-7.
10. **What the backfill actually is** — "an absolute recompute from `SessionEvent` of every session
    that has a `FINAL_OUTPUT` event; it overwrites any populated cache that differs from the
    recomputed value, and writes nothing when they match." Not "write-only-to-null".
11. **The dev-database checksum note** — delete that migration's row from `_prisma_migrations` then
    `prisma migrate resolve --applied 20260816165548_batch4_session_usage`, or `migrate reset` on a
    disposable dev database.
12. **Rehearsal rule** — rehearse on a scratch schema built from migrations with fixture rows only
    (`packages/api/src/testdb.ts`, which refuses `public`; `npm run db:fixture -w @agentos/db` seeds
    rows). **Never against a dump or clone of the live database, and never with a second API pointed
    at it**: a clone still lists the live runs as `RUNNING` with runtime handles the second control
    plane does not own, whose reconciler classifies them as orphans and deletes their workspaces.
    Learned by destroying a workspace on 2026-08-16.

**Never inline a credential.** `"$DATABASE_URL"` everywhere; no connection string, no `OPERATOR_TOKEN`,
no password in this file, in any commit message, or in any task output.

**Verification.** The rehearsal of §7.3, run against a scratch schema, proving in order: indexes build
concurrently and report `indisvalid = true` → `migrate deploy` applies the columns and records the
migration → `db:drift-check` exits 0 → backfill runs twice, second reports `updated 0` → rollback
drops indexes then columns → `migrate resolve --rolled-back` records it → drift-check against the
pre-batch-4 datamodel exits 0 → forward redeploy applies cleanly. Record the date and result in the
version header.

Rehearse the `migrate deploy` step **twice: once with a bare `DATABASE_URL` and once with a
`?schema=…` URL** (R1/MF-6). The second shape is the one the naive `?options=` append corrupts, and it
is the shape this repo actually uses; a rehearsal that only ever exercises a bare URL would have
passed while shipping the bug.

**The rehearsal is a gate, not a disclosure (R1/MF-5).** An earlier draft of this plan said that if no
scratch database were reachable, WI-8's header should say "not rehearsed" and the work could proceed.
That is wrong, and it is the failure mode the whole runbook exists to prevent: spec §7.3 requires the
rehearsal *before the operator runs the sequence*, and spec §10 DoD item 5 makes "rehearsed on a
scratch database per §7.3" part of done. A truthful header on an unproven rollback procedure is still
an unproven rollback procedure heading for production.

So:

- Honest header wording stays mandatory — never date a rehearsal that did not happen.
- **"Not rehearsed" is a failed implementation gate.** If the rehearsal cannot be run, the
  implementation step reports **FAIL** with the reason, records it as an open question in its
  deliverable and the activity log, and does **not** report the DoD satisfied. It does not wait for a
  human (the chain's standing rules), and it does not waive the criterion by describing it.
- This is not an expected outcome. The reviewer ran `npm run test:db` in this chain's environment and
  watched it rebuild `agentos_test` and apply all 12 migrations. If `test:db` runs, the rehearsal
  harness exists. A rehearsal skipped for convenience is the one thing this item forbids.
- **The rehearsal target is a scratch schema built from migrations, and nothing else.** Never a dump
  or clone of the live database, never a second API pointed at one (item 12). "I could not get a
  scratch schema" is a FAIL; "I rehearsed against a clone instead" is the incident of 2026-08-16.

**Rollback.** A document. Deleting it loses the procedure; it changes no behaviour.

---

## WI-9 — the documentation corrections (§4.6)

**Files and exact anchors** — all re-verified at `95937bc`:

| file:line | correction |
|---|---|
| `packages/db/src/usage.ts:133-136` | the "two concurrent callers would still converge" invariant → the advisory-lock invariant. **Done inside WI-3**; listed here for traceability. |
| `docs/plans/batch-4-sessions-viewer-plan.md:478-482` | "last writer wins … they converge … a performance note rather than a correctness requirement" → serialised by an advisory lock, because absolute writes from different snapshots do not converge; it is a correctness requirement. Add a dated note naming this batch. |
| `docs/plans/batch-4-sessions-viewer-plan.md:485` | stale pointer `packages/api/src/app.ts:1770-1787` → `2507-2523`. **C6, beyond the spec's letter**; this is the pointer that became the brief's "~1790". |
| `docs/specs/batch-4-sessions-viewer.md:659-663` | §10 item 4 gains the two indexes and points at `docs/runbooks/batch-4-rollback.md` for the real procedure. |
| `docs/specs/batch-4-sessions-viewer.md:664-665` | §10 item 5's "idempotent and write-only-to-null" → WI-8's item 10 wording. |
| `docs/specs/batch-4-sessions-viewer.md:634-635` | §9 item 9's backfill expectation, aligned with the deploy sequence: run it twice, the second reports `updated 0` **and exits zero**. |
| `packages/api/src/usage.test.ts:6-7` | the "pasted from samples" comment, once it is true. **Done inside WI-5.** |
| `packages/api/src/app.test.ts:1078-1079` | say the fixture stays trimmed *on purpose* — it is the `modelUsage`-absent case that keeps the fallback branch covered. **C6; done inside WI-5.** |

**Amend, do not silently rewrite.** `docs/specs/batch-4-sessions-viewer.md` is an approved document:
each corrected paragraph carries a dated note that batch 4 FIXES superseded it, with a pointer to
this batch's spec. Same for the batch 4 plan.

**Verification.**

```bash
grep -n "would still converge\|write-only-to-null\|performance note rather than" \
  packages/db/src/usage.ts docs/plans/batch-4-sessions-viewer-plan.md docs/specs/batch-4-sessions-viewer.md
# expect: no output outside a quoted "this used to say" note
grep -rn "app.ts:1770" docs/     # expect: no output
```

**Rollback.** Documents only.

---

## 10. Requirement → work-item traceability

| spec requirement | work item(s) | check |
|---|---|---|
| §4.1.1-4.1.2 advisory-lock serialisation, signature unchanged | WI-3 | `test:db` **test 0** (the locked recompute runs against a real database at all — R1/MF-1), **test 1** (the interleaving), **test 2b** (a contended recompute is actually made to wait); `typecheck` proves the signature |
| §4.1.3 ingest stays non-fatal | WI-3 (comment only) | `app.test.ts:1154` "a failing usage recompute does not fail the ingest" still green |
| §4.1.5 stub scaffolding; both false invariants corrected | WI-5, WI-3, WI-9 | `npm test`; §9's greps |
| §4.2.1 `modelUsage` branch, exclusive, camel/snake split, fallback intact | WI-2 | WI-5's four branch tests |
| §4.2.2 545/98/8768/643 and 535/20/2969/555 | WI-2, WI-5 | `npm test -w @agentos/api` |
| §4.2.3 complete untrimmed fixtures | WI-5 | reviewer diffs fixture against the sample |
| §4.2.4 blocks the restart, not just the backfill | WI-8 item 3 | the runbook states the order |
| §4.2.5 no UI change | — | §11.2's diff-surface script (R1/SF-1 — it exits non-zero on a violation, unlike the draft it replaces) |
| §4.3.1 token validation | WI-1 | WI-5 rejection table |
| §4.3.2 summed-value validation | WI-1 | WI-5 summed-overflow test |
| §4.3.3 cost guard (A2), **rejection per event** | WI-1 + C8 + R1/MF-2 | WI-5's three cost tests: the guard, the mixed invalid-plus-valid event (per-event rejection), and the aggregate overflow across individually-valid events |
| §4.3.4 backfill resilience and summary | WI-4 | WI-6 **test 3** — drives `runBackfillSessionUsageCli` with a `Proxy` that wraps the **inner** transaction client (R1/MF-3), asserting `scanned 3, updated 2, failed 1` then the repair pass |
| §4.3.4 backfill **exits non-zero** | WI-4 | WI-6 **test 3** asserts the returned exit code is `1`, and **test 4** spawns the real script and asserts a real `result.status` of `0` (R1/MF-4). Not "covered by reading the source". |
| §4.4.2 `IF NOT EXISTS` + header comment | WI-7 | `test:db` (fresh-schema apply), `db:drift-check` |
| §4.4.3 operator sequence | WI-8 item 2 | the §7.3 rehearsal, run against a scratch schema, in **both** URL shapes (bare and `?schema=…` — R1/MF-6). **Unrehearsed = FAIL**, not a header disclaimer (R1/MF-5). |
| §4.4.4 drift-check still passes | WI-7 | `npm run db:drift-check` |
| §4.5 rollback runbook, 9 required contents | WI-8 | §12 of the runbook itself |
| §4.6 five documentation corrections (+2 found here) | WI-9 | §9's greps |
| §5 no schema change, no API change | all | `git diff --name-only` excludes `schema.prisma`, `apps/web` |
| §7.1 five gates | §11.2 | all green after rebase |
| §7.2 six behavioural checks | WI-5, WI-6, WI-8 | as listed |
| §10 DoD 1-8 | §11.2 + WI-6 + WI-8 | — |

Nothing in spec §6 (out of scope) is implemented: no per-model storage, no summed `costUSD`, no
PI/CODEX usage collection, no retrofitted locking elsewhere, no production migration, no restart.

---

## 11. Order, dependencies, migration and restart steps

### 11.1 Order

```
WI-1 ──► WI-2 ──► WI-3 ──► WI-4        (all in packages/db/src/usage.ts; strictly sequential)
                     │        │
                     └──► WI-5 ◄───────┘   (unit tests; needs WI-3 for the stub, WI-2 for the numbers)
                              │
                              └──► WI-6    (dbtest; needs WI-3 and WI-4)

WI-7 ──► WI-8                              (independent of the code track; WI-8 quotes WI-7)
WI-9                                       (any time; WI-3 and WI-5 do their own two entries)
```

Hard dependencies, and why:

- **WI-1 before WI-2**: `extractModelUsage` calls `tokenCount`.
- **WI-3 before WI-5**: the stub scaffolding is only meaningful once `$transaction` is actually
  called; landing WI-3 alone leaves `npm test` red, so do not stop between them.
- **WI-4 before WI-6 tests 3 and 4**: test 3 imports `runBackfillSessionUsageCli` from `@agentos/db`
  (not `backfillSessionUsage` — R1/MF-4 moved the assertion onto the returned exit code), and test 4
  spawns the rewritten `prisma/backfill-session-usage.ts`.
- **WI-7 before the first `npm run test:db` of the session is *not* required** — the harness applies
  whatever migrations are committed either way.

Everything else is order-free. `npm test -w @agentos/api` runs `pretest` = build `@agentos/db`, so the
API tests always see the current `usage.ts`.

### 11.2 The gates, and when

After the whole diff, on a rebase onto the latest `origin/master` (spec §8 — two other chains are in
flight; `db:drift-check` is the one that can go red from someone else's migration):

```bash
npm run build
npm test
npm run test:db
npm run typecheck
npm run db:drift-check      # exit 0
```

`npm test` does **not** run `*.dbtest.ts`; an acceptance run without `npm run test:db` is incomplete.
Re-run all five **after** the rebase, not just before.

Diff-surface checks, which are cheap and catch the constraints most likely to be violated. **Run this
as a script, not as three interactive lines** (R1/SF-1): the previous draft used a PCRE negative
lookahead that `grep -E` cannot parse — this workspace's grep answers it with
`error at position 7 … invalid syntax`, and BSD grep with `repetition-operator operand invalid` — and
wrote the other two as `grep … && echo "VIOLATION"`, which **exits zero when a violation is found**.
A gate that reports success on the failure path is worse than no gate.

```bash
#!/usr/bin/env bash
set -uo pipefail
fail=0
report() { printf '\nVIOLATION: %s\n%s\n' "$1" "$2"; fail=1; }

# apps/web and schema.prisma: two explicit filters, no lookahead.
web=$(git diff --name-only origin/master...HEAD | grep -E '^apps/web/' || true)
[ -n "$web" ] && report "apps/web is in the diff (spec §5)" "$web"

schema=$(git diff --name-only origin/master...HEAD | grep -E '(^|/)schema\.prisma$' || true)
[ -n "$schema" ] && report "schema.prisma is in the diff (spec §5)" "$schema"

# A NEW migration folder. WI-7 only MODIFIES 20260816165548_batch4_session_usage,
# so filter on added files and then exclude that folder — this is the lookahead,
# spelled portably.
added=$(git diff --name-only --diff-filter=A origin/master...HEAD \
        | grep -E '^packages/db/prisma/migrations/' \
        | grep -v '^packages/db/prisma/migrations/20260816165548_batch4_session_usage/' || true)
[ -n "$added" ] && report "a new migration folder was added (spec §5)" "$added"

# Credentials. Report a COUNT and the touched files, never the matching line:
# printing the match would write the secret into the terminal, the CI log and
# whatever artifact captures them — the exact thing this check exists to stop.
secrets=$(git log origin/master..HEAD -p | grep -ci 'operator_token' || true)
if [ "$secrets" -gt 0 ]; then
  report "OPERATOR_TOKEN appears $secrets time(s) in the diff" \
         "$(git diff --name-only origin/master...HEAD)"
fi

[ "$fail" -eq 0 ] && echo "diff surface OK: no apps/web, no schema.prisma, no new migration, no credential"
exit "$fail"
```

`|| true` after each `grep` is required under `pipefail`: grep exits 1 when it matches nothing, which
is the *success* case here. `set -e` is deliberately not used for the same reason.

### 11.3 Migration and restart steps

**No schema change and no new migration folder.** The only migration edit is WI-7's `IF NOT EXISTS`
plus a comment; `schema.prisma` is untouched, so there is no Prisma enum change, no `db:generate`
requirement beyond the existing one, and no client-regeneration ordering problem.

**Implementer-side (this chain):**

- Do **not** run `npm run db:migrate` after WI-7 (§WI-7, A4). Use `npm run test:db`, which drops and
  re-applies the dedicated test schema.
- If the local dev database is needed for anything after WI-7, apply the one-time re-record from
  WI-8 item 11, or `prisma migrate reset` if that database is disposable.
- `npm run db:generate` is unaffected (no datamodel change) but is harmless.

**Operator-side (NOT this chain — WI-8 owns the authoritative copy):** pre-flight → two
`CREATE INDEX CONCURRENTLY` out of band, one `psql -c` each → prove `indisvalid` → `migrate deploy`
under `lock_timeout=3s`, with the URL **built by the separator-detecting form in WI-8 item 2, never by
appending `?options=`** (R1/MF-6: appending a second `?` to this repo's `?schema=…` URLs swallows the
timeout and redirects the migration at a nonexistent schema) → `db:generate` + `db:drift-check` →
**restart the API onto this batch's fixed code** → `db:backfill-session-usage` twice, the second
reporting `updated 0` and exiting zero.

**Restart step, stated plainly:** the API must be restarted **after** the migration and **onto code
that contains WI-2**. Restarting onto `2737113` (batch 4 as merged) starts writing under-counted
totals immediately and those rows look self-consistent to `sameColumns`, so only a later backfill
corrects them. This chain never performs the restart, never touches launchd, never touches the runner.

### 11.4 PR mechanics

One chain, one branch, one PR. Branch `agentos/cmswjrnbw0t4ampyj86lr3ymb/run-1` and its successors;
**do not merge anything**. Rebase onto the latest `origin/master` before the final push and re-run all
five gates afterwards.

---

## 12. Rollback, per section

| section | rollback | leaves behind |
|---|---|---|
| WI-1 SF-1 validation | revert `usage.ts` hunks | nothing; rejected values were never written |
| WI-2 `modelUsage` | revert `extractUsage` | **rows already corrected by a backfill keep the corrected values** until the next recompute rewrites them downward. No schema implication; note it in the runbook. |
| WI-3 advisory lock | delete the two raw statements and the `$transaction` wrapper | nothing — transaction-scoped locks vanish with the transaction |
| WI-4 backfill | revert both files | nothing; the script's name, arguments and idempotence never changed |
| WI-5 / WI-6 tests | delete | loses the proof, not the behaviour |
| WI-7 migration text | revert the two `IF NOT EXISTS` — **only while production has not applied the file**; afterwards leave it alone (a second checksum change re-opens the redeploy trap) | possibly a `_prisma_migrations` checksum mismatch on the dev database |
| WI-8 runbook | delete the file | loses the procedure |
| WI-9 doc corrections | revert | restores false statements; do not roll this back independently of WI-3 |

**Whole-batch rollback** is a code revert: nothing in this batch writes schema, and nothing writes
state that a revert cannot tolerate. The one asymmetry is WI-2's corrected numbers, above.

---

## 13. Where this plan is guessing

Ordered by how much a wrong guess costs. Each names how to settle it — by running, not by reading.

1. **Whether `lock_timeout` bounds an advisory-lock wait.** PostgreSQL documents `lock_timeout` for
   locks on "a table, index, row, or other database object"; whether an advisory lock counts is an
   implementation detail the docs do not promise. The plan therefore treats it as best-effort and
   makes Prisma's `timeout: 15_000` the real backstop — and WI-6 must not *depend* on either
   (C7 keeps the poll at 2 000 ms). **Settle it in WI-6 test 2b** (R1/SF-2), which exists for this
   purpose: hold the lock, start a second *real* recompute, and record which error ends it and after
   how long (`55P03`, possibly wrapped in `P2010`, at ≈3 s = the timeout works; `P2028` at ≈15 s = it
   does not). 2b asserts only that the contended recompute **fails**; the code goes in a comment,
   because pinning today's code as an assertion would make an answer out of the question.
2. **Prisma's raw-SQL behaviour around the lock statement — one half now known, one half still open.**
   - *Return-type deserialization: **no longer a guess. It fails.*** The review probed Prisma 6.19.0
     against `agentos_test`: a bare `SELECT pg_advisory_xact_lock(…)` raises `P2010`, *"Failed to
     deserialize column of type 'void'"*, and `pg_advisory_xact_lock(…)::text AS locked` returns a
     row. WI-3 carries the cast for that reason. This revision could not re-run the probe (no `.env`,
     no generated client in the revision workspace), so **WI-6 test 0 is the confirmation** — and it
     is also the permanent regression guard, because nothing else in the repo would catch the cast
     being "simplified" away: the unit stubs return `[]` from `$queryRaw` and the ingest path swallows
     the throw.
   - *Numeric parameter typing for `${…}::int`: still open.* `tx.$queryRaw` inside a transaction is
     proven at `workflow.ts:87`, and `testdb.ts:60-64` binds a string the same way, but neither binds
     a **number**. A JS number may arrive as `int8`, `numeric` or `double precision`; all three cast
     to `int4`, so this should work. **Settle it** in WI-6 test 0, the simplest context in which it
     can fail. The documented fallback (`$executeRawUnsafe` with the two integers interpolated) is in
     WI-3 and must not be adopted before the parameterised form is seen to fail — and if it is
     adopted, note that it moots the first half of this item too.
3. **`pg_locks` visibility of the queued lock.** The poll assumes a waiting `pg_advisory_xact_lock`
   appears as `locktype='advisory' AND NOT granted` on the *same database*. Standard behaviour, and
   the test schema shares the database with the poller. If the row never appears, the test still
   terminates (the 2 000 ms deadline) and still asserts 30 — it just loses its determinism guarantee
   in the blocked branch. **Settle it** by asserting, in test 2a, that the granted row is visible.
4. **`console.warn` as the diagnostic channel.** The spec says "a one-line diagnostic" and does not
   name a channel. `console.warn` matches `app.ts`'s `console.error` habit and is swappable in a test.
   The cost: a corrupt-payload *class* failure logs per field per session during a backfill. Accepted;
   the 20-id cap in WI-4 bounds the *summary*, not the diagnostics. If that proves noisy in the
   rehearsal, the cheapest fix is to log at most once per field per `extractUsage` call.
5. **Whether the rehearsal (spec §7.3) can run in this chain's environment.** It needs a scratch
   PostgreSQL schema. The evidence says yes: the reviewer watched `npm run test:db` rebuild
   `agentos_test`, apply all 12 migrations and pass the existing database suites. (Note that the
   *revision* workspace had neither `.env` nor a generated Prisma client, so environments in this
   chain differ — check, do not assume, and do not assume the negative either.)
   **If it cannot run, that is a FAIL, not a footnote (R1/MF-5).** The header never carries a date for
   a rehearsal that did not happen, and the step does not report the DoD satisfied on the strength of
   having disclosed the gap. Under no circumstances rehearse against a dump or clone of the live
   database, or point a second API at one.
6. **Exact fixture size in `usage.test.ts`.** The two complete captures are large (≈40 lines of JSON
   each). If the file becomes unreadable, the alternative is importing them from the sample files at
   test time — but that trades "the fixture is visible next to its assertion" for "the fixture cannot
   drift", and the spec explicitly wants the pasted object. Pasting is the plan; note the trade.
7. **`app.test.ts`'s three ingest tests need only stub scaffolding.** Reasoned from the code (their
   fixture has no `modelUsage`, so WI-2 routes it to the unchanged fallback), not observed. **Settle
   it** by running `npm test -w @agentos/api` immediately after WI-3 + WI-5's scaffolding: if any of
   the three needs a changed *expectation*, stop and re-read WI-2 — that is a defect in the fix, not
   in the test.
8. **The advisory-lock class number `20260816` is unused.** Verified: no `pg_advisory` call exists
   anywhere in `packages/` today. If one appears from another in-flight chain during the rebase, the
   registry comment in WI-3 is where the collision gets resolved.

---

## 14. Open questions carried forward (recorded, never blocking)

1. **A1 — the retrospective review file is still missing.**
   `docs/reviews/2026-08-16-batch-4-sol-retro-review.md` is absent from the working tree and from
   `origin/master` at `95937bc`; it exists only as the output of task `cmswiyqdi0s9xmpyj6qlwa08f`. The
   brief quotes its findings verbatim and every one was re-verified independently — in the spec and
   again here (§0.1) — so neither document depends on it. **If the review carries a fourth finding or
   a caveat the brief did not transcribe, this plan has missed it.** Cheapest fix: commit the review
   file and have the implementation step (⑤) re-read it before starting. Recorded in the activity log;
   `inbox_ask` was not called, per the chain's standing rules.

   **R1 note:** this is about the *retrospective* review, which is still missing. The **plan** review
   that produced R1 is a different document and it is now committed at
   `docs/reviews/2026-08-16-batch-4-fixes-plan-review.md`, carried onto this branch by this revision
   so §0.4's citations resolve and ⑤ can read the eight findings in their own words rather than only
   through my summary of them. Two different reviews; only one of them is still missing.
2. **Does the operator want the cost guard (A2) at all?** It extends the review's letter, which named
   only token fields. If Leo prefers the letter, drop §4.3.3 / WI-1's `costColumn` range check —
   nothing else depends on it. The plan implements it, because a `Decimal(12,4)` overflow fails the
   write in exactly the same way an `INTEGER` overflow does.
3. **Per-model storage is deferred, and this batch is where it would hang.** `modelUsage` is summed
   into the existing four columns. If a per-model breakdown is ever wanted, `extractModelUsage` is the
   natural seam — but it is a schema change and a UI change, and is out of scope here (spec §6).
