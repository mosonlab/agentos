# Plan decisions

Load-bearing decisions of the plan step. The spec (spec.md, sections cited by
number below) fixes the behaviour; these entries record only how the plan cut
it into slices and why. A fresh-context revision should treat each entry as
the reason the graph looks the way it does.

## D1. Single schema foundation; server slices depend on the column, not on each other

Choice: slice 01 is the only schema change, and slices 04, 05, 06 depend only
on 01. Their dbtest fixtures seed `dispatchAfterTaskId` directly on Task rows
with prisma instead of going through the instantiate route.

Rejected: making dispatch (04), the start guard (05) and the board (06) depend
on the instantiate-binding slice (03) so their fixtures use the public API.

Reason: the column plus its storage constraints fully define a valid binding
(spec section 5), so direct seeding tests exactly the same rows the route
would produce, and cutting the 03 dependency keeps four slices runnable in
parallel after 01. Revised per plan-review finding PLAN-RACE-001: direct
seeding cannot prove the cross-path mutex contract between instantiation and
terminal completion (spec 8.10), and the manual walkthrough is human evidence,
not executable slice acceptance. Executable end-to-end route-to-dispatch
coverage therefore lives in the dedicated join slice 08, blocked by 03 and 04,
which drives both race outcomes through the production entry points. The
frontier stays four wide after 01; the critical path gains one third-level
join slice, a cost the cross-path proof requires.

## D2. Overrides (02) before binding (03), sequenced by blocked_by

Choice: 02-step-overrides has no prerequisites and runs in the first wave;
03-after-task-binding is blocked by both 01 and 02.

Rejected: (a) both slices independent - they rewrite the same
`instantiateTemplate` body and route input schema (`packages/api/src/templates.ts`,
`packages/api/src/app.ts` around line 1122), so parallel execution guarantees
merge conflicts inside one function; (b) binding first, overrides second -
binding needs the schema slice anyway, so it can never be in the first wave,
while overrides need no schema and can.

Reason: this order maximises first-wave width at zero cost to the critical
path, and it puts the shared typed-refusal error module (D3) in the earlier
slice so 03 consumes it instead of both slices inventing one.

## D3. One typed refusal module instead of extending the message-regex

Choice: slice 02 introduces a dedicated error class carrying a stable `code`
(suggested `packages/api/src/template-errors.ts`) plus a route mapping to 400
`{ error, code }`; slice 03 reuses it for the after_task_* codes.

Rejected: extending the existing message-regex match in the instantiate route
handler per new refusal.

Reason: spec 6.3 requires every new code to be recognised as a 400 by
construction, not by a message that happens to match; a shared class is the
smallest mechanism that satisfies that for sixteen codes across two slices.

## D4. Manual-start guard and chain-detail projection are one slice

Choice: slice 05 delivers spec 6.6 and 6.8 together.

Rejected: separate slices for the start-route 409 and the chain-detail
blockedOn/startable fields.

Reason: spec 6.8 requires the button state and the route guard to be unable to
disagree; both are computed by the same start-decision ladder in
`packages/api/src/chain.ts`, so splitting them would put two slices in one
function and manufacture the exact files_hint overlap the graph avoids
elsewhere.

## D5. Web UI slice is unblocked

Choice: 07-web-blocked-on-ui has empty blocked_by and codes against the API
contract fixed by spec 6.7-6.9.

Rejected: blocking it on 05 and 06.

Reason: apps/web declares its own response types in `apps/web/src/lib/types.ts`
and its tests run against local fixtures (verified at the frozen base: no
type import from @agentos/api or @agentos/db), so there is no build or test
dependency. The spec is the shared contract; if a revision changes 6.7/6.8
field shapes it must touch both sides anyway.

## D6. No expand-migrate-contract staging

Choice: the schema work is one tracer-bullet slice (01).

Rejected: staging the column as expand, backfill, contract slices.

Reason: spec section 5 mandates an additive-only migration with no backfill
and no change to existing constraints; there is nothing to migrate or
contract, so staging would add empty slices.

## D7. risk=true for every slice that creates or governs persisted runtime data

Choice: slices 01 through 06 and 08 carry risk: true; only the web-only
slice 07 is risk: false.

Rejected: the earlier reading that limited risk to persisted data shape
(schema) and treated Runs, Task rows, bindings and activity as ordinary
reversible writes.

Reason: revised per plan-review finding PLAN-RISK-001. The plan contract and
docs/governance/task-routing-v1.md define persisted data as runtime-created
user or system data, including its schema; reversibility is not an exemption.
01 changes the schema; 02 persists effective assignees on new Task rows; 03
persists the dispatch binding and its activity rows; 04 creates Runs and
updates Task and activity state; 05 gates durable Run creation; 06 reads the
durable binding and predecessor state for the public projection; 08 drives
durable binding and Run creation through the production entry points. Slice 07
renders API fixtures in apps/web and touches no persisted data.

## D8. New dbtest files per feature area instead of growing chain.dbtest.ts

Choice: 02, 03, 04, 06 and 08 each introduce a focused dbtest file
(template-overrides, template-dispatch-binding, dispatch-activation,
board-blocked-on, dispatch-lifecycle); 05 extends the existing chain test
files it changes behaviour in, and 06 additionally extends board.test.ts for
the pure projection.

Rejected: appending all coverage to `packages/api/src/chain.dbtest.ts`.

Reason: three parallel slices appending to one test file is a guaranteed
conflict; per-area files keep files_hint overlap between independent slices
at zero and match the repo's existing one-file-per-concern dbtest layout.

## Requirement-to-slice map

Brief change 1 (afterTaskId on instantiate): 03-after-task-binding.
Brief change 2 (stepOverrides): 02-step-overrides.
Brief change 3 (activateChainSuccessor dispatch): 04-terminal-dispatch.
Brief change 4 (blocked-on marker): API board 06-board-blocked-on; API chain
detail and manual-start refusal 05-start-guard-chain-detail; web rendering
07-web-blocked-on-ui.
Brief change 5 (migration and schema tests): 01-dispatch-binding-schema.
Cross-path race proof (spec 8.10, route-to-completion lifecycle):
08-binding-dispatch-integration, a verification join slice over the
implementations delivered by 03 and 04; it owns no implementation requirement
of its own.
Chain-level evidence (full typecheck across slices, merge gate, merge-lease
delivery) stays outside the slice set per the task contract.
