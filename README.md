# AgentOS

AgentOS is a local, single-operator control plane for assigning scoped agents to
tasks and goals. This repository contains the Phase 1 task loop: authenticated
Project, Agent, Task and activity APIs; claim/lease-based local runners; and a
live Kanban console. The CLI remains a help stub until its later phase.

The implementation follows `BLUEPRINT.md`, with `DECISIONS.md` taking
precedence. In particular, runners are local Mac processes (`claude`, `codex`,
or `pi`), durable files stay on the local filesystem, and secrets are managed
in one encrypted database-backed catalog. There is no hosted runner or object
storage code path.

## Start Phase 1 locally

Requirements: Node.js 20.19 or newer, npm, and Docker.

```sh
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev:api
```

In separate terminals, start the console and local runner:

```sh
npm run dev:web
npm run dev:runner
```

The API health check is at `http://localhost:3000/health`, and the Vite console
is at `http://localhost:5173`. Enter `AGENTOS_API_TOKEN` when the console first
opens. A task is claimable when assigned to an agent and given an existing
working-directory path.

## Verify

```sh
npm run db:validate
npm run typecheck
npm run build
npm test
npm run agentos -- help
docker compose config --quiet
```
