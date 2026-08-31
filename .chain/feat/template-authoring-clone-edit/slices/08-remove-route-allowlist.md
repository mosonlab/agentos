---
id: 08-remove-route-allowlist
title: Route line resolves any same-project Agent; allowlist and its code removed
blocked_by: []
risk: true
requirements: [route-any-project-agent, route-safety-refusals, route-governance-doc]
verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:db -w @anneal/api -- src/template-dispatch-binding.dbtest.ts"
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && node --import tsx --test packages/api/src/templates.test.ts packages/api/src/refusal.test.ts"
  - "! rg -n 'validates the allowed Agent name|senior-dev-luna, senior-dev, frontend-dev' docs/governance/task-routing-v1.md"
regression_verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:frozen-docs"
---

# 08: Route line resolves any same-project Agent; allowlist and its code removed

**What to build:** A Direct brief's `Route: implementation=<agent>` line accepts any same-project Agent that passes the existing override rules. The three-name allowlist and `implementation_route_unknown_agent` code are removed. Missing, archived, ungranted, sentinel-binding and compound-implementation violations use the existing override refusal vocabulary. Explicit-override conflict, rename-under-lock protection and non-Direct behavior remain unchanged. The routing governance text describes project Agent resolution and its safety checks without a named set.

**Blocked by:** None (can start immediately)

**Verification:** The first command in frontmatter owns persisted assignment and refusal outcomes, the second owns code removal, and the third owns governance wording; the remaining command is regression-only.

- [ ] A Direct brief routing to an arbitrarily named, granted same-project Agent instantiates with that Agent persisted on the implementation Task.
- [ ] A nonexistent route name answers `400 step_override_agent_not_found` with no partial rows; the removed allowlist-specific code is unreachable and absent from the refusal union and status mapping.
- [ ] Archived, ungranted, sentinel-binding and compound-implementation violations answer with their existing override codes and persist no partial rows.
- [ ] The governance probe is red at the frozen base and passes only when project-Agent resolution replaces the allowlist wording and named Agent set.

**Regression verification:** Explicit override conflicts, rename-under-lock behavior, non-Direct parsing and the frozen-docs contract remain covered by existing suites and are not base-red acceptance.
