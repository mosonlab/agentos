---
id: 09-remove-route-allowlist
title: Route line resolves any same-project Agent; allowlist and its code removed
blocked_by: []
risk: false
---

# 09: Route line resolves any same-project Agent; allowlist and its code removed

**What to build:** A Direct brief's `Route: implementation=<agent>` line is accepted for any Agent in the project that passes the rules already governing `stepOverrides`; the hardcoded three-name allowlist is deleted together with the `implementation_route_unknown_agent` refusal code and its status-mapping entry. A missing Agent answers `step_override_agent_not_found`; archived answers `step_override_agent_archived`; no grant on the target Repo answers `step_override_missing_repo_grant`; the sentinel `merge-integrator` on the implementation step answers `step_override_integrator_binding`; the compound-implementation rule keeps its existing code. The conflict with an explicit `stepOverrides` entry and the re-read-under-lock rename check are unchanged; non-Direct templates keep ignoring the line. The routing governance document's `Route:` paragraph is rewritten to describe resolution against the project's Agents and the applicable refusal rules with no named Agent set.

**Blocked by:** None (can start immediately)

- [ ] A Direct brief routing to an arbitrarily named, granted, same-project Agent instantiates with that Agent on the implementation step; verified by extending the existing `Route:` test in the template-dispatch-binding dbtest.
- [ ] Routing to a nonexistent name answers `400 step_override_agent_not_found` with no partial rows; the assertion that previously expected `implementation_route_unknown_agent` now expects this code; verified by the same dbtest.
- [ ] Routing to an archived Agent, to a granted-nowhere Agent, and to the `merge-integrator` sentinel answer `step_override_agent_archived`, `step_override_missing_repo_grant` and `step_override_integrator_binding` respectively, each with no partial rows; verified by the same dbtest.
- [ ] The instantiation refusal code union and status mapping no longer contain `implementation_route_unknown_agent`, the allowlist constant is gone, and the `templates` unit test's route cases pass with a name outside the old allowlist; verified by `npm run lint` and the `templates` and `refusal` unit tests.
- [ ] `docs/governance/task-routing-v1.md` describes `Route:` resolution against project Agents and names no allowlist; verified by `grep -n "validates the allowed Agent name" docs/governance/task-routing-v1.md` returning nothing and `npm run test:frozen-docs` staying green.
