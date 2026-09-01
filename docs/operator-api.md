# Operator API handbook

## Conventions

The operator drives Anneal through this HTTP API. Unless a route is marked
**Public** or **Webhook**, send `Authorization: Bearer $OPERATOR_TOKEN`.
Examples use `$BASE_URL` (for example, `http://127.0.0.1:3000`) and placeholder
IDs such as `$PROJECT_ID`; replace them with values from your installation.
JSON request bodies require `Content-Type: application/json`.

Malformed JSON request bodies return `400 Bad Request` with code `invalid-json`
and message `Request body must be valid JSON` on every JSON route. Empty bodies
receive the same refusal when a route requires a JSON body; the manual-fire
route is the exception because it intentionally treats an empty body as an
empty object. A syntactically valid body that fails its route schema still
returns the usual `400 Bad Request` validation response.

The route list and input requirements below use the same method and path
spelling as the route definitions in `packages/api/src/app.ts` and
`packages/api/src/routes/`. Fields called
“optional (default …)” are filled by the API when omitted. A body described as
“at least one” is validated by a patch schema and must contain one or more of
the named fields. This route list is coverage-tested against those API route
source files; missing or stale entries fail
`scripts/operator-api-docs.test.mjs`.

The polled collection routes `GET /projects`, `GET /projects/:projectId/agents`,
`GET /projects/:projectId/repos`, `GET /tasks`, `GET /inbox/messages`, and
`GET /inbox/messages/summary` return an `ETag`. Send it back in
`If-None-Match`; unchanged data returns `304 Not Modified` with an empty body.

## Service, status, and onboarding

### GET `/` — Public

- Required parameters: none.

```sh
curl "$BASE_URL/"
```

### GET `/health` — Public

- Required parameters: none.

```sh
curl "$BASE_URL/health"
```

### GET `/version` — Public

- Required parameters: none.

```sh
curl "$BASE_URL/version"
```

### GET `/runners`

- Required parameters: none.

```sh
curl "$BASE_URL/runners" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/onboarding`

- Required parameters: none.

```sh
curl "$BASE_URL/onboarding" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/onboarding`

- Required JSON fields: `project.name`, `repo.name`, `repo.remoteUrl`,
  `acknowledgedHostExecution` (must be `true`).
- Optional JSON fields: `project.slug` (derived from the name),
  `repo.defaultBranch` (default `main`), and `repo.mountPath` (the starter
  mount path, which must be `repo`).

```sh
curl -X POST "$BASE_URL/onboarding" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"project":{"name":"Demo"},"repo":{"name":"demo","remoteUrl":"https://github.com/acme/demo.git"},"acknowledgedHostExecution":true}'
```

## Files

These routes address the configured Files Root. A missing query parameter means
the Files Root itself (`dir`, `path`, and `recursive` each have route-level
defaults).

### GET `/files`

- Required parameters: none.
- Optional query: `dir`.

```sh
curl "$BASE_URL/files?dir=docs" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/files/content`

- Required parameters: none.
- Optional query: `path`.

```sh
curl "$BASE_URL/files/content?path=README.md" -H "Authorization: Bearer $OPERATOR_TOKEN" -o README.md
```

### PUT `/files/content`

- Required parameters: raw request body containing the file bytes.
- Optional query: `path` (empty path targets the Files Root and is normally
  rejected by the underlying file operation).

```sh
curl -X PUT "$BASE_URL/files/content?path=notes/today.md" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" --data-binary @notes/today.md
```

### POST `/files/mkdir`

- Required JSON field: `path`.

```sh
curl -X POST "$BASE_URL/files/mkdir" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"path":"notes"}'
```

### POST `/files/move`

- Required JSON fields: `from`, `to`.

```sh
curl -X POST "$BASE_URL/files/move" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"from":"draft.md","to":"archive/draft.md"}'
```

### DELETE `/files`

- Required parameters: none.
- Optional query: `path`, `recursive` (`true` enables recursive deletion).

```sh
curl -X DELETE "$BASE_URL/files?path=archive/draft.md" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Projects and environments

### GET `/projects`

- Required parameters: none.

```sh
curl "$BASE_URL/projects" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects`

- Required JSON fields: `name`, `slug` (lowercase hyphenated form).
- Optional JSON field: `yamlDocument` (default `""`).

```sh
curl -X POST "$BASE_URL/projects" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Demo","slug":"demo"}'
```

### GET `/projects/:projectId`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/projects/:projectId`

- Required path parameter: `projectId`.
- Required JSON: at least one of `name`, `slug`, `yamlDocument`.

```sh
curl -X PATCH "$BASE_URL/projects/$PROJECT_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Demo updated"}'
```

### DELETE `/projects/:projectId`

- Required path parameter: `projectId`.

```sh
curl -X DELETE "$BASE_URL/projects/$PROJECT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/projects/:projectId/costs`

- Required path parameter: `projectId`.
- Required query parameter: `tz` (recognized IANA timezone).
- Optional query parameter: `days` (`1`, `7`, `30`, or `90`; default `30`).
- The response retains the aggregate totals, daily series, model totals, agent
  totals, and top runs. Agent rows additionally report cached-read percentage,
  unknown-split run count, and known uncached-input tokens and spend.
- `waste` partitions `wastedUsd` exactly into operator-cancelled and failed
  spend; failed spend is further partitioned by failure class.
