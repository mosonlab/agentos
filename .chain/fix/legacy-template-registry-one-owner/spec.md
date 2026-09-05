## Goal

No legacy template name minted anywhere in `packages/db` is unknown to `canonicalTemplateIdentity`; a minted-but-unregistered marker is a build-time or test-time failure, not a silent null at run time.

## Background

`packages/db/src/canonical-template-transition.ts` owns the registry of retired canonical template generations (`registeredGenerations`, `canonicalTemplateIdentity`, `legacyTemplateName` at line 576 in the 2026-09-04 tree). `packages/db/src/merge-integrator.ts` lines 64-73 mint four legacy names for the integrator template through `legacyTemplateName` with markers `10`, `9`, `human-12` and `regression-first-13` (`legacyTenStepTemplateName`, `legacyNineStepTemplateName`, `legacyHumanTwelveStepTemplateName`, `legacyRegressionFirstThirteenStepTemplateName`). The registry does not register those markers for the integrator template, so `canonicalTemplateIdentity` returns null for rows carrying those names. Deepening round 6 lane t2 (PR #471, Reported but unfixed) confirmed this on main; it was outside that lane's fence. The live board still lists templates named `compound-engineer-workflow-legacy-9-...`, `...legacy-human-12-...` and `...legacy-regression-first-13-...`, so these rows exist in production.

Root cause: two modules each own part of one fact (which retired generations exist). The registry is the authority; the integrator module restates a subset of it without registering.

## Changes

1. Decide, from the code and the seed history, whether each of the four integrator markers is a generation the registry must know (rows exist and rollover or adoption must recognise them) or a name that is only ever produced, never resolved. Record the decision in the PR body under Decisions taken.
2. For markers that must be recognised: register them in the transition registry so `canonicalTemplateIdentity(name)` resolves to the integrator template with the right generation, and delete the standalone minting helpers in `merge-integrator.ts` in favour of the registry-driven name (one owner).
3. For markers that are only produced: delete the helper and every caller, and say so.
4. Add one test in `packages/db/src` that enumerates every exported `legacy*TemplateName` function in the workspace (or every marker literal passed to `legacyTemplateName`) and asserts `canonicalTemplateIdentity` resolves the name it produces. The test must fail on main before the change.
5. Keep `template-sources.ts`, `canonical-step-adoption.ts` and everything under `agents/` untouched unless the registry change forces a shape change; if it does, state why.

## Out of scope

- Any prompt or template content change; any Prisma migration.
- The module-initialisation cycle `template-sources -> merge-integrator -> canonical-template-transition` noted by PR #471; do not restructure it, only avoid making it worse (no new run-time import from the transition module into template-sources).
- Pruning of the published generation history (a separate follow-up).

## Constraints

- An unregistered legacy name must fail loudly (typecheck or test), never resolve to null at run time.
- Seed and sync against a database that already holds those legacy rows must keep working; `canonical-prompt-sync*.dbtest.ts` are the gate's evidence for that, so extend them rather than bypassing them.

## Acceptance

- `npm run test -w @anneal/db` passes and includes the new enumeration test.
- `npm run typecheck` and `npm run lint` pass.
- `git grep -n 'legacyTemplateName(' packages/db/src` shows call sites only inside the registry module (or inside a helper the registry exports), none in `merge-integrator.ts`.
- The gate's `test:db` passes including the canonical prompt sync dbtests.

Route: implementation=senior-dev-astra-medium - registry and seed semantics over persisted legacy template rows that the unit suite cannot witness against a populated database