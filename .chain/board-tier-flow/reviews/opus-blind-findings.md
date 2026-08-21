# Opus blind review — board tier-flow wiring

Reviewer: review-coordinator-opus, session `cmt28jgrp00pdmp4597991ziz`.
Written and committed before opening `sol-findings.md`.

## Range

- base: `45584af215b1e727316caf63e900d765d727aa91`
- head: `e387cac448854d0b033fada65e38024ed5e46099` (single commit `feat: add confirmed board task starts`)
- authority: `.chain/board-tier-flow/spec.md` at head. No `slices/` directory — direct chain, spec is the sole slice authority.
- Both objects resolve in the tree; `head` is an ancestor of the branch tip `3d3129f`.

## Tool results (not re-derived below)

Run at head in a clean install (`npm ci`, `npm run db:generate`, `npm run build -w @agentos/db`):

- `npm run typecheck` — exit 0.
- `npm run lint` (biome + eslint) — exit 0, 375 files.
- `npm run test -w @agentos/api` — 408 tests, 407 pass, 1 skipped, 0 fail.
- `npm run test -w @agentos/db` — 191 tests, 191 pass, 0 fail.
- `npm run test -w @agentos/web` — 362 tests, 360 pass, 2 fail. Both failures are
  `bundle-secrets.test.ts` and `styles.test.tsx`, which refuse to run without a
  prior `npm run build -w @agentos/web`; they fail identically at `base`. Not a
  finding.
- dbtest suites were not run: this workspace has no PostgreSQL and the repo's
  testing red lines forbid pointing them anywhere else. The dbtest baselines
  (db 67/67, api 320/320) are therefore **unverified by me**; OP-1 below predicts
  no dbtest failure, because no dbtest exercises the path it breaks.

## Findings

### OP-1 — P0 — `autoStart: false` strands the chain branch; every inert chain runs step ① on the wrong branch and wedges step ②

Axis: specification + standards (correctness).
Location: `packages/api/src/templates.ts:172-175`; consequence at
`packages/db/src/workflow.ts:336-346` (`resolveRunBranches`, template arm) and
`packages/runner/src/workspace.ts:160`.

Governing spec text (§1):

> "When false, all step tasks are created in TODO as today but nothing is
> enqueued; the chain is started later by starting its first step via
> POST /tasks/:id/start (which already handles chain steps)."

Evidence. The two lines the diff moved inside `if (input.autoStart ?? false)`
were the **only** place the chain branch was ever persisted:

```ts
const run = await enqueueTaskRun(tx, first.id);
await tx.run.update({ where: { id: run.id }, data: { branch: branchName } });
```

`branchName` is `input.variables.branchName ?? \`agentos/${chainId}\`` (templates.ts:108).
Step ①'s task row deliberately does **not** carry it — `targetBranch` for the
first step is `repo.defaultBranch` (templates.ts:167), so that step ① clones the
default branch rather than a ref that does not exist yet. Steps ②..n carry
`branchName` in `targetBranch`.

So when the chain is started later through `POST /tasks/:id/start`
(`packages/api/src/app.ts:2926`, `enqueueTaskRun`), `resolveRunBranches` gets a
template task whose `targetBranch === repo.defaultBranch` and no prior run:

```ts
const chainBranch = task.targetBranch && task.targetBranch !== task.repo.defaultBranch
  ? task.targetBranch : null;          // → null
return { branch: prior?.branch ?? chainBranch, ... };   // → branch: null
```

Executed against the built `@agentos/db` with a stub `tx`, with step ① and step ②
shaped exactly as `instantiateTemplate` writes them:

```
step ① first run  : { branch: null,             targetBranch: 'main' }
step ② first run  : { branch: 'board-tier-flow', targetBranch: 'board-tier-flow' }
```

Failure scenario, end to end:

1. Operator creates a chain from the New Task panel. `apps/web/src/components/new-task-panel.tsx:75`
   now sends `autoStart: false`, and the zod default is `false`
   (`packages/api/src/app.ts:501`), so this is the *only* path an operator has.
