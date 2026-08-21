# Templates release demo

This page is the current OSS-C release-demo authority. The canonical workflow
has twelve positions: agent steps 1-10, server-side mechanical readiness at
step 11, and the mechanical `merge-integrator` at step 12. Steps 11 and 12 run
no model, carry no human approval gate, and step 12 does not open a pull
request. Earlier human-gated planning text is historical and must not drive a
new recording.

The harness proves one serial template execution against exact AgentOS and
synthetic-target commits. It does not prove fresh installation, universal
provider compatibility, production readiness, or general template authoring.
An approved OSS-B artifact separately authorizes fresh-install wording. An
approved CP-A artifact separately authorizes the named provider path.

## Prerequisites

- Work in a clean AgentOS clone at the exact commit to record.
- Use a dedicated database schema named
  `oss_c0_templates_demo_<three run-id digits>`. Run normal migrations and
  `npm run db:seed` there before setup.
- Start the API on loopback and supply `OPERATOR_TOKEN` through the environment.
- Use a separate synthetic target repository at a pinned clean baseline. Its
  remote contains no credential.
- Keep the evidence directory outside both repositories.
- Supply JSON OSS-B and CP-A approval artifacts with `status=approved`, the same
  `agentosCommit`, `approver`, `approvedAt`, and respectively
  `scopes.freshInstall=true` and `scopes.providerPath=true`.
- Public mode additionally requires an approved `scopes.publicDemo=true`
  artifact, a human-created public GitHub repository, working `gh` auth, no
  existing demo branch, and no open pull request from that branch.

The synthetic target baseline and authorized change are fixed in the harness.
The only changed files may be `src/cli.mjs`, `test/cli.test.mjs`, and
`README.md`; the example must print `{"lines":3,"words":5}` followed by LF.

## Commands

Set the isolated database URL and operator token without writing either into a
repository:

```sh
export DATABASE_URL='postgresql://.../scratch?schema=oss_c0_templates_demo_001'
export OPERATOR_TOKEN='<operator token>'
```

Create the first immutable evidence file:

```sh
npm run demo:templates -- preflight \
  --run-id oss-c0-demo-001 \
  --mode rehearsal \
  --agentos-commit <40-hex-agentos-commit> \
  --oss-b-artifact <absolute-json-path> \
  --cp-a-artifact <absolute-json-path> \
  --evidence-dir <absolute-external-directory> \
  --api-url http://127.0.0.1:3000 \
  --target-path <absolute-synthetic-checkout> \
  --target-remote file:///<absolute-bare-remote> \
  --target-baseline <40-hex-target-commit>
```

Then use only the run identity and evidence directory; later commands reload the
commit-bound preflight record:

```sh
npm run demo:templates -- setup --run-id oss-c0-demo-001 --evidence-dir <dir>
npm run demo:templates -- instantiate --run-id oss-c0-demo-001 --evidence-dir <dir>
npm run demo:templates -- capture --run-id oss-c0-demo-001 --evidence-dir <dir>
npm run demo:templates -- verify --run-id oss-c0-demo-001 --evidence-dir <dir>
```

`setup` converges only before instantiation. It locates the seeded project and
canonical template, registers the exact target Repo, and grants `GIT_WRITE` to
every agent-backed position, including readiness and the mechanical integrator.
`instantiate` calls the ordinary API exactly once. `capture` is read-only and
stores digests rather than output bodies or event payloads. `verify` requires
positions 1-12, exact output kinds on every step, server-side mechanical
readiness at step 11, mechanical merge execution at step 12, and, in public
mode, an automatic GitHub PR with no manual fallback.
A successful rehearsal is labeled `REHEARSAL_ONLY`; it cannot be relabeled
`PASS`.

If capture is premature, preserve that failed attempt and restart with the next
unused run ID; the harness never overwrites a record. A missing or wrong output, reordered
step, stale authority, dirty commit, failed target test, existing branch, manual
PR instructions, credential-shaped value, or public-action mismatch is a hard
refusal.

## Reset and cleanup

Reset is local rehearsal cleanup only:

```sh
npm run demo:templates -- reset \
  --run-id oss-c0-demo-001 \
  --confirm-run-id oss-c0-demo-001 \
  --evidence-dir <dir>
```

It deletes only the project ID recorded by setup in the dedicated rehearsal
schema. It never drops an unqualified database, removes evidence, closes a pull
request, deletes a public branch or repository, or force-pushes. Public cleanup
belongs to Leo. Source rollback is a normal revert; it does not erase recorded
external evidence or public Git history.
