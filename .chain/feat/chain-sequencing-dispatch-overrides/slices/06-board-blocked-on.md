---
id: 06-board-blocked-on
title: Board projection blockedOn field
blocked_by:
  - 01-dispatch-binding-schema
files_hint:
  - packages/api/src/board.ts
  - packages/api/src/board.test.ts
risk: false
---

## Delivers

Spec section 6.7 and the board half of S18/S19. Depends only on the column;
fixtures seed the binding directly.

- The board card projection in `packages/api/src/board.ts` gains
  `blockedOn: { taskId: string; taskName: string } | null`, non-null only for
  a task whose `dispatchAfterTaskId` is set and whose predecessor status is
  not DONE. Computed, never stored.
- Cost rule: collect the distinct non-null `dispatchAfterTaskId` values from
  the page of rows already selected and resolve them in at most one
  additional query selecting id, name and status. A page with no bound rows
  issues no additional query.
- The board ETag remains computed over the serialised body (the existing
  `etagFor`), so a predecessor status change that flips blockedOn invalidates
  a cached board with no extra code.

## Acceptance

All red at the frozen base: the field does not exist.

1. Tests in `packages/api/src/board.test.ts` (extending the existing board
   fixtures): a bound task with a non-DONE predecessor carries blockedOn with
   the predecessor id and name; the same task after the predecessor is DONE
   carries null; every unbound task on the page carries null and the rest of
   its card is byte-identical to today's expectations.
2. Query-shape assertion: a page containing no bound rows issues no
   predecessor-resolution query, and a page with several bound rows issues
   exactly one, asserted with the suite's query instrumentation if present,
   otherwise by structuring the code so the batched lookup is the only
   possible path and covering it by review.
3. ETag: two board serialisations differing only in blockedOn produce
   different ETags (direct `etagFor` assertion).

Verification: `npm run typecheck`, `npm run test -w @agentos/api`.
