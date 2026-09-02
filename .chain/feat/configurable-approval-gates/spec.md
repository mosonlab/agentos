# Configurable approval gates: project defaults, dispatch override, TODO-step toggle

Branch: `feat/configurable-approval-gates`
Workspace HEAD at authoring: `dc17e41f7f301fd7d177cca5d66a888de90f01d8`
Brief base named in the Product Contract: `origin/main` at `8ac784ece6a3e8ff47ba56e4a8942fe37de30366`

## Problem Statement

An operator dispatching an Anneal chain has no way to say "pause and let me look
at this before it goes further". Every step in every canonical template declares
`approvalGate: false`, `Project` carries no gate settings at all, the instantiate
route copies the template value verbatim, and `PATCH /tasks/:taskId` refuses any
`approvalGate` change on a chain task with "Approval gates on dispatched chain
tasks are controlled by the chain". The only lever left is editing the canonical
Markdown template and reseeding, which changes the gate for every future chain in
every project and is not a dispatch-time decision at all.

Two specific moments hurt:

- **The specification step.** A Full Assurance chain writes a spec, then plans,
  reviews, implements, and merges from it without anybody reading the spec. When
  the spec misreads the Product Contract, the operator finds out eleven steps
  later, having paid for the whole chain.
- **The merge tail.** The chain merges to the pull-request base with no human in
  the loop. `docs/governance/task-routing-v1.md` states this as a deliberate
  design ("No human gate guards the merge tail"), and for most work that is
  right. For a change the operator wants to eyeball — a migration, a defense-list
  path, a first chain in a new project — there is no supported way to hold the
  merge, and the workaround (watching the board and manually stopping the chain)
  is a race against the readiness worker.

Neither gate is wanted globally. A project that has earned trust should stay
fully autonomous; a project being brought up, or one specific risky dispatch,
should be able to ask for a pause. The setting also has to be reachable at three
different times: when configuring a project, when dispatching one chain, and
after dispatch while the gated step has not been reached yet.

Separately, the machinery that would serve the merge gate is present but
unproven. `gateQuestion` already has a `gateFeedsIntegratorStep` branch that
opens an evidence card filled by the merge evidence worker, and
`produceMergeAuthorization` already binds an approval to an exact head. But the
only fixture shape that exercises it (`merge-integrator-fixture.ts`, the default
`canonical-compound` shape) models the *pre-readiness-tail* graph, where a human
`approvalGate` step sits immediately before the integrator. In the real graph a
server-owned merge readiness step sits between them, and nothing in the test
suite has ever put a gate on that step. Shipping the toggle without proving that
path would be shipping an untested fail-open surface on the merge tail.

## Solution

Two named gate slots, each independently configurable, both off out of the box.

A **gate slot** is a step in a canonical template that this feature is allowed to
gate. There are exactly two, and both are already identifiable from existing
step metadata with no new template frontmatter:

- The **specification slot** — the step whose `stepRole` is `spec`
  (`outputKind: spec`); step 1 of the compound (Full Assurance) template. The
  direct and pull-request templates have no such step.
- The **merge slot** — the step recognised by `isMergeReadinessStep`
  (`stepRole` is `readiness`, `outputKind: merge-authorization`); step 11 of the
  compound template and step 7 of the direct template. The pull-request template
  has no such step.

An operator sets a per-project default for each slot on the project detail page
(`specGateDefault`, `mergeGateDefault`, both false out of the box). When
dispatching one chain they may override either slot for that chain only, from
the instantiate dialog or the instantiate API. After dispatch, while the gated
step is still TODO, they may flip it on that one task from the chain view; once
the step is DOING, REVIEW, or DONE the toggle is refused with a reason naming the
state. Resolution at instantiation is exactly: dispatch override, then project
default, then the template step's frontmatter value. Nothing else influences the
two slots; every other step in every template keeps its frontmatter value.

What the operator sees when a gate fires:

- **Specification gate on.** The spec step finishes and persists its output, the
  task moves to REVIEW instead of DONE, and an Inbox card carries the spec
  preview with approve/reject. Approve continues the chain into planning. Reject
  requeues the spec step, exactly as an approval gate does today, consuming
  `maxSessionsPerTask` budget like any run.
- **Merge gate on.** Regression verification passes, and instead of the merge
  readiness step being handed to the server-owned readiness worker, the readiness
  task moves to REVIEW and an Inbox evidence card opens through the existing
  `gateFeedsIntegratorStep` branch. The merge evidence worker fills it with the
  pull request's head SHA, base ref and base SHA, and each required check's
  conclusion. Approve records an exact-head merge authorization and releases the
  readiness task back to the worker, which performs its ordinary re-verification
  before the integrator merges — so a head or base that moved between the human
  reading the card and the merge stops the tail and reopens the gate on a fresh
  card rather than merging something nobody approved. Reject ends the chain: the
  merge execution step is never activated, the pull request is left open and
  unmerged, and the chain is closed terminal with a recorded reason.

The two gates are independent. A project may enable one, both, or neither.

## User Stories

### Project defaults

