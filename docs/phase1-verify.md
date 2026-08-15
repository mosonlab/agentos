# Execution-kernel manual verification

This supersedes the Phase 1 shared-directory/shared-token flow. Use a
disposable Git remote while verifying because the three CLIs run in their
non-interactive implementation modes.

## 1. Configure and start

Copy `.env.example` to `.env`. Set different random `OPERATOR_TOKEN` and
`RUNNER_TOKEN` values plus a base64-encoded 32-byte
`AGENTOS_SECRET_ENCRYPTION_KEY`. Then:

```sh
docker compose up -d postgres
npm install
npm run db:migrate
npm run db:seed
npm run dev:api
```

Create a Repo with the operator token:

```sh
curl -X POST http://localhost:3000/projects/PROJECT_ID/repos \
  -H "Authorization: Bearer OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"disposable","remoteUrl":"/absolute/path/to/disposable.git","mountPath":"repo","defaultBranch":"main"}'
```

Grant the selected Agent explicit access before creating its Task:

```sh
curl -X POST http://localhost:3000/agents/AGENT_ID/repos/REPO_ID/access \
  -H "Authorization: Bearer OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"permissions":"GIT_WRITE","mountPath":"repo"}'
```

Start `npm run dev:web` and enter the operator token. Start
`npm run dev:runner` separately; startup must report a version/auth preflight
for Claude, Codex, and Pi. A failed backend is circuit-open and will not claim.

## 2. Exercise a Run

1. Create a Task using the disposable Repo and an agent.
2. Confirm the Task stays a four-state card while its Run progresses through
   queued/claimed/running/terminal states.
3. Confirm a unique directory appears below `RUNNER_WORKSPACE_ROOT`, on branch
   `agentos/<task>/run-1`.
4. Watch append-only events via `GET /runs/:runId/events`. Tool start/end must
   be distinct structured events, not stdout chunks.
5. On success, confirm both terminal event and exit evidence were recorded,
   base/head SHA are present, the workspace is removed, and Task moves to
   Review. On failure, confirm `failureClass` and configured retention.
6. Force a lease loss. The old runner must receive 409 on its next fenced
   write and kill the process group; reconciliation marks the Run lost and
   queues a new Run only while the three-Run budget remains.

## 3. Automated checks

```sh
npm run db:validate
npm test
npm run typecheck
npm run build
```

The required unit coverage includes stale fencing rejection, child environment
isolation, exit-zero without a terminal event, and max-runs/walltime/stall
budget gates. Database migrations should additionally be applied to an empty
Postgres database and checked for Prisma schema drift.
