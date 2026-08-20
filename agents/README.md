# agents/ — Agent role prompts and skills

Source-of-truth files for the canonical agents, the mechanical merge sentinel, and their skills. The seed script imports these into the `Agent` / `Skill` / `AgentSkill` tables; `packages/db/prisma/seed.ts` is the consumer.

All prompts here are reconstructed from BLUEPRINT.md (itself reconstructed from Danny Postma's talk); none are his verbatim files.

## Layout

- `foundational.md` — the shared foundational prompt. Body maps to `Agent.foundationalPrompt` for every agent.
- `roles/<name>.md` — one file per agent. Frontmatter maps to `Agent` columns and join tables; markdown body maps to `Agent.rolePrompt`.
- `skills/<slug>.md` — one file per skill. Frontmatter maps to `Skill` columns; markdown body maps to `Skill.body` (`kind: prompt`).

## Role frontmatter

```yaml
name: plan                # Agent.name (unique per project)
title: Planner            # Agent.title
model: claude-fable-5:medium # Agent.model, including its default reasoning effort
runner: claude               # Agent.runnerPreference (claude | codex | pi)
inboxAccess: true         # Agent.inboxAccess
skills: [plan-mode]       # AgentSkill rows, by skill slug
collaborators: []         # AgentCollaboration rows, by agent name
```

Exact canonical model and runner defaults live in the role frontmatter and `packages/db/src/agent-contract.ts`; task-chain routing is governed by the routing contract this repository's operator maintains outside the published tree. A task template binds roles, while each Agent owns its default runner, model, and reasoning effort. Template steps normally leave `runner` unset so the Agent configuration remains the single runtime authority. `inboxAccess` is least-privilege: granted only where the role contract requires talking to the human (`default`, `spec`, `plan`, `plan-reviser`, `senior-dev`, `implementation-plan-executioner`, `review-coordinator-opus`).

Approval is task metadata, not an Agent personality. Roles read the current
task's `approvalGate`; they do not hard-code a pause or send a second Inbox
question to simulate one. The Full Assurance template's gate placement and
shorter-route rules live only in the routing contract.

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

## Skill frontmatter

```yaml
name: Plan Mode           # Skill.name
slug: plan-mode           # Skill.slug (unique per project)
kind: prompt              # Skill.kind
```
