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

This slice is also the prefactor that unblocks every other backend slice: it
ships the Prisma models (`ChainControl` with a `@@unique([projectId, chainId])`,
`ChainControlEvent` as its append-only child), the migration, and a shared
ChainControl reader in the db package — a function that, given
`(projectId, chainId)` pairs, returns the current hold state with absence and
released treated identically — exported for use by the activation routine
(same package), the admission read, and the claim query (api package). The
enforcement slices consume that reader; they do not each invent a lookup.

The state machine, distilled from the spec, that the row implements:

```
absent ──hold──▶ held(generation=1)
held(g) ──hold──▶ held(g)            [no-op success, no event]
held(g) ──resume(CAS on g)──▶ released(g)
released(g) ──resume──▶ released(g)  [no-op success, no event]
released(g) ──hold──▶ held(g+1)
```

Resume itself lands in slice 02; this slice ships the release-side columns and
generation semantics so the schema never needs a second migration.

**Blocked by:** None (can start immediately).

- [ ] A new migration adds `ChainControl` and `ChainControlEvent`; the API
      package's existing migration dbtests still pass, and a new dbtest asserts
      the `(projectId, chainId)` uniqueness rejects a duplicate row.
- [ ] `POST /tasks/:taskId/chain/hold` under the Chain mutex creates the held
      `ChainControl` row with the correct held layer and exactly one held event;
      verified by a new dbtest through `createApp` against a real database.
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
- [ ] The shared ChainControl reader in the db package returns 'not held' for
      both an absent row and a released row, and the held layer for a held row;
      covered by a unit or dbtest at its package.
- [ ] Hold placed while no Run is active (layer done, next not yet started)
      persists a held layer that still bars the next layer; the barrier effect
      itself is asserted in slices 03-05, but the persisted layer value is
      asserted here.
