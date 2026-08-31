---
id: 10-end-to-end-and-handbook-coverage
title: Clone, replace, instantiate, activate end to end; handbook coverage asserted
blocked_by: [02-clone-template, 03-replace-step-graph, 08-instantiate-under-template-lock]
risk: false
---

# 10: Clone, replace, instantiate, activate end to end; handbook coverage asserted

**What to build:** The whole authoring path works as one story: an operator clones a canonical template, replaces the clone's graph with a different shape (fewer steps, a parallel review layer, a changed assignee, edited prompt text), instantiates the clone with `autoStart`, and the resulting Chain has the edited structure and advances through it: the first step's Run is queued, completing it activates the successor layer, and a parallel layer fans out and joins as the edited graph dictates. The source canonical template is untouched by all of it and canonical prompt sync still ignores the clone. The operator API docs test gains a section-scoped lookup for the Task templates section and asserts both new routes are documented with their required fields, statuses and `curl` examples, so the handbook cannot silently fall behind them.

**Blocked by:** 02-clone-template, 03-replace-step-graph, 08-instantiate-under-template-lock

- [ ] Clone of a canonical fixture template, then replace with a four-step graph (single first step, a two-step parallel layer, a final step) returns `200`, and instantiation with `autoStart` creates exactly four Tasks whose names, layers, assignees and descriptions (interpolated edited prompts) come from the edited graph, with one queued Run on the first Task; verified by a new authoring end-to-end dbtest at the HTTP seam.
- [ ] Completing the first Task activates both parallel siblings, and completing both activates the final step exactly once; verified by the same dbtest using the chain-activation prior art.
- [ ] After the edit and instantiation, the source canonical template's steps are unchanged and the clone's read-back name is the requested non-canonical name (so it does not resolve through the canonical identity registry that sync iterates); verified by the same dbtest.
- [ ] `scripts/operator-api-docs.test.mjs` asserts, inside the Task templates section, entries for `POST /projects/:projectId/task-templates/:templateId/clone` (required `name`, optional `description`, `201`, the three refusal codes, `curl`) and `PUT /projects/:projectId/task-templates/:templateId/steps` (required `steps`, `200` with `warnings`, `404`/`409`/`422`, `curl`); verified by `npm run test:operator-api-docs` failing when either entry is removed and passing on the committed handbook.
