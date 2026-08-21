# agents/ — Canonical prompts

Source-of-truth files for canonical agents, the mechanical merge sentinel, and task-template step prompts. The seed script imports these into the `Agent`, join, and `TaskTemplateStep` tables; `packages/db/prisma/seed.ts` is the consumer. Skills remain an API-managed concept (`Skill` / `AgentSkill`), but no canonical skill is seeded from this directory.

All prompts here are reconstructed from BLUEPRINT.md (itself reconstructed from Danny Postma's talk); none are his verbatim files.

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
agent: implementation-plan-executioner # Agent.name, or null for a human step
approvalGate: false
outputKind: implementation
attachmentsFromPrevious: true
opensPullRequest: true
baseFromStepIndex: null                # null or a strictly earlier stepIndex
spawnPolicy: null                      # null or an inline JSON object
```

The `compound-engineer-workflow` directory contains exactly twelve files and `direct-engineer-workflow` exactly seven, each with contiguous indexes. The filename prefix must match `stepIndex`, and only these structural keys are accepted. Step display names remain seed-owned presentation metadata; all execution structure and prompt text live in the Markdown sources.

Exact canonical model and runner defaults live in the role frontmatter and `packages/db/src/agent-contract.ts`; task-chain routing is governed by the routing contract this repository's operator maintains outside the published tree. A task template binds roles, while each Agent owns its default runner, model, and reasoning effort. Template steps normally leave `runner` unset so the Agent configuration remains the single runtime authority. `inboxAccess` is least-privilege: granted only where the role contract requires talking to the human (`default`, `spec`, `plan`, `plan-reviser`, `senior-dev`, `senior-dev-luna`, `implementation-plan-executioner`, `review-coordinator-opus`, `merge-resolver`).

Approval is task metadata, not an Agent personality. Roles read the current
task's `approvalGate`; they do not hard-code a pause or send a second Inbox
question to simulate one. The Full Assurance template's gate placement and
shorter-route rules live only in the routing contract.

The seed installs two templates over these roles: the twelve-step Full
Assurance chain, and the seven-step direct chain (`direct-engineer-workflow`) —
implementation by `senior-dev-luna` from the task brief, the same dual blind review
spine, exact-head regression, server-side readiness, and mechanical merge. Both
step contracts live in their Markdown directories under `templates/`.

Provider-specific or temporary roles are not canonical defaults unless the
cross-provider review contract explicitly requires separate identities. Keep
experiments out of `roles/`; create them as local overlays and archive them when
no longer needed so a seed cannot silently turn an experiment into a release
default.

`review-coordinator` reviews plans only. `review-coordinator-sol` performs the
first integrated-diff review. `review-coordinator-opus` performs the blind final
review, must-fix adjudication, and post-fix exact-head regression verification.
Legacy reviewer roles remain only as archived database history and must not be
assigned to new tasks or templates.