1. As an operator, I want each project to carry its own approval-gate defaults, so that a project I trust stays fully autonomous while a project I am still bringing up pauses where I need it to.
2. As an operator, I want both defaults to be off on a newly created project, so that adopting this feature never changes the behaviour of anything I already run.
3. As an operator, I want to turn on the specification default from the project detail page, so that every Full Assurance chain I dispatch in that project pauses after its spec.
4. As an operator, I want to turn on the merge default from the project detail page, so that every chain in that project pauses before its merge tail.
5. As an operator, I want the two defaults to be independent switches, so that I can gate the merge without paying for a spec review on every chain.
6. As an operator, I want the project read shape to return both defaults, so that any client I write can show me what a project is currently configured to do.
7. As an operator, I want to change a project default through `PATCH /projects/:projectId`, so that I can script project configuration alongside the rest of my setup.
8. As an operator, I want changing a project default to affect only chains instantiated afterwards, so that flipping a switch never reaches into a chain that is already running.
9. As an operator, I want chains instantiated before this feature existed to keep the `approvalGate` values they were dispatched with, so that upgrading the platform does not silently re-gate or un-gate live work.

### Per-dispatch override

10. As an operator, I want to override either gate for one chain at instantiation, so that a single risky dispatch can be gated without changing the project for everything else.
11. As an operator, I want to override a gate *off* for one chain, so that a routine dispatch in a gated project can run autonomously when I have already reviewed the work.
12. As an operator, I want the instantiate dialog to pre-fill both checkboxes from the project defaults, so that I can see what will happen before I dispatch and only touch what I want to change.
13. As an operator, I want the dialog to send an override only for a value I actually changed, so that the project default keeps applying to anything I left alone.
14. As an operator, I want a `gates` override for a slot the chosen template does not have to be refused with a named reason, so that I find out immediately that my override would have done nothing.
15. As an operator, I want the resolution order to be exactly dispatch override, then project default, then template frontmatter, so that I can predict what a dispatch will do without reading the code.
16. As an operator, I want every non-slot step to keep its frontmatter `approvalGate` regardless of what I pass, so that this feature cannot accidentally gate a review, adjudication, or documentation step.
17. As an operator dispatching a direct chain, I want the merge override to apply to its merge readiness step, so that the direct route can be gated the same way the compound route is.
18. As an operator dispatching a direct chain, I want a specification override to be refused, so that I do not believe I gated a step that route does not have.
19. As an operator dispatching a pull-request chain, I want both overrides refused, so that a template with neither slot cannot be misconfigured.
20. As an operator, I want the refusal to name which slot and which template caused it, so that I can fix the request without guessing.

### Per-task toggle after dispatch

21. As an operator, I want to turn a gate on for a chain step that is still TODO, so that I can add a pause after dispatch when a chain turns out to be riskier than I thought.
22. As an operator, I want to turn a gate off for a chain step that is still TODO, so that I can release a pause I no longer need without cancelling and re-dispatching the chain.
23. As an operator, I want the toggle refused with a 409 and a reason naming the state when the slot task is already DOING, REVIEW, or DONE, so that I cannot retroactively gate a step that has already run.
24. As an operator, I want the toggle refused on any chain task that is not one of the two slots, so that the chain's own structure stays under the chain's control.
25. As an operator, I want each accepted toggle recorded in the task's activity log with the operator as actor, so that the chain's history shows who changed the gate and when.
26. As an operator, I want the chain view to show me each gate slot's current setting, so that I can see at a glance whether this chain will pause.
27. As an operator, I want the chain view's toggle disabled with the reason shown when the slot is no longer TODO, so that the UI tells me why instead of letting me click into a refusal.
28. As an operator, I want the toggle on a non-chain task to keep working exactly as it does today, so that this change does not disturb ordinary standalone tasks.

### Specification gate behaviour

29. As an operator, I want a gated specification step to move to REVIEW when it finishes, so that the chain holds instead of planning from a spec I have not read.
30. As an operator, I want the gate card to carry a preview of the persisted spec, so that I can decide from the Inbox without opening the Tasks page.
31. As an operator, I want approving the specification gate to activate the plan step, so that approval is the only thing that was blocking the chain.
32. As an operator, I want rejecting the specification gate to requeue the spec step, so that the spec agent gets another pass with my rejection on record.
33. As an operator, I want a rejected specification run to consume `maxSessionsPerTask` budget like any other run, so that a chain cannot be rejected indefinitely without hitting its ceiling.
34. As an operator, I want an ungated specification step to behave exactly as it does today, so that turning the feature off is a true no-op.

### Merge gate behaviour

35. As an operator, I want the merge gate to open when regression verification completes, so that I am asked before the mechanical tail starts, not after it has already computed an authorization.
36. As an operator, I want the merge gate card to show the pull request's head SHA, base ref, base SHA and required-check conclusions, so that I am approving a specific commit and not a moving branch.
37. As an operator, I want the card to be filled by the merge evidence worker before it is delivered to me, so that I never see a placeholder card I could approve blind.
38. As an operator, I want approving to produce a merge authorization bound to exactly the head shown on the card, so that "what I saw" and "what was authorized" are the same commit by construction.
39. As an operator, I want the readiness worker to run its ordinary re-verification after my approval, so that the merge still gets the server-side head, base and ancestry checks it gets today.
40. As an operator, I want a head that moves between my approval and the merge to stop the tail with no merge, so that an approval can never be replayed onto a commit I did not read.
41. As an operator, I want a base that moves between my approval and the merge to stop the tail with no merge, so that the merge target I approved against is the one that gets merged into.
42. As an operator, I want a stopped tail to reopen the gate with a fresh evidence card carrying the new head and base, so that I can approve the changed state instead of the chain silently dying.
43. As an operator, I want no second authorization path introduced for the gated case, so that the mechanical merge keeps exactly one exact-head authorization contract to audit.
44. As an operator, I want the readiness worker unable to claim a readiness task while its gate is open, so that the mechanical tail and my decision cannot race.
45. As an operator, I want rejecting the merge gate to end the chain, so that "no, do not merge this" means the chain stops rather than looping.
46. As an operator, I want a rejected merge gate to leave the pull request open and unmerged, so that I keep the branch and its review history to work from.
47. As an operator, I want the merge execution step never activated after a merge rejection, so that no mechanical merge run can be claimed afterwards.
48. As an operator, I want the terminal close to record a reason naming my rejection, so that anyone reading the chain later knows why it ended.
49. As an operator, I want the chain's still-open Inbox cards closed when the chain is closed terminal, so that my Inbox does not keep a decision I have already made.
50. As an operator, I want an ungated merge readiness step to behave exactly as it does today, so that turning the feature off is a true no-op on the most safety-critical path in the system.
51. As an operator, I want an approval that cannot be bound to a regression-attested head refused, so that the gate cannot authorize a commit the merge gate never signed.

