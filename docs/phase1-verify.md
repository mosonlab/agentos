# Phase 1 manual verification

Phase 1 runs local `claude`, `codex`, or `pi` CLI processes directly on the
Mac, as decided in `DECISIONS.md`. Use a disposable test repository while
verifying because the configured commands run in their yolo modes.

## 1. Configure and start Postgres

```sh
cp .env.example .env
```

Set a long random `AGENTOS_API_TOKEN` in `.env`, then start Postgres:

```sh
docker compose up -d postgres
docker compose ps
```

## 2. Create the schema and seed the built-ins

```sh
npm install
npm run db:migrate
npm run db:seed
```

The seed is idempotent. It creates `AgentOS Example`, one local environment,
and these ten agents: `default`, `plan`, `spec`, `senior-dev`,
`review-coordinator`, `feasibility`, `scope-guardian`, `coherence`,
`implementation-plan-executioner`, and `librarian`.

## 3. Start the three processes

Use separate terminals:

```sh
npm run dev:api
npm run dev:runner
npm run dev:web
```

Confirm `http://localhost:3000/health` reports a connected database. Open
`http://localhost:5173` and enter `AGENTOS_API_TOKEN` when prompted.

Before starting the runner, confirm the CLI selected by the task's agent is
installed and logged in. Command templates live in `.env` as
`CLAUDE_COMMAND_TEMPLATE`, `CODEX_COMMAND_TEMPLATE`, and
`PI_COMMAND_TEMPLATE`; the task prompt is delivered through stdin.

## 4. Exercise the task loop

1. Create a disposable local repository or directory and copy its absolute
   path.
2. Click **New task**, enter a title and description, paste that path, and
   assign an agent. `senior-dev` exercises Codex, planning/review agents
   exercise Claude, and `librarian` exercises pi.
3. Confirm the card starts in **Todo**.
4. Within one runner poll interval, confirm it moves to **Doing**. Open the
   card and watch stdout/stderr appear in Activity (the drawer polls every two
   seconds).
5. Let the CLI exit. Exit code zero creates a destroyed session; a non-zero
   code creates a failed session and a failure activity. In both cases, the
   card moves to **Review** so the operator sees the result.
6. Drag the Review card to **Done**. Refresh the page and confirm it remains in
   Done.

To exercise lease recovery, stop the runner process forcefully while a task is
Doing, wait longer than `RUNNER_LEASE_SECONDS`, and start another runner. Its
next claim pass marks the abandoned session failed, appends an expiry activity,
returns the task to Todo, and claims it again.

## 5. Automated checks without Docker/Postgres

```sh
DATABASE_URL=postgresql://agentos:agentos@localhost:5432/agentos npm run db:validate
npm test
npm run typecheck
npm run build
```

The unit tests do not connect to Postgres: runner prompt/path behavior is
tested directly, and the Hono app uses an injected no-op Prisma value to test
public metadata and bearer enforcement. CRUD and transactional lease behavior
remain database integration checks covered by the manual flow above.
