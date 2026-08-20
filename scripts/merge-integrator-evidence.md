# Merge Integrator v1.1 — evidence procedure

How to produce the Merge Integrator v1.1 acceptance evidence, and what each
artifact is and is not allowed to claim.

Two scripts, two purposes:

| Script | Plan step | What it establishes |
|---|---|---|
| `scripts/merge-integrator-real-checks.mjs` | Step 9 | The `[real]` **negative** directions — the platform's own rejections and this deployment's own process boundary |
| `scripts/merge-integrator-system-test.mjs` | Step 10 | The one **positive** end-to-end demonstration, which is what AC1 is accepted on |

Neither substitutes for the other, and neither substitutes for the component
suites (`npm run test -w @agentos/merge-executor`, `npm run test:db -w
@agentos/api`). The component suites prove behaviour against fakes; these two
prove that the fakes were faithful.

## The rule these scripts are built around

**An unrun check is never recorded as a passed one.** Every prerequisite that is
absent produces a named failure, never a skip and never a simulated result. If
`gh` is missing, N17(b) fails; if the scratch repository has no required status
check, N3 fails; if the executor cannot be started as its own OS user, phase 5
fails. This is deliberate and it is the whole value of the artifacts: an
evidence file that records what could not be established is worth reading, and
one that quietly downgrades to a fake is worth less than nothing.

There is a second verdict, `not implemented`, and it means something stricter
than a failure: **no code in these scripts could ever establish that direction**,
whatever the environment. It exists so a report cannot be read as "waiting for
infrastructure" when the truth is "unwritten". Two directions carry it — N23
live and the system test's Feishu channel — and both are listed as such below.
Anything with this verdict counts as not passed; the exit code does not
distinguish it from a failure.

## Prerequisites an operator must provide

These are outside the implementation chain that authorized the scripts. They are
provisioning and service operations, and the plan's scope note puts them with
the operator, not with the implementation:

1. **A dedicated scratch repository.** Not `mosonlab/agentos` — both scripts
   refuse it by name. It needs a default branch with **branch protection and at
   least one required status check** (N3 has nothing to demonstrate without
   one), and **auto-merge enabled** (N21 has nothing to disarm without it).
2. **A scratch credential in a file**, mode 0600, owned by the uid running the
   harness. The same custody rule as the real one, for the same reason.
3. **A read-only schema-gate token** (`GITHUB_SCHEMA_GATE_TOKEN`). The §D-P6
   gate runs first and no merge direction runs after it fails.
4. For Step 10 only: **a non-production AgentOS deployment** with the twelve-step
   template seeded, and **the merge executor installed under its own OS user**.
   `http://localhost:3000` is refused by name.

## Step 9 — the `[real]` directions

```sh
npm run build -w @agentos/merge-executor        # the harness drives the real decision table

export MERGE_EVIDENCE_SCRATCH_REPO=<owner>/<scratch-repo>
export MERGE_EVIDENCE_TOKEN_FILE=<path-to-mode-0600-credential-file>
export MERGE_EVIDENCE_BASE_REF=main
export GITHUB_SCHEMA_GATE_TOKEN=<read-only token>
# N17(b) needs a pull request whose required check is actually failing. Create it
# by hand: a check forced red is not the same event as a check that failed.
export MERGE_EVIDENCE_FAILING_PR=<number>

node scripts/merge-integrator-real-checks.mjs --out merge-integrator-v1-1-real-checks.md
```

Directions, and what a pass means for each:

- **§D-P6 schema gate** — every GraphQL field and enum value the executor binds
  exists in the live schema, and no bound enum has gained a value this
  implementation does not classify. Runs first; a failure stops the harness.
- **N1** — the merge is issued with the *authorized* head after the head has
  moved, and GitHub answers 409. A pass means the compare-and-swap the whole
  design rests on is the platform's, not ours. A 200 here would invalidate the
  feature, not the test.
- **N3** — a required status check that never ran for the authorized head is a
  stop. "No news" is not good news.
