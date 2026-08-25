---
id: 07-web-blocked-on-ui
title: Web board card and chain detail blocked-on marker
blocked_by: []
files_hint:
  - apps/web/src/lib/types.ts
  - apps/web/src/components/task-card.tsx
  - apps/web/src/pages/TaskDetail.tsx
  - apps/web/src/locales/en.ts
  - apps/web/src/locales/zh.ts
  - apps/web/src/tests/board.test.tsx
  - apps/web/src/tests/chain.test.tsx
risk: false
---

## Delivers

Spec section 6.9 and the UI half of S18/S19. apps/web owns its own response
types in `apps/web/src/lib/types.ts` and its tests run against local fixtures,
so this slice codes against the API contract fixed by spec 6.7 and 6.8 and has
no build dependency on slices 05 and 06.

- `types.ts`: board card type gains
  `blockedOn: { taskId: string; taskName: string } | null`; chain step type
  gains `blockedOn: { taskId: string; name: string; status: TaskStatus } | null`.
  Mark both optional-tolerant if the existing types treat additive API fields
  that way.
- Board card (`task-card.tsx`): when blockedOn is non-null render one
  additional meta line naming the predecessor, alongside the existing chain
  and schedule lines. No new column, lane, or status pill; a card with null
  blockedOn renders byte-identically to today.
- Chain detail (`TaskDetail.tsx` chain step rows): render the same marker on
  the bound first step; the Start control stays driven solely by `startable`
  from the API, which the spec guarantees is false while the binding is
  unresolved - no client-side re-derivation.
- Locale keys `tasks.card.blockedOn` and `chain.blockedOnPredecessor` (both
  taking a name parameter) added to `en.ts` and `zh.ts`; no literal
  user-facing sentence in a component.

## Acceptance

All red at the frozen base: the fields, strings and keys do not exist.

1. `apps/web/src/tests/board.test.tsx`: a card fixture with non-null
   blockedOn renders the marker naming the predecessor; a card with null
   blockedOn matches today's existing expectations unchanged; no new lane or
   column appears (spec 12.3.1, 12.3.3).
2. `apps/web/src/tests/chain.test.tsx`: a chain first step fixture with an
   unresolved binding renders the marker and a disabled Start control
   (startable false from the fixture); the same step with blockedOn null and
   startable true renders the normal control (spec 12.3.2).
3. i18n parity and sweep tests pass with the two new keys present in every
   locale (spec 12.3.4).

Verification: `npm run typecheck`, `npm run test -w @agentos/web`.
