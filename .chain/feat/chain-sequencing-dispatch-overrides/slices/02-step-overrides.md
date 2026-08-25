---
id: 02-step-overrides
title: Per-instantiation assignee overrides on the instantiate path
blocked_by: []
files_hint:
  - packages/api/src/app.ts
  - packages/api/src/templates.ts
  - packages/api/src/template-errors.ts
  - packages/api/src/template-overrides.dbtest.ts
  - packages/api/src/templates.test.ts
risk: true
---

## Delivers

Spec sections 6.1 (stepOverrides half), 6.3 (the step_override_* codes and the
refusal-by-construction rule), 6.5, and scenarios S11-S17. No schema change is
needed, so this slice has no dependency on 01.

- `instantiateTemplateInput` in `packages/api/src/app.ts` gains optional
  `stepOverrides`: an object keyed by decimal stepIndex strings (no leading
  zeros, no sign), each value exactly `{ assigneeAgentId: string }` with
  unknown properties rejected, at most 64 entries
  (`step_override_too_many`). Malformed keys and shapes are refused by the
  schema before any database work.
- A typed refusal mechanism for the instantiate route: a dedicated error class
  (suggested new module `packages/api/src/template-errors.ts`) carrying a
  stable machine-readable `code` and a message naming the offending id or
  step index. The route handler maps this class to a 400 `{ error, code }` by
  construction, replacing reliance on the existing message-regex match for
  the new codes. The existing refusals keep their current messages and
  status. This module is also the one slice 03 reuses for the after_task_*
  codes; it defines the class and the route mapping generically.
- `instantiateTemplate` in `packages/api/src/templates.ts` computes the
  effective assignee per step (override when present, template step assignee
  otherwise), validates every effective assignee exactly as canonical
  assignees are validated today (exists in project, not archived, repo grant,
  canonical merge-integrator binding invariant, pinned
  compound-implementation rule, assigneeType AGENT), takes the Agent-row
  mutex over the id-ordered union of canonical and override agent ids in one
  statement, locks the grant for every distinct effective assignee, and
  copies overrides onto created Task rows only. `assigneeType` always comes
  from the template step. No write to TaskTemplate or TaskTemplateStep.
- Refusal codes implemented: step_override_invalid_key,
  step_override_unknown_step, step_override_too_many,
  step_override_agent_not_found, step_override_agent_archived,
  step_override_missing_repo_grant, step_override_step_not_agent,
  step_override_integrator_binding, step_override_compound_implementation.
- Trigger-fired and webhook-fired instantiations keep calling the routine
  with no stepOverrides and are byte-unchanged (spec 8.12).

## Acceptance

All red at the frozen base: the input property does not exist and every test
below is new.

1. New dbtest file `packages/api/src/template-overrides.dbtest.ts` proves
   spec 12.1.6 through the HTTP route: valid override copies assigneeAgentId
   onto exactly the targeted Task row with template assigneeType preserved;
   TaskTemplate and TaskTemplateStep rows unchanged including `updatedAt`;
   canonical defaults on every unspecified step; prompt, outputKind,
   approvalGate, opensPullRequest, layer, chainIndex and targetBranch
   byte-identical to an un-overridden instantiation; override naming the
   canonical assignee accepted as a no-op.
2. The same file proves each refusal returns 400 with its code and that a
   follow-up query finds zero Task, TaskActivity, Run and TriggerFire rows
   for the attempted chain: unknown step index, key `0`, key `09`, key
   `1.5`, 65 entries, foreign agent, archived agent (including archived
   between pre-read and commit via the in-transaction re-read, spec 8.11),
   missing grant, HUMAN step, integrator misbinding in both directions,
   compound-implementation misassignment.
3. Schema-shape refusals (unknown property inside an override value, wrong
   value type) are covered in `templates.test.ts` or the dbtest, returning
   400 before any row exists.

## Regression verification

Already green at the frozen base; must stay green, and is not acceptance:

- Existing instantiate tests pass unchanged, proving the no-override path is
  untouched (including `templates.test.ts` autoStart coverage).

Verification: `npm run typecheck`, `npm run test -w @agentos/api`,
`npm run test:db -w @agentos/api -- src/template-overrides.dbtest.ts`.
