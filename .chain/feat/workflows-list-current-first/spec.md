Workflows: current templates list first and retired generations fold away

Goal: the Workflows page shows a project's current templates at the top and hides retired template generations behind one collapsed group, so an operator finds the three canonical chains without scrolling past their history.

Background: canonical sync keeps every retired template generation as a renamed row (`<name>-legacy-<marker>-<id>`, minted by `legacyTemplateName` in `packages/db/src/canonical-template-transition.ts`) so chains instantiated under it keep their history. `GET /projects/:projectId/task-templates` (`packages/api/src/routes/templates.ts`) returns all rows ordered `createdAt asc`, and `WorkflowsPage` in `apps/web/src/pages/Workflows.tsx` renders that array as one table. On 2026-09-05 the agentos-example project lists 36 rows; the current `direct-engineer-workflow`, `compound-engineer-workflow` and `pr-engineer-workflow` are the last three because they were re-created most recently. The console has no way to tell a retired row from a current one other than matching the name string, and the control plane already knows: `canonicalTemplateIdentity(name)` resolves a legacy name to its canonical template and generation and returns null for a current name.

Changes:
1. `GET /projects/:projectId/task-templates` adds a boolean `retired` to every listed template, true exactly when `canonicalTemplateIdentity(template.name)` is non-null. `GET /task-templates/:templateId` carries the same field. No other field or ordering of the response changes; the field is derived at read time and not persisted.
2. `docs/operator-api.md` documents the new field on both routes in the same change.
3. `WorkflowsPage` renders current templates (`retired === false`) first, ordered by name, in the existing table.
4. Retired templates render below them inside one group that is collapsed by default and whose header names the count (for example "Retired generations (33)"); expanding it shows the same rows as today, still navigable to `/workflows/:templateId`. With zero retired templates the group is not rendered at all.
5. The collapsed state is component-local; it does not persist across reloads.
6. Every new user-visible string goes through the i18n layer with keys in `apps/web/src/locales/en.ts` and `apps/web/src/locales/zh.ts`.
7. `WorkflowDetailPage` and the profile editor are unchanged apart from reading the widened `TaskTemplate` type.

Out of scope: deleting, archiving or renaming retired templates; changing the API ordering (`createdAt asc` stays); any change to canonical sync, the transition registry or `legacyTemplateName`; the Tasks board, template picker in task creation, or any other page that lists templates; filtering or searching templates.

Constraints: the console never decides retirement by parsing the name string; the API field is the only source. A template whose name is not canonical and not legacy (an operator's own clone) is `retired: false`. Fail loud: an unexpected response shape is a rendered error, not an empty list.

Acceptance: `packages/api/src/routes/templates.test.ts` (or the existing templates route test) asserts `retired: true` for a row named by `legacyTemplateName` and `retired: false` for a canonical and for a cloned name, on both the list and the single-template route; `apps/web/src/tests/workflows.test.tsx` asserts that with two current and three retired templates the table lists the two current rows first by name, the retired group header shows the count 3 and is collapsed, expanding it reveals the three retired rows, and with zero retired templates no group header is rendered; `docs/operator-api.md` names `retired` on both routes; `npm run lint`, `npm run typecheck`, `npm run test -w @anneal/api` and `npm run test -w @anneal/web` pass; `npm run test:snapshot-scan` passes.

Route: implementation=frontend-dev-opus-medium - a console list change with a one-field API read, frontend work by the routing contract