2. Operator drags step ① onto Doing and confirms. `POST /tasks/:id/start` queues
   a run with `branch: null`.
3. The runner names the workspace branch `agentos/<taskId>/run-1`
   (`workspace.ts:160`) and pushes step ①'s work there. The chain branch the API
   returned to the operator (`result.branchName`) exists nowhere.
4. Step ② resolves `branch = targetBranch = <branchName>`, and `provisionWorkspace`
   runs `git clone --branch <branchName>` against a ref nobody created
   (`workspace.ts:180-184`) → clone failure → run FAILED, and the retry resolves
   the same base every time.

This is the exact failure `resolveRunBranches`' own header names: "five copies of
the expression is how step ① ended up on a different branch from steps ②–⑨".

Why no test caught it: `tasks.dbtest.ts:798` only asserts `run.count === 0` for
the inert chain; nothing starts it. `chain-branch.dbtest.ts:330` (T6), which does
assert `firstRun.branch === agentos/<chainId>`, was changed to `autoStart: true`
— so the assertion that would have caught this was moved off the new default path
rather than duplicated onto it.

Fix direction: make the chain branch survive instantiation independently of a
Run existing at that moment — persist it on the chain/task and have the template
arm of `resolveRunBranches` read it (the sibling steps already hold it in
`targetBranch`), so step ①'s head is the chain branch whenever it is enqueued.
Then add the inert-path dbtest: instantiate with `autoStart: false`, `POST
/tasks/:id/start` on step ①, assert `run.branch === branchName` and
`run.targetBranch === repo.defaultBranch` — i.e. T6's assertions from the default
path.

### OP-2 — P1 — the start confirmation hijacks the card menu's "Move to → Doing" on desktop and mobile, which the spec scoped to drops

Axis: specification.
Location: `apps/web/src/pages/Tasks.tsx:204-219` (`move`), wired at
`Tasks.tsx:282` (`onMove: (task, status) => move(task.id, status)`, the menu) and
`Tasks.tsx:346` (`onMove={move}`, the drop); menu built at
`apps/web/src/components/task-card.tsx:133-137`.

Governing spec text (§2):

> "Change ONLY the case \"card dropped onto the DOING column AND the task is
> startable\" ... Every other drag (any card to BACKLOG/TODO/REVIEW/DONE,
> non-startable cards to DOING, HUMAN cards anywhere) keeps today's plain PATCH
> behavior — explicitly out of scope to restrict them further."

Evidence. The confirmation was placed in `move`, which is the single handler for
three surfaces: `DesktopBoard`'s `onDrop` (`desktop-board.tsx:341`), the desktop
card menu, and `MobileTaskList`'s card menu (both via `actions.onMove`).
`moveTargets(status)` returns every status except the current one
(`apps/web/src/lib/board.ts:123-124`), so "Doing" is a menu entry for BACKLOG,
TODO, REVIEW and DONE cards.

Failure scenario: an operator opens a startable TODO card's menu and picks
"Move to → Doing" to record by hand that they are working on it. They get a
"Start task?" dialog instead. Confirming spawns a real agent session; declining
leaves the card in TODO. There is now **no** surface in the web app that can set
a startable task to DOING, and the menu entry's label describes an action it no
longer performs. On mobile there is no drag at all, so the menu is the only
surface, and it has lost the plain move outright.

Fix direction: separate the drop path from the move path — e.g. keep `move` as
today's plain PATCH for `actions.onMove`, and give `DesktopBoard`'s `onDrop` a
`drop(taskId, status)` that consults `/startability` first.

### OP-3 — P2 — `StartTaskDialog` throws from render; if the guard ever fires the whole board blanks instead of surfacing an error

Axis: standards (dispensables / wrong failure mode).
Location: `apps/web/src/pages/Tasks.tsx:91-93`.

