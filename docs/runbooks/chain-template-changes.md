# Runbook: changing a chain template

The canonical chain templates — `compound-engineer-workflow` and
`direct-engineer-workflow` — have no authoring API. Their source of record is
this repository, and the only way a change reaches production is an ordinary
pull request through the merge gate. This runbook is that path end to end.

## Where the template lives

A template is a directory of Markdown files under `agents/templates/`, one file
per step, named `<NN>-<slug>.md` where `NN` is the step's index:

```
agents/templates/compound-engineer-workflow/05-implementation.md
```

Each file's frontmatter is the step's execution structure and its body is the
prompt:

```yaml
stepIndex: 5
layer: 5
agent: implementation-plan-executioner # Agent.name, or null for a human step
approvalGate: false
outputKind: implementation
attachmentsFromPrevious: true
opensPullRequest: true
baseFromStepIndex: null                # null or a step in a strictly earlier layer
spawnPolicy: null                      # null or an inline JSON object
```

The filename prefix must match `stepIndex`, indexes must be contiguous from 1,
and only those keys are accepted. Equal `layer` values are parallel siblings and
the next layer is their join; siblings must share one non-null
`baseFromStepIndex`, carry no approval gate, and open no pull request.

`packages/db/src/template-sources.ts` states each template's expected step count
and layer vector. A shape change is not complete until that entry moves with it.

Two things are deliberately *not* in the Markdown: the step's display name,
which the seed owns, and the Agent runtime configuration, which the Agent row
owns.

## The closed sync contract

`packages/db/prisma/sync-canonical-prompts.ts` materializes the sources into the
database on every deploy. It refuses to guess. For each canonically-named row it
compares the persisted graph against exactly two accepted shapes:

- the current source graph — the row is already correct, and prompt text is
  updated in place; or
- an enumerated legacy graph in
  `packages/db/src/canonical-template-transition.ts` — the row is the previous
  generation, so it is renamed out of the way and a fresh canonical row is
  created beside it.

Anything else is structural drift and the whole sync refuses, as one
all-or-none transaction. This is what stops a half-migrated template set.

Two narrow exceptions sit beside those shapes. `ASSIGNEE_TRANSITIONS`,
`STEP_NAME_TRANSITIONS` and `STEP_BASE_TRANSITIONS` in
`sync-canonical-prompts.ts` name one step at a time and let it adopt a new
assignee, display name or base pin in place instead of refusing. Each entry is a
one-shot for a migration that has already happened; do not reach for one to
avoid registering a legacy generation.

So a change that alters the *shape* of a template — adding, removing or
reordering a step, or moving a layer, a base pin or an output kind — has to
register the outgoing graph as the legacy shape in the same change. Without
that registration the deploy does not degrade quietly; it stops.

A rename also refuses while the outgoing row still has blocking work, or while
it carries webhook configuration. Both are deliberate. What blocks is narrower
than "any unfinished task": among unarchived tasks that are not `DONE`, the
guard counts those with an **active Run** (queued, claimed, provisioning,
running, or waiting on the inbox) and those with **no chain identity**. A
quiescent chain moves under the legacy name intact, keeping its task and step
ids and its runtime contract, which is why a merely unfinished but idle chain is
not a blocker. Archiving a live chain's remaining tasks does hide them from the
guard — do not do that to get a rollover through.

## Prompt text is frozen once a step has been instantiated

The in-place prompt update above only reaches a step that no task references.
Once any task has been created from a step, sync refuses to change that step's
prompt at all, so a text-only edit to a template that has already run stops the
deploy exactly like structural drift does.

Rewriting it therefore has to roll the row over: the new canonical row starts
with no tasks and carries the new text, and the old row keeps the text its own
chains were dispatched under.

