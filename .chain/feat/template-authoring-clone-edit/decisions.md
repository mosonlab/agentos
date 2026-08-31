# Plan decisions: template authoring clone-and-edit

Each entry names the choice, the alternatives rejected, and the reason, so a
fresh-context revision inherits the why.

## D1. One prefactor slice, limited to the refusal envelope

Choice: slice 01 adds only the authoring refusal type, its code union and the
404/409/422 mapping. The template-row lock helper, the validator module, the
shared dbtest fixture and the docs-test helper each land with their first
consumer (slice 03 for the first three, slice 10 for the last).

Rejected: a wider prefactor carrying the lock helper, validator scaffold and
fixture; folding the refusal type into the clone slice and making replace
block on clone.

Reason: the refusal type is the only thing two otherwise independent slices
(02 clone, 03 replace) would both have to invent, so it is the only thing worth
a prefactor. Everything else has exactly one first consumer and would be dead
code with no red acceptance criterion if landed alone. Folding it into clone
would deepen the critical path by one slice for no gain.

## D2. Validator split into three error groups plus warnings

Choice: 04 (order and base: codes 2-5), 05 (output kinds: codes 6-8),
06 (gate, assignee, integrator: codes 9-11), 07 (three warnings), all blocked
only by 03. Slice 03 creates the validator as a pure function with the fixed
check order laid out and `graph_empty` implemented; each later slice inserts
its checks at their spec positions.

Rejected: one validator slice with all eleven errors and three warnings;
one slice per code.

Reason: a single slice is the largest unit in the plan and would serialise
four contexts' worth of work behind one; per-code slices would have eleven
parallel edits to the same ordered list and the same handbook entry. Three
groups follow natural fault lines (pure positions, pure output kinds, checks
that need Agent facts), keep each slice well inside one context, and limit
concurrent edits of the shared list to four insertions at known positions.
Each group owns its own dbtest file to avoid append conflicts in one test file.

## D3. Shared dbtest fixture created in slice 03, not in 01 or 02

Choice: 03 creates the shared fixture helper (project, environment, Agents
including `merge-integrator`, Repo with grants, non-canonical template, request
helpers for clone, replace and instantiate). Slice 02 keeps its own inline
fixture like `template-overrides.dbtest.ts` because it runs in parallel with 03.

Rejected: fixture in the prefactor slice; clone blocked on 03.

Reason: a fixture without a consumer has no red criterion; the clone test
needs little (a source template with a webhook and a second project) and the
duplication is a few lines. Every slice downstream of 03 reuses the helper.

## D4. Handbook entries land with their routes; the docs-test assertion lands once, in slice 10

Choice: 02 writes the clone entry, 03 writes the replace entry and removes the
"no create-template route" sentence, 04-07 append their codes to the replace
entry, 10 extends `scripts/operator-api-docs.test.mjs` with a section-scoped
lookup asserting both routes.

Rejected: each route slice extending the docs test; a standalone docs-test
slice.

Reason: both route slices would have to generalise the same `routeSection`
helper in parallel, a guaranteed conflict; a standalone slice would be a
single test edit with no product behaviour. Slice 10 already blocks on both
route slices and is the natural home for a whole-surface assertion.

## D5. Instantiation moves entirely inside its transaction behind the template lock

Choice: `instantiateTemplate` takes the template-row lock as its first
statement inside the existing Serializable transaction, then reads the
template and steps and runs every dependent check there. The lock order
becomes TaskTemplate row, then Task rows, then Agent rows, then grant rows;
replace takes only the template row, so no cycle is possible.

Rejected: keep the pre-transaction read and verify a step digest under the
lock; a chain-structure style advisory lock keyed by template id.

Reason: a digest re-check is a second mechanism to keep in step with the
first, and the spec asks for one protocol shared by replace and instantiate.
The row itself is the natural mutex and a `FOR UPDATE` helper matches the
existing Task, Run and Agent helpers exactly. The unit seam that stubs Prisma
for `instantiateTemplate` is touched, not extended (spec Testing Decisions).

## D6. Replace deletes and recreates step rows; in-use is counted by template id or step id

