# Diagram sources

Each file here is the typed source for one diagram, not a rendered image. The
sources are checked in so a diagram change is reviewable as a text diff; the
HTML is generated on demand and is not tracked.

| Source | Shows |
|---|---|
| `anneal-runtime.architecture.json` | The runtime components and their trust boundaries, matching [`../architecture.md`](../architecture.md). |
| `anneal-direct-chain.workflow.json` | The direct chain's eight steps, its parallel review layer, and the server-owned merge tail, matching [`../governance/task-routing-v1.md`](../governance/task-routing-v1.md). |

The format is [Archify](https://github.com/tt-a1i/archify) IR. Archify is an
optional authoring tool: it is not a dependency of this repository, and nothing
in the build, lint, or gate path reads these files. To render one, install
Archify and run its `deliver` command against the source; its `--help` output
owns the exact arguments.

A change to the architecture or to the chain contract updates the matching
source in the same change. The source is the reviewable artifact — when the two
disagree, the prose document named in the table wins.
