# AgentOS — Product Spec & Implementation Blueprint

> **Historical source, superseded as implementation authority (2026-08-17).**
> This reconstruction remains intact as product-history and upstream-comparison
> evidence. Do not treat “Build exactly this system,” the roster below, or its
> review fan-out as current task-routing or seed instructions. Current authority
> is the latest Product Owner decision, `docs/governance/task-routing-v1.md`,
> `DECISIONS.md` #22, `agents/roles/*.md`, and
> `packages/db/prisma/agent-contract.ts`.

Reconstructed from Danny Postma's talk *How I Built My Own AgentOS on Claude's Agent SDK (So You Can Too)* (2026). This document is both a product spec for a human and an implementation prompt for an AI coding agent. Build exactly this system. Do not invent features that are not specified here.

**Role contracts and prompts in this file are reconstructed from the talk, not his verbatim files.** Mark every reconstructed prompt in code comments and docs as such.

---

## 1. Goal and non-goals

### Goal

Build a personal AgentOS: a control plane + UI on top of cloud-managed agents (Anthropic Claude Agent SDK / Claude managed agents) that lets a human set a goal or task, assign a scoped agent, and walk away. Agents run in ephemeral containers, do the work (plan, implement, review, commit), and only message the human when they are stuck or need a decision.

The system should automate the majority of coding and operational work: cron, webhooks, Kanban tasks, and open-ended goal loops. After each session the container is destroyed. The next session reinitializes cleanly.

### What he built (in scope)

