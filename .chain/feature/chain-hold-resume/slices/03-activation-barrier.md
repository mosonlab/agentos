---
id: 03-activation-barrier
title: Activation barrier at chain successor activation
blocked_by:
  - 01-chain-control-authority-and-hold
risk: false
---

# 03: Activation barrier at chain successor activation

**What to build:** A Step of a held Chain that finishes its Run completes
normally — output persisted, Task marked DONE, approval gate opened if it has
one — but the next layer is not activated. The successor-activation routine
reads the ChainControl authority (via the shared reader from slice 01) inside
its existing full-Chain-mutex critical section; when the Chain is held and the
layer it would activate is above the held layer, it activates nothing, records
a withheld narration on the completing Step (the counterpart of the existing
'Predecessor layer completed; step queued' line), and returns the same
'nothing activated' shape it uses for its other park cases. Layers at or below
the held layer are untouched. Because Hold and completion both serialize on the
Chain mutex, the completion/Hold race has a defined outcome in both orders.
This slice also pins the merge-tail and approval-gate interactions: a hold
placed before the merge-integrator layer keeps that layer un-activated while
the running readiness Step completes and the merge lease is never touched, and
answering an approval gate under a hold marks the Step done without pushing the
Chain past the barrier.

**Blocked by:** 01-chain-control-authority-and-hold.

- [ ] Completing the last Step of a held layer (via real Run completion through
      the HTTP seam, never by calling the routine directly) marks it DONE,
      persists its output, activates no successor, and writes the withheld
      narration; verified by a new dbtest through `createApp`.
- [ ] A held fan-out layer completes every sibling; the join layer stays
      un-activated no matter which sibling completes last; verified by dbtest.
- [ ] Completion/Hold race, Hold first: Hold commits, then the completion
      activates nothing; verified by a real concurrent dbtest.
- [ ] Completion/Hold race, completion first: the next layer is legitimately
      activated, and a subsequent Hold records the new active layer as its held
      layer without disturbing the Runs the completion just created; verified by
      a real concurrent dbtest.
- [ ] A Chain held before its merge-integrator layer leaves the running
      readiness Step to complete and record its evidence, keeps the integrator
      layer un-activated, and the merge lease rows are byte-identical before and
      after the hold; verified by dbtest.
- [ ] A Step with an approval gate completing under a hold opens its Inbox card;
      answering the gate marks the Step done and activates nothing while the
      hold stands; verified by dbtest.
- [ ] Completions within layers at or below the held layer behave exactly as at
      the frozen base (existing activation dbtests stay green).
