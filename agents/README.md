# agents/ — Canonical prompts

Source-of-truth files for canonical agent prompts and initial runtime defaults, the mechanical merge sentinel, and task-template step prompts. The seed script imports these into the `Agent`, join, and `TaskTemplateStep` tables; `packages/db/prisma/seed.ts` is the consumer. Models and runners changed by the operator in the console are persisted runtime overrides and are not replaced by seed or canonical prompt sync. Skills remain an API-managed concept (`Skill` / `AgentSkill`), but no canonical skill is seeded from this directory.

All prompts here are reconstructed from BLUEPRINT.md (itself reconstructed from Danny Postma's talk); none are his verbatim files. The chain prompts with an upstream counterpart in [mattpocock/skills](https://github.com/mattpocock/skills) do carry that text verbatim, wrapped in paragraphs written here for this platform's contracts; the notice is in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

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
attachmentsFromPrevious: true
opensPullRequest: true
baseFromStepIndex: null                # null or a step in a strictly earlier layer
spawnPolicy: null                      # null or an inline JSON object
```

The `compound-engineer-workflow` directory contains exactly twelve files and
the `direct-engineer-workflow` directory exactly seven, each with contiguous
indexes. Their layer vectors are respectively
`1,2,3,4,5,6,6,7,8,9,10,11` and `1,2,2,3,4,5,6`; equal layer values are
parallel siblings and the following layer is their join. The filename prefix
must match `stepIndex`, and only these structural keys are accepted. Step
display names remain seed-owned presentation metadata; all execution structure
and prompt text live in the Markdown sources.

The operator procedure for changing a template, including its shape, is
maintained outside this repository. There is no authoring API for template
structure: the source here is the record, canonical sync's closed contract
decides what may replace what, and a change reaches production as an ordinary
pull request through the merge gate.

Exact canonical model and runner defaults live in the role frontmatter and `packages/db/src/agent-contract.ts`; task-chain routing is governed by the routing contract this repository's operator maintains outside the published tree. A task template binds roles, while each Agent owns its runtime runner, model, and reasoning effort. The canonical values are used for new or uncustomized Agents; an operator edit sets an explicit runtime override. Template steps normally leave `runner` unset so the Agent configuration remains the single runtime authority. `inboxAccess` is least-privilege: granted only where the role contract requires talking to the human (`default`, `spec`, `plan`, `plan-reviser`, `senior-dev`, `senior-dev-luna`, `implementation-plan-executioner`, `review-coordinator-opus`, `merge-resolver`).

Approval is task metadata, not an Agent personality. Roles read the current
task's `approvalGate`; they do not hard-code a pause or send a second Inbox
question to simulate one. The Full Assurance template's gate placement and
shorter-route rules live only in the routing contract.

The seed installs two templates over these roles: the twelve-step Full
Assurance chain, and the seven-step direct chain (`direct-engineer-workflow`) —
implementation by `senior-dev-luna` from the task brief, parallel Sol and blind
review siblings whose findings the fix step adjudicates itself, exact-head
regression, server-side readiness, and mechanical merge. Both step contracts live in their
Markdown directories under `templates/`.

Provider-specific or temporary roles are not canonical defaults unless the
cross-provider review contract explicitly requires separate identities. Keep
experiments out of `roles/`; create them as local overlays and archive them when
no longer needed so a seed cannot silently turn an experiment into a release
default. `senior-dev` is the risk-routing escalation for persisted-data,
defense-list, and cross-cutting work: a direct chain reassigns its
implementation step to it before dispatch.

`review-coordinator` reviews plans only. `review-coordinator-sol` performs the
first integrated-diff review. `regression-verifier` performs the bounded
post-fix semantic verification and the one exact-head gate. New templates bind
that step to `regression-verification-v2`: semantic checks run before lease
acquire, the target base is rechecked after acquire, and only the control plane
may release or steal the chain lease. Renamed v1 template rows retain the
original `regression-verification` contract for their historical tasks.
`review-coordinator-opus` performs the blind final review. The
`review-adjudicator-opus` role is archived: the fix step reads both immutable
reports and records a disposition for every finding itself, and its output
contract refuses anything less. Chains created while the adjudication node
existed keep their own template rows and Agent records as history. Existing
task rows keep the assignee captured when their chain was created, so the Sol
and Opus roles retain regression instructions for legacy chains that were
instantiated before their template bindings changed.
Legacy reviewer roles remain only as archived database history and must not be
assigned to new tasks or templates.
