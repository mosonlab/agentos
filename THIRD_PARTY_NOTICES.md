# Third-party notices

AgentOS is released under the MIT License (`LICENSE`). This file records the
third-party material the release carries and the licenses that apply to it.

## What this release actually distributes

The v0.1.0 Developer Preview is a **source-only** release. It contains no
compiled artifact, no bundled JavaScript, no vendored dependency tree, and no
binary of any kind — the published file set has zero binary files in it, which
`npm run snapshot:scan` re-checks on every run.

That matters for licensing, because it means this repository does not
redistribute the packages it depends on. `npm ci` fetches them from the registry
onto your machine, resolved by `package-lock.json`, and each one arrives with its
own license text in its own `node_modules` directory. Those texts are the
authoritative ones; the table below is an index, not a substitute.

## Third-party source carried in this repository

One body of third-party code is checked in rather than installed.

**shadcn/ui** — `apps/web/src/components/ui/*.tsx` (14 files).

These components were generated into this repository by the shadcn/ui CLI, whose
configuration is `apps/web/components.json`, and have been edited here since.
shadcn/ui distributes component source to be copied into a project and owned by
it; that is its distribution model, not an accident of vendoring. The upstream
project is MIT-licensed:

```
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Every other file in the published set is first-party and covered by `LICENSE`.
`docs/release/v0.1.0-license-and-assets.md` lists each one with its digest.

## Declared dependencies and their licenses

Direct dependencies, as declared in the workspace manifests. Versions resolve
through `package-lock.json`; the license identifier is the one the package
publishes.

### Runtime

| Package | License |
| --- | --- |
| `@hono/node-server` | MIT |
| `@larksuiteoapi/node-sdk` | MIT |
| `@prisma/client` | Apache-2.0 |
| `@radix-ui/react-checkbox` | MIT |
| `@radix-ui/react-dialog` | MIT |
| `@radix-ui/react-dropdown-menu` | MIT |
| `@radix-ui/react-hover-card` | MIT |
| `@radix-ui/react-progress` | MIT |
| `@radix-ui/react-slot` | MIT |
| `@radix-ui/react-switch` | MIT |
| `@radix-ui/react-tabs` | MIT |
| `@tailwindcss/vite` | MIT |
| `@vitejs/plugin-react` | MIT |
| `class-variance-authority` | Apache-2.0 |
| `clsx` | MIT |
| `cron-parser` | MIT |
| `cronstrue` | MIT |
| `dotenv` | BSD-2-Clause |
| `fs-ext` | MIT |
| `hono` | MIT |
| `lucide-react` | ISC |
| `react` | MIT |
| `react-dom` | MIT |
| `tailwind-merge` | MIT |
| `tailwindcss` | MIT |
| `vite` | MIT |
| `zod` | MIT |

### Build, test and tooling

| Package | License |
| --- | --- |
| `@biomejs/biome` | MIT OR Apache-2.0 |
| `@types/fs-ext` | MIT |
| `@types/jsdom` | MIT |
| `@types/node` | MIT |
| `@types/react` | MIT |
| `@types/react-dom` | MIT |
| `dotenv-cli` | MIT |
| `eslint` | MIT |
| `jsdom` | MIT |
| `prisma` | Apache-2.0 |
| `tsx` | MIT |
| `typescript` | Apache-2.0 |
| `typescript-eslint` | MIT |

These are direct dependencies only. Each pulls in transitive dependencies of its
own; `package-lock.json` names every one of them with its resolved version and
integrity hash, and `npm ls --all` will print the tree from an installed
checkout. This file does not enumerate that tree, because a static copy of it in
Markdown would be stale the first time the lockfile moved and would then be worse
than no copy at all.

## What AgentOS does not bundle

AgentOS launches coding CLIs that are already installed on your machine. It does
not contain, redistribute, or relicense the Codex CLI, Claude Code, Pi, or any
provider's model, subscription, or capacity. Those remain governed by their own
terms and your own account with their vendor.