What has changed is what a rollover can be registered *as*. Until 2026-08-26 a
rollover could only be registered as a shape, so a prompt-only rewrite had no
way to express itself and had to ride an unrelated structural change. A
generation may now also be registered by its **prompt generation**: the
`promptDigest` field on an entry in
`packages/db/src/canonical-template-transition.ts`, a digest over that
generation's ordered step prompts. An entry carrying one matches a persisted
graph only when the shape *and* the digest agree, which is what lets the
outgoing and incoming graphs be structurally identical without the successor
matching its own predecessor's entry and rolling over again on every deploy.
This supersedes the earlier rule that a template with instantiation history
admits no prompt-only change (operator ruling, 2026-08-26).

Structural changes are unaffected: they are still registered as a shape, and an
entry with no `promptDigest` still matches on shape alone.

Registering one stays a deliberate act, and this is the part not to misread.
Nothing computes a rollover from drift. The digest of the outgoing generation is
written into the registry by hand, exactly as a shape is, and a prompt edit with
no registered entry still stops the deploy rather than migrating anything on its
own. The freeze did not become advisory; it became expressible.

One consequence to plan for: the rolled-over row keeps its own prompt, so tasks
already instantiated from it keep the text they were created with. That is
correct for a task that has run, and wrong for one that has not yet started when
the old text has become false. Startup reconciliation
(`packages/api/src/rolled-prompt-descriptions.ts`) recomposes the description of
not-yet-started tasks from the current canonical step, and only across
prompt-only generations, where the shape is identical and a step ordinal is
guaranteed to mean the same node.

## What a template change does and does not affect

A template change affects **future instantiations**, with one named exception
below. Tasks that already exist keep the template step rows they were created
against — a rollover renames the old row and leaves its step ids intact,
precisely so a running chain keeps its runtime contract.

The exception is the description refresh described above: across a prompt-only
rollover, a task that has not started — no Run at all — has its own frozen copy
recomposed from the current canonical step, because the text it was created with
is exactly what the rollover declared untrue. Its template step row is still not
rewritten, and a task with any Run is never touched.

That is also the trap to check. Runtime predicates key on template *name* plus
step ordinal: `isIntegratorStep`, `isMergeReadinessStep`, `isCanonicalAgentStep`,
the readiness poll and the base-drift recovery poll all have to recognise the
renamed row at its old ordinals, or an in-flight chain silently loses its merge
tail or its output immutability. When you register a legacy shape, extend those
predicates in the same change.

The narrower predicates in `packages/api/src/canonical-task-output.ts` —
`isCanonicalSolFindingsStep`, `isCanonicalBlindFindingsStep` and
`isCanonicalFixStep` — match the canonical names only, on purpose: they carry
obligations that belong to the current graph's division of labour. Their cover
therefore ends at the rollover, which is sound only because a rollover requires
the outgoing row's chains to be finished.

## The procedure

1. Branch from `origin/main` in a worktree of its own.
2. Edit the Markdown sources. Keep filenames, `stepIndex` and `layer`
   consistent; renumber the following files if you inserted or removed a step.
3. Update `CANONICAL_TEMPLATE_SOURCE_SPECS` in
   `packages/db/src/template-sources.ts` and the step-name list in
   `sync-canonical-prompts.ts` and `seed.ts`.
4. For a shape change, add the outgoing graph to
   `packages/db/src/canonical-template-transition.ts`, mint its legacy name,
   and teach the name-plus-ordinal predicates listed above about it. For a
   prompt-only change, add the outgoing graph the same way and give the entry
   the `promptDigest` of the generation it retires; the shape is the current
   one, unchanged, so the predicates need nothing new.
5. Run `npm run typecheck`, `npm run lint`, `npm test --workspaces`, and the
   database suites `npm run test:db -w @agentos/db` and
   `npm run test:db -w @agentos/api` against a scratch PostgreSQL.
6. Open a pull request and pass the merge gate the ordinary way. There is no
   separate approval path for template changes.
7. After the deploy, read the result back:
   `GET /projects/<projectId>/task-templates` should show the new step count on
   the canonical name and the outgoing graph under its legacy name.

## What not to do

Do not edit template structure in the database. There is no endpoint for it —
the two half-built step authoring routes were removed on 2026-08-26 — and direct
SQL puts the row into a shape the closed sync contract will refuse on the next
deploy, blocking every later template change until someone reconstructs the
graph by hand.
