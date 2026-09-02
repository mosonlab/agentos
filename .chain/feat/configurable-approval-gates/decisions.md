# Plan decisions: feat/configurable-approval-gates

Load-bearing decisions of the slice decomposition. The spec's own decisions
(D1-D13, A1-A6 in `spec.md`) are inherited, not restated; each entry below is a
planning choice this slice set makes on top of them.

## P1: Two prefactor slices, both unblocked

Chosen: cut the shared `gateSlotOf` helper (slice 01) and the gated-readiness
fixture option (slice 02) as standalone prefactor slices with empty
`blocked_by`, before any behaviour slice.

Rejected: folding the helper into the first slice that needs it (05 or 06), and
folding the fixture option into the first merge-gate test (07).

Reason: three behaviour slices (05, 06, and the chain read shape) consume the
helper and three (07, 08, 09) consume the fixture. Extracting them first means
those consumers start from a green, tested primitive instead of each racing to
create it, and it removes the only file-level coupling that would otherwise
force 05 and 06 to serialise. This is the "make the change easy" step; both
prefactors are small enough to verify in isolation.

## P2: Merge gate split into open (07), approve (08), reject (09)

Chosen: three slices — gate opens and holds (D5), approval releases the worker
with the exact-head assertion and drift reopening (D6+D7), rejection ends the
chain (D8) — with 08 and 09 both blocked only by 07 and parallel to each other.

Rejected: one slice for the whole merge-gate lifecycle; also splitting D7's
fail-closed worker assertion from D6's approve disposition.

Reason: a single slice would carry four dbtest scenarios across two decision
channels plus changes to chain activation, both decision modules, and the
readiness worker — too much for one fresh context window. D6 and D7 stay
together because the approve disposition without the worker assertion is the
fail-open state the spec forbids shipping; a slice boundary between them would
make slice 08's intermediate state unmergeable on safety grounds. 08 and 09
touch different regions of the decision modules (approve vs reject paths), so
they can run in parallel; the merge conflict risk is noted in P6.

## P3: Spec gate lifecycle folded into the instantiate slice (06)

Chosen: the gated specification step's runtime behaviour (stories 29-34) is
verified inside slice 06 rather than as its own slice.

Rejected: a dedicated spec-gate lifecycle slice.

Reason: the spec gate needs zero new runtime machinery — it is the existing
`approvalGate` path exercised through a task that instantiation now gates. A
standalone slice would have an empty "what to build" and test-only content
whose criteria are not red against a base that already implements the
behaviour. Folded into 06, the lifecycle test doubles as the end-to-end demo
that makes 06 a true vertical: dispatch with the gate on, watch the chain
pause, approve and reject.

## P4: Project defaults slice (03) carries its own UI; instantiate dialog UI is separate (10)

Chosen: slice 03 is a full vertical (migration, wire contract, PATCH, read
shape, project-page toggles, tests); the instantiate dialog checkboxes are
their own slice 10 behind 03 and 06.

Rejected: putting all three D11 web surfaces in one UI slice; putting the
dialog checkboxes into 06.

Reason: the project toggles' only dependency is the PATCH route in the same
slice, so folding them keeps 03 vertical at small cost. The dialog checkboxes
depend on both the project defaults (pre-fill) and the instantiate `gates`
contract (payload), so they cannot join either parent without serialising the
two; a thin trailing slice keeps 03 and 06 parallelisable. A single "web UI"
slice was rejected as a horizontal layer cut. The chain-view toggle lives in 05
because it is the UI face of the PATCH rule built there.

## P5: Docs slice (04) is unblocked

Chosen: the documentation slice has empty `blocked_by` and can land before any
code.

Rejected: blocking docs on the behaviour slices they describe.

Reason: the contract is fully fixed by the spec (D12, corrected by A1), so the
text can be written from it; nothing in the docs is verified against runtime
behaviour, and the route-coverage test needs no new headings. Landing docs
early also surfaces contract disagreements while the behaviour slices are still
open. Risk of describing something the implementation later diverges from is
bounded by the chain's review and regression steps, which see docs and code
together.

## P6: Accepted file-overlap between parallel slices, noted rather than serialised

Chosen: slices 05 and 08 both touch the task PATCH module (05 the
`approvalGate` preflight, 08 the status-decision approve path); slices 08 and
09 both touch the decision modules (approve vs reject branches). They stay
parallel.

Rejected: adding `blocked_by` edges to serialise every file overlap.

Reason: the overlapping edits are in disjoint branches of the same functions
and merge mechanically; serialising them would deepen the critical path from 3
to 5 for conflict avoidance only. The same judgement the spec already applies
to the concurrent `feat/inbox-free-text-answers` chain (expected mechanical
conflict in the inbox decision module) applies inside this chain.

## P7: Risk flags

Chosen: `risk: true` on 03 (Prisma migration, persisted schema) and on 07, 08,
09 (they change the merge tail, whose end action — merging a pull request — is
irreversible and external).

Rejected: flagging 06 (writes `approvalGate` on created tasks) and the
prefactors.

Reason: 06 writes ordinary task rows through the existing instantiate
transaction and creates nothing irreversible; the prefactors are a pure helper
and test fixture. The flag is reserved for the two surfaces where a defect
destroys data or merges something a human did not approve.

## P8: Slice numbering and the critical path

Dependency order: 01-04 unblocked, 05 behind 01, 06 behind 01+03, 07 behind 02,
08 and 09 behind 07, 10 behind 03+06. Critical path depth is 3
(02 -> 07 -> 08), with six slices startable at depth <= 1. Every spec
requirement maps to exactly one slice: stories 1-9 -> 03, 10-20 -> 06 (12-13 ->
10), 21-28 -> 05, 29-34 -> 06, 35-44 and 50-51 -> 07/08 per P2, 45-49 -> 09,
52-57 -> 04. Chain-level proof (repository merge gate) stays outside the slice
set.
