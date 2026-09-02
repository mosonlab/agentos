---
id: 05-todo-slot-toggle
title: "TODO-slot gate toggle: PATCH rule, chain read shape, chain view toggle"
blocked_by: [01-gate-slot-helper]
risk: false
---

# 05: TODO-slot gate toggle: PATCH rule, chain read shape, chain view toggle

**What to build:** After dispatch, an operator looking at a chain in the task
detail view sees each gate slot's current `approvalGate` as a toggle. While the
slot task is still TODO the toggle works: flipping it patches the task, the
change lands, and an operator-actor activity row records who changed what. Once
the slot task is DOING, REVIEW, or DONE the toggle is disabled with the refusal
reason shown; the API refuses the same attempt with 409 and a message naming the
state. Any other chain task keeps refusing `approvalGate` changes (409, reason
naming the non-slot cause), and a non-chain task's gate toggle keeps working
exactly as today. Spec stories 21–28, decisions D9–D10 plus the chain-view
surface of D11.

The vertical: `patchTask`'s preflight becomes conditional on `gateSlotOf` and
TODO status, with the status re-read under the Task-row mutex so a concurrent
state change loses the race; the chain read shape (`ChainStep`) gains
`gateSlot: "spec" | "merge" | null`; the chain list row renders a toggle in
place of the static lock icon for slot steps only, enabled iff the step is
TODO, wired to the task PATCH by the task detail page; the refusal message text
is shared between server and disabled-toggle reason so they cannot drift.

**Blocked by:** 01-gate-slot-helper

- [ ] `patchTask` tests (unit and dbtest, run by named file) show: an `approvalGate` change accepted on a TODO spec-slot task and on a TODO merge-slot task, each writing the value and an operator-actor `TaskActivity` naming the slot and the new value; 409 with a message naming the state on a DOING slot task; 409 on a REVIEW and a DONE slot task; 409 with the non-slot reason on a chain task that is not a gate slot; a non-chain task's `approvalGate` patch unchanged from today.
- [ ] A dbtest shows the race guard: a slot task that leaves TODO between the preflight read and the locked write is refused, not patched.
- [ ] The chain read shape returns `gateSlot` as `"spec"` for the specification step, `"merge"` for the merge readiness step, and `null` for every other step, asserted where the existing board-contract read shape is tested.
- [ ] An `apps/web` test renders the chain list with a slot step in TODO showing an enabled toggle and a slot step in DOING showing a disabled toggle whose title carries the shared refusal reason; a non-slot step keeps today's rendering. Clicking the enabled toggle issues the task PATCH (asserted via the existing web test harness).
- [ ] New strings exist in both locales; the i18n sweep test passes; typecheck of `@anneal/db`, `@anneal/api`, and `apps/web` passes; `npm run lint` passes on touched files.