### Documentation and discoverability

52. As an operator, I want the routing contract to state that chains run without human gates by default, so that the governing document matches what the platform does.
53. As an operator, I want the routing contract's merge-tail section to state the exact-head semantics of a gated merge, so that I know precisely what a merge gate does and does not guarantee.
54. As an operator, I want the routing contract to record that a dispatch may override per chain and an operator may toggle a not-yet-reached slot, so that the dispatch procedure is written down.
55. As an agent or operator reading `agents/README.md`, I want the two slots and the resolution order named there, so that I do not have to infer them from `step-role.ts`.
56. As an API consumer, I want `docs/operator-api.md` to document the new project fields, the `gates` instantiate field, and the relaxed `approvalGate` PATCH rule, so that the handbook matches the routes.
57. As an API consumer, I want the previously undocumented "gates are controlled by the chain" refusal documented alongside its relaxation, so that the handbook explains both what is now allowed and what is still refused.

## Implementation Decisions

### D1 — Slot identity comes from `stepRole`, not new metadata

The two slots are identified with the existing structural predicates in
`packages/db/src/step-role.ts` and `packages/db/src/merge-tail.ts`:

- specification slot: `stepRole(step) === "spec"`
- merge slot: `isMergeReadinessStep(step)` (i.e. `stepRole(step) === "readiness"`)

No template frontmatter key is added, no template shape changes, and every step
in `agents/templates/*` keeps `approvalGate: false`. Both predicates already
normalise a versioned `outputKind` suffix and already recognise legacy template
generations, so legacy chains resolve the same way canonical ones do.

A single shared helper resolves a step to a slot so that the instantiate route,
the task PATCH refusal, and the chain read shape cannot disagree. Its shape:

```ts
export type GateSlot = "spec" | "merge";
export const gateSlotOf = (step: TemplateStepLike | null | undefined): GateSlot | null =>
  step == null ? null : stepRole(step) === "spec" ? "spec" : isMergeReadinessStep(step) ? "merge" : null;
```

It lives in `@anneal/db` beside `step-role.ts` because both `packages/api` and
`packages/db` need it and `step-role.ts` is already the shared authority.

### D2 — Two boolean columns on `Project`, no settings blob

`Project` gains `specGateDefault Boolean @default(false)` and
`mergeGateDefault Boolean @default(false)`. These are the only new persisted
settings. No JSON settings object, no per-template or per-repo scoping.

One Prisma migration adds both columns. Because both are `NOT NULL DEFAULT
false`, the migration is a pure additive column add: it applies to a fresh
database and to a database already at head without a backfill step, and existing
rows take the default.