- `chains` contains terminal chains whose last run ended in the window, with
  lead/busy time, repair counts, longest idle gap, priced spend by step role,
  and an unpriced-run count. The `unassigned` role is used when persisted step
  metadata cannot classify priced spend. Unknown cache splits are counted and
  excluded from cache metrics; unpriced chain runs never receive a fabricated
  cost.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/costs?days=1&tz=America%2FLos_Angeles" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/projects/:projectId/environments`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/environments" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/environments`

- Required path parameter: `projectId`.
- Required JSON field: `name`.
- Optional JSON fields: `networking` (`OPEN` or `LIMITED`, default `LIMITED`),
  `allowedHosts` (default `[]`).

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/environments" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"local"}'
```

### GET `/environments/:environmentId`

- Required path parameter: `environmentId`.

```sh
curl "$BASE_URL/environments/$ENVIRONMENT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/environments/:environmentId`

- Required path parameter: `environmentId`.
- Required JSON: at least one of `name`, `networking`, `allowedHosts`.

```sh
curl -X PATCH "$BASE_URL/environments/$ENVIRONMENT_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"networking":"LIMITED","allowedHosts":["api.example.com"]}'
```

### DELETE `/environments/:environmentId`

- Required path parameter: `environmentId`.

```sh
curl -X DELETE "$BASE_URL/environments/$ENVIRONMENT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Secrets

Secret values are accepted only on create/update and are not returned by the
read routes. `purpose` is one of `MCP`, `REPO`, `ENV`, or `WEBHOOK`.

### GET `/secrets`

- Required parameters: none.

```sh
curl "$BASE_URL/secrets" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/secrets`

- Required JSON fields: `name`, `purpose`, `value`.
- Optional JSON field: `description` (default `null`).

```sh
curl -X POST "$BASE_URL/secrets" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"GitHub token\",\"purpose\":\"REPO\",\"value\":\"$REPO_TOKEN\"}"
```

### GET `/secrets/:secretId`

- Required path parameter: `secretId`.

```sh
curl "$BASE_URL/secrets/$SECRET_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/secrets/:secretId`

- Required path parameter: `secretId`.
- Required JSON: at least one of `name`, `purpose`, `description`, `value`.

```sh
curl -X PATCH "$BASE_URL/secrets/$SECRET_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d "{\"value\":\"$NEW_REPO_TOKEN\"}"
```

### DELETE `/secrets/:secretId`

- Required path parameter: `secretId`.

```sh
curl -X DELETE "$BASE_URL/secrets/$SECRET_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Agents and capabilities

### GET `/projects/:projectId/agents`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/agents" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/agents`

- Required path parameter: `projectId`.
- Required JSON fields: `environmentId`, `name`, `title`, `model`, `rolePrompt`.
- Optional JSON fields: `foundationalPrompt`, `codexServiceTier` (`DEFAULT` or
  `FAST`, default `DEFAULT`), `runnerPreference` (`CLAUDE`, `CODEX`, `PI`,
  `AUTO`, or `INHERIT`, default `INHERIT`), `inboxAccess` (default `false`),
  `disabledTools` (default `[]`).

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/agents" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"environmentId":"'$ENVIRONMENT_ID'","name":"builder","title":"Builder","model":"gpt-5","rolePrompt":"Implement the assigned work."}'
```

### GET `/agents/:agentId`

- Required path parameter: `agentId`.

```sh
curl "$BASE_URL/agents/$AGENT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/agents/:agentId`

- Required path parameter: `agentId`.
- Required JSON: at least one agent field (`environmentId`, `name`, `title`,
  `model`, `codexServiceTier`, `foundationalPrompt`, `rolePrompt`,
  `runnerPreference`, `inboxAccess`, or `disabledTools`).

```sh
curl -X PATCH "$BASE_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Senior builder"}'
```

### POST `/agents/:agentId/reset-runtime-config`

- Required path parameter: `agentId`.
- Required JSON: none. The agent must have a canonical role source and must
  not be archived. The canonical role's `model` and `runnerPreference` are
  applied immediately, and the agent becomes eligible for future canonical
  runtime updates. A stored non-default `codexServiceTier` must also be valid
  for the canonical model and runner; if reset refuses that combination, first
  PATCH `codexServiceTier` to `DEFAULT`, then retry the reset.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/reset-runtime-config" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### DELETE `/agents/:agentId`

- Required path parameter: `agentId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/archive`

- Required path parameter: `agentId`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/archive" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/unarchive`

- Required path parameter: `agentId`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/unarchive" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/agents/:agentId/secret-grants`

- Required path parameter: `agentId`.

```sh
curl "$BASE_URL/agents/$AGENT_ID/secret-grants" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/secret-grants`

- Required path parameter: `agentId`.
- Required JSON fields: `secretId`, `envVar` (an environment-variable name).

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/secret-grants" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"secretId":"'$SECRET_ID'","envVar":"GITHUB_TOKEN"}'
```

### DELETE `/agents/:agentId/secret-grants/:secretId/:envVar`

- Required path parameters: `agentId`, `secretId`, `envVar`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/secret-grants/$SECRET_ID/GITHUB_TOKEN" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/agents/:agentId/filesystem-grants`

- Required path parameter: `agentId`.

```sh
curl "$BASE_URL/agents/$AGENT_ID/filesystem-grants" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/filesystem-grants`

- Required path parameter: `agentId`.
- Required JSON field: `folderPath` (use `""` for the whole Files Root).
- At least one of `canRead`, `canWrite`, `canDelete` must be `true`; each
  defaults to `false`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/filesystem-grants" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"folderPath":"repo","canRead":true,"canWrite":true}'
