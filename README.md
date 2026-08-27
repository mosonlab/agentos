<div align="center">

# AgentOS

**A local control plane for coding agents.**

You write the spec. A chain of agents takes it from there — plan, review,
implement, verify, merge — and every run stays observable and reviewable.

[![status](https://img.shields.io/badge/status-developer%20preview-orange)](docs/status.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-lightgrey)](docs/status.md)
[![node](https://img.shields.io/badge/node-22.17.0-brightgreen)](.nvmrc)

[Install](#quick-start) · [Docs](#documentation) · [Status](docs/status.md) · [简体中文](README.zh-CN.md)

<img src="docs/media/tasks.png" alt="AgentOS task board: a twelve-step template chain in flight, with per-run status and cost on each card" width="880">

</div>

## What it is

AgentOS connects tasks, agents, repository and file grants, isolated run
records, provider event streams, human questions, review gates and git delivery
into one workflow that runs entirely on your own machine.

It orchestrates the official Codex CLI, Claude Code and Pi that you have
already installed and signed in to, so the subscription logins those CLIs
already hold are what it runs on. AgentOS supplies no credential of its own and
resells no subscription — see
[Authentication and subscriptions](#authentication-and-subscriptions).

## What it changes

A task chain carries a whole delivery path — specification, plan, plan review,
implementation, two independent code reviews, fix application, regression
verification, merge readiness and the merge itself. Each step carries its own
role, prompt, model and reasoning effort, and each step's output becomes the
next step's input.

Once a chain starts it advances on its own. Your attention is required when an
agent asks you something through the Inbox, when a step you marked as gated
needs a human decision, or when a run escalates. Everything between those points
runs unattended, including delivery: a branch, an optional pull request, and a
merge behind the merge gate.

That is the leverage. The scarce resource stops being your hours and becomes how
many runners you have registered — chains for different tasks and different
repositories are in flight at the same time, and you are reading review output
instead of typing the implementation.

One honest limit: long-horizon autonomy is not wired yet. A Goal is stored and
edited but nothing schedules work from it, so a chain is still started by you or
by a webhook trigger, not by a standing objective. See
[Status](docs/status.md).

<div align="center">

<img src="docs/media/agents.png" alt="Agents view: each agent's role, model, reasoning effort and runner" width="880">

<sub>Agents: a role, a prompt, a model and effort, and the runner it goes to.</sub>

</div>

## The twelve-step chain

The Full Assurance template that ships with AgentOS. Every step binds a role,
and every role carries its own runner, model and reasoning effort.

| # | Step | Agent role | What it does | Runner | Model · effort |
| --- | --- | --- | --- | --- | --- |
| 1 | Write a spec | `spec` | Turns the task into the specification of record | Claude | Claude Opus 5 · high |
| 2 | Plan | `plan` | Cuts the spec into parallel vertical tracer-bullet slices | Claude | Claude Fable 5 · medium |
| 3 | Plan review | `review-coordinator` | Reviews every slice against the spec and the frozen base | Pi | GPT-5.6 Sol · xhigh |
| 4 | Revise plan | `plan-reviser` | Edits the slice set against the findings, in a fresh session | Claude | Claude Opus 5 · medium |
| 5 | Implementation | `implementation-plan-executioner` | Executes the slice set from the live dependency frontier and opens the pull request | Codex | GPT-5.6 Sol · high, with GPT-5.6 Luna · max subagents |
| 6 | Code review | `review-coordinator-sol` | Reviews the integrated diff at the pinned base and head | Pi | GPT-5.6 Sol · xhigh |
| 7 | Blind code review | `review-coordinator-opus` | Reviews the same diff again, blind to step 6's findings | Claude | Claude Opus 5 · high |
| 8 | Apply review fixes | `senior-dev` | Dispositions every finding from both reviews and applies the adopted ones | Codex | GPT-5.6 Sol · high |
| 9 | Documentation | `librarian` | Updates internal documentation to match the delivered code | Pi | GPT-5.6 Luna · xhigh |
| 10 | Regression verification | `regression-verifier` | Refreshes onto the target branch and reruns the regressions | Claude | Claude Opus 5 · medium |
| 11 | Merge readiness | — | Recomputes the head, requires every open review to clear, emits an exact-head authorization | — | mechanical, no model run |
| 12 | Merge execution | `merge-integrator` | Re-verifies every precondition against the live pull request, then merges | — | mechanical, no model run |

Steps 6 and 7 are parallel siblings: the blind review never sees the other's
output, and step 8 adjudicates both. Step 5's root session dispatches native
subagents pinned to Luna at maximum effort, at most eight concurrent.

Role bindings live in
[`agents/templates/compound-engineer-workflow/`](agents/templates/compound-engineer-workflow)
and the models in [`agents/roles/`](agents/roles). A model or effort changed in
the console is a persisted runtime override and is not replaced by a later
seed.

> **Developer Preview 3 (v0.3.0).** Interfaces, configuration and stored data
> shapes may change between preview releases, and the only upgrade path is a
> fresh install.
>
> **Host execution.** AgentOS launches coding CLIs with non-interactive
> permission bypass. By default they run as your macOS user, outside a sandbox,
> with that user's filesystem and network authority. AgentOS grants constrain
> AgentOS APIs; they are not host containment. Use a disposable repository and a
> machine you are willing to let an agent modify.

## Quick start

Targets an Apple Silicon Mac with Node.js `22.17.0` from `.nvmrc` (installation requires
Node.js satisfying `^20.19.0 || ^22.13.0 || >=24` and refuses anything else), npm 10.9.2+,
Docker Compose, Git, and the official Codex CLI already signed in under the same
macOS account. Claude Code and Pi are optional.

```sh
git clone https://github.com/mosonlab/agentos.git
cd agentos
git checkout v0.3.0
npm ci
npm run setup:local
npm run build
docker compose up -d --wait --wait-timeout 60 postgres
export GOAL5A0_MASTER_SHA=8d69ee8544196a3310b3d63caf8ce5ec9a0e023b
export GOAL5A0_CONTROL_PLANE_A_SHA=29f8dd354cb99d671c2e2e4e9e23716fd8004f3d
npm run db:migrate:release -- --fresh
```

Then start `npm run dev:api`, `npm run dev:runner` and `npm run dev:web`, in
that order, in three terminals, and open `http://127.0.0.1:5173`.

This is the short form. The literal sequence, including its filesystem, port,
runner identity and repository preflights, is in
[`docs/release/developer-preview.md`](docs/release/developer-preview.md),
with the remaining installation detail in [`docs/install.md`](docs/install.md).

## Status

| Surface | Status |
| --- | --- |
| Codex CLI | Verified |
| Claude Code | Verified / maintainer-verified auth |
| Pi | Verified |
| macOS on Apple Silicon | Target platform |
| Linux | Unverified |
| Windows | Unsupported |

Every label above means recorded evidence in this repository, not a promise by a
CLI provider. The evidence boundaries are in [`docs/status.md`](docs/status.md)
and the authoritative matrix in
[`docs/release/support-matrix.md`](docs/release/support-matrix.md).

## Authentication and subscriptions

AgentOS holds no provider credential. It launches the official CLIs you have
already installed and signed in to — Codex CLI, Claude Code and Pi — and their
authentication stays where each CLI keeps it, in that CLI's own configuration.
AgentOS neither reads it nor forwards it, and there is no AgentOS account, no
API proxy and no key to paste in.

Whatever authentication those CLIs support is therefore what AgentOS runs on: a
ChatGPT subscription login, a Claude Pro/Max login, or each CLI's own API-key
mode, exactly as you already configured it. Pi carries no account of its own
either: it authenticates through the Codex login.

You can check this instead of taking it on faith. The runner constructs the
child environment for the provider process rather than copying the host
environment wholesale
([`docs/architecture.md`](docs/architecture.md), `packages/runner/src/adapters/`),
and the release check scans this checkout for token variables, bearer headers
and `Authorization` ([`docs/release/security.md`](docs/release/security.md)).

What none of that does is settle a provider's terms on your behalf. Plan limits,
rate limits, usage allowances, and whether your plan permits this kind of
orchestration are between you and the provider. AgentOS grants no entitlement
and makes no compatibility promise for a CLI provider.

## Documentation

- [Architecture and security model](docs/architecture.md) — how the console,
  API, runner and provider CLIs fit together, and what the grants do and do not
  contain.
- [Installation notes and verification](docs/install.md) — environment file,
  migrations, merge executor, and the check sequence.
- [Security](docs/release/security.md) — read before pointing this at
  anything you care about.
- [Migration and recovery](docs/release/migration-and-recovery.md) — read
  before putting data in it.
- [Release notes](docs/release/v0.3.0-release-notes.md) · [Support](SUPPORT.md) ·
  [Contributing](CONTRIBUTING.md)

## Credits and license

An independent build inspired by Danny Postma's video *How I Built My Own
AgentOS on Claude's Agent SDK (So You Can Too)* (2026), written from scratch
from the ideas in it.

This snapshot is licensed under the [MIT License](LICENSE); the snapshot
boundary is defined by [`public-snapshot.json`](public-snapshot.json).
