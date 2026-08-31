---
id: 09-end-to-end-authoring
title: Clone, replace, instantiate and activate end to end
blocked_by: [02-replace-step-graph]
risk: false
requirements: [clone-replace-instantiate-activate]
verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:db -w @anneal/api -- src/template-authoring-end-to-end.dbtest.ts"
---

# 09: Clone, replace, instantiate and activate end to end

**What to build:** The whole authoring path works as one operator story: clone a canonical template, replace the clone with a different shape, instantiate it with auto-start, and observe the edited Chain advance through a parallel fan-out and join. The source canonical template remains unchanged, and the clone remains outside canonical identity. This slice adds only end-to-end evidence; route-specific handbook assertions belong to the route and validator slices that author those entries.

**Blocked by:** 02-replace-step-graph

**Verification:** The command in frontmatter owns every end-to-end criterion.

- [ ] Clone of a canonical fixture, then replace with a four-step graph containing one first step, two parallel successors and one final join, returns success; auto-started instantiation creates exactly four Tasks with the edited names, layers, assignees and interpolated prompt descriptions, and queues only the first Run.
- [ ] Completing the first Task activates both parallel siblings, and completing both siblings activates the final step exactly once.
- [ ] After edit and instantiation, the source canonical steps remain byte-identical and clone read-back retains the requested non-canonical name.