`if (!request.task.agent || !request.task.repo || !request.task.targetBranch) throw new Error(...)`
executes during render of a `TasksPage` child. There is no error boundary
anywhere in `apps/web/src` (no `componentDidCatch` / `getDerivedStateFromError`),
so a throw here unmounts the whole tree: the operator loses the board, the notice
area and every other card, and sees a blank page with the message only in the
console. That is the opposite of the repo's "errors surface to the user" rule the
spec cites.

Judgement call, and the reason it is P2 rather than P1: the guard is currently
unreachable. `startable: true` already implies `repoId` and `assigneeAgentId` are
set (`chain.ts:145-146`), both relations are FK-backed, and `Repo.defaultBranch`
is `String @default("main")` (`packages/db/prisma/schema.prisma:336`), so
`targetBranch` cannot be null for a startable task.

Fix direction: render the page's existing `ErrorNotice` copy instead of throwing,
or drop the guard and let the types carry the invariant.

### OP-4 — P2 — `taskStartability`'s archived-assignee test is redundant and silently reverses the null-relation case

Axis: standards (dispensables — dead condition; couplers — undocumented contract change).
Location: `packages/api/src/chain.ts:151-155`.

```ts
&& row.assigneeAgent?.archivedAt !== undefined
&& row.assigneeAgent?.archivedAt === null
```

The first conjunct is implied by the second: `x === null` is already false for
`undefined`. It is dead.

It is also not a faithful port. The replaced code was
`if (row.assigneeAgent?.archivedAt) return false;` (chain.ts pre-change), which
**passed** a `StartableRow` whose `assigneeAgent` is `null`; the new expression
**fails** it. No caller hits that today — all three (`app.ts:2366`,
`app.ts:2921`, the `chainStartDecisions` mapper at `app.ts:2428`) include the
relation — so this is latent, not a live defect. But the expression states an
intent nothing explains, and the function's own doc comment does not mention it.

Fix direction: pick one and say so in a comment — `row.assigneeAgent === null ||
row.assigneeAgent.archivedAt === null` to preserve the old contract, or
`row.assigneeAgent !== null && row.assigneeAgent.archivedAt === null` if
fail-closed is intended.

### OP-5 — P2 — `GET /tasks/:id/startability` re-derives the `/start` route's fact-gathering instead of sharing it

Axis: specification + standards (shotgun surgery).
Location: `packages/api/src/app.ts:2331-2381` against `packages/api/src/app.ts:2852-2916`.

Governing spec text (§3):

