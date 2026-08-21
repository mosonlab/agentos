# Adjudication — runner: fail loudly when a runner CLI is unreachable

## Authority

| | |
|---|---|
| Recorded `implementation_range.base` | `9914a401d0f9fa94dbe9d8556a66bcbf46a7f4ce` |
| Recorded `implementation_range.head` | `29f687921d12552fc8aacb3804b3003a41b21d12` |
| Corrected base (see OPUS-15) | `0d5b93e` — parent of `ad8bc67`, the WIP salvage that carries the runner implementation |
| Pre-fix head, authoritative for the fix phase | `29f687921d12552fc8aacb3804b3003a41b21d12` |
| Governing specification | `.chain/runner-cli-availability-fail-loud/spec.md` |
| Revised slices | none — direct chain |

Both recorded commits resolve, and `29f6879` is an ancestor of the branch head.

## Report identities

| Report | File | Range reviewed | Findings |
|---|---|---|---|
| First reviewer (Sol) | `.chain/runner-cli-availability-fail-loud/reviews/sol-findings.md`, committed `f6f983d` | `9914a40..29f6879` as recorded; "No alternate base was substituted" | 1 P1 |
| Second reviewer (Opus, blind) | `.chain/runner-cli-availability-fail-loud/reviews/opus-blind-findings.md`, committed `3b377eb` | `0d5b93e..29f6879` plus the tree at `29f6879` | 2 P1, 13 P2 |

The Opus findings were written and committed at `3b377eb` before
`sol-findings.md` was opened. The commit order is the blind-review evidence.

The two reports used different ranges. Sol reviewed the recorded range, which
contains no `packages/runner` change; Opus reviewed the superset that includes
the runner daemon. The superset strictly contains the recorded range, so no code
Sol reviewed went unreviewed by Opus.

## Merge matrix applied

| Rule | Applied to |
|---|---|
| Same defect in both reports → adopt at the higher severity | none — the reports share no defect |
| Opus independent finding → retained by default | OPUS-1 … OPUS-15 |
| Sol-only finding → enters the list only after Opus verifies it against code and authority | SOL-STD-001 — verified below, adopted |
| One report identifies, the other explicitly rejects with evidence → stop and escalate | not triggered |

