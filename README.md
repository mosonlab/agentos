# AgentOS

AgentOS is a local, single-operator control plane for assigning scoped agents to
tasks and goals. This repository currently contains the Phase 0 foundation:
the domain database, API process, local runner polling loop, CLI help stub, and
an empty web console.

The implementation follows `BLUEPRINT.md`, with `DECISIONS.md` taking
precedence. In particular, runners are local Mac processes (`claude`, `codex`,
or `pi`), durable files stay on the local filesystem, and secrets are managed
in one encrypted database-backed catalog. There is no hosted runner or object
storage code path.

## Start Phase 0 locally

Requirements: Node.js 20.19 or newer, npm, and Docker.

```sh
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev:api
```

In separate terminals, start the console and the currently empty runner loop:

```sh
npm run dev:web
npm run dev:runner
```

The API health check is at `http://localhost:3000/health`, and the Vite console
is at `http://localhost:5173`.

## Verify

```sh
npm run db:validate
npm run typecheck
npm run build
npm run agentos -- help
docker compose config --quiet
```
