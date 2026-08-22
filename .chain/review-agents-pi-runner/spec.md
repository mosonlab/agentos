# Feature brief: route review coordinators through the pi runner

Status: pending dispatch as a direct-engineer-workflow chain (repo agentos
cmsv8gofe0005mpj2esyr3a0e, template cmt1n48zh001impg5cup0c1zw). Decisions
below were settled in grilling with Leo 2026-08-22 (nine questions, all
closed); treat every numbered change as a constraint, not an open design
question. Suggested branchName: `review-agents-pi-runner`.

Queue note: dispatched immediately by Leo's ruling, ahead of the standing
queue (control gaps, sequencing). No file overlap expected with in-flight
chains (this touches packages/runner adapters, packages/db agent-contract and
cost, agents/roles); rebase onto current main before delivery as usual.

---

The two Codex-based review coordinators run on the pi runner instead of
`codex exec`, and every pi agent session is isolated from host-level
configuration discovery. Review work is read-verify-report: it uses none of
the Codex harness's implementation affordances, and pi's minimal system
prompt and lean tool surface cost fewer tokens per review step.

Background: AgentOS supports three runners (CLAUDE, CODEX, PI;
packages/runner/src/config.ts RunnerKind). The pi adapter already works:
model strings with a `provider/` prefix route to PI
(packages/db/src/agent-contract.ts:37 catalogRunnerForModel), preflight
rejects a PI model without a provider prefix
(packages/runner/src/adapters.ts:738), auth goes through
`pi auth check --provider openai-codex` (same ChatGPT credential Codex
uses), the `:high` effort suffix maps to `--thinking high`, and the four
AgentOS tools are registered via the pi extension
(packages/runner/assets/pi-agentos-extension.ts). What is missing: the two
review roles still declare `runner: codex`, the PI branch of `argsForRunner`
passes no isolation flags so host `~/.pi` extensions, skills, prompt
templates, themes, and on-path AGENTS.md/CLAUDE.md files leak into agent
sessions, and pricing lookup cannot resolve a provider-prefixed model name.

Changes:

1. `agents/roles/review-coordinator.md` and
   `agents/roles/review-coordinator-sol.md` frontmatter: `runner: pi`,
   `model: openai-codex/gpt-5.6-sol:high`. The matching two rows of
   `CANONICAL_AGENT_DEFAULTS` (packages/db/src/agent-contract.ts) change to
   `RunnerPreference.PI` with the same model string; both must change
   together or `assertCanonicalAgentSources` throws. No other role changes:
   review-coordinator-opus stays CLAUDE, spec and merge-resolver stay CODEX,
   the effort tier stays `high` (raising it is explicitly out of scope so
   the runner switch stays the only variable).

2. `review-coordinator-sol.md` body: remove the native-review-harness
   paragraph (the one launching two background
   `codex exec review -m gpt-5.6-sol ...` subprocesses; line 26 today). A pi
   session cannot run codex subprocesses (CODEX_HOME is only seeded for
   CODEX claims, packages/runner/src/adapters.ts:96) and Leo has ruled the
   subprocess pattern retired. Replace it with: one session, two sequential
   explicit passes over the same reviewed range - first the complete
   Standards pass (correctness, security, repository conventions, smell
   families) producing its full findings list, then a separate Spec pass
   (requirement-by-requirement tracing with quoted governing text) started
   only after the Standards pass is closed, merged into one persisted
   report. The two-axis separation exists so spec tracing is not masked by
   surface findings; preserve that intent in the prompt wording. Everything
   else in the role - review authority and range rules, evidence ladder,
   severity scheme, persistence rules, the regression verification phase -
   stays as written.

3. `packages/runner/src/adapters.ts`, PI branch of `argsForRunner`: add
   `--no-extensions --no-skills --no-prompt-templates --no-themes
   --no-context-files`. Applies to every PI session unconditionally - no
   per-role configuration. The explicit `--extension <pi-agentos-extension>`
   still loads (pi's `--no-extensions` disables discovery only, explicit
   `-e` paths keep working). `--no-context-files` is deliberate: a
   reviewer's rules live entirely in its role prompt, and repo AGENTS.md is
   part of the material under review, not instructions to the reviewer.
   This mirrors the CLAUDE branch's `--setting-sources project,local` and the
   CODEX branch's scratch CODEX_HOME.

4. `packages/db/src/cost.ts` `modelNameForPricing`: strip a `provider/`
   prefix in addition to the `:effort` suffix, so
   `openai-codex/gpt-5.6-sol:high` resolves to the existing
   `gpt-5.6-sol` price row. The price table stays keyed by bare model name -
   one row per model regardless of runner. `mechanical/merge-executor-v1`
   strips to a name with no price row and keeps returning null cost,
   unchanged behavior.

5. Tests updated alongside: the agent contract tests, adapter argv tests for
   the PI branch, and pricing tests covering the prefixed lookup. The
   dry-run assertion in packages/api/src/agent-template-dry-run.ts checks
   step 1 (spec, CODEX) and is unaffected.

Out of scope, ruled and recorded: harvesting pi's per-message token usage
(pi's terminal `agent_settled` event carries no usage, so PI sessions
persist null tokens and null cost - packages/db/src/usage.ts:140-179;
accepted for now, follow-up work item, not this chain); raising reasoning
effort; switching any implementation-side role; deployment actions.

Delivery ends at merge. Rollout is operator work in a separate window
(handoff prepared): SQL backfill of the two live Agent rows'
model/runnerPreference (sync-canonical-prompts treats those as structure
fields and refuses on mismatch), then `db:sync-canonical-prompts` for the
rewritten rolePrompt, runner rebuild/restart, and a toy chain through the
direct workflow before trusting production chains. In-flight chains keep
already-created Runs on Codex and pick up PI on steps whose Run rows are
created after the backfill; the mix is accepted.

Persist the final implementation output for this step through the AgentOS task output endpoint.