Choice: the replace transaction deletes the template's step rows and creates
the submitted ones with dense indexes; row ids are not preserved. The in-use
check counts Task rows whose `templateId` is the template or whose
`templateStepId` is one of its steps, under the lock.

Rejected: diffing and updating rows in place to preserve ids.

Reason: nothing may reference the rows once in-use is refused (`onDelete:
SetNull` on Task is exactly what the in-use rule guards), and delete-plus-create
is the only implementation with no cascade or renumbering policy. Counting by
both columns covers a Task whose step pointer was already nulled.

## D7. Canonical detection uses the canonical identity registry

Choice: `template_canonical` and `template_name_reserved` are true exactly when
`canonicalTemplateIdentity(name)` is non-null, which covers both current
canonical names and registered-legacy names minted by `legacyTemplateName`.

Rejected: comparing against the two canonical names only; a persisted
canonical flag.

Reason: the registry is the existing single authority for canonical identity
(sync, run-open and rollover already consult it) and the schema needs no new
column. Tests exercise one canonical and one legacy name each, per the brief.

## D8. Warning role sets

Choice: review role means `sol-findings` or `blind-findings`; implementation
role means `implementation` or `fixed-implementation`; regression role means
`regression-verification`; all resolved through `stepRole`, so versioned
kinds (`-vN`) resolve too.

Rejected: counting `plan-review` as a review step; a new authoring-only list.

Reason: `no_review_step` and `same_agent_implements_and_reviews` are about
code review of the implementation; a plan review does not review code. Using
`stepRole` keeps the warnings aligned with the roles the rest of the platform
recognises, as the spec requires.

## D9. Integrator check reuses `canonicalIntegratorBindingRefusal` verbatim

Choice: `integrator_binding_invalid` is produced when the existing canonical
binding rule returns a refusal for the step (agent name, step index, output
kind, template name). `assignee_invalid` runs first so the Agent name is known.

Rejected: restating the rule in the validator.

Reason: the spec forbids relaxing or restating the rule; one authority.

## D10. Agent facts are read, not locked, inside replace

Choice: the replace transaction reads the assignee Agents by id (no project
filter, so other-project Agents are visible to `assignee_invalid`) and hands
the facts to the pure validator; it does not take the Agent-row lock.

Rejected: locking Agent rows in replace as instantiation does.

Reason: authoring has no runtime consequence until instantiation, which locks
and re-checks every Agent itself; an Agent archived after authoring is caught
there. Locking here would add the Agent rows to replace's lock set for no
observable guarantee.

## D11. Route allowlist removal is an independent slice

Choice: slice 09 has no blockers and touches `templates.ts`,
`template-errors.ts`, `refusal.ts`, the dispatch-binding dbtest, the templates
unit test and `task-routing-v1.md`.

Rejected: sequencing it after 01 or 08 because they touch neighbouring lines.

Reason: it removes one case line where 01 adds a new block and 08 edits a
different region of `templates.ts`; the overlap is a trivial merge and the
slice is the only one that can start immediately alongside 01.

## D12. Slice 10 blocks on 08 as well as 02 and 03

Choice: the end-to-end slice waits for the instantiation change.

Rejected: blocking on 02 and 03 only for a shallower path.

Reason: the end-to-end test is the acceptance evidence for the final shape of
the instantiate path; running it before 08 would verify a path that 08 then
rewrites. The critical path is 01 - 03 - 08 - 10, four slices; everything else
is width.

## D13. Risk flags

Choice: `risk: true` on 02 (creates template and step rows), 03 (deletes and
creates step rows), 08 (changes the transaction that writes Tasks); `false` on
01, 04-07, 09, 10, which add checks, tests or documentation and write no
persisted data of their own.

Reason: the frontmatter contract defines risk as touching persisted data or an
irreversible external action; a validator refusal touches nothing.

## D14. No schema migration

Choice: the feature uses the existing `TaskTemplate` and `TaskTemplateStep`
columns; no generation, revision or canonical flag is added.

Reason: immutable-after-use replaces copy-on-write (brief ruling), so nothing
new needs to be persisted, and canonical identity is derivable (D7).
