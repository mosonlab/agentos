---
id: 06-universal-enqueue-barrier
title: Universal Run-open barrier including scheduled Tasks
blocked_by:
  - 01-chain-control-authority-and-hold
risk: true
---

# 06: Universal Run-open barrier including scheduled Tasks

**What to build:** No Run producer can enqueue work above a Chain's held layer.
The shared `openRun`/`enqueueTaskRun` path reads the persisted ChainControl
authority in the transaction that would create a Run and declines creation when
the Task belongs to a held Chain above its held layer. This is the universal
backstop for producers that do not consume operator admission or successor
activation, including the due-Task scheduler. It complements slice 03's
operator narration, slice 04's actionable API refusal, and slice 05's defense
against Runs queued before the hold; it does not replace those user-visible
seams. Work at or below the held layer, unheld Chains, released Chains, and
chainless scheduled Tasks retain their ordinary Run creation behavior.

**Blocked by:** 01-chain-control-authority-and-hold.

- [ ] When a due AT Task above the held layer is processed by the real scheduler,
      no Run row or queue activity is created and the schedule remains eligible
      for a later attempt; verified by a new real-database scheduler test.
- [ ] In the same scheduler test suite, a due AT Task at or below the held layer
      creates exactly one ordinary Run while the hold stands, proving the current
      layer is not interrupted.
- [ ] Releasing the authority makes the previously barred due AT Task eligible;
      the next scheduler pass creates exactly one Run without resurrecting a
      cancelled Run or provider conversation, verified against settled database
      state.
- [ ] Run creation for an unheld or released Chain and a chainless scheduled Task
      remains unchanged, while a direct producer cannot bypass the shared gate;
      covered by focused Run-open integration cases alongside the scheduler
      tests.
