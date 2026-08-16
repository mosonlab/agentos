# Files batch — review fixes (PR #9)

Response to two independent reviews (Sol, review-coordinator; Opus, code-reviewer), both
FAIL. This is the corrected record of what the containment work actually covers. Paste-ready
for the PR description.

## Corrections to the implementation's own claims

**"19 containment probes, all green" was misleading as a coverage claim.** Mutation testing
showed the probe wall pinned no individual layer:

| Mutation | Result before these fixes |
|---|---|
| drop the `..` escape guard (`paths.ts`) | 3 red — all in `paths.test.ts`, none in the probe wall |
| drop the absolute-path guard (`paths.ts`) | 2 red — all in `paths.test.ts`, none in the probe wall |
| drop the root-prefix containment check (`local.ts:57-59`) | **0 red — 43/43 files tests green, 66/66 API tests green** |

So `paths.ts` was genuinely pinned — by `paths.test.ts`, not by the probes — while the
store's own last-line containment assertion was pinned by nothing in the repository. Of the
three probes named in the self-report, only probe 12 was load-bearing; probes 14 and 16
stayed green when their nominal guard was deleted, because another layer masked them.
Probe 16 in particular never reached the boundary it named: its inputs were rejected earlier
by path normalization.

Fixed: the assertion is extracted as `assertContainedTarget` and pinned by probe 20
(predicate) and probe 21 (call site). Deleting it is now 2 red; weakening it to a bare
`startsWith(canonicalRoot)` is 2 red. Probe 16 is renamed to say what it actually covers.

**"Post-walk swaps require OS isolation" was recorded as a PASS.** It is a known open gap and
now reads as one. Probe 24 collects the race into the repository (opt-in,
`AGENTOS_RACE_PROBE=1`) and wins it in milliseconds:

```
probe 24: attempts=11727 flips=5314 penetrated=1 rejected=9629 benign=2097
```

The backstop that gap depends on is now checked rather than assumed: the API refuses to
start when `FILES_ROOT` overlaps `RUNNER_WORKSPACE_ROOT`, and warns while
`RUNNER_RUN_AS_PREFIX` is empty — which is the shipped default, i.e. the configuration in
which the backstop is absent.

**Hardlinks were in neither the threat model nor the probe wall.** They defeated containment
for both reads and writes, persistently, with no race to win. Now closed: reads refuse
`nlink > 1`, writes land on a private inode that is renamed over the target.

## Platform defect found during review, deliberately not fixed here

`packages/runner/src/adapters.ts:494-499` returns `BINARY_NOT_FOUND` whenever stdout or
stderr contains `ENOENT` or "No such file or directory", anywhere in the output, with
`retryable: false` and an operator action pointing at CLI installation. Any agent doing
ordinary filesystem work can be misclassified, and the real failure is hidden — this
misclassification destroyed five consecutive review sessions of this very batch.

Not changed on this branch: it is global runner behaviour, unrelated to Files, and three
other chains are in flight against it. Recorded in `docs/BACKLOG-V2.md` with the suggested
fix (restrict to spawn failure / exit 127 / structured preflight evidence).

## Decisions taken, with reasons

- **Whole-root grant sentinel**: fixed by validating the pre-trim value, not by replacing
  `""` with `wholeRoot: boolean`. The schema change would require `apps/web` (out of scope
  for the fix task, and the console is the only way an operator sets this) and would worsen
  the non-commutative three-way `schema.prisma` merge with batch 2. The sentinel itself
  remains a "one typo = everything" shape and is in the backlog.
- **`files_*` tool exposure**: stays globally discoverable, authorized server-side per
  request (403 without a matching grant). Discovering a capability by having a call fail is
  worse than seeing a tool that may be denied. The manifest now names all eight tools, which
  is the contract its own comment states.
- **Backslash paths**: the rejection is dropped rather than filtered out of `list()`. A
  backslash is an ordinary POSIX filename character in a human-managed folder, containment
  never rested on the rejection, and the drive-letter guard still covers the Windows shapes.
- **Grant aliasing**: both sides compare in the filesystem's own key (`realpath.native`
  returns the on-disk spelling), rather than folding case or Unicode by assumption. This
  needs no per-platform branch and stays correct on a case-sensitive volume.
