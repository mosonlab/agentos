# agents/ — Canonical prompts

Source-of-truth files for canonical agent prompts and initial runtime defaults, the mechanical merge sentinel, and task-template step prompts. The seed script imports these into the `Agent`, join, and `TaskTemplateStep` tables; `packages/db/prisma/seed.ts` is the consumer. Models and runners changed by the operator in the console are persisted runtime overrides and are not replaced by seed or canonical prompt sync. Skills remain an API-managed concept (`Skill` / `AgentSkill`), but no canonical skill is seeded from this directory.

The chain prompts with an upstream counterpart in [mattpocock/skills](https://github.com/mattpocock/skills) do carry that text verbatim, wrapped in paragraphs written here for this platform's contracts; the notice is in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Canonical synchronization and verification

`npm run db:sync-canonical-prompts` synchronizes the canonical sources in this
directory across every Project in one all-or-none transaction. It repairs
canonical-named active Agents and canonical template rows that a Project
already holds. Outside `agentos-example`, a partial inventory is valid: an
ordinary sync does not create absent Agents or templates. The canonical Project
still owns the complete inventory, including restoration of a missing
canonical template.

An operator may fill one other Project's missing post-A1 inventory explicitly:

```sh
npm run db:sync-canonical-prompts -- --install-full <projectId>
```

`--install-full` fills only missing canonical Agents and templates in the
addressed Project. An unknown Project id is refused before the transaction; the
addressed Project must have exactly one Environment, and an archived
same-name Agent is refused. It never resurrects or
overwrites an existing object and it creates no Repo, `AgentRepoAccess`,
`AgentSecretGrant`, or other grant. The ordinary synchronization and the
installation share the same transaction, so a refusal leaves every Project
unchanged. A second successful installation is a no-op.

To check one Project without requiring a complete canonical inventory, run:

```sh
npm run db:verify-agent-template -- --project <projectId>
```

Project-scoped verification checks exactly the canonical Agents and templates
that are present and ignores absent and noncanonical inventory. With no
`--project`, verification retains its complete `agentos-example` inventory
requirement and its special Full Assurance and Direct checks.

## Full-tail readiness — three categories

Full-tail readiness is a contract between the repository, the control plane,
and operator infrastructure. Keep these three categories separate:

### 1. Repository files (repository contract)

The target repository must carry the merge-tail files that define its checks and
worker dispatch:

- `scripts/merge-gate.sh`
- `scripts/regression-verification.sh`
- `scripts/gate-worker/gate-dispatch.sh`
- `scripts/gate-worker/lib.sh`

### 2. Control-plane prerequisites

The target Project must have an in-Project Repo. Every effective template
assignee must have an `AgentRepoAccess` row for that Repo; synchronization does
not create the Repo or grants for you.

### 3. Operator infrastructure

The operator supplies the required model CLIs for the selected roles and their
runner-host authentication, an authenticated `gh`, `GITHUB_READ_TOKEN`, an
SSH-reachable gate worker selected through `RUNNER_GATE_SERVER`, and the
private merge-executor GitHub App installed on the target repository with its
isolated executor service. Provider authentication is runner-host
infrastructure: it is not an `AgentSecretGrant`, and `AgentSecretGrant` is not
a full-tail readiness prerequisite.

## Layout

- `foundational.md` — the shared foundational prompt. Body maps to `Agent.foundationalPrompt` for every agent.
- `roles/<name>.md` — one file per agent. Frontmatter maps to `Agent` columns and join tables; markdown body maps to `Agent.rolePrompt`.
- `templates/<template-name>/<NN>-<slug>.md` — one file per canonical workflow step. Frontmatter maps to structural `TaskTemplateStep` fields; markdown body maps to `TaskTemplateStep.prompt`.

## Role frontmatter

```yaml
name: plan                # Agent.name (unique per project)
title: Planner            # Agent.title
model: claude-fable-5:medium # Agent.model, including its default reasoning effort
runner: claude               # Agent.runnerPreference (claude | codex | pi)
inboxAccess: true         # Agent.inboxAccess
collaborators: []         # AgentCollaboration rows, by agent name
```

## Template step frontmatter

```yaml
stepIndex: 5
layer: 5
agent: implementation-plan-executioner # Agent.name, or null for a human step
approvalGate: false
outputKind: implementation
priorOutputKinds: []         # Prior TaskStepOutput kinds required by this prompt
attachmentsFromPrevious: true
opensPullRequest: true
requiresCommit: true          # false when a valid Step outcome may leave HEAD unchanged
baseFromStepIndex: null                # null or a step in a strictly earlier layer
spawnPolicy: null                      # null or an inline JSON object
```

`packages/db/src/template-sources.ts` is the live authority for each
template's file count, contiguous indexes, layer vector, and accepted
structural keys; equal layer values are parallel siblings and the following
layer is their join. Step display names remain seed-owned presentation
metadata; all execution structure and prompt text live in the Markdown
sources.

The operator procedure for changing a template, including its shape, is
maintained outside this repository. There is no authoring API for template
structure: the source here is the record, canonical sync's closed contract
decides what may replace what, and a change reaches production as an ordinary
pull request through the merge gate.

Exact canonical model and runner defaults live in the role frontmatter; `packages/db/src/agent-sources.ts` is the loader consumed by the seed, canonical sync, onboarding, and contract checks. A task template binds roles, while each Agent owns its runtime runner, model, and reasoning effort: canonical values apply to new or uncustomized Agents, and an operator edit sets an explicit runtime override. Template steps normally leave `runner` unset so the Agent configuration remains the single runtime authority. `inboxAccess` is least-privilege — granted only where the role contract requires talking to the human; the role frontmatter is the live roster.

Approval is task metadata, not an Agent personality. Roles read the current
task's `approvalGate`; they do not hard-code a pause or send a second Inbox
question to simulate one. The Full Assurance template's gate placement and
shorter-route rules live only in the routing contract.

The seed installs three templates over these roles: the twelve-step Full
Assurance chain, the eight-step bound-capable direct chain
(`direct-engineer-workflow`) — revalidation for bound briefs, implementation by
`senior-dev-luna` from the task brief, parallel Sol and blind review siblings
whose findings the fix step adjudicates itself, exact-head regression,
server-side readiness, and mechanical merge — and the four-step pull-request
chain (`pr-engineer-workflow`), which runs implementation, Sol and blind
reviews, and review-fix application before ending at an open pull request with
no regression or merge step. Unbound direct instantiation omits the
revalidation row and retains the historical seven-step prompts. All three step
contracts live in their Markdown directories under `templates/`.

Provider-specific or temporary roles are not canonical defaults unless the
cross-provider review contract explicitly requires separate identities. Keep
experiments out of `roles/`; create them as local overlays and archive them
when no longer needed so a seed cannot silently turn an experiment into a
release default. Implementation-assignee escalation follows the "Work
directly" section of `AGENTS.md`.

Each review and regression role states its own duty in its role file; read
`roles/` rather than a summary here. Superseded roles and template rows —
including the archived `review-adjudicator-opus` node and renamed
`regression-verification` v1 rows — remain database history so chains
instantiated under them keep the prompts and assignees they were dispatched
with; archived roles are never assigned to new tasks or templates.
