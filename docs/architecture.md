# Architecture and security model


## Runtime shape

```text
Web console
          |
          v
Control-plane API  <---->  PostgreSQL
          ^                    tasks, runs, leases,
          |                    events, grants, outputs
          |
Local runner -----> ephemeral git workspace
          |
          +----> Codex CLI / Claude Code / Pi
                         |
                         +----> Anneal session tools (MCP or Pi extension)
```

- The React/Vite web console and Hono API expose projects, agents, capabilities,
  tasks, chains, approvals, runs, sessions, and the Inbox workflow.
- PostgreSQL, accessed through Prisma, stores task state separately from durable
  Run and SessionEvent records.
- The local runner claims work with a fenced lease, clones the selected
  repository into a controlled per-run workspace, creates or resumes the run
  branch, preflights the selected CLI, and records structured provider events.
- Codex and Claude receive the Anneal session tools over a per-run stdio MCP
  server. Pi receives the corresponding task tools through an extension.
- Anneal does not ship a repository command-line interface. Operators use the
  web console and the documented service, database, and runner scripts.

## A real task workflow

1. The operator creates a project, registers a repository, defines an agent,
   and grants the repository access, Files Root access, and secrets needed by
   the current runtime. Skill, custom-MCP, and collaborator bindings can also
   be stored as control-plane configuration, but they are not currently sent to
   the runner as runtime grants.
2. The operator creates a task directly or from a task-chain template and
   selects the Codex, Claude, or Pi path.
3. The runner claims the queued Run with a lease and fencing generation, then
   provisions an ephemeral clone and a run-specific git branch.
4. Provider preflight checks the configured binary, version command, and login
   status before the agent starts.
5. The agent works in the clone, streams provider and tool events, logs notable
   progress, can ask a blocking human question through the Inbox, and persists
   its task output.
6. Anneal captures the git result and pushes the run branch. A repository-access
   row is required when the task is created and claimed, but its read/write
   level does not currently gate that push. The Run's `opensPullRequest` setting
   controls whether delivery also attempts to open a pull request. A gated task
   moves to review for a human decision; an ungated successful task can finish.

## Security defaults and limits

- Operator, runner, and per-run session principals are separate. Runner routes
  and session routes are scoped independently, and session tokens expire or are
  revoked with the Run.
- Runner-authenticated run-state writes and the session event, activity, output,
  Inbox, and completion paths are checked against the Run's fencing generation;
  stale or expired generations are rejected, and the runner terminates the
  provider process group. Files Root mutations instead require a lease-bound
  per-run session token and matching Filesystem Grant; their requests carry no
  client fencing field.
- Child processes receive an explicit environment containing configured
  `PATH`/`HOME`, Run identity, session credentials, and granted secrets; the
  runner does not copy the host environment wholesale.
- Runner proxying is opt-in through `RUNNER_HTTP_PROXY`, `RUNNER_HTTPS_PROXY`,
  and `RUNNER_NO_PROXY`. When configured, it applies to the whole
  runner-controlled network path: Claude, Codex, Pi,
  and Git/workspace provisioning and delivery commands. Conventional host proxy
  variables are ignored. A `RUNNER_RUN_AS_PREFIX` launcher must preserve the
  explicit environment; proxy URLs are not serialized into provider argv.
- Stored secrets use AES-256-GCM. Plaintext and ciphertext are excluded from the
  public API's secret representations.
- The control plane requires a repository-access row and checks Files Root
  grants. The repository access row's read/write level does not currently gate
  delivery push. Per-run credentials are written mode `0600` inside the
  throwaway workspace and excluded from git locally.
- Successful workspaces are removed. A bounded number of failed workspaces may
  be retained for recovery according to runner configuration.
- Exactly one API control plane may own a canonical workspace root. Ownership is
  acquired from the protected, API-only `CONTROL_PLANE_STATE_DIR` before Prisma
  is imported or reconciliation begins. Runner daemons remain ordinary clients,
  and any number of them may poll that one API.
- The public snapshot is closed by default and scanned for unclassified paths,
  credentials, PII, private absolute paths, and internal-only material.

Important limitation: the current provider adapters use non-interactive
permission-bypass flags. Anneal grants constrain its control-plane APIs, but
they are not by themselves an OS sandbox. With the shipped same-user default,
Filesystem Grants are an authorization and audit boundary rather than a host
filesystem containment boundary. This release candidate does not claim enforced
network isolation. Use a dedicated, minimally privileged runner account when
stronger host separation is required, and review the warning comments in
`.env.example` before enabling `RUNNER_RUN_AS_PREFIX` — that prefix separates
the *runners* from each other, and one runner's account still owns every
workspace it has ever created, so it can delete its own earlier ones. The Files
path walk also carries a known open gap against an adversary who can already
write inside the Files Root.

[`docs/release/security.md`](release/security.md) states each
of these limits and what is and is not checked; read it before pointing this at
anything you care about.