> "Compute the verdicts server-side from the same predicates the /start route
> uses (extract/share, don't duplicate the logic in the web client)"

The *predicate* is genuinely shared — `taskStartability` is the single
implementation, which is what the spec asked for, and the web client duplicates
nothing. What is duplicated is the three queries that feed it: the grant lookup
(`db.agentRepoAccess.findFirst` here vs `lockAgentRepoGrant` there), the run
aggregate (character-for-character identical `_count`/`_max` shape), and the
chain-prefix query. A seventh precondition added to `/start` will compile,
pass its own tests, and quietly not appear on the checklist.

Fix direction: extract a `readStartabilityFacts(client, taskId)` returning
`{ row, facts, predecessorsDone }` and call it from both routes.

### OP-6 — P2 — the checklist reports `startable: true` for tasks `POST /start` will refuse

Axis: standards (correctness, latent).
Location: `packages/api/src/chain.ts:135-158` against `packages/db/src/workflow.ts:430-440`.

`enqueueTaskRun` refuses on two further conditions the predicate does not model:
`stopStateFor` (integrator stop → `IntegratorStoppedError`) and
`assertIntegratorBinding`. A task under an integrator stop reports
`startable: true`, the drag opens the confirmation dialog, and the POST answers
409. The 409 body is surfaced verbatim, so it fails loudly — no silent fallback.

Recorded, not charged to this diff: the pre-change `startable` had the same gap
and it already drove the Start button, and the spec's §2 enumeration of
"startable" lists only the six checklist items plus archived/status. Fix
direction, if taken: add the stop/binding refusals as checklist items so
"Ready to start" means the same thing on both sides of the button.

### OP-7 — P2 — `dropAction`'s status test is dead at its only call site, and its test proves a branch that cannot be taken

Axis: standards (dispensables / speculative generality).
Location: `apps/web/src/pages/Tasks.tsx:51-53` and `:207-213`;
test at `apps/web/src/tests/tasks-board.test.tsx:69-74`.

`move` already gates on `if (status === "DOING")` before it fetches the verdict,
so `dropAction` can only ever be called with `status === "DOING"`. The exported
helper exists to give the board test something callable, and the test iterates
all five columns — four of which the caller can never produce.

Judgement call: the guard in `move` is defensible on its own terms (it avoids a
round-trip on every non-Doing drop), so this is a shape question, not a defect.
Fix direction: let `dropAction` own the whole decision and have `move` call it
unguarded, or inline the condition and test the decision through `move`.

### OP-8 — P2 — `confirmStart` hand-rolls the pending/error machinery the page already has

Axis: standards (duplicated code / divergent change).
Location: `apps/web/src/pages/Tasks.tsx:221-238` against
`apps/web/src/lib/hooks.ts:133-155`.

The page already holds `useAction()`, whose `run` sets pending, clears the
previous error, catches, and stores `errorMessage(reason)` — and every other
action on the page (`move`, `retry`, `archive`, `remove`, `archiveDone`) goes
through it, with the comment at `Tasks.tsx:288-291` stating the rule: "One error
surface, one information surface." `confirmStart` adds a second pending flag, a
second error state and a third `ErrorNotice` at `Tasks.tsx:322`.

Secondary consequence, same location: `startError` is cleared on cancel and on
the next confirm, but not when a *new* drag opens the dialog for a different
card. Drag A onto Doing, confirm, get a 409; drag B onto Doing — B's dialog opens
above A's stale error, which now reads as B's.

Fix direction: reuse `useAction` and keep the dialog open on `run(...) === false`,
or state in a comment why the shared hook cannot express that.

### OP-9 — P2 — no test covers the drop → confirm → `POST /start` wiring, only the pure helper

Axis: specification (test coverage against §2's central requirement).
Location: `apps/web/src/tests/tasks-board.test.tsx:69-74`.

Governing spec text (§2):

> "Confirm → call POST /tasks/:id/start. Do NOT PATCH status"

Nothing in the suite asserts that. `dropAction` is tested in isolation;
`task-detail.test.tsx:21-40` covers the checklist markup;
`tasks.dbtest.ts:798-815` covers the autoStart flag. The one behaviour the spec
wrote in capitals — that the confirm path issues exactly one `POST
/tasks/:id/start` and zero `PATCH /tasks/:id` — is unasserted, as is the decline
no-op.

Fix direction: a `TasksPage` render test with a stubbed `api` that drops a
startable card on Doing, confirms, and asserts the exact request pair; plus a
decline case asserting zero requests.

## Not findings

- The activity-body change at `templates.ts:178-182` ("ready to start" for the
  inert case) is behaviour the spec did not name, but the old sentence would be
  false under `autoStart: false`. Required by the change, not extra scope.
- `en.ts`/`zh.ts` each gained exactly the 14 keys the two new components read;
  every key used resolves. Checked by hand, both files.
- Every `instantiateTemplate` call site in the tree passes `autoStart` explicitly
  (18 sites: both webhook routes, both scripts, the dry-run, and every test),
  except `templates.test.ts:123`, which omits it deliberately to assert the
  default. This satisfies §1's "do not silently rely on the default".
- The new route is operator-scoped by the existing `principalMayAccess`
  (`packages/api/src/auth.ts:71-79`): it is not under `/runner/` or `/session/`,
  so runner, merge-executor and session principals are refused.
- The two failing web tests are build-order failures identical at base.