**Correction to the brief.** The brief instructs that the migration be
"registered in `RELEASE_CANDIDATE_MIGRATIONS` in
`packages/db/src/release-migrate.ts`". The live authority — the doc comment on
that constant — says the opposite: "The release-cut commit (the `chore(release):
prepare` commit) updates these two values to the migration tail on disk at that
commit. **Adding a migration does not touch them.**" The only exception is a
migration whose timestamp sorts *before* the recorded terminal. The recorded
terminal is `20260830233000_run_requires_commit` with `count: 47`, while the
checkout already carries fifty migration directories including three dated after
that terminal — confirming that the current practice is not to bump the pin per
migration. This migration will be dated after the terminal, so it takes the
ordinary path and **must not** modify `RELEASE_CANDIDATE_MIGRATIONS`. See
Assumption A2. (`docs/governance/task-routing-v1.md`'s "every migration bumps
`RELEASE_CANDIDATE_MIGRATIONS`" sentence in the Backlog card lifecycle section is
stale against the code comment; correcting it is out of scope here — see Out of
Scope.)

### D3 — Project wire contract and PATCH

`Project` in `packages/db/src/wire-contract.ts` gains `specGateDefault: boolean`
and `mergeGateDefault: boolean`. The three project route handlers
(`GET /projects`, `GET /projects/:projectId`, `PATCH /projects/:projectId`)
return the Prisma row as-is typed against that contract, so the read shape picks
the fields up once the contract and the column exist; the `satisfies
ProjectResponse` annotations make omission a type error.

The two booleans are added to the **patch** schema only, not to the shared
`projectFields` used by `projectInput`. Project creation goes through
`createProjectBootstrap`, and the column defaults already give a new project the
correct values; widening the create input would add a field with no requirement
behind it. `PATCH /projects/:projectId` keeps its current ad hoc shape (a bare
`db.project.update` with `withoutUndefined`); it is not converted to the
`Refusal`/`refusalJson` convention, because nothing in this feature needs a new
refusal on that route — two optional booleans have no invalid value.

### D4 — Instantiate resolution

`POST /projects/:projectId/task-templates/:templateId/instantiate` accepts an
optional `gates` object with optional booleans `spec` and `merge`:

```ts
gates?: { spec?: boolean; merge?: boolean }
```

`InstantiateTemplateInput` gains the field; the zod input schema accepts it as a
strict object (unknown keys refused, consistent with the route's existing
handling of unknown fields).

For each created task, `approvalGate` is resolved as:

| step | resolution |
| --- | --- |
| specification slot | `gates.spec` if present, else `project.specGateDefault`, else the step's frontmatter `approvalGate` |
| merge slot | `gates.merge` if present, else `project.mergeGateDefault`, else the step's frontmatter `approvalGate` |
| every other step | the step's frontmatter `approvalGate`, unconditionally |

"Present" means the key was supplied, including when supplied as `false`. Since
project defaults are non-nullable booleans, the frontmatter tier is reached only
in theory today; it is kept in the order because the brief fixes the order and
because it is what makes "template frontmatter is still the base value" true.

The project row is read inside the same transaction that materialises the chain,
so a concurrent `PATCH /projects/:projectId` cannot land between the read and the
task creation.

**Refusals.** Supplying `gates.spec` for a template with no specification slot,
or `gates.merge` for a template with no merge slot, is refused before any task is
created, with two new `TemplateInstantiationRefusalCode` values:

- `gates_spec_step_absent`
- `gates_merge_step_absent`

Both map to 400 through the existing `refusalResponse` switch (the same arm the
other `template_*` codes use) and carry a message naming the slot and the
template. The `never` exhaustiveness default in `refusalResponse` forces both to
be wired. Refusing before creation matters: a partially materialised chain is
worse than a rejected request. If both are absent and both are supplied, the
refusal names the first one checked in slot order (spec, then merge) —
deterministic, and the operator sees the second on the retry.

### D5 — Opening the merge gate at readiness activation

Today, when a predecessor layer completes and the successor is a merge readiness
step, `activateChainSuccessorInternal` writes a `MERGE_TAIL_KIND.readiness`
activity marker with `state: "queued"` and continues without enqueueing a run —
the readiness worker claims the task itself.

That branch becomes: if the readiness successor has `approvalGate: true` **and**
a `sourceRunId` is available (the completing regression run), the readiness task
is set to `TaskStatus.REVIEW` and `gateQuestion` is called with that run;
otherwise the existing "queued" marker path is unchanged.

This placement is what makes the merge gate work at all, and three existing
properties fall out of it rather than being added:

- **The evidence card opens through the existing branch.** `gateQuestion` calls
  `gateFeedsIntegratorStep`, which looks up the gate task's immediate successor
  by `chainIndex` and asks whether it is the integrator step. For a gated
  readiness task the immediate successor *is* the merge execution step, so the
  branch fires and `requestMergeEvidence` opens a `purpose: "gate"` placeholder
  card that the merge evidence worker fills. No change to `gateQuestion`.
- **A source run exists.** The readiness step is server-owned and has no run or
  session of its own; `gateQuestion` requires a session-bearing run. Opening the
  gate at *activation* time supplies the completing regression run. Opening it
  after the readiness worker finished would have no run to bind the card to.
- **The worker cannot race the human.** `readiness-claim.ts` treats a readiness
  task as available only when its status is `TODO` (or `DOING` with an expired
  lease). A task parked in `REVIEW` is not claimable, so the gate holds the tail
  closed for free. The REVIEW write and the card creation happen in the same
  transaction as the regression completion, so there is no window in which the
  task is claimable and gated.

`chain-activation.ts` already carries the invariants a server-owned gate needs:
"Approval gate is not allowed in multi-node chain layer" and "Server-owned
approval gate must follow one executable predecessor". Both hold for a readiness
slot (its layer is single-node, and regression is its executable predecessor).

### D6 — Approving a merge gate releases the worker; it does not skip it

`applyInboxDecisionTx` (Inbox channel) and `patchTask`'s status-to-DONE path
(PATCH channel) share one approve shape today: mark the gate task DONE, call
`produceMergeAuthorization`, and — unless the authorization's purpose was
`confirmation` — call `activateChainSuccessor`. Applied unchanged to a gated
readiness task that would mark readiness DONE and enqueue the integrator
directly, skipping the readiness worker, its head/base/ancestry re-verification,
its defense-list audit, its merge lease, and its `merge-authorization` step
output. That is the fail-open outcome this feature must not ship.

The approve path therefore gains a third disposition, alongside the existing
`gate` and `confirmation` ones, selected when the gate task is a merge slot:

- `produceMergeAuthorization` runs unchanged and records the operator's
  exact-head authorization activity on the readiness task. It is unchanged
  because `gateFeedsIntegratorStep` already resolves the integrator from a
  readiness gate task, and `requireGateAttestation` already refuses an approval
  whose head has no regression attestation.
- The readiness task is **not** marked DONE and `activateChainSuccessor` is
  **not** called. Instead the task returns to `TaskStatus.TODO` and the ordinary
  `MERGE_TAIL_KIND.readiness` `state: "queued"` marker is written, which is
  exactly the state the activation path would have left it in had there been no
  gate. The readiness worker then claims it and proceeds normally.
- An operator-actor `TaskActivity` records the approval on the readiness task.

The result: the human decision gates *entry* to the mechanical tail; the
mechanical tail's own contract is untouched downstream of it. No second
authorization path is introduced — the authorization the integrator consumes is
still the one the readiness worker produces.

Both channels must behave identically. The condition is factored into one shared
predicate over the gate task's template step so `inbox-decision.ts` and
`task-patch.ts` cannot diverge.

### D7 — Exact-head binding after approval

The requirement is that the integrator never runs without an authorization bound
to the head the human saw. Under D6 that is delivered by composition of existing
checks, plus one explicit fail-closed assertion:

1. `requireGateAttestation` refuses the approval unless the card's `headSha`
   carries a regression attestation — so the approved head equals the head the
   regression verdict passed at.
2. `evaluateReadiness` already refuses to authorize unless the live pull request
   head equals the regression verdict's `headSha` and the live base equals the
   verdict's `baseHeadSha`, and unless `compareCommits` reports the head ahead of
   or identical to the base with `behindBy === 0`.
3. **New, explicit:** when the readiness task carries `approvalGate: true`, the
   readiness worker additionally requires that the operator gate authorization
   recorded on that task names the same `headSha` and `baseSha` it just verified.
   A mismatch, or the absence of any operator authorization on a gated readiness
   task, stops the tail closed through the existing `stopMergeTail` path with a
   named reason. This is deliberate belt-and-braces: (1) and (2) chain through
   the regression verdict rather than comparing to the approval directly, and the
   brief's constraint is that on any doubt the tail stops closed.

**Drift after approval.** A head or base that moves after approval is caught by
(2) and produces the existing `requeue-regression` settlement: regression and
readiness both return to TODO and regression is re-enqueued with a compensating
budget grant. When regression completes again, D5 fires again — the readiness
task re-enters REVIEW and a **fresh** evidence card opens carrying the new head
and base. No merge happens, and the stale approval cannot be reused because the
new card is a new decision identity. This is the "gate reopens with a fresh
evidence card" behaviour, delivered by existing paths.

A hard-stop condition (unresolvable target, unreadable evidence, incomplete
comparison) continues to use `stopMergeTail`, parking readiness and regression in
REVIEW with a `failureReason` and a dedupe-keyed stop notice, exactly as today.

### D8 — Rejecting a merge gate ends the chain

Today `applyInboxDecisionTx`'s reject path special-cases a readiness gate task
(`isMergeReadinessStep(question.gateTask.templateStep)`) by refusing to treat the
mechanical task as its own redo target and searching backwards for the nearest
executable earlier task — which for the canonical graph is regression. That would
loop the chain rather than end it.

For a merge-slot gate rejection the behaviour becomes terminal, reusing the
existing chain-abandonment disposition that `applyStopAnswer` already implements
for an operator-closed integrator:

- The merge execution task is **not** activated and no merge run is opened.
- `closeIntegratorQuestions` closes every still-OPEN Inbox message on the
  integrator task (this is the "aggregate card can be archived" behaviour).
- A `TaskStepOutput` of kind `merge-result` is upserted on the integrator task
  recording that the chain was abandoned without a merge at the operator's
  rejection, and the integrator task is closed (`DONE`, `failureReason: null`) —
  terminal, not stopped-needing-a-human.
- The readiness task is closed with an operator-actor `TaskActivity` naming the
  rejection.
- The pull request is left open and unmerged. Nothing in this path touches
  GitHub.

The reject path for the **specification** slot is unchanged: the spec task is an
AGENT task and not a readiness step, so the existing branch makes it its own redo
target, sets it TODO and re-enqueues it, consuming budget like any run.

### D9 — Relaxing the task PATCH refusal

`patchTask` currently refuses any `approvalGate` change on a task with a non-null
`chainId`, before anything else runs. That preflight becomes conditional:

- The change is **accepted** when the task's template step resolves to a gate
  slot (`gateSlotOf`) **and** the task's status is `TODO`.
- The change is **refused with `reason: "conflict"`** (409) otherwise, with a
  message that distinguishes the two causes: a non-slot chain task ("only the
  specification and merge readiness steps carry a configurable gate") versus a
  slot task past TODO (naming the actual state, e.g. "…is already DOING").

The status is re-read under the Task-row mutex on the write path rather than
being trusted from the unlocked preflight read, so a task that leaves TODO
concurrently loses the race and the PATCH is refused rather than landing on a
running step. This follows the module's existing rule that the unlocked `before`
read is stale by definition.

An accepted change writes a `TaskActivity` with `actorType: "operator"` naming
the slot and the new value.

The refusal message text is shared with the web UI's disabled-toggle reason so
the two cannot drift.

### D10 — Chain read shape carries the slot

`ChainStep` in `packages/db/src/board-contract.ts` already carries
`approvalGate: boolean`. It gains `gateSlot: "spec" | "merge" | null`, populated
from `gateSlotOf` on the step's template step. The server stays the authority for
slot identity; the client derives only "enabled iff `gateSlot !== null &&
status === TODO`" and renders the shared refusal reason otherwise.

### D11 — Web UI

Three surfaces, each following prior art already in `apps/web`:

- **Project detail (`pages/Projects.tsx`).** Two `Toggle` controls for
  `specGateDefault` and `mergeGateDefault`, placed in the read-only `KeyValue`
  block beside the other project settings. They use the instant-PATCH pattern
  already proven by the task approval-gate toggle: clicking fires
  `api.patch('/projects/:projectId', { … })` and reloads, with no separate save
  step. They are not folded into the existing `yamlDocument` edit-mode flow.
- **Instantiate dialog (`components/new-task-panel.tsx`).** Two checkboxes in
  the template mode, pre-filled from the selected template's project defaults.
  The panel tracks each checkbox's initial value and includes a key in the
  `gates` object of the POST body **only** when the operator changed it; when
  neither changed, `gates` is omitted entirely. Checkboxes for a slot the
  selected template does not have are not rendered, so the client cannot produce
  the 400 by accident — but the server refusal remains the authority.
- **Chain view (`components/chain-list.tsx`, mounted from
  `pages/TaskDetail.tsx`).** A `ChainRow` whose step has a non-null `gateSlot`
  renders a `Toggle` in place of the current static lock icon, enabled only when
  that step's status is TODO and disabled with the refusal reason as its title
  otherwise. `ChainList` gains an `onToggleGate(taskId, next)` callback which
  `TaskDetail` wires to `PATCH /tasks/:taskId` and a reload. The existing
  single-task gate toggle in `TaskDetail` keeps its `task.chainId === null`
  condition, so there is exactly one editor for a chain task's gate. Steps with
  `gateSlot === null` keep today's lock-icon-or-nothing rendering.

All new user-visible strings are added to both `locales/en.ts` and
`locales/zh.ts`; the i18n sweep test enforces this.

### D12 — Documentation

- **`docs/governance/task-routing-v1.md`.** The "Human approval placement"
  section is rewritten to state that chains run without human gates by default;
  that a project may enable a specification gate, a merge gate, or both; that a
  dispatch may override either per chain and an operator may toggle a
  not-yet-reached slot; and — replacing the sentence "No human gate guards the
  merge tail" — the exact-head semantics from D5–D8: the gate opens on regression
  completion with server-read evidence, approval releases the readiness worker
  and the merge still requires the worker's exact-head re-verification, drift
  reopens the gate on a fresh card without merging, and rejection ends the chain
  with the pull request left open. The document's version header is bumped and
  its change note names this feature. See Assumption A1 on the version number.
- **`agents/README.md`.** The "Approval is task metadata" paragraph gains the two
  slot names (specification step, merge readiness step), how each is recognised
  (`stepRole`), and the resolution order.
- **`docs/operator-api.md`.** `PATCH /projects/:projectId` gains the two boolean
  fields in its accepted-field list; the instantiate route gains the optional
  `gates` object with its two booleans, the resolution order, and the two 400
  refusal codes; `PATCH /tasks/:taskId` documents the `approvalGate` rule for
  chain tasks — accepted on a TODO gate-slot task, 409 otherwise — including the
  currently-undocumented refusal it replaces. No route is added or removed, so
  the handbook's route-coverage test needs no new headings.

### D13 — What is deliberately not built

No changes to merge lease handling, to `evaluateReadiness`'s existing drift and
ancestry logic, or to `produceMergeAuthorization`. No gate timeout, reminder, or
auto-decision. No coupling between the Critical risk label and gate selection. No
treatment of an externally merged pull request as approval. No gates on any step
other than the two slots.

## Testing Decisions

### What makes a good test here

Every test in this feature asserts observable behaviour at a service boundary:
the persisted `approvalGate` values a dispatch produces, the HTTP status and
reason a refused request returns, the task statuses and Inbox cards a completion
produces, and the markup a component renders. No test asserts which helper was
called, how resolution is factored, or the internal shape of the settlement
objects. A test that would still pass after the feature was reimplemented behind
the same boundary is the goal.

The merge-tail tests in particular assert the *absence* of the dangerous outcome,
not just the presence of the safe one: after a rejection, that no merge run
exists and the merge execution task was never activated; after a drift, that no
merge happened and a new card is open. A test that only checked the happy path
would pass against a fail-open implementation.

### Seams

Four seams, three of them existing. The ideal of one seam is not reachable here
because the feature genuinely spans a database resolution rule, an HTTP contract,
a control-plane state machine, and a browser view; but no new seam is introduced
below the highest point at which each behaviour is observable.

1. **`instantiateTemplate` (existing).** The highest seam at which gate
   resolution is observable: call it with a project, a template and an input, and
   read the created tasks' `approvalGate`. Prior art: `template-overrides.dbtest.ts`,
   `template-dispatch-binding.dbtest.ts`, `templates.test.ts`. The two new
   refusal codes are asserted through the same seam (the thrown
   `TemplateInstantiationRefusal` and its code), with the 400 mapping covered by
   the existing `refusalResponse` unit surface rather than a second HTTP test.
2. **The real API entrypoint over HTTP (existing).** Used only for the surfaces
   whose contract *is* the HTTP shape: `PATCH /projects/:projectId` round-tripping
   both defaults and the project read shape returning them. Spawned through
   `packages/api/src/test-startup-environment.ts` per the repository
   instructions. Prior art: the existing route dbtests in `packages/api`.
3. **`patchTask` (existing).** The highest seam for the toggle rule: call it
   directly with an `approvalGate` patch against seeded tasks in each state and
   assert the returned `Refusal` reason and message, or the written row. Prior
   art: `task-patch.test.ts` and `task-patch.dbtest.ts`, which already drive this
   function directly.
4. **The chain fixture plus the control-plane completion and decision entry
   points (existing, extended).** The merge-gate behaviour is only meaningful as
   a sequence across regression completion, card fill, decision, readiness
   settlement and integrator activation. The seam is `seedIntegratorChain` from
   `merge-integrator-fixture.ts` plus the same public functions the production
   path calls — `advanceTemplateTask`/`activateChainSuccessor`,
   `applyInboxDecision`, and the readiness worker's tick. No new seam is cut into
   the merge tail; the fixture is widened instead. Prior art:
   `merge-tail-readiness.dbtest.ts`, `merge-base-drift-recovery.dbtest.ts`,
   `chain-activation-barrier.dbtest.ts`, `merge-evidence-protocol.dbtest.ts`.

The web tests use the two existing `apps/web` rendering seams
(`renderToStaticMarkup` for presentational assertions, `dom-harness`'s
`mountPage` + `installFetch` for click-to-request assertions). No new test
harness is introduced.

### Fixture extension

`merge-integrator-fixture.ts` already derives an internal `realReadinessTail`
boolean from its `shape` option, and already materialises a genuine server-owned
readiness task for the `canonical-compound-readiness`, `canonical-direct`,
`twelve-step-readiness` and `legacy-seven-step-direct` shapes. What it has never
produced is a **gated** readiness task: on every readiness shape the readiness
step and task are created with `approvalGate: false` and status `DONE`.

The fixture therefore gains one option — a boolean that, on a readiness shape,
sets `approvalGate: true` on both the readiness template step and the readiness
task, and leaves the readiness task in the pre-activation state (rather than
`DONE`) so the gate can actually be observed opening. Requesting it on a
non-readiness shape is a fixture error, raised loudly, not silently ignored. Every
existing caller keeps its current behaviour byte for byte.

### Modules under test

| Module | Seam | What is asserted |
| --- | --- | --- |
| instantiate resolution | 1 | the eight-row matrix below, on the compound template; the direct template resolving the merge slot only; `gates.spec` on the direct template refused |
| project defaults | 2 | PATCH round-trips both fields; GET returns them; a fresh project reads false/false |
| `patchTask` | 3 | accepted on a TODO slot task with an operator activity row; 409 on a DOING slot task naming the state; 409 on a non-slot chain task; unchanged on a non-chain task |
| merge gate lifecycle | 4 | the four scenarios below |
| spec gate lifecycle | 4 | a gated spec step completing moves to REVIEW with a card; approval activates the plan step; rejection requeues the spec step |
| `apps/web` | web seams | project toggles render and PATCH; instantiate checkboxes pre-fill and send only changed keys; chain toggle disabled with reason for a non-TODO slot |

### The instantiate resolution matrix

Run against the compound template, asserting `approvalGate` on step 1 and step 11
and that every other step is false in every row. Template frontmatter is `false`
for both slots in all rows.

| # | `specGateDefault` | `mergeGateDefault` | `gates` | step 1 | step 11 |
| --- | --- | --- | --- | --- | --- |
| 1 | false | false | omitted | false | false |
| 2 | false | false | `{spec:true, merge:true}` | true | true |
| 3 | false | true | omitted | false | true |
| 4 | false | true | `{spec:true, merge:false}` | true | false |
| 5 | true | false | omitted | true | false |
| 6 | true | false | `{spec:false, merge:true}` | false | true |
| 7 | true | true | omitted | true | true |
| 8 | true | true | `{spec:false, merge:false}` | false | false |

Rows 2, 4, 6 and 8 are the override-wins cases in both directions; rows 1, 3, 5
and 7 are the default-wins cases. Two further rows cover an override that agrees
with the default (`{spec:true}` on a `specGateDefault: true` project, and the
false/false equivalent), proving that "present and equal" is not accidentally
treated as absent.

The direct template gets its own rows for the merge slot only (step 7), plus the
`gates.spec` refusal. The pull-request template gets both refusals.

### The merge gate scenarios

One `packages/api` dbtest file using seam 4 with a gated readiness task:

1. **Gate opens.** Regression verification completes → the readiness task is in
   REVIEW, an OPEN Inbox card exists on it, the merge evidence worker fills the
   card with head/base/checks, and the readiness worker does not claim the task
   while it is in REVIEW.
2. **Approval merges.** Approving the filled card → an exact-head merge
   authorization activity exists on the readiness task, the readiness task is
   released to the worker (not DONE-and-skipped), the worker authorizes, the
   integrator is activated, and the merge completes.
3. **Drift stops the tail.** With the pull-request head changed between approval
   and integration → no merge run reaches a merged outcome, the readiness task is
   not DONE, and a fresh OPEN evidence card carrying the new head exists.
4. **Rejection ends the chain.** Rejecting the card → the merge execution task
   has no run and was never activated, the chain is closed terminal with a
   recorded reason naming the rejection, and no Inbox card on the integrator task
   remains OPEN.

Scenarios 2 and 4 are additionally run through the PATCH decision channel to
prove the two channels agree, reusing the existing pattern by which
`task-patch.ts` and `inbox-decision.ts` are held to the same gate semantics.

### Whole-repository proof

`npm run lint`, `npm run test:snapshot-scan`, and the touched workspaces'
typecheck are the named gates. Per the repository instructions, only the touched
workspaces are verified by hand; the merge gate owns repository-wide proof, and
no database suite is run wholesale. `packages/db` tests are run by named file
(`npm run test:db -w @anneal/api -- src/<file>.dbtest.ts` and the `@anneal/db`
equivalent), with `RUNNER_WORKSPACE_ROOT` pointed at a fresh temporary directory
before any runner-touching test.

## Out of Scope

- **Template frontmatter.** Every step in `agents/templates/*` keeps
  `approvalGate: false`. No template shape change, no new frontmatter key, no
  canonical template transition, no reseed.
- **Gates on any other step.** Plan, plan review, revise-plan, implementation,
  the review siblings, adjudication, documentation, regression, and merge
  execution are not configurable by this feature.
- **Critical-label coupling.** Nothing infers a gate from the Critical risk
  label, and nothing writes the label from a gate setting.
- **Externally merged pull requests.** A pull request merged outside the platform
  is not treated as an approval, and this feature adds no detection of one.
- **Gate timeouts, reminders, escalation, and auto-decisions.** A gate stays open
  until a human decides.
- **Feishu.** No change to the Feishu channel, card rendering, or delivery.
- **Inbox `note` and `acceptsFreeText`.** Delivered by the concurrent
  `feat/inbox-free-text-answers` chain, which may or may not merge first. The
  gate UI and documentation in this chain describe approve and reject only, and a
  rejection note stays out of scope. Nothing here may depend on those fields.
- **Multi-project settings UI.** Only the two toggles on the project detail page;
  no settings section, no bulk editor, no project-template defaults.
- **Merge lease, readiness re-verification logic, and
  `produceMergeAuthorization`.** Their behaviour is composed, not modified. The
  one addition is the fail-closed assertion in D7 that a gated readiness task's
  operator authorization matches the head the worker verified.
- **Other project settings.** `maxDurationMin`, `stallTimeoutMin`,
  `maxSessionsPerTask` and `spendCap` remain unpatchable and unedited; making
  them settable is a separate change.
- **Converting `PATCH /projects/:projectId` to the `Refusal` convention.** Its
  ad hoc shape is left as found.
- **Correcting the routing contract's stale "every migration bumps
  `RELEASE_CANDIDATE_MIGRATIONS`" sentence.** It is wrong against the live code
  comment (see D2), but it sits in the Backlog card lifecycle section, not the
  section this change edits. Reported, not swept.
- **The stale `Routing Contract: v1.4` literal inside the routing contract's
  per-chain routing snapshot block.** Unrelated to gate placement; reported, not
  swept.

## Further Notes

### Assumptions

**A1 — Routing contract version number.** The brief says
`docs/governance/task-routing-v1.md` "v1.4 … moves to v1.5" and makes "carries
`v1.5`" an acceptance criterion. The document is actually at **Version 1.7**, and
was at 1.7 at the brief's stated base commit `8ac784ec`; the "v1.4" the brief
read is the stale `Routing Contract: v1.4` literal inside the per-chain routing
snapshot code block, not the document header. Writing `1.5` into the header would
regress the document's version. **Assumption: the version header is bumped to
`1.8` — the next version above the current one — with a change note naming this
feature.** The substance of the acceptance criterion (the document is revised for
this feature and no longer contains "No human gate guards the merge tail") is met
exactly as written. Downstream plan review and code review should read the
acceptance criterion's version literal as "the next version", not as `1.5`.

**A2 — `RELEASE_CANDIDATE_MIGRATIONS`.** The brief says the migration is
"registered in `RELEASE_CANDIDATE_MIGRATIONS`". The constant's own doc comment
says adding a migration does not touch it, and the checkout carries three
migrations dated after the recorded terminal that did not touch it.
**Assumption: the new migration does not modify `RELEASE_CANDIDATE_MIGRATIONS`**,
because its timestamp will sort after the recorded terminal and it therefore
falls outside the documented exception. If the operator intends the pin to move
per migration, that is a change to the release procedure and belongs in its own
chain. The brief's actual acceptance criterion — "the migration applies on a
fresh database and on one already at head" — is unaffected either way.

**A3 — Merge gate timing.** The brief's sentence "when regression verification
completes and the readiness task has `approvalGate: true`, the readiness task
enters REVIEW and the evidence card opens" is read as placing the gate at
*entry* to the readiness step, not after it. **Assumption: the gate opens at
readiness activation, and approval releases the readiness worker rather than
substituting for it.** This is the only reading compatible with the existing
machinery: `gateQuestion` requires a session-bearing source run, and a
server-owned readiness step has none of its own, so the completing regression run
is the only available binding. It is also the reading that keeps every existing
merge-tail check on the path (D6, D7).

**A4 — The eight combinations.** The brief's "all eight combinations of project
default and `gates` override" is realised as the eight-row table in Testing
Decisions: four project-default combinations crossed with override-omitted and
override-inverts-the-default. Two further "override agrees with the default" rows
are added because "present and equal to the default" is a distinct code path from
"absent" and a bug there would be invisible in the eight.

**A5 — Where the chain toggle lives.** "The chain detail view" is realised as the
`ChainList` rows rendered inside `pages/TaskDetail.tsx`, which is the chain view
this application has; there is no standalone chain page. The toggle replaces the
existing read-only lock icon for gate-slot steps only.

**A6 — Project creation.** The two defaults are patchable but not settable at
`POST /projects`; a new project takes the column defaults. Adding them to the
create input would widen `projectFields`, which is shared with the project
bootstrap path, for no requirement the brief states.

### Notes for the plan step

- The `packages/db` files this touches — `chain-activation.ts`,
  `inbox-decision.ts`, `merge-tail.ts`, `step-role.ts` — are on the defense list
  in `merge-tail.ts`'s `DEFENSE_EXACT` set. Expect the defense-list audit notice
  on the merge tail; it records and proceeds rather than holding the merge, but
  the implementation assignee should be routed accordingly.
- `packages/inbox` runs as a separate process that can reach neither the API's
  GitHub client nor its configuration. Anything the approve path needs must be
  readable from persisted state inside the decision transaction. D6 and D7 are
  written to respect this: the operator authorization is a `TaskActivity` the
  readiness worker reads later, not a value the Inbox process computes.
- `refusalResponse`'s `never` exhaustiveness default will fail the typecheck
  until both new refusal codes are added to the switch — a useful forcing
  function, and a good first compile target.
- `apps/web` has no test file for `pages/Projects.tsx` today. The project-toggle
  test is a new file, not an extension of an existing one.
- The concurrent `feat/inbox-free-text-answers` chain touches
  `packages/db/src/inbox-decision.ts`, which D6 and D8 also change. A refresh
  conflict there is likely; the resolution is mechanical (both add branches to
  the same decision function) but should be expected rather than discovered.
