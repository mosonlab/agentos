# Plan decisions: feat/configurable-approval-gates

Load-bearing decisions of the slice decomposition. The spec's own decisions
(D1-D13, A1-A6 in `spec.md`) are inherited, not restated; each entry below is a
planning choice this slice set makes on top of them.

## P1: Slot identity is a visible read vertical; the fixture belongs to gate opening

Chosen: slice 01 combines the shared `gateSlotOf` authority with the
`ChainStep.gateSlot` contract, chain-read projection, and API proof. The
gated-readiness fixture option is part of slice 07, the first production
behaviour that consumes it. Slice 02 is removed, and slice 07 is unblocked.

Rejected: standalone helper and test-fixture prefactor slices.

Reason: the chain-read projection gives slice 01 an independently demonstrable
operator/API result, while a test-only fixture has no independent runtime
result. Moving the projection out of 05 preserves the 05/06 parallel frontier;
folding the fixture makes 07 startable immediately and does not deepen the
critical path, so no behaviour parallelism is lost. This overturns the original
prefactor decomposition in response to PLR-001.

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

Chosen: `risk: true` on 03, 05, 06, 07, 08, 09, and 10. Slice 03 changes the
persisted schema; 05 changes stored task gates and writes activity rows; 06
persists resolved gates on dispatched tasks; 10 controls the request that
determines those persisted values; and 07-09 alter the merge tail whose end
action is an irreversible external merge. Slices 01 and 04 remain false.

Rejected: the earlier narrower interpretation that ordinary persisted task
writes were non-risky.

Reason: the routing contract's Critical rule covers any work touching persisted
runtime-created data, not only destructive writes. This overturns the original
risk decision in response to PLR-002; it changes metadata only and adds no
dependency.

## P8: Slice numbering, requirement ownership, and the critical path

The retained IDs are 01 and 03-10; removed ID 02 is not reused. Slices 01, 03,
04, and 07 are unblocked; 05 depends on 01; 06 depends on 01+03; 08 and 09
depend on 07; and 10 depends on 03+06. The initial frontier is four slices, the
next frontier is four slices, and the longest path is three slices
(01/03 -> 06 -> 10). Folding 02 into 07 therefore shortens the merge-gate path,
and moving the chain-read projection to 01 does not serialise 05 and 06.

Every specification requirement has one owning slice:

- D1 and the D10 chain-read contract -> 01.
- Stories 1-7 plus D2-D3 and the project-default UI surface -> 03.
- Stories 52-57 and D12 -> 04.
- Stories 21-28 plus D9 and the chain-toggle UI surface -> 05.
- Stories 8-11, 14-20, and 29-34 plus D4 -> 06. Stories 8-9 move here from 03;
  slice 03 proves migration preservation, while 06 owns the runtime
  non-retroactivity behaviour.
- Stories 35-37, 44, and 50 plus D5 and the gated-readiness fixture capability
  -> 07.
- Stories 38-43 and 51 plus D6-D7 -> 08.
- Stories 45-49 plus D8 -> 09.
- Stories 12-13 and the instantiate-dialog UI surface -> 10.

The repository Merge Gate, snapshot scan, and repository-wide proof are
chain-level evidence and remain outside the slice set.