- **N17(b)** — with the actual provisioned credential, `gh pr merge --admin`
  against a failing required check is refused **by GitHub**. A pass requires the
  refusal to be an authorization refusal; `gh` failing for any other reason is a
  failure, because it is not evidence about the credential's bounds.
- **N21** — an armed auto-merge or queue entry is disarmed **through the
  executor's own client**, and the disarm is confirmed by a **separate read**
  through the same production parser, not by the mutation's own reply. A
  read-back that still shows an armed state is a **failure** of the direction:
  the executor stopping in that situation is correct behaviour, but this
  direction set out to demonstrate a completed disarm and did not.
- **N23 (a/b/c)** — the three startup-gate negatives: a merge credential in the
  process environment, an OS user other than the declared one, and the
  executor's own user listed as a peer. Each must refuse at startup with its
  named message. **These three need no GitHub access and can be run anywhere.**
- **N23 live — NOT IMPLEMENTED.** The full cross-principal attempt list, run as
  a real BASH-enabled agent in the supported deployment. `--with-live-agent`
  asks for it and the harness answers `not implemented`: there is no code here
  that runs it, and approximating it with a same-uid shell would demonstrate the
  opposite of the claim. Whoever provisions that deployment must also write this
  direction.

N1, N3 and N21 drive the executor's **own** `readPullRequest`, decision table
and disarm calls out of `packages/merge-executor/dist`, with the production
signatures, so what the report observes is what the daemon would observe. Build
the package first (`npm run build -w @agentos/merge-executor`) or the harness
fails with a named message.

## Step 10 — the positive demonstration

```sh
export MERGE_SYSTEM_TEST_API_URL=http://localhost:3100      # NOT :3000
export MERGE_SYSTEM_TEST_OPERATOR_TOKEN=<non-production operator token>
export MERGE_SYSTEM_TEST_PROJECT_ID=<project>
export MERGE_SYSTEM_TEST_TEMPLATE_ID=<compound-engineer-workflow>
export MERGE_SYSTEM_TEST_REPO=<owner>/<scratch-repo>
export MERGE_SYSTEM_TEST_PR_NUMBER=<a real delivered PR on the scratch repo>
export MERGE_SYSTEM_TEST_READ_TOKEN_FILE=<path-to-mode-0600-credential-file>
export MERGE_SYSTEM_TEST_CHANNEL=web                        # feishu is NOT IMPLEMENTED (below)
export MERGE_EXECUTOR_OS_USER=agentos-merge
export MERGE_EXECUTOR_IDENTITY_LOGIN=<the dedicated merge identity's login>
export MERGE_SYSTEM_TEST_EXECUTOR_COMMAND='<service-manager command for the dedicated merge user>'

node scripts/merge-integrator-system-test.mjs --out merge-integrator-v1-1-system-test.md
```

The script refuses to run as the executor's own OS user. Phase 5 is the custody
claim, and a phase 5 executed by the same uid that drove phases 1–4 demonstrates
nothing about principal separation.

**The Feishu channel is NOT IMPLEMENTED.** `MERGE_SYSTEM_TEST_CHANNEL=feishu`
returns the `not implemented` verdict and halts. Driving it means delivering a
real card-action callback to the running `@agentos/inbox` process from a Feishu
app bound to that deployment; the script will not reach into another process's
module graph and call `processFeishuEvent` directly, because the point of the
direction is that the protocol crosses a process boundary. The web channel is
implemented and does run.

Phase 1 also verifies, rather than assumes, that the chain's **step 8 has a run
carrying the pull request number**: the merge target is resolved from
`Run.pullRequestNumber`, and driving steps 1–8 through the operator API creates
no run. If step 8 was not executed by a real agent run that opened the pull
request, phase 1 fails with that message instead of demonstrating a fixture.

## What the artifacts are filed as

Both scripts write Markdown to the path you give with `--out`. Each records,
per direction or phase: a replayable redacted command, the observed refusal or
state, and the verdict. The system test additionally
records the base SHA, the head SHA, the merge commit SHA, and the full API call
trace.

Exit code is the verdict: `0` only when every direction or phase passed.