```

### PATCH `/agents/:agentId/filesystem-grants/:grantId`

- Required path parameters: `agentId`, `grantId`.
- Required JSON: at least one of `folderPath`, `canRead`, `canWrite`,
  `canDelete`.

```sh
curl -X PATCH "$BASE_URL/agents/$AGENT_ID/filesystem-grants/$GRANT_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"canWrite":false}'
```

### DELETE `/agents/:agentId/filesystem-grants/:grantId`

- Required path parameters: `agentId`, `grantId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/filesystem-grants/$GRANT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/collaborators`

- Required path parameter: `agentId`.
- Required JSON field: `allowedAgentId`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/collaborators" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"allowedAgentId":"'$COLLABORATOR_AGENT_ID'"}'
```

### DELETE `/agents/:agentId/collaborators/:allowedAgentId`

- Required path parameters: `agentId`, `allowedAgentId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/collaborators/$COLLABORATOR_AGENT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/projects/:projectId/skills`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/skills" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/skills`

- Required path parameter: `projectId`.
- Required JSON fields: `name`, `slug`, `kind` (`PROMPT` or `FILE`).
- Optional JSON fields: `body` and `filePath` (default `null`); `PROMPT`
  requires `body`, while `FILE` requires `filePath`.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/skills" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Review checklist","slug":"review-checklist","kind":"PROMPT","body":"Check the acceptance criteria."}'
```

### POST `/agents/:agentId/skills`

- Required path parameter: `agentId`.
- Required JSON field: `skillId`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/skills" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"skillId":"'$SKILL_ID'"}'
```

### DELETE `/agents/:agentId/skills/:skillId`

- Required path parameters: `agentId`, `skillId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/skills/$SKILL_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## MCP connections

### GET `/projects/:projectId/mcp-connections`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/mcp-connections" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/mcp-connections`

- Required path parameter: `projectId`.
- Required JSON fields: `name`, `transport`.
- Optional JSON fields: `config` (record, default `{}`), `allowedOperations`
  (array, default `[]`), `credentialSecretId` (default `null`).

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/mcp-connections" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Docs MCP","transport":"stdio","config":{"command":"docs-mcp"}}'
```

### POST `/agents/:agentId/mcp-connections`

- Required path parameter: `agentId`.
- Required JSON field: `mcpConnectionId`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/mcp-connections" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"mcpConnectionId":"'$MCP_CONNECTION_ID'"}'
```

### DELETE `/agents/:agentId/mcp-connections/:connectionId`

- Required path parameters: `agentId`, `connectionId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/mcp-connections/$MCP_CONNECTION_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Repositories

### GET `/projects/:projectId/repos`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/repos" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/repos`

- Required path parameter: `projectId`.
- Required JSON fields: `name`, `remoteUrl`.
- Optional JSON fields: `mountPath` (default `repo`), `defaultBranch`
  (default `main`), `credentialSecretId` (default `null`).

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/repos" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"demo","remoteUrl":"https://github.com/acme/demo.git"}'
```

### PATCH `/repos/:repoId`

- Required path parameter: `repoId`.
- Required JSON: at least one of `name`, `remoteUrl`, `mountPath`,
  `defaultBranch`, `credentialSecretId`.

```sh
curl -X PATCH "$BASE_URL/repos/$REPO_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"defaultBranch":"main"}'
```

### DELETE `/repos/:repoId`

- Required path parameter: `repoId`.

```sh
curl -X DELETE "$BASE_URL/repos/$REPO_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/repos/:repoId/access`

- Required path parameters: `agentId`, `repoId`.
- Optional JSON fields: `permissions` (`GIT_READ` or `GIT_WRITE`, default
  `GIT_WRITE`), `mountPath` (default `repo`).

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/repos/$REPO_ID/access" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"permissions":"GIT_WRITE","mountPath":"repo"}'
```

### DELETE `/agents/:agentId/repos/:repoId/access`

- Required path parameters: `agentId`, `repoId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/repos/$REPO_ID/access" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Goals

### GET `/projects/:projectId/goals`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/goals" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/goals`

- Required path parameter: `projectId`.
- Required JSON field: `title`.
- Optional JSON fields: `spec` (default `""`), `spendCap` (default `null`),
  `maxDurationMin` (default `240`), `stallTimeoutMin` (default `10`),
  `maxSessionsPerTask` (default `3`), `stuckThreshold` (default `19`),
  `runnerPreference` (`CLAUDE`, `CODEX`, `PI`, `AUTO`, or `INHERIT`, default
  `AUTO`), `sharedFolderPath` (default `null`), and `definitionOfDone` (array
  of `{text}` objects, default `[]`).

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/goals" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Ship the release","definitionOfDone":[{"text":"All acceptance tests pass"}]}'
```

### GET `/goals/:goalId`

- Required path parameter: `goalId`.

```sh
curl "$BASE_URL/goals/$GOAL_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/goals/:goalId`

- Required path parameter: `goalId`.
- Required JSON: at least one of `title`, `spec`, `spendCap`, `maxDurationMin`,
  `stallTimeoutMin`, `maxSessionsPerTask`, `stuckThreshold`,
  `runnerPreference`, `sharedFolderPath`.

```sh
curl -X PATCH "$BASE_URL/goals/$GOAL_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"spendCap":25}'
```

### DELETE `/goals/:goalId`

- Required path parameter: `goalId`.

```sh
curl -X DELETE "$BASE_URL/goals/$GOAL_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/goals/:goalId/approve-dod`

- Required path parameter: `goalId`.

