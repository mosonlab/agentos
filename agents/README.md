# agents/ — Agent role prompts and skills

Source-of-truth files for the ten pipeline agents (DECISIONS #11) and their skills. The seed script imports these into the `Agent` / `Skill` / `AgentSkill` tables; `packages/db/prisma/seed.ts` is the consumer.

All prompts here are reconstructed from BLUEPRINT.md (itself reconstructed from Danny Postma's talk); none are his verbatim files.

## Layout

- `foundational.md` — the shared foundational prompt. Body maps to `Agent.foundationalPrompt` for every agent.
- `roles/<name>.md` — one file per agent. Frontmatter maps to `Agent` columns and join tables; markdown body maps to `Agent.rolePrompt`.
- `skills/<slug>.md` — one file per skill. Frontmatter maps to `Skill` columns; markdown body maps to `Skill.body` (`kind: prompt`).

## Role frontmatter

```yaml
name: plan                # Agent.name (unique per project)
title: Planner            # Agent.title
model: claude             # Agent.model (claude | codex | openai-codex/gpt-5.6-luna)
runner: claude            # Agent.runnerPreference (claude | codex | pi)
inboxAccess: true         # Agent.inboxAccess
skills: [plan-mode]       # AgentSkill rows, by skill slug
collaborators: []         # AgentCollaboration rows, by agent name
```

Routing follows DECISIONS #6: planning/spec/review agents run on claude, implementation agents (`senior-dev`, `implementation-plan-executioner`) on codex, `librarian` on pi with the Luna model. `inboxAccess` is least-privilege: granted only where the role's contract requires talking to the human (`default`, `spec`, `plan`, `senior-dev`, `implementation-plan-executioner`).

## Skill frontmatter

```yaml
name: Plan Mode           # Skill.name
slug: plan-mode           # Skill.slug (unique per project)
kind: prompt              # Skill.kind
```
