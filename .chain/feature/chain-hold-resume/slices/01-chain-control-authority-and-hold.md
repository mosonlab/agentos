---
id: 01-chain-control-authority-and-hold
title: ChainControl authority, shared reader, and the Hold route
blocked_by: []
risk: true
---

# 01: ChainControl authority, shared reader, and the Hold route

**What to build:** An operator with any Task of a Chain in hand can POST
`/tasks/:taskId/chain/hold` with a `requestId` (and optional `reason`) and the
Chain becomes durably held: a single `ChainControl` row keyed by
`(projectId, chainId)` records the held state, the held layer (the lowest
execution layer containing a non-DONE Task, computed under the Chain mutex using
the existing `chainLayer`-falling-back-to-`chainIndex` reading), the requester's
request identifier, the optional reason, and an incremented hold generation; one
append-only `ChainControlEvent` row records the transition. Pressing Hold again
— same or different `requestId` — is a 200 that reports the existing hold and
writes nothing. Holding a Task with no `chainId`, or a Chain whose every Task is
DONE, is refused with 409; an unknown Task with 404. Hold provably interrupts
nothing: it writes no Run row, no cancellation intent, touches no Task.status,
and never reads or writes the merge lease.

Idempotency survives changes to current state: the event store enforces one
accepted request identifier per Chain and transition kind, and route logic
consults that durable history. A delayed network replay therefore cannot become
a new transition after an intervening release; the matching Resume proof lands
with the Resume route in slice 02.

This slice is also the prefactor that unblocks every other backend slice: it
ships the Prisma models (`ChainControl` with a uniqueness constraint on its
project-and-Chain key, and `ChainControlEvent` as its append-only child), the
migration, and a shared
ChainControl reader in the db package — a function that, given
`(projectId, chainId)` pairs, returns the current hold state with absence and
released treated identically — exported for use by the activation routine
(same package), the admission read, and the claim query (api package). The
enforcement slices consume that reader; they do not each invent a lookup.
They cover successor activation, operator admission, claim selection, and the
shared Run-open path used by the scheduler and every other Run producer.

The state machine begins absent, creates held generation one on the first Hold,
treats Hold while held and Resume while released as event-free successes,
releases only by compare-and-set on the held generation, and increments the
generation when a released Chain is held again.

Resume itself lands in slice 02; this slice ships the release-side columns and
generation semantics so the schema never needs a second migration.

**Blocked by:** None (can start immediately).

- [ ] A new migration adds `ChainControl` and `ChainControlEvent`; a new dbtest
      proves one authority per project-and-Chain and durable uniqueness of an
      accepted request identifier per transition kind, while the existing
      migration dbtests stay green.
- [ ] `POST /tasks/:taskId/chain/hold` under the Chain mutex creates the held
      authority with state, held layer, hold request identifier, reason or null,
      hold timestamp, null release facts, and generation; its one event contains
      kind, layer, authenticated actor, the same request identifier, reason or
      null, timestamp, and resulting generation. A new real-database HTTP dbtest
      asserts every field and valid timestamps.
- [ ] Repeating Hold on a held Chain (same and different `requestId`) returns
      200 reporting the original hold's requestId and writes no second event and
      no state change; verified in the same dbtest file.
- [ ] Hold on a chainless Task returns 409, on an all-DONE Chain returns 409
      naming that nothing is left to hold, on an unknown Task 404; verified by
      dbtest.
- [ ] After Hold, the database contains no new Run row, no cancellation intent
      on any existing Run, unchanged Task.status on every Chain member, and an
      untouched merge lease; asserted directly in the dbtest.
- [ ] A hold on one Chain leaves a second Chain in the same project, and a Chain
      with the same chainId in another project, entirely unaffected; verified by
      dbtest.
- [ ] Moving one Chain Step to BACKLOG through the HTTP API creates no authority
      for a never-held Chain, leaves an existing authority byte-identical, parks
      only that Step, and leaves the task-list Chain progress projection
      unchanged; verified in the authority dbtest with held and unheld fixtures.
- [ ] The shared ChainControl reader in the db package returns 'not held' for
      both an absent row and a released row, and the held layer for a held row;
      covered by a unit or dbtest at its package.
- [ ] Hold placed while no Run is active (layer done, next not yet started)
      persists a held layer that still bars the next layer; the barrier effects
      are asserted at their owning seams in slices 03-06, while the persisted
      layer value is asserted here.
