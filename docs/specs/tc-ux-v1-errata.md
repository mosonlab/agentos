# TC-UX v1.0 errata — dependency-safe chains and task-scoped detail

Status: approved Product Contract, 2026-08-17

TC-UX v1.0 supersedes the ordinary out-of-order start behavior described in
`batch-2.5-tasks-visibility.md` §§4.1/4.3 and its C1/C4/S1 scenarios. The older
document remains as historical implementation context; where the two disagree,
this errata is authoritative.

## Chain execution

- Normal indexed chains are sequential. The first surviving non-DONE row is the
  only possible manual-start candidate.
- That row is startable only when it is an AGENT step in TODO or BACKLOG, is not
  archived, has a current agent/repository grant, has no active run, and still
  has run budget. TODO means **Start next step**; BACKLOG means **Recover parked
  step**.
- HUMAN, DOING, and REVIEW rows block every successor. There is no force-bypass
  action in v1.
- The API enforces the same rule transactionally. A blocked start returns 409,
  names the first unfinished predecessor, and creates no Run or activity claim.
- Automatic advancement resolves the first surviving non-DONE successor,
  including across deleted rows and legacy DONE gaps, and serializes its claim
  with manual start.

## Mutation authority

- Ordinary Task PATCH cannot change `approvalGate` on a dispatched chain row.
- Ordinary PATCH cannot mark a future chain row DONE while an earlier surviving
  row is unfinished, and cannot mark a task DONE while it has an active Run.
- Inbox decisions, automatic completion/advancement, retry, BACKLOG parking,
  unarchive, and gate replay keep their dedicated authority paths.

## Task-detail resource identity and copy

- Data, errors, loading state, validators, drafts, expansion state, pending
  actions, and action closures are scoped to the URL task id. A path change
  immediately exposes a destination loading shell with no source content or
  controls; late source responses are ignored.
- A settled 404 from the destination output endpoint means **No output
  recorded**. It never retains a previous task's artifact.
- The **Task prompt** card leads with `Step responsibility:` and keeps the common
  `Product Contract:` in a closed disclosure. It explains that the effective
  runner prompt also includes the foundational prompt, role prompt, tool
  manifest, and available prior outputs; it does not claim to display them.
- Chain rows distinguish **Viewed here** from **Current execution**, label
  progress **Completed n/m**, and present HUMAN with human rather than robot
  semantics.

## Safety

Never validate these controls against a live chain. Use scratch fixtures and the
dedicated non-public test database. TC-UX v1.0 adds no database migration,
production activation, restart, runtime-router change, or force-start override.
