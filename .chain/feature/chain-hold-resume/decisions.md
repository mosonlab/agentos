# Plan decisions: hold after current layer and resume Chain

Each entry: the choice made, the alternatives rejected, and the reason. The
spec of record (`spec.md` beside this file) fixes the product contract; these
decisions are about how the plan slices it.

## 1. Slice 01 bundles the schema with the Hold route instead of shipping a schema-only prefactor

Choice: one slice ships `ChainControl`/`ChainControlEvent`, the migration, the
shared reader, and the Hold route end to end.
Rejected: a schema-only slice 00 followed by a separate Hold-route slice.
Reason: a schema-only slice is horizontal and demoable by nothing; bundling the
Hold route makes slice 01 a true tracer bullet (press Hold, see the row and the
event) while still unblocking slices 02-07 after a single predecessor. The
critical path stays depth 2 for the backend frontier and depth 3 for the UI.

## 2. The shared ChainControl reader lives in the db package

Choice: slice 01 exports one reader (given `(projectId, chainId)` pairs, return
current hold state, treating absent and released identically) from the db
package, and every enforcement seam consumes it.
Rejected: each seam writing its own lookup; placing the reader in the api
package.
Reason: the four enforcement seams sit in two packages
(`packages/db/src/workflow.ts` for activation; `packages/api/src/chain.ts` and
`packages/api/src/run-claim.ts` for admission and claim; and the shared Run-open
path used by the scheduler and other producers), and the api package already
depends on db, never the reverse — so db is the only home all four can import
from. One reader is also what makes "absence means not held" a single
implementation detail instead of four copies. The claim SQL lane still needs
an inline NOT EXISTS (raw SQL cannot call the reader); slice 05 owns keeping
that predicate semantically identical to the reader.

## 3. Enforcement is four parallel slices (03 activation, 04 admission, 05 claim, 06 enqueue), not one

Choice: one slice per enforcement seam, each blocked only by 01.
Rejected: a single "enforce the barrier" slice; folding enforcement into 01.
Reason: activation, admission, claim, and Run creation are independent bypass
boundaries with no shared implementation beyond the slice-01 reader. The
scheduler can call the Run-open path without consuming admission or activation,
so activation, admission, and claim alone do not satisfy "no later layer is
enqueued." Each seam has its own observable demo (a completion that withholds,
a start that refuses, a poll that skips, or a due schedule that creates no Run).
Splitting them preserves a four-way post-01 backend frontier without deepening
the critical path.

## 4. Enforcement slices seed hold state directly where the Hold route is not the subject

Choice: slices 03-06 create held/released states by writing `ChainControl` rows
in test seed (or via the Hold route where the race under test involves it, as
in 03's completion/Hold races), rather than requiring slice 02's Resume.
Rejected: blocking 03-06 on 02 so every test drives only public routes.
Reason: the spec's testing philosophy prefers the HTTP seam, but it also
accepts database rows an operator could read as observable state; seeding the
authority row directly is exactly how existing dbtests seed Tasks and Runs.
This keeps 02 through 06 mutually unblocked. The full public-route cycle
(Hold via route, Resume via route, three cycles audited) lives in 02.

## 5. Race tests are assigned by the seam that defines them

Choice: completion/Hold races in both orders live in 03 (activation);
completion/Resume races in both mutex orders and concurrent double-Resume live
in 02 (resume); claim-vs-hold visibility lives in 05 (claim).
Rejected: a dedicated "races" slice at the end.
Reason: each race is the defining behaviour of one seam's slice — a trailing
race slice would leave 02/03/05 landing without their own acceptance-critical
evidence and would recreate a deep critical path. Double-Resume alone cannot
prove that completion and release serialize to exactly one activation, so both
lock orders belong in slice 02.

## 6. One dbtest file per slice instead of the spec's "one new dbtest file"

Choice: each backend slice owns its own `*.dbtest.ts` file (hold-authority,
resume, activation-barrier, admission-refusal, claim-exclusion, and
enqueue-barrier as needed).
Rejected: the single new dbtest file the spec's testing section sketches.
Reason: slices 02-06 execute in parallel in fresh contexts; a single shared new
file guarantees merge conflicts between them. The dbtest runner discovers
`*.dbtest.ts` by glob with per-file database assignment, so extra files carry
no registration or infrastructure cost. This is a consequential deviation from
the spec's testing sketch, not from its contract: the seam (createApp against a
real database) and the coverage are unchanged.