- Multi-agent control plane with per-agent prompts, skills, MCPs, repos, env, and collaboration lists
- Least-privilege isolation: per-agent container, per-agent MCP/repo/network access, per-agent filesystem folder ACLs
- Ephemeral session lifecycle: pull repo → inject secrets → do work → commit → destroy container
- Persistent filesystem via Cloudflare R2 + an MCP that enforces read/write/delete server-side
- Task Kanban (`todo` / `doing` / `review` / `done`) with assign-agent, run-now, schedule, recurring, attachments, templates, approval gates, and follow-up chains
- A default "compound engineer" / feature-build template (9 steps, including human approval gates)
- Goals ("gauntlet loop"): definition of done, orchestrator that spawns the next specialist, progress log, spend/time/stuck caps
- Inbox MCP: agents message the human; human replies resume the session; multiple-choice questions; PWA + push
- Activity feed + live session viewer (watch tool calls in real time)
- Triggers: inbound webhooks spawn a scoped job
- Automations: cron jobs that spawn tasks/agents
- Runner routing: Claude managed-agents cloud vs cheap local VM (Claude `--dangerously-skip-permissions` and Grok in yolo mode); per-goal and per-agent routing
- YAML-as-code per project + CLI (`help`, push/pull sync, create project/goal/task, adjust agents, create skills)
- Encrypted secret storage (he used Google's token encryption system; name forgotten — treat as Secret Manager / Cloud KMS)
- UI to inspect/edit/download/preview files on the R2 filesystem

### What he mentioned but did not ship as a specified product (out of scope unless marked later)

- Deep-dive videos / publishing exact code of his production system
- Open-sourcing his exact agents/skills/prompts (he offered; we do not have them)
- His own future custom runner replacing Claude managed agents
- Game-project specifics (`fight-for` repo is only an example of a mounted repo)
- Exact spend numbers as product requirements (`$500/day` cloud, `$1000` uncapped goal, `$10` Hetzner VM are anecdotes, not SLOs)

### Non-goals

- A multi-tenant SaaS for other companies. This is a single-operator AgentOS.
- Giving every agent full filesystem, Gmail, GitHub, and production credentials "for convenience."
- Persistent long-lived agent containers. Sessions are throwaway.
- Inventing extra agent roles, extra template steps, or extra UI beyond what he described.
- Copying his verbatim system prompts (unknown). Reconstruct role contracts only.

---

## 2. System overview and mental model

AgentOS is a **control plane** you own, sitting on top of **Claude managed agents / Agent SDK**.

```
 Human
   │  writes spec / creates task / creates goal / replies in inbox
   ▼
┌──────────────────────────────────────────────────────────┐
│  AgentOS control plane (your app)                        │
│  UI · API · CLI · YAML sync · webhooks · cron            │
│  Kanban tasks · Goals/orchestrator · Inbox · Sessions    │
└───────────────┬──────────────────────────┬───────────────┘
                │ spawn session            │ persist
                ▼                          ▼
     Claude Agent SDK /              R2 filesystem MCP
     local runner (Hetzner)          Secrets store
                │
                ▼
     Ephemeral container
       - clone allowed repos
       - inject allowed env
       - attach allowed MCPs
       - apply network allowlist
       - run agent with skills
       - commit if allowed
       - DESTROY
```

Mental model:

1. A **Project** is the unit of YAML-as-code. It declares agents, skills, templates, MCP connections, repos.
2. An **Agent** is a named role with a foundational prompt + role prompt, a model, skills, MCPs, repos, a collaboration list, an environment, and a runner preference.
3. A **Task** is a Kanban card. One agent works it. It can be one-shot, scheduled, recurring, gated, or part of a follow-up chain.
4. A **Goal** is an open-ended loop. An orchestrator keeps spawning specialists until a human-approved Definition of Done is fully checked, or a safety rail trips.
5. A **Session** is one containerized agent run. It is born empty, initialized, executed, committed, and thrown away.
6. The **Inbox** is the only human interrupt channel. Agents do not wait on the human unless they are stuck or need a decision.
7. **Least privilege is first-class.** Access is granted per agent, enforced at MCP, network, filesystem, and repo layers. Prompt leaks must not be able to reach anything the agent was not given.

---

## 3. Architecture

### 3.1 Three layers

| Layer | Responsibility |
|---|---|
| Control plane + UI | Projects, agents, tasks, goals, inbox, triggers, automations, session records, YAML sync, ACL policy. Your code. |
| Runtime | Claude Agent SDK / Claude managed agents (cloud) **or** a cheap local runner (Hetzner VM running Claude Code with `--dangerously-skip-permissions`, and Grok in yolo mode). |
| Persistence | Cloudflare R2 (files) via a custom MCP; encrypted secrets (Google Secret Manager / Cloud KMS — he forgot the product name); app DB for domain objects. |

### 3.2 Why ephemeral containers

He started in the Claude Code terminal and realized he wanted to overload work, leave, and come back hours later. Cron and triggers require unattended runs. Each session therefore:

1. Starts a unique container.
2. Pulls the allowed repo(s).
3. Gets a scoped view of the filesystem (R2 MCP), allowed MCPs, allowed env, allowed network hosts.
4. Does the task.
5. Commits (if the agent/repo policy allows).
6. Cleans up. The container is destroyed.
7. The next session reinitializes the project cleanly. No leftover state except what was committed to git or written to R2 through the MCP.

### 3.3 Control plane vs SDK

The SDK already gives: spin up sessions, MCP connections, files API. AgentOS is **your UI and policy on top**: agent catalog, least-privilege walls, Kanban, goals/orchestrator, inbox, triggers, cron, YAML, runner routing, live session viewer.

He said he is starting to work out his own runtime pieces. Do not build a from-scratch agent runtime in MVP. Use the SDK. Local runners are an alternative execution backend with the same control-plane contract.

### 3.4 Suggested stack (assumptions — label them in code)

These are opinionated defaults so an agent can start. They are not his exact stack.

| Concern | Assumption |
|---|---|
| Language | TypeScript (Node 20+) |
| API | Hono or Fastify on a single service |
| DB | Postgres + Prisma (or Drizzle) |
| Queue / cron | A durable job runner (e.g. pg-boss or Inngest). Cron automations and scheduled tasks enqueue jobs. |
| Agent runtime (cloud) | Anthropic Claude Agent SDK / Claude managed agents |
| Agent runtime (local) | A worker on a cheap VM that can run Claude Code (`--dangerously-skip-permissions`) and Grok in yolo mode |
| Files | Cloudflare R2 + a custom MCP server that enforces ACLs |
| Secrets | Google Secret Manager (he said "Google's token encryption system" and forgot the name; Cloud KMS is the alternative). Never store raw tokens in the app DB. |
| Auth | Single-operator. One human user. Session cookie or personal access for CLI. |
| UI | React + Vite. Sidebar app. Mobile-responsive PWA for inbox + push. |
| Webhooks | Public HTTPS receiver with per-trigger secrets. |
| Push | Web Push (VAPID) for the PWA. |

Do not pretend this is his production stack. It is a buildable default that matches the capabilities he described.

---

## 4. Domain model

Implement these entities. Names can vary; the fields and relationships cannot be dropped.

### Project

A workspace that maps to a YAML AgentOS file.

- `id`, `name`, `slug`
- `yamlDocument` (canonical on disk / in git; DB is a projection)
- has many: Agents, Skills, TaskTemplates, MCPConnections, Repos, Triggers, Automations, Tasks, Goals

### Agent

- `id`, `projectId`
- `name` (e.g. `default`, `senior-dev`, `plan`, `spec`, `review-coordinator`, `feasibility`, `scope-guardian`, `coherence`, `implementation-plan-executioner`, `librarian`, `customer-support`, `diagnostic`, `linkedin-content`)
- `title`
- `model` (e.g. a Claude model for planners; Grok 4.6 for workers — routing is also a runner concern)
- `foundationalPrompt` — shared AgentOS prompt: which files/systems exist, which MCPs exist, how inbox works, how to finish a task, least-privilege rules
- `rolePrompt` — the one-job contract (see §8)
- `skillIds[]`
- `mcpConnectionIds[]`
- `repoAccess[]` — `{ repoId, mountPath, permissions: git-read | git-write }`
- `filesystemGrants[]` — `{ folderPath, canRead, canWrite, canDelete }`
- `collaborationList[]` — agent ids this agent may spawn as subtasks
- `environmentId`
- `runnerPreference` — `cloud` | `local` | `inherit`
- `inboxAccess` — boolean (some tasks need it; spec step does)
- **Least privilege default: deny.** An agent gets nothing that is not listed.

Concrete agents he named (implement these as defaults; more can be added via YAML/UI/CLI):

| Agent | One job |
|---|---|
| default | General workhorse |
| senior-dev | Implement / apply review fixes |
| plan | Turn an approved spec into a concrete implementation plan; write it to the task; finish |
| spec | Produce a detailed feature spec (used in the template; approval-gated) |
| review-coordinator | Spawn specialized reviewers; consolidate must-fix / should-fix |
| feasibility | Review a plan for feasibility |
| scope-guardian | Review a plan for scope creep |
| coherence | Review a plan for coherence |
| implementation-plan-executioner | Implement the code from the plan |
| librarian | Update the internal wiki from how the codebase actually works |
| customer-support | Handle support chats via Front MCP only |
| diagnostic | Given a bug + support chat + repo, produce a cause report |
| linkedin-content | Recurring content automation |

You may add agents through YAML. Do not hard-require every named agent for MVP, but ship `default`, `plan`, `senior-dev`, `spec`, `review-coordinator`, `feasibility`, `scope-guardian`, `coherence`, `implementation-plan-executioner`, `librarian` so the feature template runs.

### Environment

- `id`, `name`
- `networking` — `open` | `limited`
- `allowedHosts[]` — e.g. `api.front.com`. If `limited`, the container/proxy **blocks everything else at the base level**, including GitHub, even if a leaked prompt asks.
- This is independent of MCP grants. Network deny is a second wall.

### Skill

- `id`, `name`, `slug` (e.g. `plan-mode` invoked as `/plan`)
- `kind` — `prompt` | `file` (e.g. a Python script the agent can run)
- `body` or `filePath` on the R2 filesystem
- Skills are attached per agent. Plan mode is a skill.

### MCP Connection

- `id`, `name` (e.g. `github`, `front`, `agentos`, `r2-fs`, `inbox`)
- `transport` / connection config
- `credentialSecretId` — pointer into the secret store, not a raw token
- `allowedOperations` if the MCP supports scoping
- Agents reference connections by id. Example: customer-support gets Front, never Gmail, never GitHub. Plan agent gets plan-mode + AgentOS MCP, not Ahrefs, not GitHub.

Built-in MCPs you must implement:

- **AgentOS MCP** — read/write the current task, mark status (except when an approval gate forbids the agent from marking `done`), spawn a collaborator subtask, read project metadata the agent is allowed to see
- **Inbox MCP** — send a message to the human; send a multiple-choice question; read replies
- **R2 filesystem MCP** — list/read/write/delete under granted folders only
- **GitHub MCP** — only if the agent is granted that connection + repo access

External MCPs he mentioned as examples (configure, do not hardcode product logic): Front, Ahrefs, Gmail (explicitly **not** given to support), MongoDB read-only via env.

### Repo

- `id`, `name` (example: `fight-for` for a game project — example only)
- `remoteUrl`
- `mountPath` inside the container
- `credentialSecretId` (PAT or deploy key)
- `defaultBranch`

### Secret

- `id`, `name`, `providerRef` (Google Secret Manager / KMS resource name)
- `purpose` — `mcp` | `repo` | `env` | `webhook`
- Injected into a session only if the agent/environment lists them.
- Stored encrypted at rest in Google's system. App DB holds only the reference.

### Task

- `id`, `projectId`
- `name`, `description`
- `status` — `todo` | `doing` | `review` | `done`
- `assigneeType` — `agent` | `human`
- `assigneeAgentId` nullable
- `attachments[]` — FileObject ids (spec files, etc.)
- `approvalGate` — if true, **the assigned agent can never mark this task `done`**. Only the human can. The next follow-up must not start until status is `done`.
- `followUpTaskId` / `chainId` + `chainIndex` — template-generated chain
- `schedule` — `once-now` | `{ runAt }` | `{ cron, timezone }` (e.g. every Monday of the month, summarize inbox)
- `templateId` nullable
- `activity[]` — messages the agent writes into the task/inbox
- `sessionIds[]`

### TaskTemplate

- `id`, `projectId`, `name` (e.g. `compound-engineer-workflow`)
- `description` — "~3-hour fully managed feature build" (his words; actual runs were ~5–6 hours)
- `variables[]` — e.g. `branchName`
- `steps[]` — each step: name, assignee agent, prompt, approvalGate, attachmentsFromPrevious, spawnPolicy
- Instantiating a template creates a chain of Tasks. Step N+1 is blocked until step N is `done`.

### Goal

- `id`, `projectId`
- `title`, `spec` (or a generated-from-spec-sheet DoD)
- `definitionOfDone[]` — checkboxes, written by the human or generated from a spec sheet, then human-approved
- `status` — `active` | `paused` | `completed` | `stopped-spend` | `stopped-time` | `stopped-stuck`
- `spendCapUsd` nullable — **required in product UX**; he ran one overnight without a cap and hit $1000
- `maxDuration` nullable
- `stuckThreshold` — default 19 identical iterations, then orchestrator stops
- `runnerPreference` — `cloud` | `local` | `auto` ("when busy use cloud; otherwise local"; per-goal override: "this one should only run on local runners")
- `progressLog` — append-only, shared across sessions
- `sharedInbox` + shared filesystem folder
- `sessionIds[]`

### Trigger

- `id`, `projectId`
- `name` (e.g. `customer-support-inbound`, `bug-report`)
- `webhookSecretId`
- `agentId` — the scoped agent that runs
- `jobPrompt` / mapping from payload → task description
- Example: support message in → webhook → job. Agent has Front (or equivalent) only, analyzes chat, assigns a support rep or account executive. One trigger fired 600 times.
- Example: support submits a bug → diagnostic agent with **repo + support chat**, writes a report. If the human approves, start the implement → plan → plan review → fix → E2E test chain. Human only reviews and merges.

### Automation

- `id`, `projectId`
- `name` (e.g. weekly LinkedIn content, first-of-month LinkedIn content bot)
- `cron`, `timezone`
- `taskTemplateId` or inline task spec + `agentId`
- Distinct from Task.recurring: Automations are named cron entries in the sidebar. Recurring tasks are a schedule field on a Task. Implement both; they can share the same scheduler.

### InboxMessage

- `id`
- `from` — `agent` | `human`
- `agentId`, `sessionId`, `taskId`, `goalId` nullable
- `kind` — `text` | `multiple-choice` (radio buttons, like Claude's ask-user-question)
- `body`, `choices[]`, `selectedChoice`
- `status` — `open` | `answered` | `closed`
- Answering an open message **resumes the waiting session** (sends the reply back into the agent).

### Session

- `id`, `agentId`, `taskId` / `goalId`
- `runner` — `cloud` | `local`
- `status` — `starting` | `running` | `waiting-inbox` | `committing` | `destroyed` | `failed`
- `containerId` / SDK session id
- `toolCallLog[]` — for the live viewer
- `startedAt`, `endedAt`, `costUsd` if available
- `commitShas[]`

### FileObject

- `id`, `bucketKey` (R2)
- `path`, `projectId`
- `mime`, `size`
- Previewable in UI. Agents never touch R2 except through the filesystem MCP.

---

## 5. Least-privilege / isolation rules (first-class)

These are product requirements, not suggestions.

1. **Default deny.** An agent has no MCPs, no repos, no env, no filesystem write, no network, no collaboration spawn, unless listed on the agent.
2. **One container per session.** No shared writable container between agents.
3. **Customer-support bot** may have Front MCP. It must never have Gmail. It must never have GitHub / repo access. He was explicit: do not leak codebase info while doing support.
4. **Plan agent** has plan-mode skill + AgentOS MCP. It does **not** get Ahrefs or GitHub MCP.
5. **Network allowlist is a second wall.** If the environment is `limited` to `api.front.com`, the process cannot reach GitHub even if a prompt leak or a mis-attached MCP tries.
6. **Filesystem is not a mounted superuser disk.** It is an MCP. Server-side checks enforce folder ACL and verb (read / write / delete separately). An agent that "can write" still cannot delete unless `canDelete` is true. Unlimited filesystem access will wipe the disk — that is why this exists.
7. **Folder grants are per agent.** An agent may be allowed to read another agent's folder without write.
8. **Secrets are injected only for listed env/MCP/repo credentials.** Encrypted at rest. Even if the app DB is stolen, tokens stay in Google's secret system.
9. **Approval gates are not honor-system.** The API refuses `PATCH status=done` from an agent session token when `approvalGate=true`.
10. **Collaboration list is the only spawn path.** Plan agent may spawn listed helpers as subtasks. It cannot spawn an agent that is not on its list.
11. **Prompt injection / leak assumption.** Design as if the model will try to use every tool it has. If it should not be able to do a thing, do not attach the tool, and block the network path.

---

## 6. Session lifecycle

Implement this state machine exactly.

```
requested
  → provision container (cloud SDK session or local runner slot)
  → inject env from Secret store (only listed keys)
  → attach allowed MCP connections
  → apply environment network policy
  → clone each granted repo to mountPath using repo credential
  → mount R2 filesystem MCP with that agent's folder ACLs
  → inject foundational prompt + role prompt + skills
  → status=running
  → agent works (tool calls streamed to live viewer + activity feed)
  → if inbox question: status=waiting-inbox; pause; on reply, resume with answer
  → if task complete and not approval-gated: AgentOS MCP marks task done / review
  → if git-write granted and work produced: commit, record sha
  → cleanup
  → destroy container
  → status=destroyed
```

Rules:

- After destroy, nothing from the container remains except git commits and R2 writes that went through the MCP.
- The next session must clone/pull again. No "warm" dirty workspace.
- Failures still destroy the container. Persist logs and tool-call history on the Session row first.
- For goals: after destroy, the orchestrator runs (see §10) and may enqueue the next specialist session.

---

## 7. Persistent filesystem (R2 + MCP)

Because sessions are ephemeral, there is no durable container disk.

- Store blobs in Cloudflare R2.
- Expose them only through an **R2 filesystem MCP**.
- UI can list, open, edit, download, preview files (high-level file browser).
- MCP tools (minimum): `fs.list`, `fs.read`, `fs.write`, `fs.delete`, `fs.mkdir`.
- Every call is authorized server-side:

```
if !grant.canRead && op in (list, read) → deny
if !grant.canWrite && op in (write, mkdir) → deny
if !grant.canDelete && op == delete → deny
if path is outside granted folder prefix → deny
```

- Do not give the agent a raw S3/R2 SDK or a FUSE mount that bypasses the MCP.
- Per-agent home folder convention: `/agents/{agentSlug}/` plus any extra grants.
- Shared goal folder: `/goals/{goalId}/` granted read/write to agents on that goal (delete still explicit).

---

## 8. Agent definition and reconstructed role contracts

Every agent session is prompted as:

1. **Foundational AgentOS prompt** (shared)
2. **Role prompt** (per agent)
3. **Runtime inputs** — current task/goal, attachments, allowed MCP list, allowed folder list, collaboration list

### 8.1 Foundational prompt (reconstructed from the talk, not his verbatim file)

```
You are running inside AgentOS.

You have only the tools, MCPs, repos, environment variables, and filesystem
folders listed in your session manifest. If a tool is not listed, you cannot
use it and you must not try to. Do not ask for more access. Do not attempt
to reach hosts outside your network policy.

The container you are in will be destroyed at the end of this session.
Persist work by (a) committing to a granted repo if you have git-write, or
(b) writing files through the filesystem MCP. Do not assume a local disk
survives.

When you need a human decision or you are stuck, use the Inbox MCP.
Do not message the human for routine progress. They are not watching.
Write notable progress to the task activity log.

Your job is the role prompt below. Do that job, then finish. Use the
AgentOS MCP to update the task. If this task has an approval gate, you
must NOT mark it done — leave it in review and inbox the human.

You may spawn a collaborator only if they appear on your collaboration list.
Spawn them as a subtask with a tight brief.

Least privilege is a safety rule, not a suggestion.
```

### 8.2 Role prompts (reconstructed)

**plan**

```
You are a plan agent. You have one job: turn an approved specification
into a concrete, ordered implementation plan. Write the plan onto the
task (and as a file attachment). Then finish the task. You do not
implement. You do not open unrelated tools.
```

**spec**

```
You are a spec agent. Produce a detailed specification for the requested
feature. Attach the spec file. Refine it if the human replies. You cannot
mark this task done — it is approval-gated. Inbox the human when the spec
is ready for review.
```

**senior-dev**

```
You are a senior developer. Implement the assigned work, or apply review
fixes, in the granted repo. Follow the plan if one is attached. Commit
when done. Run available tests. Inbox the human only if you are blocked.
```

**implementation-plan-executioner**

```
You implement the code according to the attached implementation plan.
Do not re-litigate the plan. Commit. Leave notes in activity.
```

**review-coordinator**

```
You are a review coordinator. Spawn the listed review specialists
(feasibility, scope-guardian, coherence for plans; the code-review
specialists for implementation). Each writes a report. You consolidate
into must-fix and should-fix. Attach the consolidated report. Do not
implement fixes yourself.
```

**feasibility** / **scope-guardian** / **coherence**

```
You review the attached plan only through your lens
(feasibility / scope / coherence). Write a report. Finish.
```

**librarian**

```
You update the internal wiki (filesystem folder you are granted) to
reflect how the codebase actually works after this change. Do not
change product code.
```

**customer-support**

```
You handle inbound customer support. You have the support MCP (e.g. Front)
only. Analyze the conversation. Assign the correct human rep or account
executive. You do not have Gmail. You do not have GitHub. You must not
exfiltrate or request codebase information.
```

**diagnostic**

```
You diagnose a bug. You have the repo and the customer-support chat.
Produce a cause report. Do not implement until a human approves and a
follow-up implementation chain is started.
```

**linkedin-content**

```
You produce the scheduled LinkedIn content. Use only the MCPs and folders
you were granted. Inbox if you need a human approval before posting, if
posting is even in your tool list.
```

**default**

```
You are the default AgentOS agent. Do the assigned task with the tools
you have. Finish or inbox if stuck.
```

Orchestrator is **not** a user-facing chat agent. It is control-plane code that runs after each goal session (see §10). It may call a model to choose the next specialist; that call still uses a tight reconstructed prompt:

```
You are the AgentOS goal orchestrator. Read the progress log, the
definition of done, and the last session summary. Choose the next
specialist agent from the allowed list (or declare the goal complete
if every DoD checkbox is satisfied, or stop if stuck/spend/time rails
trip). Output a structured decision. Do not do the specialist's work.
```

---

## 9. Tasks — Kanban, gates, chains, schedule

### 9.1 Board

Columns: **todo → doing → review → done**.

A task is "to do, doing, review, done." Per subject of the task, an agent starts working on it.

### 9.2 Create-task form

- name
- description
- attachments
- assign an agent (e.g. senior-dev)
- run: immediately | schedule a datetime | recurring (cron; example: every Monday of the month, summarize inbox)
- optional: start from a template

### 9.3 Approval gates

A step can be marked `approvalGate: true`. Then:

- Agent work can move the card to `review`.
- AgentOS MCP / API reject any agent attempt to set `done`.
- Human must manually put it on `done`.
- Follow-up tasks stay blocked until that happens.

Used for: spec approval, and the final human PR/deploy review.

### 9.4 Follow-up chains

A template is a chain of follow-up tasks. Each step names an agent and a prompt. Completing step N (status `done`) enqueues step N+1 (`todo` → runner picks it up).

### 9.5 Activity

Agents write details into the task activity / inbox. The UI shows this next to the card.

---

## 10. Default template: compound-engineer / feature workflow

Ship this as the built-in template `compound-engineer-workflow`. He described it as a ~3-hour fully managed feature build; a concrete run was spawned 15:00, done 21:00 (~5–6 hours), PR ready the next day. 99% of the time it works because **E2E testing is implemented inside the workflow**. Include an E2E step in implementation and in the post-bugfix chain.

Template variables: at least `branchName` (and whatever the feature title/spec needs).

| # | Step | Assignee | Approval gate | Notes |
|---|---|---|---|---|
| 1 | Write a spec | `spec` | **yes** | Agent produces a detailed spec, attaches the spec file, may refine via inbox. Human reads, approves, marks `done`. Next step cannot start before that. |
| 2 | Plan | `plan` | no (but tells human to review via inbox/activity) | One job: spec → concrete ordered plan. Writes details in activity/inbox. |
| 3 | Plan review | `review-coordinator` | no | Coordinator spawns **four** review agents: he named feasibility, scope-guardian, coherence — implement those three plus a fourth plan-review specialist (`plan-risk` or a second coherence/feasibility pass; he said "four different review agents" and named three). Each writes a report. Coordinator consolidates **must-fix / should-fix**. |
| 4 | Revise plan | `plan` | no | Gets the plan from step 2 and the review from step 3; adjusts. |
| 5 | Implementation | `implementation-plan-executioner` | no | Implements the code. E2E tests run as part of this work. |
| 6 | Code review | `review-coordinator` | no | Reviews the code; how it should be fixed. Consolidated must-fix / should-fix. |
| 7 | Apply review fixes | `senior-dev` | no | Applies the review fixes. |
| 8 | Librarian | `librarian` | no | Updates the internal wiki based on how the codebase works. |
| 9 | Human review of deployment / PR | `human` | **yes** | Human checks out the PR, reviews, merges. |

After a **bug-report trigger** that the human approved, the chain is: implement → plan → plan review → fix → E2E test, then human reviews and merges. Reuse the same agents; do not invent a second product.

---

## 11. Goals / gauntlet loop

For unstructured, open-ended work (he also called this the gauntlet loop).

Daily workflow he described: write a spec in the morning, throw it into the goal system, it writes a Definition of Done, he approves the DoD, it runs 5–6 hours, end of day he gets a PR, reviews, merges.

### Loop

1. Human creates a Goal with a spec (or a task-like brief).
2. System (or a planning call) drafts `definitionOfDone[]` checkboxes from the spec sheet if the human did not write them.
3. Human approves the DoD. Do not start the loop without that approval.
4. Orchestrator picks the first specialist (senior-dev, plan, etc.) and spawns a session.
5. Session runs the lifecycle in §6. Shared inbox + shared filesystem + append-only progress log.
6. **At the end of every session**, the orchestrator:
   - reads progress logs
   - reads definitions of done
   - reads what was implemented
   - marks DoD checkboxes that are satisfied
   - if all checkboxes satisfied → Goal `completed`
   - else if safety rail trips → stop
   - else spawn the next specialist
7. Repeat until done or stopped.

### Safety rails (must implement)

| Rail | Behavior |
|---|---|
| Spend cap | Stop spawning when estimated/actual spend ≥ cap. UX should make a cap hard to forget. |
| Maximum time | Stop when wall-clock since start ≥ maxDuration. |
| Stuck detection | If the same iteration happens 19 times (same specialist + same unresolved DoD + no meaningful progress-log delta), orchestrator stops. |

A goal without a spend cap is allowed only if the human explicitly confirms. Default to requiring a cap.

### Shared state

- Progress log (append-only, visible in UI)
- Shared inbox thread for the goal
- Shared R2 folder

---

## 12. Inbox MCP + PWA

Inbox is an MCP agents call. It is also a UI surface.

Capabilities:

- Send a text message to the human
- Send a multiple-choice question with radio buttons (same idea as Claude's ask-user-question)
- Human replies in the UI; the reply is sent back into the waiting session and the session resumes
- Chat / communicate across multiple turns
- Agents message **only when stuck or they need a decision** — not for chatter

PWA:

- Mobile-responsive
- Installable
- Web push when something is done or needs help

Do not build a second messaging product. Inbox is the interrupt channel for tasks, goals, and triggers.

---

## 13. Activity feed + live session viewer

- Global activity feed of agent actions / inbox / task transitions.
- Live session viewer: watch tools being called in real time while a session is `running`.
- Persist tool-call logs on the Session so a finished run can be replayed.

---

## 14. Triggers (webhooks)

- Each Trigger has a public URL + webhook secret.
- On valid POST: create a Task (or Goal job) assigned to the trigger's scoped agent, enqueue a session immediately.
- Agent receives a sanitized payload (do not dump raw headers/secrets into the prompt).

Examples to ship as seed config (not hardcoded business logic):

1. **Support inbound** — payload is a conversation. Agent: `customer-support`. Tools: Front (or configured support MCP) only. Output: assignment to a support rep or AE. This pattern fired 600 times for him.
2. **Bug report** — support submits a bug in the backend. Agent: `diagnostic` with repo **and** support chat. Output: cause report. Human approval then starts the fix chain with E2E.

---

## 15. Cron automations

- Named automations with cron + timezone + agent + task body or template.
- Examples: weekly LinkedIn content; first-of-the-month LinkedIn content bot.
- Scheduler creates a Task and a Session on fire.
- Recurring Tasks (§9.2) use the same scheduler.

---

## 16. Runner routing

Originally everything ran on Claude managed agents API — expensive (anecdote: ~$500/day). He added a $10 Hetzner VM running Claude with `--dangerously-skip-permissions` and Grok in yolo mode.

Routing rules to implement:

| Signal | Where it runs |
|---|---|
| Control plane `busy` (cloud queue saturated / cost policy) | prefer `local` if a local runner is healthy |
| Otherwise | `cloud` is fine |
| Goal.runnerPreference = `local` | only local runners |
| Agent.runnerPreference = `cloud` (planners) | Claude cloud |
| Agent.runnerPreference = `local` (workers) | Grok 4.6 / local Claude, fast |
| Per-goal override | wins over default |

Implement a `Runner` interface:

```
provision(session) → handle
streamToolCalls(handle) → events
injectReply(handle, inboxAnswer)
destroy(handle)
```

Two backends: `CloudClaudeRunner`, `LocalVmRunner`. Local VM is a worker process that pulls jobs; it is not the control plane.

Do not build "his own future runner" beyond this interface. He said he is starting to work out his own stuff — that is an unknown, not a spec.

---

## 17. YAML-as-code + CLI

Every project has an AgentOS YAML file that mimics the online UI: agents, skills, templates, MCP connections, repo access, prompts.

Example shape (illustrative, reconstructed):

```yaml
# agentos.yml
project: acme
agents:
  spec:
    title: Spec agent
    model: claude-opus-4
    skills: [inbox]
    mcp: [agentos, inbox, r2-fs]
    repos: []
    environment: limited-none
    runner: cloud
    prompt: |   # reconstructed — not his verbatim file
      You are a spec agent. ...
  plan:
    title: Plan agent
    model: claude-opus-4
    skills: [plan-mode]
    mcp: [agentos, inbox, r2-fs]
    repos: []
    collaboration: []
    environment: limited-none
    runner: cloud
    prompt: |
      You are a plan agent. ...
  senior-dev:
    title: Senior dev
    model: grok-4.6
    skills: []
    mcp: [agentos, inbox, r2-fs, github]
    repos:
      - id: app
        mount: /workspace/app
        permissions: git-write
    environment: open
    runner: local
    prompt: |
      You are a senior developer. ...
skills:
  plan-mode:
    kind: prompt
    body: |
      /plan — enter plan mode and produce an ordered implementation plan.
templates:
  - id: compound-engineer-workflow
    variables: [branchName]
    steps:
      - { name: Write a spec, agent: spec, approvalGate: true }
      - { name: Plan, agent: plan }
      - { name: Plan review, agent: review-coordinator }
      - { name: Revise plan, agent: plan }
      - { name: Implementation, agent: implementation-plan-executioner }
      - { name: Code review, agent: review-coordinator }
      - { name: Apply review fixes, agent: senior-dev }
      - { name: Librarian, agent: librarian }
      - { name: Human PR review, agent: human, approvalGate: true }
```

CLI (he named these):

| Command | Behavior |
|---|---|
| `agentos help` | usage |
| `agentos push` | sync local YAML → control plane |
| `agentos pull` | sync control plane → local YAML |
| `agentos project create` | create a project |
| `agentos goal create` | create a goal from details (used after local Claude brainstorming) |
| `agentos task create` | create a task; CLI knows which agents to apply from YAML/template |
| `agentos agent update` / create | adjust agents |
| `agentos skill create` | create a new skill |

Most of the time he chats with Claude locally while brainstorming. When done, he tells the CLI to create a goal or session on AgentOS with the details. The CLI creates the task/goal and applies the right agents. Templates have variables (branch name, etc.); Claude Code implements the template steps locally as a convenience, but AgentOS is the system of record once created.

Auth: CLI uses a personal token against the control-plane API.

---

## 18. Suggested UI surfaces

Single app, sidebar sections — "all the different aspects":

1. **Agents** — list (default, senior-dev, plan, …). Detail: name, title, model, foundational + role prompt, skills, MCPs, repos, filesystem grants, collaboration list, environment, runner preference.
2. **Skills** — list/create; prompt or file (e.g. Python script).
3. **Files** — R2 browser: open, edit, download, preview.
4. **MCPs** — connections, credential refs, which agents use them.
5. **Repos** — name, mount path, credential ref, how it connects to the GitHub MCP.
6. **Environment variables** — inject into sessions; values come from the secret store.
7. **Tasks** — Kanban; create form; template picker; activity on the card.
8. **Goals** — DoD checkboxes, progress log, spend/time/stuck, runner preference.
9. **Inbox** — thread, radio-button questions, reply. This view is also the PWA home.
10. **Triggers** — webhook URL, secret rotation, target agent, recent fires.
11. **Automations** — cron list.
12. **Sessions** — live viewer + history of tool calls.
13. **Activity** — global feed.

Mobile: inbox + push is the required responsive surface. The rest can be desktop-first.

---

## 19. Data model sketches

Postgres-oriented. Adjust names, not relationships.

```ts
// types — implement as Prisma/Drizzle models

type Project = {
  id: string
  name: string
  slug: string
  yaml: string
  createdAt: Date
}

type Agent = {
  id: string
  projectId: string
  name: string
  title: string
  model: string
  foundationalPrompt: string
  rolePrompt: string
  skillIds: string[]
  mcpConnectionIds: string[]
  repoAccess: { repoId: string; mountPath: string; permissions: "git-read" | "git-write" }[]
  filesystemGrants: { folderPath: string; canRead: boolean; canWrite: boolean; canDelete: boolean }[]
  collaborationList: string[]
  environmentId: string
  runnerPreference: "cloud" | "local" | "inherit"
  inboxAccess: boolean
}

type Environment = {
  id: string
  projectId: string
  name: string
  networking: "open" | "limited"
  allowedHosts: string[]
}

type Skill = {
  id: string
  projectId: string
  name: string
  slug: string
  kind: "prompt" | "file"
  body?: string
  filePath?: string
}

type McpConnection = {
  id: string
  projectId: string
  name: string
  config: unknown
  credentialSecretId?: string
}

type Repo = {
  id: string
  projectId: string
  name: string
  remoteUrl: string
  mountPath: string
  credentialSecretId: string
  defaultBranch: string
}

type SecretRef = {
  id: string
  projectId: string
  name: string
  providerRef: string
  purpose: "mcp" | "repo" | "env" | "webhook"
}

type Task = {
  id: string
  projectId: string
  name: string
  description: string
  status: "todo" | "doing" | "review" | "done"
  assigneeType: "agent" | "human"
  assigneeAgentId?: string
  attachmentIds: string[]
  approvalGate: boolean
  chainId?: string
  chainIndex?: number
  scheduleKind: "now" | "at" | "cron"
  runAt?: Date
  cron?: string
  timezone?: string
  templateId?: string
}

type TaskTemplate = {
  id: string
  projectId: string
  name: string
  description: string
  variables: string[]
  steps: TemplateStep[]
}

type TemplateStep = {
  name: string
  agentName: string // "human" for the final PR step
  prompt: string
  approvalGate: boolean
}

type Goal = {
  id: string
  projectId: string
  title: string
  spec: string
  definitionOfDone: { id: string; text: string; done: boolean }[]
  dodApproved: boolean
  status: "active" | "paused" | "completed" | "stopped-spend" | "stopped-time" | "stopped-stuck"
  spendCapUsd?: number
  spendUsd: number
  maxDurationMinutes?: number
  stuckThreshold: number // default 19
  runnerPreference: "cloud" | "local" | "auto"
  progressLog: string
}

type Trigger = {
  id: string
  projectId: string
  name: string
  webhookSecretId: string
  agentId: string
  jobPrompt: string
}

type Automation = {
  id: string
  projectId: string
  name: string
  cron: string
  timezone: string
  agentId: string
  taskTemplateId?: string
  taskBody?: string
}

type InboxMessage = {
  id: string
  from: "agent" | "human"
  agentId?: string
  sessionId?: string
  taskId?: string
  goalId?: string
  kind: "text" | "multiple-choice"
  body: string
  choices?: { id: string; label: string }[]
  selectedChoiceId?: string
  status: "open" | "answered" | "closed"
}

type Session = {
  id: string
  agentId: string
  taskId?: string
  goalId?: string
  runner: "cloud" | "local"
  status: "starting" | "running" | "waiting-inbox" | "committing" | "destroyed" | "failed"
  runtimeHandle?: string
  toolCallLog: unknown[]
  startedAt: Date
  endedAt?: Date
  costUsd?: number
  commitShas: string[]
}

type FileObject = {
  id: string
  projectId: string
  path: string
  bucketKey: string
  mime: string
  size: number
}
```

---

## 20. API sketch

Single-operator API. Session-cookie for the UI; bearer token for the CLI and runners.

```
POST   /projects
GET    /projects/:id
PUT    /projects/:id/yaml          # push
GET    /projects/:id/yaml          # pull

GET    /projects/:id/agents
PUT    /projects/:id/agents/:name
GET    /projects/:id/skills
POST   /projects/:id/skills

GET    /projects/:id/files?path=
GET    /projects/:id/files/content?path=
PUT    /projects/:id/files/content
DELETE /projects/:id/files/content  # UI only if operator; agents use MCP

POST   /projects/:id/tasks
PATCH  /projects/:id/tasks/:id      # human may set done on gated tasks
POST   /projects/:id/tasks/:id/run
POST   /projects/:id/templates/:id/instantiate

POST   /projects/:id/goals
POST   /projects/:id/goals/:id/approve-dod
POST   /projects/:id/goals/:id/pause

GET    /inbox
POST   /inbox/:id/reply             # resumes session

GET    /sessions
GET    /sessions/:id                # includes toolCallLog; SSE at /sessions/:id/live

POST   /hooks/:triggerId            # public, HMAC/secret
GET    /projects/:id/triggers
GET    /projects/:id/automations

# Runner / MCP internal (not public)
POST   /internal/sessions/:id/tool-events
POST   /internal/sessions/:id/cost
```

AgentOS MCP maps to the same task/goal/spawn endpoints but is authorized with a **session-scoped token** that is limited to that agent’s ACL. Approval-gate `done` is rejected for that token.

Inbox MCP: `inbox.send`, `inbox.ask` (choices required), `inbox.read`.

Filesystem MCP: see §7.

---

## 21. Implementation phases (ship in this order)

Do not start phase N+1 until phase N acceptance tests pass.

### Phase 0 — Skeleton

- TS service, Postgres, single-user auth, empty React shell with the sidebar routes (can 404).
- `agentos help` stub CLI.

### Phase 1 — MVP (one agent, one task, one session)

- Project + Agent + Task CRUD.
- Cloud runner via Claude Agent SDK: create session, attach a hardcoded AgentOS MCP + Inbox MCP, run, destroy.
- Kanban UI: create task, assign default agent, run now, watch status go todo → doing → done.
- Session record with basic tool-call log.
- Foundational + default role prompt (reconstructed).
- **Done when:** you can create a task, an agent session starts, the agent updates the task through the MCP, the container/session is destroyed, the card is `done`.

### Phase 2 — Isolation

- Environment network policy (`open` | `limited` + allowlist) enforced at the runner proxy.
- Per-agent MCP / repo / env grants.
- R2 + filesystem MCP with server-side read/write/delete ACLs and per-agent folders.
- Secret refs via Google Secret Manager (or Cloud KMS). Inject at session start only.
- UI file browser (open/edit/download/preview).
- **Done when:** a support-style agent with only a fake Front MCP cannot call GitHub or read another agent's folder; a plan agent cannot use a GitHub connection that exists on the project but is not granted to it; delete is denied without `canDelete`.

### Phase 3 — Templates + gates + chains

- TaskTemplate + instantiate.
- Approval gates enforced in API + MCP.
- Follow-up chain scheduler.
- Seed `compound-engineer-workflow` with all 9 steps and the four plan-review specialists.
- Schedule-at and recurring cron on tasks.
- **Done when:** instantiating the feature template creates 9 cards; step 2 does not start until a human marks step 1 `done`; an agent token cannot mark step 1 `done`.

### Phase 4 — Goals

- Goal + DoD generate/approve + progress log.
- Orchestrator after every session.
- Spend cap, max time, stuck-at-19.
- Per-goal runner preference.
- **Done when:** a small goal with a 2-item DoD completes by spawning at least two specialist sessions; a goal with stuckThreshold=2 stops after two no-progress iterations; a spend cap of $0.00 refuses to spawn.

### Phase 5 — Triggers + automations

- Webhook receiver + secret.
- Seed support-inbound and bug-report trigger shapes.
- Bug-report approval → fix chain (implement → plan → plan review → fix → E2E).
- Named cron automations (LinkedIn examples as fixtures).
- **Done when:** a signed webhook creates a task and session for the scoped agent; a cron entry fires once in a test clock.

### Phase 6 — CLI / YAML

- `agentos.yml` schema matching UI.
- `push` / `pull` / `project create` / `goal create` / `task create` / agent update / `skill create`.
- **Done when:** a YAML file pushed from CLI produces the same agents+template you can see in the UI, and `pull` is a no-op after `push`.

### Phase 7 — PWA + live viewer polish

- Inbox as installable PWA, web push on "needs help" and "done".
- Multiple-choice radio questions.
- Live session viewer (SSE/websocket of tool calls).
- Activity feed.
- Local runner worker + routing (planners cloud, workers local/Grok).
- **Done when:** an agent `inbox.ask` shows radio buttons on a phone-sized viewport; answering resumes the session; a planner session is routed cloud and a worker session can be forced local.

---

## 22. Acceptance tests / done-when

Automated tests an implementing agent must add:

1. **Session destroy:** after a successful run, no runner handle remains; a second task reclones the repo rather than reusing a dirty workspace.
2. **ACL filesystem:** write without `canWrite` fails; delete without `canDelete` fails; path escape (`../`) fails.
3. **ACL MCP:** agent without GitHub connection cannot invoke GitHub tools even if the project has one.
4. **Network wall:** limited environment to `api.front.com` cannot open `github.com`.
5. **Approval gate:** agent session token `PATCH done` → 403; human token → 200; follow-up still `todo` until then.
6. **Template chain:** 9 tasks, order respected, variables (branchName) interpolated into prompts.
7. **Inbox resume:** `waiting-inbox` + reply → session continues with the answer in context.
8. **Multiple-choice:** message with `choices` renders and stores `selectedChoiceId`.
9. **Goal rails:** spend / time / 19-iteration stuck all set `stopped-*` and do not spawn.
10. **DoD approval:** goal will not spawn before `dodApproved`.
11. **Webhook auth:** bad secret → 401; good secret → task+session.
12. **YAML round-trip:** push then pull is identity (modulo whitespace).
13. **Least-privilege support agent:** fixture agent with Front only; test asserts GitHub, Gmail, and repo clone are absent from the session manifest.
14. **Orchestrator spawn list:** cannot spawn an agent not on the collaboration / project allow list.

Manual / demo script (human):

- Morning: write a spec, create a goal, approve DoD, leave.
- Evening: PR exists or inbox asked a real question.
- Trigger: POST a fake support payload, see an assignment note.
- Phone: receive a push, answer a radio question.

---

## 23. Unknowns / deferred (do not fake these)

| Item | Status |
|---|---|
| His exact foundational and role prompt files | Unknown. Use reconstructed contracts in §8 and label them. |
| Exact Google secret product name | He forgot. Use Secret Manager; Cloud KMS is acceptable if you need envelope encryption. |
| His own future custom runner | Mentioned as in progress. Not specified. Use SDK + local VM interface only. |
| Exact fourth plan-review agent name | He said four reviewers and named feasibility, scope-guardian, coherence. Add a fourth `plan-risk` specialist with a reconstructed "risk / missing-test" lens, and label it reconstructed. |
| Exact E2E harness | "E2E testing is implemented inside the workflow" — require the implementation step (and bugfix chain) to run the repo's existing E2E if present; do not invent a product-wide test framework. |
| Front / Ahrefs / Gmail / MongoDB | Examples of MCP/env grants. Integrate as configurable connections, not hardcoded vendors in the core. |
| `fight-for` game repo | Example mount only. |
| Cost figures ($500/day, $1000 night, $10 VM) | Anecdotes that motivate runner routing and spend caps, not SLOs. |
| Open-sourced agents/skills/prompts | Offered, not provided. Do not block on them. |
| Deep-dive / code-walk videos | Future content, not a spec. |
| Multi-user / teams / billing | Not described. Single operator. |
| Exact CLI binary name beyond `agentos` | Use `agentos`. |
| Exact YAML filename | He said "an AgentOS file." Use `agentos.yml` at project root. |

---

## 24. Build rules for the implementing agent

- Implement in the phase order in §21.
- Least privilege is not a phase-2 nice-to-have you skip; Phase 1 may hardcode grants, Phase 2 must enforce them.
- Do not add Slack, email-the-user, or extra chat products. Inbox is the human channel.
- Do not persist a container to "save time."
- Do not give agents raw cloud credentials.
- Do not copy this document's transcript-of-origin story into the product UI.
- Every reconstructed prompt file must start with a comment: `Reconstructed from Danny Postma's AgentOS talk — not his verbatim prompt.`
- If a choice is not specified here, pick the simplest thing that preserves isolation and the session lifecycle.

---

## 25. One-page operator story (for the README)

You define agents (plan, senior-dev, …) with only the tools they need. You file a task or a goal. AgentOS starts a throwaway container, clones the allowed repo, injects allowed secrets, and lets that agent work. When it needs you, you get an inbox push. When it is done, the container is gone and a commit or a PR is left behind. Recurring jobs and webhooks use the same path. A feature template runs spec (you approve) → plan → multi-agent plan review → revise → implement with E2E → code review → fixes → wiki → you merge. A goal loop keeps dispatching specialists until the definition of done is checked, or spend/time/stuck rails stop it.
