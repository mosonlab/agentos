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
critical path stays depth 2 for four of the seven downstream slices and depth 3
for the UI.

## 2. The shared ChainControl reader lives in the db package

Choice: slice 01 exports one reader (given `(projectId, chainId)` pairs, return
current hold state, treating absent and released identically) from the db
package, and every enforcement seam consumes it.
Rejected: each seam writing its own lookup; placing the reader in the api
package.
Reason: the three enforcement seams sit in two packages
(`packages/db/src/workflow.ts` for activation; `packages/api/src/chain.ts` and
`packages/api/src/run-claim.ts` for admission and claim), and the api package
already depends on db, never the reverse — so db is the only home all three can
import from. One reader is also what makes "absence means not held" a single
implementation detail instead of three copies. The claim SQL lane still needs
an inline NOT EXISTS (raw SQL cannot call the reader); slice 05 owns keeping
that predicate semantically identical to the reader.

## 3. Enforcement is three parallel slices (03 activation, 04 admission, 05 claim), not one

Choice: one slice per enforcement seam, each blocked only by 01.
Rejected: a single "enforce the barrier" slice; folding enforcement into 01.
Reason: the seams are in three different files across two packages with no
shared code beyond the slice-01 reader, each has its own test seam and prior
art, and each is independently demoable (a completion that withholds, a start
that refuses, a poll that skips). Splitting them is what makes the plan
parallel; folding them together would recreate the one-giant-context problem
the tracer-bullet rule exists to avoid.

## 4. Enforcement slices seed hold state directly where the Hold route is not the subject

Choice: slices 03-05 create held/released states by writing `ChainControl` rows
in test seed (or via the Hold route where the race under test involves it, as
in 03's completion/Hold races), rather than requiring slice 02's Resume.
Rejected: blocking 03-05 on 02 so every test drives only public routes.
Reason: the spec's testing philosophy prefers the HTTP seam, but it also
accepts database rows an operator could read as observable state; seeding the
authority row directly is exactly how existing dbtests seed Tasks and Runs.
This keeps 02 through 05 mutually unblocked. The full public-route cycle
(Hold via route, Resume via route, three cycles audited) lives in 02.

## 5. Race tests are assigned by the seam that defines them

Choice: completion/Hold races in both orders live in 03 (activation);
concurrent double-Resume lives in 02 (resume); claim-vs-hold visibility lives
in 05 (claim).
Rejected: a dedicated "races" slice at the end.
Reason: each race is the defining behaviour of one seam's slice — a trailing
race slice would leave 02/03/05 landing without their own acceptance-critical
evidence and would recreate a deep critical path.

## 6. One dbtest file per slice instead of the spec's "one new dbtest file"

Choice: each backend slice owns its own `*.dbtest.ts` file (hold-authority,
resume, activation-barrier, claim-exclusion, board-non-interaction as needed).
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
tests) that is demoable as "the operator sees and drives the hold". A separate
read-contract slice would be a thin horizontal layer with no independent demo.

## 8. Slice 06 exists to pin the board's negative space

Choice: a small dedicated slice asserts card moves never touch ChainControl and
board surfaces never describe a parked Step as a held Chain.
Rejected: scattering these assertions across 01 and 07; skipping them as
"nothing changed, nothing to test".
Reason: the brief names "Moving a Task card never pretends to Hold a Chain" as
acceptance, and user stories 24-26 are all negative-space guarantees. Negative
space that no test names is exactly what a later refactor breaks silently. The
slice is cheap and independently verifiable.

## 9. Docs are an unblocked slice

Choice: slice 08 (operator handbook) has no blockers and can be written from
the spec.
Rejected: blocking docs on 02 so they document shipped routes.
Reason: the spec fixes both route contracts exactly (paths, fields, refusals,
idempotence), so the handbook can be authored in parallel; the chain-level
review/merge gate still catches drift if implementation diverges, because docs
checks and the review pass run over the assembled branch.

## 10. Risk flag is true only for slice 01

Choice: `risk: true` on 01, false elsewhere.
Rejected: flagging every backend slice because it writes database rows.
Reason: the flag marks schema migration of persisted data and irreversible
external actions. Only 01 carries a migration; every other slice writes
ordinary rows through paths that are routinely exercised and reversible, and
flagging everything would make the flag carry no information.

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
Reason: the state machine (inlined in slice 01 from the spec's contract) is one
object; two migrations for one model in one feature would force 02 to be a
schema slice too and serialize the DAG for no benefit.
