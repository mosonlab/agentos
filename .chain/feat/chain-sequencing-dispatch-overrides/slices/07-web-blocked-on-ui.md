---
id: 07-web-blocked-on-ui
title: Web board card and chain detail blocked-on marker
blocked_by: []
files_hint:
  - apps/web/src/lib/types.ts
  - apps/web/src/components/task-card.tsx
  - apps/web/src/components/chain-list.tsx
  - apps/web/src/locales/en.ts
  - apps/web/src/locales/zh.ts
  - apps/web/src/tests/tasks-board.test.tsx
  - apps/web/src/tests/chain-list.test.tsx
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
- Chain detail rows (`components/chain-list.tsx`, the ChainRow render): at
  base a Start button renders only when `startAction` is non-null, and the
  spec-fixed unresolved-binding response has startable false and startAction
  null, so unchanged code would hide the control instead of disabling it.
  New ChainRow rule: when a step's `blockedOn` is non-null, render the
  blocked-on marker naming the predecessor and render the Start control
  disabled, driven solely by `startable`/`blockedOn` from the API with no
  client-side re-derivation. A step with blockedOn null and startAction null
  keeps today's behaviour: marker absent, no action rendered.
- Locale keys `tasks.card.blockedOn` and `chain.blockedOnPredecessor` (both
  taking a name parameter) added to `en.ts` and `zh.ts`; no literal
  user-facing sentence in a component.

## Acceptance

All red at the frozen base: the fields, strings and keys do not exist.

1. `apps/web/src/tests/tasks-board.test.tsx` (the existing board card render
   surface): a card fixture with non-null blockedOn renders the marker naming
   the predecessor; a card with null blockedOn matches today's existing
   expectations unchanged; no new lane or column appears (spec 12.3.1,
   12.3.3).
2. `apps/web/src/tests/chain-list.test.tsx` (the existing ChainRow render
   surface): a chain first step fixture with an unresolved binding
   (blockedOn non-null, startable false, startAction null) renders the marker
   and a disabled Start control; the same step with blockedOn null and a
   startable fixture renders the normal enabled control; an ordinary step
   with no startAction renders no action, unchanged (spec 12.3.2).
3. i18n parity and sweep tests pass with the two new keys present in every
   locale (spec 12.3.4).

Verification: `npm run typecheck`, `npm run test -w @agentos/web`.