No contradiction arose. Sol's report records an absence of further findings
("no candidate findings" on the specification axis; "No P0, P2, or retained
Fowler smell judgement" on the standards axis) but never names or argues against
any Opus finding, and Opus never argues against SOL-STD-001. An absence of a
finding is not an explicit rejection with evidence, so no Inbox escalation was
opened and adjudication continued.

## Verification of the Sol-only finding

**SOL-STD-001 — verified, adopted at P1.**

Checked against the tree at `29f6879`:

1. `packages/api/src/app.ts:3357` — `const previous = await db.runnerBackendState.findUnique(...)`
   runs on `db`, not on a transaction client, and takes no row lock. Confirmed.
2. `packages/api/src/app.ts:3364` and `:3374` — both the `create` and `update`
   arms pass `preserveCliAvailability(body.capabilities, previous?.capabilities)`,
   which returns a whole replacement value for the `capabilities` JSON column
   derived from that stale snapshot. Confirmed.
3. `packages/api/src/app.ts:3287-3300` — `/runner/availability` reads and
   replaces the same column inside
   `{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }`.
   PostgreSQL SSI only orders conflicts among serializable transactions; the
   preflight read runs at the default READ COMMITTED level on a separate
   connection and its upsert is a separate implicit transaction, so no
   serialization failure is raised and last-writer-wins applies to the whole
   column. Confirmed.
4. Authority for the trigger: `README.md:229-231` — "Runner daemons remain
   ordinary clients, and any number of them may poll that one API." Confirmed
   verbatim. The trigger is also reachable in a single-daemon installation
   during a rolling restart: the outgoing daemon stops "after the current task"
   (`packages/runner/src/index.ts:78-80`) and its availability monitor keeps
   ticking while the incoming daemon runs its startup preflight.
5. Consequence chain confirmed. If preflight restores a stale `available: true`,
   `app.ts:3520` stops blocking and a task is claimed for a CLI that is not on
   the machine — the exact silent-unclaimed-to-silent-spawn-failure outcome this
   feature exists to prevent. The next heartbeat then reads
   `previousAvailability.available === true`, so
   `outageStarted` is true again and a **second** `InboxMessage` is created for
   one continuous outage, violating specification item 3. If preflight restores
   a stale `available: false` after recovery, claiming stays blocked for up to
   one further heartbeat with no blocked reason on any task, weakening item 4.
6. The window where preflight can also *drop* availability entirely is real and
   worse than restoring a stale value: when the stale `previous` carried no
   stored availability, `preserveCliAvailability` emits no `cliAvailability` key
   at all, `readStoredCliAvailability` returns `null`, and `app.ts:3520`'s
   `?.available === false` is false — claiming is permitted with no record that
   a probe ever ran.
7. `packages/api/src/runner-cli-availability.dbtest.ts:99-101` and `:161-166`
   post serially and cannot falsify the interleaving. Confirmed.

Severity retained at P1 as reported. It is a correctness violation that defeats
specification items 3 and 4 under a deployment the repository documents.

## Disposition of every finding

| ID | Reported by | Severity | Disposition |
|---|---|---|---|
| SOL-STD-001 | Sol | P1 | **Must-fix.** Verified against code and authority; adopted. |
| OPUS-1 | Opus | P1 | **Must-fix.** Retained. |
| OPUS-2 | Opus | P1 | **Must-fix.** Retained. |
| OPUS-3 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-4 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-5 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-6 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-7 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-8 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-9 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-10 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-11 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-12 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-13 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-14 | Opus | P2 | Recorded, non-blocking. Retained. |
| OPUS-15 | Opus | P2 | Recorded, non-blocking. Retained; the corrected base is carried in this document's Authority table, which is what the fix and regression phases use. |

Nothing was dropped, downgraded, or merged away.

## Must-fix list

Three findings, all P1. Full text: SOL-STD-001 in `sol-findings.md`;
OPUS-1 and OPUS-2 in `opus-blind-findings.md`.

All three land on the same seam — `capabilities` as a single JSON column that two
routes read-modify-write — so they must be fixed as one change, not three.

### MF-1 — SOL-STD-001 — `/runner/preflight` can overwrite a concurrent availability write

`packages/api/src/app.ts:3355-3381`, `packages/api/src/runner-cli-availability.ts:52-61`

Close the read-modify-write race on `RunnerBackendState.capabilities` between
`/runner/preflight` and `/runner/availability`, and add the deterministic
interleaving regressions Sol specified (delayed preflight write after a missing
report; the reverse ordering after a recovery report).

### MF-2 — OPUS-1 — the copied Feishu-thread block swallows an error inside a Serializable transaction

`packages/api/src/app.ts:3311-3320`

Stop swallowing `inboxThread.create` inside the transaction — the swallow cannot
recover anything once PostgreSQL has aborted the transaction, and it discards the
whole availability report along with the root cause. De-duplicate against
`app.ts:3385-3392` and carry that site's justifying comment into the shared
helper.

### MF-3 — OPUS-2 — an unvalidated reserved key wedges every route that reads it, with no repair path

`packages/api/src/runner-cli-availability.ts:20-42`, `:52-61`;
`packages/api/src/app.ts:933`, `:3289`, `:3364`, `:3374`, `:3520`

Strip `cliAvailability` from the client-supplied preflight `capabilities` before
merging, so only the availability path ever writes that subtree; and give
`/runner/availability` a mechanical cure for an unreadable stored document — log
loudly, then overwrite — so the loud failure is recoverable without hand-editing
PostgreSQL.

## Not must-fix

OPUS-3 through OPUS-15 are P2. They are recorded above and in
`opus-blind-findings.md` with locations, evidence and named fix directions. They
do not block. If the fixer touches an adjacent line anyway, OPUS-5 (unhandled
rejection in the heartbeat timer) and OPUS-3 (dead `check` parameter) are the two
cheapest; nothing else should be swept in, and no P2 may be used to widen the fix
diff.

## Test evidence at the pre-fix head

| Check | Opus (this session) | Sol |
|---|---|---|
| `typecheck` (`@agentos/api`, `@agentos/runner`) | pass | pass (harness) |
| `biome lint` / `eslint` on changed files | pass | pass (harness) |
| runner package tests, scratch `RUNNER_WORKSPACE_ROOT` | 155/155 | 155/155 |
| API unit tests | 411 pass, 1 skipped | 411 pass, 1 skipped |
| API dbtest suite | **not run** — no `.env` in the throwaway clone and the local PostgreSQL rejects the documented default credentials (`P1000`) | 332/332 |
| `npm run snapshot:scan` | pass, `unclassifiedFiles: 0` | — |
| `git diff --check` | — | pass |

Acceptance 4 is satisfied on Sol's dbtest run; the non-database half is
independently confirmed here. No lint, type or format failure was observed by
either reviewer.

## Instruction to the fix phase

Fix MF-1, MF-2 and MF-3 as one change on top of `29f6879`. Add the regressions
named in MF-1. Re-run: runner package tests under a scratch
`RUNNER_WORKSPACE_ROOT`, the API unit tests, and the API dbtest suite. Report the
exact fixed head. This list is closed — there is no open-ended review
instruction in it, and no finding outside it is in scope.
