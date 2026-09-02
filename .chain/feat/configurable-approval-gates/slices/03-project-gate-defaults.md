---
id: 03-project-gate-defaults
title: "Project gate defaults: columns, PATCH, read shape, project-page toggles"
blocked_by: []
risk: true
---

# 03: Project gate defaults: columns, PATCH, read shape, project-page toggles

**What to build:** An operator opens a project's detail page, sees two toggles —
specification gate default and merge gate default, both off on any existing or
new project — flips one, and the change persists: the project read shape returns
it, and any client can also set it by scripting `PATCH /projects/:projectId`.
This is the full vertical for spec stories 1–7: one Prisma migration adding
`specGateDefault` and `mergeGateDefault` (`Boolean @default(false)`, per D2 —
and per D2/A2 the migration does **not** touch `RELEASE_CANDIDATE_MIGRATIONS`),
the two booleans on the `Project` wire contract and the PATCH input schema
(patch only, not create — A6), and the two instant-PATCH `Toggle` controls on
the project detail page following the existing task approval-gate toggle
pattern (D11), with strings in both locales.

Nothing reads these defaults yet; slice 06 consumes them at instantiation.

**Blocked by:** None (can start immediately)

- [ ] The migration applies on a fresh database and on a database already at head (verified by the migration workflow the repository's existing migrations use), and an existing project row reads false for both columns afterwards.
- [ ] A dbtest through the real API entrypoint over HTTP (spawned via the test startup environment helper) shows `PATCH /projects/:projectId` round-tripping each boolean independently, and `GET` of the project list and the single project returning both fields, with a fresh project reading false/false.
- [ ] `PATCH /projects/:projectId` with neither field supplied leaves both values unchanged.
- [ ] A new `apps/web` test renders the project detail with both toggles reflecting the fetched values, and clicking one issues a PATCH carrying only the changed field (asserted via the existing fetch-installing web test harness).
- [ ] Both toggle labels exist in the `en` and `zh` locale files; the i18n sweep test passes.
- [ ] Typecheck of `@anneal/db`, `@anneal/api`, and `apps/web` passes; `npm run lint` passes on the touched files.
