---
id: 06-board-blocked-on
title: Board projection blockedOn field
blocked_by:
  - 01-dispatch-binding-schema
files_hint:
  - packages/api/src/board.ts
  - packages/api/src/board.test.ts
  - packages/api/src/app.ts
  - packages/api/src/board-blocked-on.dbtest.ts
risk: true
---

## Delivers

Spec section 6.7 and the board half of S18/S19. Depends only on the column;
fixtures seed the binding directly. Touches `app.ts` only in the
GET /tasks `view=board` region (the board select, chain enrichment and
`boardCard` call, around lines 3021-3140 at base), disjoint from the
instantiate region slice 03 edits and the start/chain route region slice 05
edits, so blocked_by stays [01] with no frontier cost.

- The board card projection in `packages/api/src/board.ts` gains
  `blockedOn: { taskId: string; taskName: string } | null`, non-null only for
  a task whose `dispatchAfterTaskId` is set and whose predecessor status is
  not DONE. Computed, never stored. `boardCard` stays a pure serializer: it
  receives the resolved predecessor (or null) as input.
- The GET /tasks `view=board` route in `packages/api/src/app.ts` implements
  the cost rule: select `dispatchAfterTaskId` with the page rows, collect the
  distinct non-null values, and resolve them in at most one additional query
  selecting id, name and status. A page with no bound rows issues no
  additional query.
- The board ETag remains computed over the serialised body (the existing
  `etagFor`), so a predecessor status change that flips blockedOn invalidates
  a cached board with no extra code.

## Acceptance

All red at the frozen base: the field does not exist and neither test surface
covers it.

1. Pure projection tests in `packages/api/src/board.test.ts` (extending the
   existing board fixtures): a card given a bound row with a non-DONE
   predecessor carries blockedOn with the predecessor id and name; the same
   row with a DONE predecessor carries null; an unbound row carries null and
   the rest of its card is byte-identical to today's expectations.
2. New executable route test surface
   `packages/api/src/board-blocked-on.dbtest.ts` drives GET /tasks
   `view=board` over HTTP against seeded rows and proves: the returned body
   carries blockedOn on exactly the bound rows; two bound rows pointing at
   the same predecessor plus a third bound row are resolved through a
   deduplicated id set; query counting via a dbtest Prisma client
   query-event listener (`$on("query")`, or an equivalent counted adapter)
   asserts a page with zero bound rows issues zero predecessor-lookup
   queries and a page with multiple bound rows issues exactly one. No
   code-review fallback is acceptable.
3. ETag over HTTP in the same dbtest: fetch the board and its ETag, apply one
   real state change only - the bound predecessor transitions to DONE - and
   assert the body's blockedOn flips to null and the ETag differs, so a
   cached board is invalidated by the new field.

## Regression verification

Already green at the frozen base; must stay green, and is not acceptance:

- `etagFor` changes whenever serialized bytes change (existing
  board.test.ts coverage); cards of unbound tasks keep today's byte-exact
  shape apart from the always-present blockedOn: null field.

Verification: `npm run typecheck`, `npm run test -w @agentos/api`,
`npm run test:db -w @agentos/api -- src/board-blocked-on.dbtest.ts`.
