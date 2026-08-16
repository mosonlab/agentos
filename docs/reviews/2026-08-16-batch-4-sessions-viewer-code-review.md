# CODE REVIEW — Batch 4: the sessions viewer (implementation)

**Artifact.** Branch `agentos/cmsvzm4cd0acempyjwpsydclw/run-1`, head `d1393ee`, eight commits on top of
plan revision 1 at `73d613a`. 26 files, +2603/−48.

**Verdict: PASS with 1 must-fix.** 1 must-fix, 7 should-fix.

This is not a cross-vendor review — the implementer and I are both Claude/Opus, per Leo's frontend
exception (decisions.md §12). Every claim below was re-derived from the diff, the source files, the
real captured CLI stdout, a re-run of every gate, and a real browser. The implement step's output,
the commit messages and the plan were read as claims, not as authority.

---

## What I re-derived rather than accepted

**Gates, re-run from a clean `npm install` in this workspace** (the implementer's numbers are
confirmed, not taken on trust):

| gate | result |
|---|---|
| `npm run build` | ✅ exit 0 |
| `npm test` | ✅ exit 0 — web **68**, api **157**, inbox **5**, runner **25** |
| `npm run typecheck` | ✅ exit 0 |
| `prisma validate` | ✅ `The schema at prisma/schema.prisma is valid` (run with a dummy `DATABASE_URL`; this workspace has no `.env`) |
| no new dependency | ✅ `git diff 73d613a..d1393ee -- package-lock.json` is empty; the only `package.json` changes are the two `db:backfill-session-usage` script lines |
| `db:drift-check` | **not run** — it requires a live `DATABASE_URL` and there is no Postgres or `.env` in this workspace. See the offline substitute below. |

**Offline substitute for the drift check, which is stronger for the question that matters.**
`prisma migrate diff --from-schema-datamodel <schema@73d613a> --to-schema-datamodel <schema@d1393ee>
--script` emits SQL **byte-identical** to the committed
`20260816165548_batch4_session_usage/migration.sql`. The migration is therefore exactly the schema
delta, unedited: four nullable `INTEGER` columns plus two `CREATE INDEX`. No `DROP`, no `NOT NULL`,
no data loss — BACKLOG-V2's destructive-migration precheck genuinely does not apply.

**Payload mappings, replayed through real captured stdout rather than fixtures.** I routed
`spikes/cli-capabilities/samples/pi-*.stdout` and `codex-*.stdout` through the adapter's own routing
and then through `normalize`:

- `pi-tool-event.stdout` → `messages: 1, toolCalls: 1`. The PI double-emission (2 × `message_end` +
  2 × `turn_end`) collapses to **one** message. The identity-keyed dedup (MF-8 of the plan review)
  works against real data, and the tool renders `bash printf 3 [ok] result=3` — PI's nested
  `result.content[]` extraction is correct.
- `pi-sigterm.stdout` → the unfinished tool reads `incomplete` on a terminal session. ✅
- `codex-auth-failure.stdout` → six `ADAPTER_ERROR` rows render with the adapter's own message text.
  ✅ (MF-6 of the plan review.)
- `codex-tool-event.stdout` → `agent_message` text plus the `final` fallback to the last agent
  message. The `command_execution` shape is still unobserved (the sandbox killed the sample's shell
  call), matching plan §11-G1 honestly.

**Adapter contract, read field by field** (`packages/runner/src/adapters.ts:193-320`): CLAUDE
`TOOL_STARTED` carries the `tool_use` **part**, `TOOL_COMPLETED` the `tool_result` part; CODEX
`TOOL_STARTED` carries the **item**, not the event; PI carries the **whole event**. `normalize`
reads each at the right level. No mismatch found.

**`costUsd` has no other writer.** `grep costUsd packages/{api,runner,db}/src packages/db/prisma`
returns nothing outside `usage.ts`, so `recomputeSessionUsage` cannot clobber a value another path
owns. The spec's founding observation holds.