## 7. The read `control` object ships with the UI slice, not with slice 01

Choice: slice 07 adds the `control` projection to `GET /tasks/:taskId/chain`
together with the Chain card toggle, badge, hints, and locales.
Rejected: putting the projection in 01 (where the model lands) or in a separate
read-contract slice.
Reason: the projection's only consumer is the card; shipping them together
makes 07 a complete vertical (API field, web type, component, locales, wiring,
tests) that is demoable as "the operator sees and drives the hold". It blocks
on both Resume and admission because its toggle needs both operations and its
disabled controls must consume the real held-aware `startable` response. A
separate read-contract slice would be a thin horizontal layer with no
independent demo.

## 8. Board negative-space evidence is folded into slices 01 and 07

Choice: slice 01's authority dbtest proves a card move neither creates nor
changes ChainControl and leaves the board read projection unchanged; slice 07's
UI tests prove parked-card wording never claims a Chain hold.
Rejected: a dedicated board slice; skipping the guarantees because production
board code is unchanged.
Reason: the dedicated slice was test-only and would already pass once the model
existed, so it was not an independently demoable tracer bullet. Folding the
tests preserves every negative-space guarantee while keeping their ownership
with the authority and UI changes that make each criterion red at the frozen
base. This removes one nominal post-01 branch, but not an implementation branch.

## 9. Docs are an unblocked slice

Choice: slice 08 (operator handbook) has no blockers and can be written from
the spec.
Rejected: blocking docs on 02 so they document shipped routes.
Reason: the spec fixes both route contracts exactly (paths, fields, refusals,
idempotence), so the handbook can be authored in parallel. The slice adds its
own executable handbook contract test because the existing frozen-record and
release-documentation checks do not inspect the operator handbook; those remain
regression verification only. Chain-level review and Merge Gate evidence stay
outside the slice set.

## 10. Risk follows persisted-data effects, not migrations alone

Choice: `risk: true` on slices 01, 02, 03, 06, and 07; false on the read-only
admission and claim defenses and on documentation.
Rejected: treating only schema migration or irreversible writes as risky;
flagging read-only/test-only work.
Reason: the planning contract marks every slice that touches persisted data or
an irreversible external action. Slice 02 releases control, writes events,
activity, and Runs; slice 03 writes withheld activity; slice 06 changes whether
Run rows are created; and slice 07 exposes controls that execute persisted
transitions. Slices 04 and 05 add refusal/filter reads without a new persisted
effect, while slice 08 is documentation.

## 11. The operator Resume gets a name distinct from the existing auto-resume

Choice: code and event vocabulary for the operator operation must not reuse
"resume" bare where it could collide with the existing
`chainDispatch.autoResume` stalled-successor machinery (for example, prefer
"chain control release" or "operator resume" in internal identifiers; the route
path and UI label stay `resume` as the spec fixes them).
Rejected: reusing the auto-resume vocabulary.
Reason: two mechanisms named identically in one file
(`packages/db/src/workflow.ts`) is a reviewer trap and an audit trap; the
collision was found during the codebase survey, not in the spec.

## 12. Hold's release-side columns ship in the slice-01 migration

Choice: the single migration includes the released-state fields and the hold
generation even though Resume lands in slice 02.
Rejected: a second migration in slice 02.
Reason: the state machine (described in slice 01 from the spec's contract) is one
object; two migrations for one model in one feature would force 02 to be a
schema slice too and serialize the DAG for no benefit.

## 13. Request idempotency is durable across later opposite transitions

Choice: the audit event schema carries a uniqueness constraint for one request
identifier per Chain and transition kind, and both routes consult that durable
history before changing current state. A replay of an accepted Hold after a
release, or an accepted Resume after a later Hold, returns a deduplicated
success without changing the current authority or creating an event.
Rejected: deduplicating only against the request identifier stored on the
mutable current-state row; relying on the current held/released state alone.
Reason: current-row checks handle immediate retries but forget an accepted
request as soon as the opposite transition overwrites current facts. The
append-only history already exists for exact audit and is the durable place to
recognize delayed network replays; database uniqueness closes concurrent races.