```sh
curl -X POST "$BASE_URL/goals/$GOAL_ID/approve-dod" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/goals/:goalId/pause`

- Required path parameter: `goalId`.

```sh
curl -X POST "$BASE_URL/goals/$GOAL_ID/pause" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/goals/:goalId/definition-of-done`

- Required path parameter: `goalId`.

```sh
curl "$BASE_URL/goals/$GOAL_ID/definition-of-done" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/goals/:goalId/definition-of-done`

- Required path parameter: `goalId`.
- Required JSON field: `text`.

```sh
curl -X POST "$BASE_URL/goals/$GOAL_ID/definition-of-done" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"The release is documented"}'
```

### PATCH `/goals/:goalId/definition-of-done/:itemId`

- Required path parameters: `goalId`, `itemId`.
- Required JSON: at least one of `text`, `done`.

```sh
curl -X PATCH "$BASE_URL/goals/$GOAL_ID/definition-of-done/$DOD_ITEM_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"done":true}'
```

### DELETE `/goals/:goalId/definition-of-done/:itemId`

- Required path parameters: `goalId`, `itemId`.

```sh
curl -X DELETE "$BASE_URL/goals/$GOAL_ID/definition-of-done/$DOD_ITEM_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/goals/:goalId/progress-log`

- Required path parameter: `goalId`.

```sh
curl "$BASE_URL/goals/$GOAL_ID/progress-log" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/goals/:goalId/progress-log`

- Required path parameter: `goalId`.
- Required JSON field: `body`.
- Optional JSON fields: `sessionId` (nullable) and `metadata` (record).

```sh
curl -X POST "$BASE_URL/goals/$GOAL_ID/progress-log" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"The implementation is ready for review"}'
```

## Task templates

Templates can be cloned under a new project-local name, read, patched for
webhook configuration, or instantiated. Cloning copies the description,
variables, and complete Step graph, but clears webhook configuration; Tasks
and trigger fires are never copied.

### GET `/projects/:projectId/task-templates`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/task-templates" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/task-templates/:templateId/clone`

- Required path parameters: `projectId`, `templateId`.
- Required JSON field: `name` (trimmed, non-empty, and at most 200 characters).
- Optional JSON field: `description` (at most 50,000 characters); when omitted,
  the source description is copied.
- Returns `201 Created` with the cloned template and its ordered Steps.
- Refusals: `404 Not Found` with code `template_not_in_project` when the source
  is not in the addressed project; `409 Conflict` with code
  `template_name_taken` when the name is already used in the project; and
  `409 Conflict` with code `template_name_reserved` when the name is a current
  or registered-legacy canonical identity.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/clone" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"custom-review-workflow","description":"A project-specific workflow"}'
```

### PUT `/projects/:projectId/task-templates/:templateId/steps`

- Required path parameters: `projectId`, `templateId`.
- Required JSON field: `steps`, an array of at most 64 Steps. Each Step
  requires `name`, `assigneeType`, `assigneeAgentId`, `prompt`,
  `approvalGate`, `attachmentsFromPrevious`, `priorOutputKinds`,
  `spawnPolicy`, `runner`, `outputKind`, `opensPullRequest`,
  `requiresCommit`, `baseFromStepIndex`, and `layer`; `stepIndex` is
  assigned densely from array order. `baseFromStepIndex` is a 1-based
  position in the submitted array and may be `null`.
- The request and every nested Step are strict: unknown fields, including a
  caller-supplied `stepIndex`, are rejected with `400 Bad Request`.
- Returns `200 OK` with `{ template, warnings }`. `template` is the
  resulting template read projection and `warnings` is the complete warning
  array for that graph. Warnings are not persisted.
- Refusals: `404 Not Found` with `template_not_in_project` when the
  addressed template is absent from the project; `409 Conflict` with
  `template_canonical` for current or registered-legacy canonical identity,
  or `template_in_use` when any Task references the template or one of its
  Steps. The `template_in_use` recovery is to clone again.
- An empty array answers `422 Unprocessable Entity` with
  `graph_empty`. Other graph validator refusals use `422` with their stable
  code and optional `stepIndex`: `first_step_not_agent`,
  `first_layer_not_single`, `layer_order_invalid`, and `base_step_invalid` are
  the ordering and base-reference checks. Output wiring also refuses
  `prior_kind_unproduced`, `output_kind_duplicate`, and `prior_kind_duplicate`.
  Gate and assignee checks refuse `approval_gate_in_parallel_layer`,
  `assignee_invalid`, and `integrator_binding_invalid`. Agent assignments must
  name an existing, non-archived Agent in the addressed project. Repo grants
  are not checked while authoring; the instantiation route checks the grant
  against its selected Repo. Warning codes are
  `no_review_step`, `same_agent_implements_and_reviews`, and
  `pull_request_without_regression`; warnings are non-blocking, describe the
  complete resulting graph, and are ephemeral (they are not persisted or
  returned by template reads).

```sh
curl -X PUT "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/steps" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"steps":[{"name":"Implement","assigneeType":"AGENT","assigneeAgentId":"'$AGENT_ID'","prompt":"Implement the change","approvalGate":false,"attachmentsFromPrevious":false,"priorOutputKinds":[],"spawnPolicy":null,"runner":"CODEX","outputKind":"implementation","opensPullRequest":true,"requiresCommit":true,"baseFromStepIndex":null,"layer":1}]}'
```

### GET `/task-templates/:templateId`

- Required path parameter: `templateId`.

```sh
curl "$BASE_URL/task-templates/$TEMPLATE_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/task-templates/:templateId`

