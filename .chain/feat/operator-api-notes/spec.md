Two small operator-experience improvements. Decision record: records/AUDIT-danny-parity-refresh-20260826.md (light card, approved by Leo 2026-08-26). The operator drives this platform by talking to LLM assistants which then call the HTTP API; the UI is secondary.

Part 1 -- Operator API handbook:
1. Write docs/operator-api.md: enumerate the operator-facing HTTP routes in packages/api/src/app.ts (tasks incl. schedule/cron fields, task templates + instantiate, triggers/automations, repos, MCP connections, secrets, agents, inbox, sessions/runs, files). For each: method, path, required params, one curl example. Organize by domain. State auth (Bearer OPERATOR_TOKEN) once at the top.
2. Keep it accurate by construction: derive from the route definitions, do not invent parameters. Where a zod input schema exists, reflect its required fields.
3. Add a single pointer line to the handbook from AGENTS.md so coding agents discover it.

Part 2 -- Operator task notes reach the agent:
4. Today POST /tasks/:taskId/activity (the "Add a comment" box) writes a TaskActivity row that no agent ever sees. Change run prompt assembly so operator-authored activity rows created after the previous run of the same task are appended to the next run's prompt as an "Operator notes" section, bounded (most recent 10 notes / 4000 chars max).
5. Cover with a workflow test: create task, add operator note, assert next run prompt contains it; assert runner/agent-authored activity is not injected.

Non-goals: mid-run message injection into a live session; UI changes; new endpoints.

Acceptance: handbook covers all operator routes present in app.ts (spot-check three domains against code); prompt injection test green; lint and existing tests green.
