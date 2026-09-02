---
id: 01-gate-slot-helper
title: "Gate slot identity in the shared contract and chain read shape"
blocked_by: []
risk: false
---

# 01: Gate slot identity in the shared contract and chain read shape

**What to build:** Give clients one server-authored answer to “is this chain
step a configurable gate slot, and which one?” Add a shared `GateSlot` contract
and `gateSlotOf` authority based on the existing specification and merge
readiness roles. Project that value into every chain step returned by the task
read API: specification steps return `spec`, merge readiness steps return
`merge`, and all other steps return null. The authority must recognise the
canonical and existing versioned/legacy output-kind forms without adding
template metadata or changing template frontmatter.

This is independently demonstrable through the chain read response. Later
slices consume the same authority for instantiation and task PATCH validation.

**Blocked by:** None (can start immediately)

## Acceptance

- [ ] Reading a chain containing both slots returns `gateSlot: "spec"` on its
  specification step, `gateSlot: "merge"` on its readiness step, and null on
  every other step.
- [ ] Canonical, versioned, and legacy representations resolve to the same slot,
  while null input and every non-slot role resolve to null.
- [ ] The slot type and resolver are available to both database and API
  consumers through the shared package contract.

## Verification

- New unit test: `packages/db/src/gate-slot.test.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" node --conditions=development --import tsx --test packages/db/src/gate-slot.test.ts`
- New API dbtest: `packages/api/src/gate-slot-chain-read.dbtest.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test:db -w @anneal/api -- src/gate-slot-chain-read.dbtest.ts`
- Scoped controls: `npm run typecheck -w @anneal/db`,
  `npm run typecheck -w @anneal/api`, `npm run lint -w @anneal/db`, and
  `npm run lint -w @anneal/api`.
