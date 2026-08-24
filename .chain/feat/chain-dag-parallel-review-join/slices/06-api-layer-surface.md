---
id: 06-api-layer-surface
title: HTTP surface assigns, copies, and reports chainLayer
blocked_by:
  - 01-schema-expand-chain-layer
files_hint:
  - packages/api/src/app.ts
  - packages/api/src/templates.ts
  - packages/api/src/board.ts
  - packages/api/src/templates.test.ts
  - packages/api/src/tasks.dbtest.ts
  - packages/api/src/board.test.ts
risk: true
---

# Slice 06: API layer surface

## Delivers

The HTTP and instantiation surface (spec 6.2 server side). Risk true: it
changes persisted TaskTemplateStep and Task creation and instantiation
writes. Independent of slice 04: it assigns and reports layer data;
activation semantics live in the scheduler slice. Coordination note: slice
04 also edits
`packages/api/src/chain.ts` decision logic; this slice keeps to input
assignment, instantiation, and wire shape, and only adds the derived
`currentLayer`/`layerCount` fields where chain progress is computed.

- Public task creation (`POST /projects/:projectId/tasks`, app.ts:3012)
  continues to accept only the `chainId + chainIndex` pair, exposes no
  parallel-layer or dependency input, and the server assigns
  `chainLayer = chainIndex`.
- Public template-step creation (app.ts:2485) exposes no layer input and
  assigns `layer = stepIndex`, so custom templates remain linear.
- `instantiateTemplate` (`packages/api/src/templates.ts:69`) copies
  `TaskTemplateStep.layer` into `Task.chainLayer` and stops writing
  `followUpTaskId` links (templates.ts:184).
- Chain reads (`GET /tasks/:taskId/chain`, app.ts:3208) add only `layer` to
  each node representation; no sibling ids, dependency arrays, or edges.
- Board chain progress adds derived `currentLayer` and `layerCount` next to
  existing node counts (`chainProgress` in `packages/api/src/chain.ts`,
  `packages/api/src/board.ts`). Sparse, zero-based, and one-based stored
  layers are valid; derived values use dense rank over sorted distinct
  layers.

## Acceptance

All red at frozen base 5f5aad1: no chainLayer column, no layer in any wire
shape, instantiation still links followUpTaskId.

1. API dbtests create a task via the public route with `chainId+chainIndex`
   and assert `chainLayer = chainIndex`; create a template step via the
   public route and assert `layer = stepIndex`; assert both routes reject any
   layer or dependency input field. Verification:
   `npm run test:db -w @agentos/api`.
2. Template tests instantiate hand-built persisted template fixtures — one
   linear and one with a two-node layer plus the exact Direct-shaped layer
   vector `1,2,2,3,4,5,6,7` — and assert `TaskTemplateStep.layer` is copied
   into `Task.chainLayer` node for node, with no `followUpTaskId` writes.
   Exact canonical 8/13 instantiation from the synced templates is proven by
   slices 05 and 10, whose dependency closures actually contain the new
   sources (review finding PLAN-006); this slice needs only schema slice 01.
   Verification: `npm run test:db -w @agentos/api`.
3. Chain-read tests assert each node carries `layer` and nothing else new;
   board tests assert `currentLayer`/`layerCount` for a chain with a
   two-node layer and for a sparse-layer legacy chain (spec 8.8 API half).
   Verification: `npm test -w @agentos/api`.
