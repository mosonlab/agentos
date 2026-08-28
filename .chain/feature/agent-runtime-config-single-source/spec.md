# Agent runtime config: single-source canonical defaults and flag-based adoption

## Goal

Changing a canonical agent's default model or runner edits exactly one file,
and an operator can return a customized agent to canonical defaults through
the API without a deploy.

## Background

An agent's runtime model and runnerPreference truth is its Agent database
row. PATCH /agents/:agentId changes it, takes effect on the next run, and
sets runtimeConfigCustomized so canonical sync never overwrites an
operator-owned row. The canonical defaults, however, are triplicated: the
agents/roles/*.md frontmatter, the handwritten CANONICAL_AGENT_DEFAULTS
table in packages/db/src/agent-contract.ts (assertCanonicalAgentSources
forces exact equality between the two), and CANONICAL_AGENT_RUNTIME_TRANSITIONS,
whose exact from-pins gate whether sync-canonical-prompts adopts a new
default onto existing rows. Every default re-pin therefore edits two files
in three places, permanently grows the transitions map, and only lands
after a deploy. The from-pin is redundant protection: PATCH is the only
runtime mutation path and it always sets runtimeConfigCustomized, so the
flag alone identifies operator-owned rows. Separately, once a row is
customized no API path returns it to canonical ownership.

## Changes

1. Single-source canonical agent defaults in agents/roles/*.md frontmatter.
   Delete the CANONICAL_AGENT_DEFAULTS table; every consumer (seed,
   canonical sync, source assertions, tests) obtains the canonical
   model/runnerPreference through the existing role source loader. The
   model-to-runner catalog consistency assertion (catalogRunnerForModel)
   is retained and now validates the loaded role sources themselves,
   including the mechanical merge-integrator sentinel exemption.
2. Delete CANONICAL_AGENT_RUNTIME_TRANSITIONS and its from-pin gating in
   sync-canonical-prompts. The adoption rule becomes: for a canonical-role
   agent row with runtimeConfigCustomized false whose model or
   runnerPreference differs from the role source, adopt the role source
   values and clear runtimeConfigDriftNoticeFingerprint; for a customized
   row, preserve the values and keep the existing drift-notice behavior
   unchanged. One cut: no compatibility shim and no leftover exports or
   references.
3. Canonical sync reports every adoption loudly: one per-agent line naming
   the agent and the from and to values in the sync output, in addition to
   the existing counters.
4. New operator endpoint POST /agents/:agentId/reset-runtime-config:
   applies the canonical role source model and runnerPreference to the
   row immediately, clears runtimeConfigCustomized and
   runtimeConfigDriftNoticeFingerprint. Refuses agents whose name has no
   canonical role source, and archived agents. Standard runner/model
   validation applies.
5. Tests updated to the new contract: dbtest coverage for uncustomized
   drift adopted, customized drift preserved with drift notice, and the
   reset round-trip (PATCH makes the row customized; reset returns it to
   canonical values; a subsequent sync reports zero adoptions for it).

## Out of scope

- PATCH /agents/:agentId semantics (it still sets runtimeConfigCustomized
  on a model or runnerPreference change).
- Template step sync: prompt updates, assignee/base/name transitions, and
  the regression-verifier creation path in sync-canonical-prompts stay
  as they are.
- Any web UI surface for the reset action.
- Role prompt (foundational prompt, role prompt) sync behavior.
- The drift-notice fingerprint mechanism itself, beyond the clears named
  in the Changes.
- Hand-editing current production Agent rows; value changes to existing
  rows happen only through the sync adoption path or the new endpoint.

## Constraints

- Operator ownership is inviolable: a row with runtimeConfigCustomized
  true must never have its model or runnerPreference changed except via
  PATCH or the new reset endpoint.
- Fail loud: sync still throws on structural differences and on invalid
  runtime configurations exactly as today; a missing or unparsable role
  source is an error, never a silent skip or fallback.
- Fresh-install seed and canonical sync must derive defaults from the
  same loader; no second TypeScript copy of the defaults may reappear.

## Acceptance

- No references to CANONICAL_AGENT_DEFAULTS or
  CANONICAL_AGENT_RUNTIME_TRANSITIONS remain in the tree (migration
  history and changelog excepted).
- dbtest: a canonical-role row with runtimeConfigCustomized false and a
  divergent model is adopted to the role source values on sync; a row
  with runtimeConfigCustomized true and a divergent model is preserved
  and receives a drift notice.
- dbtest: reset-runtime-config returns a customized row to the role
  source values with runtimeConfigCustomized false, and a following sync
  adopts nothing for that row.
- API test: reset-runtime-config refuses an unknown agent id, an agent
  whose name has no canonical role source, and an archived agent.
- npm run lint is green; packages/db and packages/api suites including
  dbtests are green.

## Routing

senior-dev — the change migrates the canonical-sync adoption contract and
the operator-config ownership semantics across packages/db and
packages/api; the hazard class is a sync pass rewriting operator-owned
rows, a cross-module contract migration whose failure the acceptance
suite cannot fully witness.

## Authority note

Overlap swept 2026-08-28 against in-flight chains (bounded-startup
frontend perf, claim-ordering, lease-hold, hold-resume compound,
revalidate-step, token-accounting, usage-capture): no shared write
surface or invariant. Dispatched in parallel with autoStart; no
afterTaskId predecessor.
