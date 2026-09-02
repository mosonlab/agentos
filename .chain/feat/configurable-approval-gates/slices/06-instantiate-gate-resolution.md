---
id: 06-instantiate-gate-resolution
title: "Instantiate gate resolution, non-retroactivity, refusals, and spec gate"
blocked_by: [01-gate-slot-helper, 03-project-gate-defaults]
risk: true
---

# 06: Instantiate gate resolution, non-retroactivity, refusals, and spec gate

**What to build:** Accept an optional strict `gates` object at instantiation and
persist each slot’s gate from exactly dispatch override, project default, then
template frontmatter; explicit false counts as present. Every non-slot keeps its
frontmatter value. Resolve the project row in the chain-creation transaction.
Refuse a supplied gate for a missing slot before creating any task, with a named
400 reason identifying slot and template; when both are invalid, report the
specification slot first.

Prove the persisted snapshot is non-retroactive: a later project-default change
must never alter tasks in an existing chain. Demonstrate the specification gate
only through chains instantiated by this new resolver, so its REVIEW card,
approve, reject, budget, and ungated controls cannot pass on the frozen base by
relying on manually seeded approval metadata.

**Blocked by:** 01-gate-slot-helper, 03-project-gate-defaults

## Acceptance

- [ ] The compound template passes the specification’s eight-row defaults and
  override matrix plus both present-and-equal controls; only its specification
  and readiness slots vary and every other step remains false.
- [ ] The direct template resolves only its readiness slot; its specification
  override is refused. A template with neither slot refuses either supplied key.
  Each 400 names the slot and template, and no partial chain is created.
- [ ] Unknown keys inside `gates` are rejected, explicit false overrides true,
  and both new refusal codes map to HTTP 400.
- [ ] Chain A instantiated with false defaults retains every stored gate after
  the project defaults are patched true; chain B instantiated afterwards takes
  the new defaults. No chain read dynamically substitutes current project
  values.
- [ ] A compound chain instantiated with `gates.spec: true` completes its spec
  into REVIEW with a persisted-spec preview card; approval activates planning,
  rejection requeues specification and consumes run budget. The same route with
  the resolved gate false follows the existing autonomous path.

## Verification

- New end-to-end dbtest: `packages/api/src/configurable-gate-instantiation.dbtest.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test:db -w @anneal/api -- src/configurable-gate-instantiation.dbtest.ts`
- Existing route unit test extended: `packages/api/src/routes/templates.test.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" node --conditions=development --import tsx --test packages/api/src/routes/templates.test.ts`
- Scoped controls: `npm run typecheck -w @anneal/api`,
  `npm run typecheck -w @anneal/db`, `npm run lint -w @anneal/api`, and
  `npm run lint -w @anneal/db`.
