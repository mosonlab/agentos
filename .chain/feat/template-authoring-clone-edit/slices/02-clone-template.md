---
id: 02-clone-template
title: Clone a task template under a new name
blocked_by: [01-authoring-refusal-envelope]
risk: true
---

# 02: Clone a task template under a new name

**What to build:** An operator calls `POST /projects/:projectId/task-templates/:templateId/clone` with `{ "name", "description"? }` and receives `201` with an independent, non-canonical copy of the template in the same projection the template read route returns (steps ordered by index, each with its assignee Agent). The copy carries the source description (unless overridden), variables, and every step field including `requiresCommit`, `spawnPolicy`, `runner`, `baseFromStepIndex` and prompt text, with the same `stepIndex` values; every webhook field is cleared; trigger fires and Tasks are not copied. Cloning a canonical or already-used source is allowed. The route refuses with `template_not_in_project` (404) when the source is not in the addressed project, `template_name_taken` (409) when the name exists in the project, and `template_name_reserved` (409) when the name resolves through the canonical identity registry (canonical or registered-legacy). The name is trimmed and non-empty and bounded like the existing template name input; the validator is not run. The handbook's Task templates section gains the route entry (fields, statuses, codes, `curl` example) in this slice.

**Blocked by:** 01-authoring-refusal-envelope

- [ ] A clone of a multi-step template with a webhook configured returns `201` and, read back through the template read route, has identical description, variables and per-step fields (all fields listed above) and null/empty webhook secret, repo, payload mapping, paused-at and replay window; verified by a new authoring clone dbtest at the HTTP seam.
- [ ] A clone with an explicit `description` replaces the source description; a clone of a source that already has Tasks succeeds and the source's Tasks remain attached to the source only; verified by the same dbtest.
- [ ] A template id from another project answers `404 template_not_in_project`; an existing project name answers `409 template_name_taken`; the canonical name `compound-engineer-workflow` and one registered-legacy name minted by the legacy-name helper both answer `409 template_name_reserved`; no template row is created in any refusal case; verified by the same dbtest.
- [ ] A blank or over-long `name` is a `400` request-schema rejection; verified by the same dbtest.
- [ ] The handbook documents `POST /projects/:projectId/task-templates/:templateId/clone` with required and optional fields, `201`, the three refusal codes with statuses and a `curl` example; verified by reading the handbook section (the automated assertion lands in slice 10).
