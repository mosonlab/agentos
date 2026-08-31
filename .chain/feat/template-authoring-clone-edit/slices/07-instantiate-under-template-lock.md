---
id: 07-instantiate-under-template-lock
title: Instantiation reads and validates the graph under the template row lock
blocked_by: [02-replace-step-graph]
risk: true
requirements: [replace-instantiate-serialization, locked-graph-reread]
verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:db -w @anneal/api -- src/template-authoring-race.dbtest.ts"
regression_verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && node --import tsx --test packages/api/src/templates.test.ts"
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:db -w @anneal/api -- src/template-overrides.dbtest.ts src/template-dispatch-binding.dbtest.ts"
---

# 07: Instantiation reads and validates the graph under the template row lock

**What to build:** Template instantiation and structure replace share the template-row mutex inside Serializable transactions. Instantiation re-reads the full template graph after acquiring that mutex and evaluates variables, base references, Route directives, overrides and assignee-dependent checks from the locked read before writing Tasks. A real replace request and a real instantiate request therefore resolve in one of two ways: replace first yields a Chain from the new graph; instantiate first makes replace answer `409 template_in_use`. Existing non-racing behavior, activity rows and retry policy remain unchanged, and existing unit stubs are adjusted only for the moved reads and lock query.

**Blocked by:** 02-replace-step-graph

**Verification:** The command under `verification` owns every acceptance criterion; the remaining commands are compatibility-only regression evidence.

- [ ] A holder locks an old step row; a real replace request starts, acquires the template mutex and blocks deleting that step; a real instantiate request then starts. Releasing the holder lets replace commit first, after which instantiation creates Tasks whose count, names, layers and step references all come from the new graph.
- [ ] A holder locks an assignee Agent row; a real instantiate request starts, acquires the template mutex and blocks on that Agent; a real replace request then starts. Releasing the holder lets instantiation commit Tasks from the old graph first, after which replace answers `409 template_in_use` and leaves that graph unchanged.
- [ ] A holder locks the template row, changes its required variables, and commits after instantiation has begun. Instantiation applies `template_variables_missing` to the post-lock graph, proving the graph-dependent check did not use a pre-transaction snapshot.
- [ ] In both real-request orderings, every created Task references a live step from exactly one graph; no hybrid relation or orphaned step reference exists.

**Regression verification:** Existing refusal statuses, activity behavior and stubbed instantiation tests remain green through the exact commands in frontmatter; they are not acceptance checkboxes because they already pass at the frozen base.