- Required path parameter: `templateId`.
- Required JSON: at least one of `webhookSecretId`, `webhookRepoId`,
  `webhookPayloadMapping`, `webhookReplayWindowSec`.
- `webhookPayloadMapping` is either `null` or `{map?, defaults?}`;
  `webhookReplayWindowSec` is `0`–`86400` or `null`.

```sh
curl -X PATCH "$BASE_URL/task-templates/$TEMPLATE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"webhookReplayWindowSec":300}'
```

### POST `/projects/:projectId/task-templates/:templateId/instantiate`

- Required path parameters: `projectId`, `templateId`.
- Required JSON fields: `repoId`, `variables` (string-to-string record; values
  must not be blank).
- Optional JSON fields: `autoStart` (default `false`), `afterTaskId`, `name`,
  `description`, and `stepOverrides` (map of positive step indexes to
  `{assigneeAgentId}`). `afterTaskId` cannot be combined with `autoStart:true`.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/instantiate" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"repoId":"'$REPO_ID'","variables":{"branchName":"feature/demo"},"autoStart":true}'
```

## Triggers and automations

Triggers are webhook-configured task templates. The operator routes inspect,
pause, enable, and manually fire them.

### GET `/projects/:projectId/triggers`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/triggers" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/triggers/:templateId`

- Required path parameter: `templateId`.

```sh
curl "$BASE_URL/triggers/$TEMPLATE_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/triggers/:templateId/fires`

- Required path parameter: `templateId`.
- Optional query: `take` (clamped to `1`–`100`, default `20`).

```sh
curl "$BASE_URL/triggers/$TEMPLATE_ID/fires?take=20" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/triggers/:templateId/pause`

- Required path parameter: `templateId`.

```sh
curl -X POST "$BASE_URL/triggers/$TEMPLATE_ID/pause" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/triggers/:templateId/enable`

- Required path parameter: `templateId`.

```sh
curl -X POST "$BASE_URL/triggers/$TEMPLATE_ID/enable" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/task-templates/:templateId/fire`

- Required path parameter: `templateId`.
- Optional JSON body: `variables` (string-to-string record). An empty body is
  accepted; configured defaults resolve omitted variables.

```sh
curl -X POST "$BASE_URL/task-templates/$TEMPLATE_ID/fire" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"variables":{"branchName":"feature/manual-fire"}}'
```

### POST `/hooks/templates/:templateId` — Webhook

- Required path parameter: `templateId`.
- Required header: `X-Anneal-Webhook-Secret`.
- Required body: a JSON object. `X-Anneal-Delivery-Id` is optional and is used
  for replay deduplication when the trigger has a replay window.
- This public delivery route does not use the operator bearer token.

```sh
curl -X POST "$BASE_URL/hooks/templates/$TEMPLATE_ID" \
  -H "X-Anneal-Webhook-Secret: $WEBHOOK_SECRET" -H "Content-Type: application/json" \
  -d '{"branchName":"feature/webhook"}'
```

## Tasks

Task creation defaults to an agent task scheduled `NOW`; an agent task must
also have a project-local `assigneeAgentId` and `repoId`, and the assignee must
have access to that repository. `scheduleKind` is `NOW`, `AT`, or `CRON`:
`AT` requires `runAt` and an agent/repository; `CRON` requires `cron` (five
fields, no macros) and computes the next `runAt`; `timezone` is an optional IANA
timezone. The task body also supports `status` (`TODO` or `BACKLOG` at
creation), `approvalGate`, `opensPullRequest`,
`maxDurationMin`, `stallTimeoutMin`, `maxSessionsPerTask`, `workingDirectory`,
`targetBranch`, and paired `chainId`/`chainIndex` fields.

### GET `/tasks`

- Required parameters: none.
- Optional query: `projectId`; `archived` (`false`, `true`, or `all`, default
  `false`); `view` (`full` or `board`, default `full`); `enrich` (`true` or
  `false`, default `true`).

The `board` view is a compact card projection. It includes `createdAt` for
stable queue ordering and `assigneeType` so a human-owned task can be
distinguished from an agent task whose agent assignment is missing.

```sh
curl "$BASE_URL/tasks?projectId=$PROJECT_ID&view=full&archived=false" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/tasks`

- Required path parameter: `projectId`.
- Required JSON field: `name`.
- Optional JSON fields and defaults: `description` (`""`),
  `workingDirectory` (`null`), `repoId` (`null`), `targetBranch` (`null`),
  `assigneeType` (`AGENT`), `assigneeAgentId` (`null`), `approvalGate`
  (`false`), `opensPullRequest` (`true`), `maxDurationMin` (`240`),
  `stallTimeoutMin` (`10`), `maxSessionsPerTask` (`5`), `scheduleKind`
  (`NOW`), `runAt` (`null`), `cron` (`null`), `timezone` (`null`), and `status`
  (`TODO`). At creation, `status` may be `TODO` or `BACKLOG`; `DOING`,
  `REVIEW`, and `DONE` are rejected rather than normalized.
  `chainId` and `chainIndex` are optional but must be supplied together.
  For the default `AGENT` type, `repoId` and `assigneeAgentId` are required by
  the route's project/access checks.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/tasks" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Run checks","repoId":"'$REPO_ID'","assigneeAgentId":"'$AGENT_ID'","scheduleKind":"NOW"}'
