# Operator API handbook

The operator drives AgentOS through this HTTP API. Unless a route is marked
**Public** or **Webhook**, send `Authorization: Bearer $OPERATOR_TOKEN`.
Examples use `$BASE_URL` (for example, `http://127.0.0.1:3000`) and placeholder
IDs such as `$PROJECT_ID`; replace them with values from your installation.
JSON request bodies require `Content-Type: application/json`.

The route list and input requirements below use the same method and path
spelling as the route definitions in `packages/api/src/app.ts`. Fields called
“optional (default …)” are filled by the API when omitted. A body described as
“at least one” is validated by a patch schema and must contain one or more of
the named fields.

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

### POST `/projects/:projectId/goals/:goalId/approve-dod`

- Required path parameters: `projectId`, `goalId`.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/goals/$GOAL_ID/approve-dod" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/goals/:goalId/pause`

- Required path parameter: `goalId`.

```sh
curl -X POST "$BASE_URL/goals/$GOAL_ID/pause" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/goals/:goalId/pause`

- Required path parameters: `projectId`, `goalId`.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/goals/$GOAL_ID/pause" -H "Authorization: Bearer $OPERATOR_TOKEN"
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

There is no create-template route in `app.ts`; templates are read, patched for
webhook configuration, or instantiated.

### GET `/projects/:projectId/task-templates`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/task-templates" -H "Authorization: Bearer $OPERATOR_TOKEN"
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
- Required header: `X-AgentOS-Webhook-Secret`.
- Required body: a JSON object. `X-AgentOS-Delivery-Id` is optional and is used
  for replay deduplication when the trigger has a replay window.
- This public delivery route does not use the operator bearer token.

```sh
curl -X POST "$BASE_URL/hooks/templates/$TEMPLATE_ID" \
  -H "X-AgentOS-Webhook-Secret: $WEBHOOK_SECRET" -H "Content-Type: application/json" \
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

```sh
curl "$BASE_URL/tasks/$TASK_ID/chain" -H "Authorization: Bearer $OPERATOR_TOKEN"
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

### GET `/runs/:runId/events`

- Required path parameter: `runId`.
- Optional query: `afterSeq` and `limit` (1–2000, default `500`).

```sh
curl "$BASE_URL/runs/$RUN_ID/events?afterSeq=0&limit=500" -H "Authorization: Bearer $OPERATOR_TOKEN"
```
