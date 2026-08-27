<div align="center">

# AgentOS

**A local control plane for coding agents.**

Assign scoped tasks to Codex CLI and Claude Code, then keep every run
observable, reviewable and durable.

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

It orchestrates the official Codex CLI and Claude Code that you have already
installed and signed in to. It bundles or resells no subscription, and provider
terms and plan limits apply.

<div align="center">

<img src="docs/media/chain.png" alt="Chain view: a twelve-step assurance workflow with assigned agent roles" width="880">

<sub>A task chain: each step carries its own role, prompt and review gate.</sub>

<img src="docs/media/agents.png" alt="Agents view: each agent's role, model, reasoning effort and runner" width="880">

<sub>Agents: a role, a prompt, a model and effort, and the runner it goes to.</sub>

</div>

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
macOS account. Claude Code and the experimental Pi adapter are optional.

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
| Pi | Experimental |
| macOS on Apple Silicon | Target platform |
| Linux | Unverified |
| Windows | Unsupported |

Every label above means recorded evidence in this repository, not a promise by a
CLI provider. The evidence boundaries are in [`docs/status.md`](docs/status.md)
and the authoritative matrix in
[`docs/release/support-matrix.md`](docs/release/support-matrix.md).

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
