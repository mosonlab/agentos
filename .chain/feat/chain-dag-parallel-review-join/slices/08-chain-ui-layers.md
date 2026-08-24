---
id: 08-chain-ui-layers
title: Chain UI groups by layer and shows parallel siblings and the join
blocked_by:
  - 06-api-layer-surface
files_hint:
  - apps/web/src/components/chain-list.tsx
  - apps/web/src/lib/chain.ts
  - apps/web/src/lib/types.ts
  - apps/web/src/components/task-card.tsx
  - apps/web/src/tests/chain-list.test.tsx
  - apps/web/src/tests/board.test.tsx
risk: false
---

# Slice 08: Chain UI layer rendering

## Delivers

The web half of spec 6.2. Consumes only the `layer` field and derived
`currentLayer`/`layerCount` that slice 06 returns; persists nothing new.

- `ChainList` (`apps/web/src/components/chain-list.tsx`) groups rows with
  equal `layer`, presenting a dense one-based layer ordinal derived from
  sorted distinct stored values so sparse, zero-based, and legacy chains
  render consistently. Parallel siblings render side by side within a layer
  group, visibly distinct from the task-node ordinal, without implying they
  are serial.
- The join dependency is visible: a blocked next layer shows which
  outstanding sibling tasks block it, derived from the returned rows only
  (no sibling or dependency payload).
- Board chain progress (`apps/web/src/components/task-card.tsx`,
  `apps/web/src/lib/chain.ts`) shows `currentLayer`/`layerCount` alongside
  the existing node counts.
- Wire types in `apps/web/src/lib/types.ts` add `layer` to chain steps and
  the derived progress fields to board tasks.
- Web-side `followUpTaskId` retirement (review finding PLAN-009): the
  remaining references in `apps/web/src/lib/types.ts` and
  `apps/web/src/lib/board.ts` (types, comments, and any derived logic) are
  removed or replaced with layer-derived equivalents, together with their
  web tests, so the slice 09 census can reach zero hits.

## Acceptance

All red at frozen base 5f5aad1: the UI renders a flat step list with no
layer concept.

1. `chain-list.test.tsx` renders an 8-node Direct chain fixture with layers
   `1,2,2,3,4,5,6,7` and asserts two siblings share one layer group, the
   layer ordinal differs from the node ordinal, and a blocked adjudication
   row names the outstanding sibling (spec 8.8 web half). Verification:
   `npm test -w @agentos/web`.
2. The same suite renders a sparse-layer legacy fixture and asserts dense
   one-based ordinals.
3. `board.test.tsx` asserts the card shows derived `currentLayer` of
   `layerCount` for a chain fixture with a parallel layer. Verification:
   `npm test -w @agentos/web`.