**Vite env access.** Deviation 2 of the implement output (`import.meta.env` read as a whole object
with `?? {}`) is safe: a build with `VITE_API_URL=https://example.test/api` set emits
`{VITE_API_URL:"https://example.test/api"}` into the bundle. Configuration still works; this is not
a regression.

**Browser verification — real, and stated where it is partial.** I ran the app against a fixture
control plane on a spare port (`/tmp`, never committed, **no database of any kind** — the implement
step's incident rule respected: no second control plane, nothing pointed at the live DB). I captured
**one real screenshot** of `/sessions` in light theme; after I used `Emulation.setDeviceMetricsOverride`,
`Page.captureScreenshot` began timing out browser-wide and never recovered across fresh tabs and
fresh task spaces — the same failure the implementer reported, reproduced. Everything after that
point is live-DOM evidence: rendered accessibility tree plus computed styles read out of the running
page, not markup reasoning, but not a picture either.

What the browser confirmed:

- `/sessions` — 50 rows, `Load more` → **87** rows (exactly the fixture's total, no duplicates), the
  button disappears when exhausted; the nested Task link navigates to the task, a click anywhere else
  in the row opens the session.
- `/sessions/s-done` (finished CLAUDE) — `Done · 2 messages · 3 tool calls · 2 files · 52.8K tokens ·
  $6.12`; Branch resolves to `https://github.com/mosonlab/agentos/tree/agentos/impl/run-1`; the
  stream renders headings, bullets, inline code, a fenced block with its `ts` caption and a safe
  link; tool rows read `Read … ok`, `Bash … error`, `Edit … incomplete`; the `ADAPTER_ERROR` shows
  inline; `Files touched (2)` and `Debug events (13)` are collapsed.
- **Polling stop, measured**: over 12 s on a terminal session, **0** requests to `/runs/*/events`
  while metadata polling continued at 2.5 s. On the live session, 4 `/events` polls in the same
  window and the stream auto-pinned to the bottom (`scrollHeight − scrollTop − clientHeight === 0`).
  Spec §5.3's stop condition and §9 step 5 hold.
- Terminal/waiting/failed variants — `Failed` in the stat-bar lifecycle slot, `failureReason` as an
  `ErrorNotice`, `Resume attempts: 2`, and `Branch` as plain text when `repo` is null.
- `/tasks/t1` — `52.8K tokens` pill, `Tokens` column (`52.8K` / `—`), `Branch` and `Pull request →
  #44` as anchors, step output as markdown with the clamp measured at `max-height: 420px` over 1299 px
  of content, `[a hostile link](javascript:alert(1))` rendered as literal text with no anchor. The
  expanded run row shows `Session → Open session ↗` and **no** raw event table; clicking the branch
  anchor does not toggle the row.
- **Dark theme** — every value resolves from a token: body `rgb(11,10,7)` on `rgb(241,239,228)`,
  cards `rgb(32,29,18)`, code `rgb(203,199,182)` on `rgb(21,19,12)`, links `rgb(143,167,255)`, error
  text `rgb(255,155,160)` on `rgb(45,20,22)`, the amber `incomplete` marker `rgb(233,176,74)`.
  `grep -nE "#[0-9a-fA-F]{3,8}" apps/web/src/pages/Sessions.tsx` returns nothing, and
  `sessions.test.tsx` pins that.
- **Degradation** — a session id the API does not know renders `404 Session not found` with a
  `Retry`, not a blank page (§9 step 11).

**Test quality.** The new tests are not decorative. `event-stream.test.tsx` builds a hand-rolled
clock and drives the hook through initial drain, append-only polling, old-shape dedup, the 4-empty
backoff to the 15 s ceiling and its reset, the render ceiling, hidden-tab suspend/resume, error
retention, the terminal stop and `reload()` — one assertion per contract clause. `usage.test.ts`
stubs a stateful Prisma so a second recompute observes the first one's write, which is the only way
the idempotence claim is actually testable. `sessions.test.tsx` exercises real JSDOM clicks for
expansion, filtering, row-vs-link navigation and `Load more`. The `N new ↓` regression test stubs
`scrollHeight`/`clientHeight` because JSDOM has no layout, and the implementer's claim that it fails
with the guard removed is the right check to have made.

---

## Judgement per spec section

Each section stands or falls on its own, so a defect in one does not block another.

| spec § | verdict | note |
|---|---|---|
| §4.1 sessions list | **PASS** | columns, order, pills, project scoping, `Load more`, row/link click isolation all verified in the browser |
| §4.2 header + stat bar | **PASS** | lifecycle slot reads Live/Done/Failed; counts derive from normalized items. Deviation on orphan tool calls is §6-conformant and recorded as open question 4 |
| §4.3 message stream | **PASS** | verified against real PI and CODEX captures, not fixtures |
| §4.4 Files touched | **PASS with SF-2** | CLAUDE verified; the spec's verification duty for PI/CODEX is unmet and no ledger note was filed |
| §4.5 Debug events | **PASS** | moved, collapsed, `All/Provider/Runner` filter works; exactly one raw event table in the product |
| §4.6 cost and tokens | **PASS with MF-1** | extraction, recompute and backfill are correct and idempotent; the ingest **wiring** is unguarded and untested |
| §4.7 task detail | **PASS with SF-3** | markdown, clamp, branch and PR links verified; older runs' PRs become unreachable |
| §4.8 markdown | **PASS** | fences, language caption, unterminated fence, http/https-only links — all four browser- and test-verified |
| §5.1 API | **PASS** | routes, clamps, cursor, envelope, `remoteUrl`, 404 shape all pinned by tests I re-read |
| §5.3 polling contract | **PASS** | measured in a real browser, not inferred |
| §5.5 what must not change | **PASS** | `usePoll` untouched, `packages/runner` untouched, lockfile unchanged |
| §6 edge cases | **PASS with SF-5** | every row holds except the `WAITING_INBOX` notice |
| §7 non-functional | **PASS** | memo keyed on count, no virtualization, both themes token-clean |
| §8 tests | **PASS with SF-1** | every named test exists and asserts; the ingest seam is the one gap |
| §10 rollback | **PASS** | additive migration; the envelope's forbidden direction is the only hazard and it is documented |

---

## Must-fix

### MF-1 — A failure inside the usage recompute aborts run delivery and destroys the workspace

**Origin lens: risk (fourth pass, re-briefed onto the ingest seam).**

`packages/api/src/app.ts:1790` awaits `recomputeSessionUsage(db, run.session.id)` inside
`POST /runner/runs/:runId/events` with no error isolation. Follow what a throw does:

1. The route rejects → Hono's `onError` returns 500.
2. `packages/runner/src/api.ts:79` throws on any non-ok response, and `appendEvents` has **no
   retry** — the plan established this itself when it corrected MF-2 of the plan review.
3. `packages/runner/src/runner.ts:219` (`await flushEvents(); await eventWrites;`) therefore rejects.
   This is the **terminal** flush, the one carrying `FINAL_OUTPUT` — precisely the batch that
   triggers the recompute.
4. Control jumps to the outer catch at `runner.ts:266`, so `deliverWorkspace` and the success
   `completeRun` at `runner.ts:230-265` **never run**. Instead `runner.ts:283` calls
   `cleanup(config, workspace, config.failedWorkspaceRetention > 0)` and `completeRun` records
   `terminalSuccess: false, externalFailure: true, failureReason: "AgentOS API 500: …"`.

**Failure scenario.** An agent finishes successfully. Its terminal batch arrives. A transient
connection error, a lock timeout, or a `value out of range for type integer` on the update (Postgres
`INTEGER` caps at 2 147 483 647 while `cachedInputTokens` sums cache reads across every resume
attempt) makes the recompute throw. The run is recorded **FAILED**, its workspace is **deleted**, and
the branch is **never pushed** — the agent's work is gone, for a reason that has nothing to do with
the events themselves.

This contradicts the module's own design. `packages/db/src/usage.ts:118-126` states that
`SessionEvent` is the source of truth and the five columns are a derived cache that the next ingest
or the backfill repairs. A cache write that is repairable by design must not be fatal to the write
path it decorates.

**Remedy.** Isolate it:

```ts
if (body.events.some((event) => event.type === "FINAL_OUTPUT")) {
  // A derived cache must never fail an ingest: db:backfill-session-usage repairs it.
  try { await recomputeSessionUsage(db, run.session.id); }
  catch (error) { console.error(`Session usage recompute failed for ${run.session.id}`, error); }
}
```

Add one API test: a stubbed `session.update` that throws still yields `{accepted: n}` with 200.

---

## Should-fix

### SF-1 — Nothing tests that the ingest actually calls the recompute
**Lens: quality (test coverage).** `packages/api/src/usage.test.ts` covers `extractUsage`,
`sumUsage`, `deriveUsageColumns` and all four `recomputeSessionUsage` properties thoroughly, and
`app.test.ts` covers the three new read routes. No test touches `app.ts:1786-1791`. Delete those five
lines and the entire 255-test suite stays green — the feature's only production write path is
unguarded by the gate. **Remedy:** an `app.test.ts` case posting a runner batch containing a
`FINAL_OUTPUT` against a stub `PrismaClient`, asserting `session.update` was called with the derived
columns; and a second asserting no update fires for a batch without one. Combine with MF-1's throw
test.

### SF-2 — §4.4's verification duty is unmet and no BACKLOG-V2 ledger note was filed
**Lens: scope (a silently dropped requirement).** Spec §4.4 obliges the implementer to check the PI
`args` and CODEX `file_change` shapes against a real session and, if a shape does not verify, to
render the honest hint **and file a ledger note in BACKLOG-V2**; §4.6.5 / assumption A4 requires the
same note for PI usage. `git diff 73d613a..d1393ee -- docs/` is **empty** — no ledger note exists, and
the discovered fact that PI does report usage as
`message.usage.{input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost.total}` lives only in a
task output that the repo will not carry forward. Separately, `apps/web/src/pages/Sessions.tsx:373-375`
emits the hint for **CODEX only**: a PI session whose arg keys do not match the three inferred names
shows `Files touched (0)` with no explanation. My replay of `pi-tool-event.stdout` could not settle
this either way — its only tool call is `bash`, which has no file argument, so §11-G2 remains open.
**Remedy:** extend the hint condition to `runner !== "CLAUDE"`, and add the two BACKLOG-V2 entries
(PI/CODEX path-shape verification; PI per-message usage and cost, with the shape recorded).

### SF-3 — A non-newest run's pull request becomes unreachable
**Lens: scope.** `apps/web/src/pages/TaskDetail.tsx:83` drops the PR anchor from the expanded run row
(spec §4.7.2 does sanction this as "the duplicated anchor"), while `TaskDetail.tsx:195` sources the
task-level `Pull request` entry from `runs[0]` alone. The two together are not equivalent: for a task
whose newest run has no PR — a retry, a review run, a run that failed before pushing — the earlier
run's PR is reachable from nowhere in the UI. Browser-confirmed against a two-run fixture: run #2's
`pull/43` appears on no surface. **Remedy:** restore a `Pull request` entry in the expanded run row's
`KeyValue` (distinct from `Push`, so nothing is duplicated), or relabel the task-level entry
`Latest pull request` and make it fall back to the newest run that has one.

### SF-4 — `compactTokens(999_999)` renders `1000K`
**Lens: quality.** `apps/web/src/lib/format.ts:60-61` tests the `M` threshold at exactly `1_000_000`,
so 999 999 divides to 999.999, rounds to `1000.0`, strips to `1000` and renders `1000K tokens` in a
stat pill — which reads as a formatting bug rather than a number. `markdown.test.tsx:58` currently
pins that output, so it must change with the code. **Remedy:** compare against the rounded value
(promote to `M` at ≥ 999 950), and update the assertion to `1M`.

### SF-5 — The `WAITING_INBOX` notice is missing its text and vanishes without a message id
**Lens: coherence.** Spec §6 requires "a notice above the stream: `Waiting on an Inbox decision.`
linking to `/inbox/:waitingOnMessageId` **when set**". `apps/web/src/pages/Sessions.tsx:390-394`
renders a bare link, and only when `waitingOnMessageId !== null`. A session parked in `WAITING_INBOX`
whose message id has not landed yet shows a `waiting` pill and nothing else — the one state where an
operator most needs to be told why nothing is happening. Browser-confirmed on a `WAITING_INBOX`
fixture. **Remedy:** always render the notice for `WAITING_INBOX`, wrapping it in the link only when
the id is present.

### SF-6 — `loadMore` swallows its errors
**Lens: quality.** `apps/web/src/pages/Sessions.tsx:112-125` is `try { … } finally { setLoadingMore(false) }`
with no `catch`. A failed older-page fetch leaves the button re-enabled, shows the operator nothing,
and surfaces as an unhandled rejection in the console. Every other fetch on the page routes through
`usePoll`'s error state or an `ErrorNotice`. **Remedy:** hold a `moreError` state and render the
existing `ErrorNotice` beside the button, with the button as the retry.

### SF-7 — The baseline-screenshot harness has no route for the batch's headline page
**Lens: coherence.** `docs/plans/baseline-screenshots/harness/server.mjs:200-228` serves the fixture
control plane the repo's own README uses to shoot light/dark reference frames. It has no `/sessions`
or `/sessions/:id` route, and its run fixtures carry no `session` object — so the new page cannot be
captured at all, and the task page shot would render `—` for Tokens and no `Open session ↗`. The
repo's visual-regression tool now has a blind spot exactly where this batch's UI lives. **Remedy:**
add the two session routes and a `session` object (with token columns) to the harness fixtures.

---

## Deviations from the plan: all four accepted

1. **`deriveUsageColumns` rounds cost to 4 dp** — correct and necessary. `costUsd` is
   `Decimal(12,4)`; without the rounding a freshly derived Decimal could never compare equal to the
   stored one and "the second backfill run updates nothing" would be unachievable. `usage.test.ts:107`
   pins `0.049117 → "0.0491"`.
2. **`lib/api.ts` reads `import.meta.env` as an object** — verified safe by an actual build; without
   it the required JSDOM hook test could not import the module under node.
3. **`ui.tsx` exports `SHOW_MORE_BUTTON` / `isLongText`** — makes WI-8's "the same control shape as
   `ShowMore`" literally true instead of a look-alike. Good.
4. **The `N new ↓` priming fix** — beyond the plan text, found by looking at the page, and correct:
   gating on the `loading` true→false *transition* rather than the value is the only version that
   works, because the hook starts `loading: false` while `runId` is still null.

## Open questions carried forward, unchanged and unresolved by this review

1. **A1** — the raw event table *moved*; the run row does not keep a copy. Implemented as the spec
   reads. Reversing is an addition.
2. **PI usage is real and untaken** — per-message on `message_end`/`turn_end`, so summing it
   double-counts against PI's duplicate emission. Needs SF-2's ledger note.
3. **G5** — `totalTokens = input + output` reads `81` for a CLAUDE run that processed ~8.8K tokens,
   because CLAUDE reports almost everything as cache. `cachedInputTokens` is stored separately, so
   including cache in the display is a UI-only change. Still worth one line from Leo.
4. **Spec §4.2 vs §6 on orphan tool calls** — §4.2 counts only tool calls with a `TOOL_STARTED`, §6
   says an orphan `TOOL_COMPLETED` counts. Implemented per §6, which is the only reading under which
   the stat bar cannot disagree with the stream. Two lines and one expectation to reverse.
5. **`reasoning_output_tokens` excluded from CODEX `outputTokens`** — under-reports CODEX against the
   provider's own billing. One line in `extractUsage` if that is wrong.

## Not run, stated rather than skipped

- `npm run db:drift-check` — needs a live `DATABASE_URL`; no Postgres and no `.env` in this
  workspace, and I would not point it at the live control-plane database. Substituted with the
  offline `migrate diff` above, which proves the committed migration is exactly the schema delta.
- Screenshots beyond the first — `Page.captureScreenshot` broke browser-wide mid-review, reproducing
  the implementer's report. All later visual claims are live-DOM and computed-style readings.
- The production migration and API restart remain the human's step; I touched neither, restarted
  nothing, and merged nothing.