```

### GET `/tasks/:taskId`

- Required path parameter: `taskId`.
- Each returned Run's `session.latestAgentMessage` is either `null` when the
  session has no non-empty `MODEL_COMPLETED` or `FINAL_OUTPUT` text event, or
  `{body, at}` containing the newest qualifying event's plain-text body and
  timestamp. This is a derived read from the session event stream.
- Each returned Run includes the report-only `worktreeContainmentViolations`
  fact: absolute worktree paths from that Run's checkout found outside its run
  workspace, or `null` when no observation was reported.

```sh
curl "$BASE_URL/tasks/$TASK_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/tasks/:taskId/startability`

- Required path parameter: `taskId`.

```sh
curl "$BASE_URL/tasks/$TASK_ID/startability" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/tasks/:taskId/chain`

- Required path parameter: `taskId`.
- The response includes a Chain-level `control` object. It contains the
  current `state`, held layer (`heldLayer`), `heldAt`, optional hold reason
  (`holdReason`), the request identifier (`holdRequestId`) that accepted the
  hold, and `releasedAt` when the hold was last released. `control` is `null`
  for a Chain that has never been held;
  after a release it reports the released state and its last-release facts.
  Each Step also carries `holdRefusal`: the API's hold-specific refusal message
  when the persisted barrier prevents that Step from starting, otherwise
  `null`. The UI uses this field with `startable` and `startAction`; it does not
  recompute the held-layer barrier.

```sh
curl "$BASE_URL/tasks/$TASK_ID/chain" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### DELETE `/tasks/:taskId/chain`

- Required path parameter: `taskId`, naming either a direct Chain member or a
  detached merge-tail repair task bound to the Chain by its repair marker.
- Deletes every Task in the project-scoped Chain, including its marker-bound
  repair tasks, atomically.
- Refusals: `404 Not Found` when the Task does not exist; `409 Conflict` when
  the Task belongs to no Chain, any Chain member has an active Run, or a member
  has retained Run/Session history. Active Run and retained-history refusals
  return codes `chain_delete_active_run` and `chain_delete_run_history`,
  respectively, and change nothing.

```sh
curl -X DELETE "$BASE_URL/tasks/$TASK_ID/chain" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/chain/hold`

- Required path parameter: `taskId`.
- Required JSON field: `requestId`.
- Optional JSON field: `reason` (the operator's explanation for holding the
  Chain).
- A repeated Hold while the Chain is already held is a successful idempotent
  no-op: it reports the existing hold and makes no transition or audit event.
- Refusals: `404 Not Found` when the Task does not exist; `409 Conflict`
  when the Task belongs to no Chain or every Task in the Chain is already
  `DONE` (there is nothing left to hold).

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/chain/hold" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"hold-001","reason":"Review the current layer first"}'
```

### POST `/tasks/:taskId/chain/resume`

- Required path parameter: `taskId`.
- Required JSON field: `requestId`.
- Resume releases a held Chain and activates the currently eligible layer at
  most once. It never revives a cancelled Run or reuses its provider
  conversation.
- Resume on a Chain that is not held is a successful idempotent no-op: it
  makes no transition, audit event, or activation.
- Refusals: `404 Not Found` when the Task does not exist; `409 Conflict`
  when the Task belongs to no Chain.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/chain/resume" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"resume-001"}'
