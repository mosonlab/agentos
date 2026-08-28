Implement this task on revalidate-step directly from the feature brief below — a direct chain carries no spec or plan phase, so the brief is the specification of record. The platform materializes `.chain/revalidate-step/spec.md` as the specification of record; leave it untouched. The platform pins native child threads to Luna max and limits the session to eight concurrent children. Use them only when the brief contains independent, safely parallel work; group related change points instead of creating one child per item. In the controlled resource limit, fill as many slots as can execute safely in parallel. Give every concurrent writer its own branch and git worktree, and keep coupled work in your own context. When at least two child-writer branches need integration, start one long-lived merger after the first result is ready; integrate a sole child-writer branch yourself. The merger integrates completed branches in dependency-safe order, resolves only mechanical conflicts, reruns affected narrow tests, and reports semantic conflicts to you. Follow the platform-pinned Implementation proof boundary after integration. Give a failed child one bounded correction in the same thread, then take over its assignment yourself. A child must not perform irreversible external actions. Commit the result and persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication and pull-request creation to the platform. Complete when the brief's behavior is demonstrably delivered and tests are green at the recorded head.
<!-- agentos:task-brief:v1 length=4985 -->
A direct chain instantiated with afterTaskId starts with a revalidate step
that refreshes the brief's stale descriptive references against the current
tree before implementation, and pauses to ask the operator when a premise
has collapsed.

Background: a chain's brief freezes into the implementation task's
description at instantiation. The runner materializes it as
`.chain/<branch>/spec.md` when the implementation step is claimed, and both
review steps byte-verify that file against the description re-read from the
database — the database row is the authority, the file is a checked copy. A
bound chain executes long after instantiation, once its predecessor has
changed the tree, so its description goes stale; today that staleness is
patched by hand-written "tree wins" prose that the implementer interprets
alone and reviewers cannot see.

Changes:
1. New role agent `spec-revalidator`: pi runner, model
   `openai-codex/gpt-5.6-luna:xhigh`, read-only workflow — it never commits
   to the chain branch.
2. `direct-engineer-workflow` gains a revalidate step ahead of
   implementation. The step's task row is created at instantiation only
   when afterTaskId is provided; an unbound chain keeps today's 7-step
   shape and byte-identical prompts. The canonical template source spec
   (step count, layers, step names), the numbered prompt files, and the
   numeric-keyed step transition maps in the prompt-sync migration change
   in lockstep, and the sync leaves already-instantiated 7-step chains
   untouched.
3. The revalidate step reads the brief and the current tree and updates
   stale descriptive references — file, function, field, route names and
   descriptions of current behavior — in the implementation task's
   description through the task PATCH API, so the later spec.md
   materialization and both review verifications flow from the updated
   authority. Intent stays fixed: Goal, the intent of each Changes item,
   Out of scope, Constraints, and Acceptance bars are outside its write
   boundary. Grant the session the minimal authorization this PATCH needs.
4. When a Changes item's premise no longer holds (the thing it exists to
   change is gone or already delivered), the step calls inbox_ask with
   evidence and three fixed choices: cancel this chain; operator rewrites
   the brief, then continue; proceed with the step's proposed reading. The
   session resumes in place on reply and acts on the choice.
5. Revalidate failure (unreadable repository, PATCH rejection, tool error)
   fails the step loudly with the reason recorded; standard retry
   semantics apply.

6. `instantiateTemplate` parses a `Route: implementation=<agent-name>` line
   from the instantiation description and applies it as the
   implementation-step assignee override; an unknown agent name rejects the
   request with 400. This makes the brief's Route line the mechanism, not
   prose: today the platform ignores it and routing silently falls to the
   template default (observed 2026-08-28 on this very chain). Three
   implementation routes exist as agents: senior-dev-luna (default),
   senior-dev, frontend-dev.

Out of scope: the compound template; any conditional-step machinery beyond
instantiation-time inclusion; watcher or trigger registries; changes to the
review-side byte-verification logic; revalidation for already-instantiated
chains.

Constraints: an unbound instantiation is byte-identical to today's
behavior; the description update completes before the implementation claim
materializes spec.md, so spec verification passes against the updated
authority without any relaxation of the byte-check.

Acceptance:
- Instantiating without afterTaskId creates 7 tasks with today's prompts
  (snapshot); with afterTaskId creates 8 tasks, the first assigned to
  spec-revalidator.
- Fixture test: revalidate PATCHes the implementation description; the
  implementation claim materializes the updated spec.md; both review
  claims verify against it without mismatch.
- Fixture test: a premise-collapse fixture drives inbox_ask, the run
  enters WAITING_INBOX, and an operator reply resumes the session with the
  chosen decision.
- Prompt-sync migration applies on a database seeded with existing 7-step
  chains and leaves their step rows and prompts unchanged.
- Instantiating with `Route: implementation=senior-dev` in the description
  assigns the implementation step to senior-dev; an unknown route name is
  rejected with 400.
- npm run lint, typecheck, and the targeted suites pass.

Post-delivery drill (operator-run, before the one-hop binding cap in
RUNBOOK-agentos-card-intake.md is relaxed): one toy chain with pure
descriptive drift completes end-to-end after silent rewrite; one toy chain
with a collapsed premise stops in WAITING_INBOX and continues per the
reply.

Route: implementation=senior-dev - step renumbering rewrites hand-maintained numeric-keyed migration maps and crosses the template-validation / claim-time-materialization contract.
<!-- /agentos:task-brief:v1 -->
Persist the final implementation output for this step through the AgentOS task output endpoint.