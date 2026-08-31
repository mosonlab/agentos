---
id: 08-instantiate-under-template-lock
title: Instantiation reads and validates the graph under the template row lock
blocked_by: [03-replace-step-graph]
risk: true
---

# 08: Instantiation reads and validates the graph under the template row lock

**What to build:** Template instantiation and structure replace share one concurrency protocol. `instantiateTemplate` moves its template and step reads, and every check that depends on them (variables, base references, Route line, step overrides, assignee checks), inside its existing Serializable transaction, after taking the same template-row lock that replace takes, so the Tasks it writes and the step relations they point at always come from one graph. Externally visible behaviour is unchanged: the same refusal codes and statuses, the same activity rows, the same retry policy. A race between a replace and an instantiation of the same template resolves to exactly one of two outcomes: replace first, then the Chain materialises the new graph; instantiation first, then the replace answers `409 template_in_use`. The unit tests that drive `instantiateTemplate` against a stubbed Prisma client are adjusted for the in-transaction reads (stubbing the lock query and the template read on the transaction client); no new unit tests are added.

**Blocked by:** 03-replace-step-graph

- [ ] With a second client holding the template row lock while it replaces the graph, an instantiation issued during the hold produces a Chain whose Tasks match the replaced graph (count, names, layers, template step ids all from the new step rows); verified by a new race dbtest at the HTTP seam following the held-lock helper pattern with the template row in place of the Agent row.
- [ ] With a second client holding the template row lock while it instantiates, a replace issued during the hold answers `409 template_in_use` and the step rows are unchanged; verified by the same dbtest.
- [ ] No Task ever references a step row that no longer exists after either ordering (`templateStepId` of every Task in the Chain resolves to a live step of that template); verified by the same dbtest.
- [ ] Every existing instantiation refusal code still answers with its existing status (spot-checked: `template_not_found`, `template_variables_missing`, `template_base_reference_not_earlier`, `step_override_agent_archived` under a held Agent lock); verified by the existing `template-overrides` and `template-dispatch-binding` dbtests and the `templates` unit test staying green after the stub adjustment.
- [ ] The lock-order comment at the head of the lock helpers names the TaskTemplate row ahead of Task rows, Agent rows and grant rows; verified by `npm run lint` and reading the header.