```

### Recovering a merge tail stopped after its repair budget

When a regression verdict fails after the automatic repair budget is exhausted,
the Regression verification task remains parked in `REVIEW`, and a stop notice
is written to the Inbox. Its `failureReason` is exactly one of these shapes:

- `semantic regression FAIL on chain head <sha> after N automatic repair attempts`
- `merge gate FAIL on chain head <sha> after N automatic repair attempts`

These are the repair ceiling, not an API defect. From this state,
`POST /tasks/:taskId/retry` on the regression task opens a Run whose
`regression-repair-handoff` claim fails at claim time as `handoff-invalid` with
`regression repair handoff is invalid: no successful review-fix result binds <head> to <base>`
for a semantic regression stop, or
`regression repair handoff is invalid: no successful gate-fix result binds <head> to <base>`
for a merge gate stop. A `PATCH /tasks/:taskId` request that supplies `status`
is refused with `Chain task statuses are controlled by chain execution`. Both
refusals are expected behaviour; do not use them to reopen the old Chain.

Carry the delivered branch forward in this order. The brief used in step (c)
must follow [Continuing from a delivered branch](BRIEF-TEMPLATE.md#continuing-from-a-delivered-branch).

1. (a) Read the regression task output and the stop notice, and confirm that
   the last verdict identifies a real defect. Find the notice by listing the
   project's Inbox and selecting the message for the regression task whose
   body starts with `Autonomous merge tail stopped:`.

   ```sh
   curl "$BASE_URL/tasks/$REGRESSION_TASK_ID/output" -H "Authorization: Bearer $OPERATOR_TOKEN"
   STOP_NOTICE_ID=$(curl "$BASE_URL/inbox/messages?projectId=$PROJECT_ID" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" | \
     jq -r --arg taskId "$REGRESSION_TASK_ID" \
       '.[] | select(.taskId == $taskId and (.body | startswith("Autonomous merge tail stopped:"))) | .id' | head -n 1)
   curl "$BASE_URL/inbox/messages/$STOP_NOTICE_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
   ```

2. (b) Hold the old Chain from any of its tasks, giving a `reason` that names
   the successor Chain you plan to create (for example, by its planned
   branch).

   ```sh
   curl -X POST "$BASE_URL/tasks/$OLD_CHAIN_TASK_ID/chain/hold" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
     -d '{"requestId":"hold-merge-tail-repair-budget-exit","reason":"Continue in successor chain for branch '$NEW_BRANCH_NAME'"}'
   ```

3. (c) Instantiate a new direct Chain on the same repository with a fresh
   `branchName`. Set `description` to the new brief following the linked
   pattern, with its first Change merging the delivered branch.

   ```sh
   SUCCESSOR_BODY=$(jq -n \
     --arg repoId "$REPO_ID" \
     --arg branchName "$NEW_BRANCH_NAME" \
     --arg description "$SUCCESSOR_BRIEF" \
     '{repoId: $repoId, variables: {branchName: $branchName}, description: $description, autoStart: true}')
   curl -X POST "$BASE_URL/projects/$PROJECT_ID/task-templates/$DIRECT_CHAIN_TEMPLATE_ID/instantiate" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
     -d "$SUCCESSOR_BODY"
   ```

4. (d) Archive every task in the old Chain. `GET /tasks/:taskId/chain` returns
   the primary Chain rows but omits its chain-detached merge-tail repair tasks.
   Find those tasks with `GET /tasks?view=board`: their `repairOf.chainId`
   contains the Chain binding derived from the same repair markers that
   `DELETE /tasks/:taskId/chain` covers. Archive both sets of task IDs.

   ```sh
   OLD_CHAIN=$(curl "$BASE_URL/tasks/$OLD_CHAIN_TASK_ID/chain" \
     -H "Authorization: Bearer $OPERATOR_TOKEN")
   OLD_CHAIN_ID=$(printf '%s' "$OLD_CHAIN" | jq -r '.chainId')
   OLD_TASK_IDS=$(printf '%s' "$OLD_CHAIN" | jq -r '.steps[].taskId')
   REPAIR_TASK_IDS=$(curl "$BASE_URL/tasks?projectId=$PROJECT_ID&view=board&archived=false" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" | \
     jq -r --arg chainId "$OLD_CHAIN_ID" \
       '.[] | select(.repairOf.chainId? == $chainId) | .id')
   printf '%s\n%s\n' "$OLD_TASK_IDS" "$REPAIR_TASK_IDS" | sed '/^$/d' | sort -u | while read -r TASK_ID; do
     curl -X POST "$BASE_URL/tasks/$TASK_ID/archive" -H "Authorization: Bearer $OPERATOR_TOKEN"
   done
   ```

5. (e) Never edit database rows to reopen the loop. Use the API only to inspect
   the old Chain after the handoff; there is no supported database recovery.

   ```sh
   curl "$BASE_URL/tasks/$OLD_CHAIN_TASK_ID/chain" -H "Authorization: Bearer $OPERATOR_TOKEN"
   ```

### PATCH `/tasks/:taskId`

- Required path parameter: `taskId`.
- Required JSON: at least one task field, `status`, or `failureReason`.
  Patchable task fields are `name`, `description`, `workingDirectory`, `repoId`,
  `targetBranch`, `assigneeType`, `assigneeAgentId`, `approvalGate`,
  `opensPullRequest`, `maxDurationMin`, `stallTimeoutMin`,
  `maxSessionsPerTask`, `scheduleKind`, `runAt`, `cron`, and `timezone`.
  `status` is a task status (`BACKLOG`, `TODO`, `DOING`, `REVIEW`, `DONE`);
  `failureReason` may be `null`.

```sh
curl -X PATCH "$BASE_URL/tasks/$TASK_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"maxSessionsPerTask":4}'
```

### DELETE `/tasks/:taskId`

- Required path parameter: `taskId`.
- Chain members, including detached repair tasks resolved through their repair
  markers, cannot be deleted individually. The route returns `400 Bad Request`
  with code `chain_task_delete_required`, names the Chain, and directs callers
  to `DELETE /tasks/:taskId/chain`.

```sh
curl -X DELETE "$BASE_URL/tasks/$TASK_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/retry`

- Required path parameter: `taskId`.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/retry" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/start`

- Required path parameter: `taskId`.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/start" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/archive`

- Required path parameter: `taskId`.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/archive" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/unarchive`

- Required path parameter: `taskId`.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/unarchive" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/tasks/archive-done`

- Required path parameter: `projectId`.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/tasks/archive-done" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/schedule/pause`

- Required path parameter: `taskId`.
- The task must have `scheduleKind: CRON`; no body is required.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/schedule/pause" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/schedule/resume`

- Required path parameter: `taskId`.
- The task must have `scheduleKind: CRON`; no body is required.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/schedule/resume" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/tasks/:taskId/recurring-fires`

- Required path parameter: `taskId`.
- Optional query: `take` (clamped to `1`–`50`, default `5`).

```sh
curl "$BASE_URL/tasks/$TASK_ID/recurring-fires?take=10" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/tasks/:taskId/activity`

- Required path parameter: `taskId`.

```sh
curl "$BASE_URL/tasks/$TASK_ID/activity" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/activity`

- Required path parameter: `taskId`.
- Required JSON field: `body`.
- Optional JSON fields: `actorType` (default `operator`; the operator route
  records the actor as operator), `actorId`, and `metadata`.
- The route records a direct operator note. Notes posted after the task is
  created can reach its first Run if it has not been claimed yet; thereafter,
  notes written after the previous Run are appended to the next Run's prompt
  under `Operator notes`. At most the 10 newest whole notes and 4,000 characters
  are delivered. A note does not reach a Run that is already in flight, and
  canonical `blind-findings` steps receive no activity notes.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/activity" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"Please preserve the existing public API."}'
```

### GET `/tasks/:taskId/output`

- Required path parameter: `taskId`.

```sh
curl "$BASE_URL/tasks/$TASK_ID/output" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PUT `/tasks/:taskId/output`

- Required path parameter: `taskId`.
- Required JSON fields: `kind`, `body`.
- Optional JSON fields: `fencingToken`, `metadata`, `commitSha`.

```sh
curl -X PUT "$BASE_URL/tasks/$TASK_ID/output" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"report","body":"Checks passed."}'
```

### POST `/tasks/:taskId/merge-target`

- Required path parameter: `taskId`.
- Required JSON field: `prNumber` (positive integer).

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/merge-target" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"prNumber":42}'
```

## Inbox

### GET `/inbox/messages`

- Required parameters: none.
- Optional query: `projectId`.

```sh
curl "$BASE_URL/inbox/messages?projectId=$PROJECT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/inbox/messages/summary`

- Required parameters: none.
- Returns the small global count used by the sidebar: `{ "needsReply": number }`.

```sh
curl "$BASE_URL/inbox/messages/summary" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/inbox/messages/:messageId`

- Required path parameter: `messageId`.

```sh
curl "$BASE_URL/inbox/messages/$MESSAGE_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/inbox/messages/:messageId/decision`

- Required path parameter: `messageId`.
- Required JSON fields: `decision`, `requestId`.

```sh
curl -X POST "$BASE_URL/inbox/messages/$MESSAGE_ID/decision" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"approve","requestId":"decision-001"}'
```

### POST `/inbox/messages/:messageId/reply`

- Required path parameter: `messageId`.
- Required JSON fields: `body`, `requestId`.

```sh
curl -X POST "$BASE_URL/inbox/messages/$MESSAGE_ID/reply" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"Use the existing deployment target.","requestId":"reply-001"}'
```

### POST `/inbox/messages/:messageId/close`

- Required path parameter: `messageId`.
- Required JSON field: `requestId`.

```sh
curl -X POST "$BASE_URL/inbox/messages/$MESSAGE_ID/close" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"close-001"}'
```

### POST `/inbox/messages/:messageId/supersede`

- Required path parameter: `messageId`.
- Required JSON field: `requestId`.

```sh
curl -X POST "$BASE_URL/inbox/messages/$MESSAGE_ID/supersede" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"supersede-001"}'
```

## Sessions and runs

The operator can list and inspect sessions, cancel runs, and page through run
events. The `/session/runs/...` routes used by an authenticated live agent
session and the `/runner/...` machine protocol are intentionally not listed:
the authentication middleware denies those prefixes to the operator principal.
The two revalidation routes below are session-only capabilities; they are
listed here so their authorization boundary is explicit even though operators
cannot call them directly. A `spec-revalidator` session on a bound direct chain
is the only caller accepted.
The machine-only `POST /runner/runs/:runId/complete` completion payload and
`POST /runner/runs/:runId/cancel/acknowledge` cancellation acknowledgement
accept the optional `worktreeContainmentViolations` array: absolute worktree
paths registered by the Run's checkout that lie outside its run workspace. The
field is report-only; omitted or empty means no observation and never changes
the Run outcome. A late cancellation acknowledgement backfills this evidence
when reconciliation terminalized the Run first.

### GET `/sessions`

- Required parameters: none.
- Optional query: `projectId`, `limit` (1–200, default `50`), and `before` (an
  ISO date cursor).

```sh
curl "$BASE_URL/sessions?projectId=$PROJECT_ID&limit=50" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/sessions/:sessionId`

- Required path parameter: `sessionId`.

```sh
curl "$BASE_URL/sessions/$SESSION_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/runs/:runId/cancel`

- Required path parameter: `runId`.
- Required JSON fields: `requestId`, `reason`.
- Optional JSON field: `parkTask` (default `false`).

```sh
curl -X POST "$BASE_URL/runs/$RUN_ID/cancel" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"cancel-001","reason":"Operator requested stop","parkTask":true}'
```

### PATCH `/session/runs/:runId/task`

- Session bearer authentication must name the same `runId` as the path.
- Required JSON fields: `fencingToken`, `description`.
- Only the bound chain's `spec-revalidator` Run may call this route. The
  implementation task is derived server-side; no task ID or chain ID is
  accepted. The fenced write replaces the brief while preserving the
  platform-authored prompt and output instructions. The server rejects changes
  to Goal, Changes-item intent, Out of scope, Constraints, Acceptance, Route,
  or the section structure; only Background and code-shaped descriptive
  references inside Changes may drift with the tree.

### POST `/session/runs/:runId/revalidation/cancel`

- Session bearer authentication must name the same `runId` as the path.
- Required JSON field: `fencingToken`.
- Only the bound chain's `spec-revalidator` Run may call this route, and only
  after the same Run's premise-collapse Inbox question has an answered
  `cancel-chain` decision. It records cancellation intent for the current Run,
  parks every unfinished task in the bound chain, and revokes the session token;
  the owning runner then performs provider cleanup and terminalization. A retry
  with the same session token and fencing token replays the committed result
  without repeating chain or activity mutations; the revoked token remains
  unauthorized for every other session route.

### GET `/runs/:runId/events`

- Required path parameter: `runId`.
- Optional query: `afterSeq` and `limit` (1–2000, default `500`).

```sh
curl "$BASE_URL/runs/$RUN_ID/events?afterSeq=0&limit=500" -H "Authorization: Bearer $OPERATOR_TOKEN"
```
