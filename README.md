<div align="center">

# Anneal

**You write the specs. It clears the board.**

Anneal is a local control plane for coding agents. Queue tasks in the
evening, and chains plan, review, implement, verify and merge them
unattended — on the Codex and Claude subscriptions you are already
signed in to.

[![status](https://img.shields.io/badge/status-developer%20preview-orange)](#status)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-lightgrey)](#status)
[![node](https://img.shields.io/badge/node-22.17.0-brightgreen)](.nvmrc)

[Install](#quick-start) · [How it works](#how-it-works) · [Status](#status) · [简体中文](README.zh-CN.md)

<img src="docs/media/parallel-tasks.gif" alt="Multiple tasks running in parallel across the board" width="880">

</div>

## The workflow it is built for

During the day you do one thing: write specs. In the evening you queue
them as tasks on the board. Overnight, a chain picks up each task and
takes it the whole way — plan, plan review, implementation, two
independent code reviews, fix application, regression verification, and
the merge itself. In the morning you read the pull requests that matter,
open an agent window on the ones you care about, and iterate until you
are satisfied.

Between those points nothing needs you. A chain only stops for you when
an agent asks a question through the Inbox, when a step you marked as
gated needs a human decision, or when a run escalates. You are not
sitting in front of it; the board is what you come back to.

## What you get

- **Spec in, merge out.** A task card becomes a branch, a pull request
  and a merge behind the merge gate, with every intermediate artifact —
  plan, review findings, fix dispositions, regression results — recorded
  and reviewable.
- **Parallel by default.** Chains for different tasks and different
  repositories run at the same time; throughput comes from how many
  runners you register, not from your hours.
- **Your subscriptions, no keys.** Anneal launches the official Codex
  CLI, Claude Code and Pi you have already installed and signed in to.
  It holds no credential of its own, runs no proxy, and there is no key
  to paste in.
- **Review is the product.** Every step's output is the next step's
  input, and every run record stays on your machine for you to audit.

## Anneal is built with Anneal

The pull requests in this repository are specified, planned, reviewed,
implemented and merged by Anneal's own chains, running on one Mac.
Chain-delivered commits carry `Co-Authored-By: Anneal Chain` and
`X-Anneal-Run` / `X-Anneal-Step` trailers, so you can check in the git
log which commits the chains produced.

## How it works

A chain instantiates a template of steps. Each step binds an agent role
— a prompt, a model, a reasoning effort and the runner CLI it executes
on — and the flagship Full Assurance template covers delivery in twelve
steps. `Sol` and `Luna` below are the GPT-5.6 variants the Codex CLI
exposes.

<details>
<summary><b>The twelve steps in full</b> — role, runner, model and effort for each</summary>

| # | Step | Agent role | What it does | Runner | Model · effort |
| --- | --- | --- | --- | --- | --- |
| 1 | Write a spec | `spec` | Turns the task into the specification of record | Claude | Claude Opus 5 · high |
| 2 | Plan | `plan` | Cuts the spec into parallel vertical tracer-bullet slices | Claude | Claude Fable 5 · medium |
| 3 | Plan review | `review-coordinator` | Reviews every slice against the spec and the frozen base | Pi | GPT-5.6 Sol · xhigh |
| 4 | Revise plan | `plan-reviser` | Edits the slice set against the findings, in a fresh session | Codex | GPT-5.6 Sol · high |
| 5 | Implementation | `implementation-plan-executioner` | Executes the slice set from the live dependency frontier and opens the pull request | Codex | GPT-5.6 Sol · high, with GPT-5.6 Luna · max subagents |
| 6 | Code review | `review-coordinator-sol` | Reviews the integrated diff at the pinned base and head | Pi | GPT-5.6 Sol · xhigh |
| 7 | Blind code review | `review-coordinator-opus` | Reviews the same diff again, blind to step 6's findings | Claude | Claude Opus 5 · high |
| 8 | Apply review fixes | `senior-dev` | Dispositions every finding from both reviews and applies the adopted ones | Codex | GPT-5.6 Sol · high |
| 9 | Documentation | `librarian` | Updates internal documentation to match the delivered code | Pi | GPT-5.6 Luna · xhigh |
| 10 | Regression verification | `regression-verifier` | Refreshes onto the target branch and reruns the regressions | Codex | GPT-5.6 Luna · max |
| 11 | Merge readiness | — | Recomputes the head, requires every open review to clear, emits an exact-head authorization | — | mechanical, no model run |
| 12 | Merge execution | `merge-integrator` | Re-verifies every precondition against the live pull request, then merges | — | mechanical, no model run |

</details>

<div align="center">

<img src="docs/media/chain.png" alt="Task detail: the twelve-step chain with each step's role and status, above the completed run and the task prompt" width="880">

<sub>A chain in flight: step 4 running, steps 6 and 7 waiting as parallel siblings.</sub>

</div>

Steps 6 and 7 are parallel siblings: the blind review never sees the
other's output, and step 8 adjudicates both. Role bindings live in
[`agents/templates/compound-engineer-workflow/`](agents/templates/compound-engineer-workflow)
and the models in [`agents/roles/`](agents/roles). Board column
semantics are defined in the
[task-routing contract](docs/governance/task-routing-v1.md).

## Quick start

You need:

- an Apple Silicon Mac
- Node.js `22.17.0` (from `.nvmrc`) and npm 10.9.2+
- Docker Compose and Git
- the official Codex CLI signed in under the same macOS account
  (Claude Code and Pi optional)

```sh
git clone https://github.com/mosonlab/anneal.git
cd anneal
git checkout v0.4.0
npm ci
npm run setup:local
npm run build
docker compose up -d --wait --wait-timeout 60 postgres
npm run db:migrate:release -- --fresh
```

Then start `npm run dev:api`, `npm run dev:runner` and `npm run dev:web`
in three terminals, in that order, and open `http://127.0.0.1:5173`.
The full sequence with its preflights is in
[`docs/release/developer-preview.md`](docs/release/developer-preview.md).

## Status

Developer Preview 4 (v0.4.0): interfaces and stored data shapes may
change between previews, and the only upgrade path is a fresh install.
macOS on Apple Silicon only.

**Read before pointing this at anything you care about:** Anneal
launches coding CLIs with non-interactive permission bypass, as your
macOS user, outside a sandbox. Use a disposable repository and a machine
you are willing to let an agent modify. Details in
[`docs/release/security.md`](docs/release/security.md).

The provider CLIs, their authentication and their plan terms stay
between you and the provider: Anneal neither reads nor forwards their
credentials and grants no entitlement. The authoritative support
statement is
[`docs/release/support-matrix.md`](docs/release/support-matrix.md).

## Documentation

[Architecture](docs/architecture.md) ·
[Install](docs/install.md) ·
[Security](docs/release/security.md) ·
[Migration and recovery](docs/release/migration-and-recovery.md) ·
[Release notes](docs/release/v0.4.0-release-notes.md) ·
[Contributing](CONTRIBUTING.md) ·
[Support](SECURITY.md)

## Credits and license

Five skills from
[mattpocock/skills](https://github.com/mattpocock/skills) (MIT,
Copyright (c) 2026 Matt Pocock) supply working text for the chain's
prompts; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). This
snapshot is licensed under the [MIT License](LICENSE), with its boundary
defined by [`public-snapshot.json`](public-snapshot.json).
