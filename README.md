# AgentOS

AgentOS is a local, single-operator control plane for scoped agent work. The
execution kernel keeps the four-column Task board separate from durable Runs:
each Run owns its queue state, retry number, fenced lease, ephemeral workspace,
CLI snapshot, failure classification, and git branch/commit handoff.

`BLUEPRINT.md` is the upstream requirement; `DECISIONS.md` is this project's
explicit override layer. The current order is DECISIONS #10 step ②.

## Execution boundaries

- `OPERATOR_TOKEN` is for the UI/human API. Only this principal can approve a
  gated task or use normal CRUD routes.
- `RUNNER_TOKEN` can call only `/runner/*`. It is never passed to a CLI.
- A random session token is issued for one Run, exposed as
  `AGENTOS_SESSION_TOKEN`, and revoked when that Run ends or loses its lease.
- Every runner/session write also carries the current fencing token. A stale
  generation gets HTTP 409; the runner then kills the complete process group.
- Child environments are constructed from an explicit allowlist: configured
  `PATH`/`HOME`, Run identity/session credentials, and only Secrets granted to
  the selected Agent. Host `process.env` is not inherited.

Each Run clones its configured Repo beneath `RUNNER_WORKSPACE_ROOT`, checks out
the Repo target branch, creates `agentos/<task>/run-N`, and records base/head
SHA. Successful workspaces are deleted. Failed workspaces may be retained;
`RUNNER_FAILED_WORKSPACE_RETENTION` controls how many startup reconciliation
keeps. `Task.workingDirectory` remains only as a deprecated migration field and
is never used as a runtime directory.

## CLI adapter contract

Claude, Codex, and Pi implement the six-method adapter protocol:
`preflight`, `start`, `resume`, `kill`, `heartbeat`, and `classifyError`.
Startup checks all binaries, versions, and subscription login state. Runs use
Claude `stream-json`, Codex `--json`, and Pi `--mode json`; raw JSON and
normalized process/model/tool events are appended to `SessionEvent`.

A Run succeeds only when a successful provider terminal event agrees with a
clean process exit. Exit code zero alone is a protocol failure. Stall detection
has three layers: process liveness, structured progress, and a separate
in-flight tool deadline. Effective budgets default to 120 minutes walltime,
10 minutes progress stall, and 3 Runs per Task. `spendCap` is preserved with
`spendCapApplicable=false` because subscription CLIs expose no dollar meter.

## Start locally

Requirements: Node.js 20.19+, npm, Docker, Git, and the three logged-in CLIs.

```sh
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev:api
```

In separate terminals:

```sh
npm run dev:web
npm run dev:runner
```

Create at least one Repo via `POST /projects/:projectId/repos`, then grant the
selected Agent access with `POST /agents/:agentId/repos/:repoId/access` before
creating an agent Task. The console uses `OPERATOR_TOKEN`; the runner requires
the different `RUNNER_TOKEN`.

### Optional `agentrunner` account

`RUNNER_RUN_AS_PREFIX` is off by default. Before setting it to
`sudo -u agentrunner`, all of the following must already be true:

1. The `agentrunner` account exists and can write `RUNNER_WORKSPACE_ROOT`.
2. Claude, Codex, Pi, Git, and the configured PATH are usable by that account.
3. Each subscription CLI is logged in under that account and its HOME is
   writable; startup preflight must report all three backends healthy.
4. The service account has narrowly scoped, passwordless sudo permission only
   for the configured runner command prefix.

See `deploy/` for launchd templates. API startup reconciles expired Runs and
orphan workspaces before listening.

## Verify

```sh
npm run db:validate
npm run typecheck
npm run build
npm test
npm run agentos -- help
docker compose config --quiet
```
