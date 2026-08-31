# Template authoring: clone-and-edit operator API

## Problem Statement

The operator drives Anneal through the HTTP API, but the shape of a Chain is not something the operator can change there. Every Chain comes from one of two canonical templates whose structure — how many Steps, which Steps run in parallel, which role owns each Step, what each Step's prompt says, what output kind each Step produces and consumes — is fixed in the repository and reaches production only as an ordinary pull request through the Merge gate. The operator API can read a template, patch its webhook configuration, and instantiate it. Nothing else.

That costs the operator in three concrete ways.

First, work that does not fit either canonical shape has no home. A card that needs a spec, one implementation Step and a Merge gate tail, or one that needs three parallel reviews instead of two, or one that needs a documentation Step the canonical graph does not have, must either be forced through a graph that does not match it or wait for a code change to the platform.

Second, the machine-readable `Route: implementation=<agent>` line in a Direct brief is validated against a hardcoded allowlist of three Agent names. Any other in-project Agent — including one the operator created five minutes ago for exactly this card — is refused, even though the explicit `stepOverrides` mechanism already accepts any same-project, non-archived, Repo-granted Agent that satisfies the integrator and compound-implementation invariants. Two mechanisms for the same decision disagree, and the more ergonomic one is the more restrictive.

Third, an operator who does experiment with template structure today has no guard rail. The invariants that make a graph runnable — a first Step that an Agent can execute, a single-node first layer, non-decreasing layers, a base Step in a strictly lower layer, consumed output kinds that some earlier Step actually produces, no Approval gate inside a parallel layer, the bidirectional merge-integrator sentinel binding — are enforced at scattered points across instantiation and Chain activation. A structurally broken graph is discovered when a Chain deadlocks or throws at activation, not when it is authored.

## Solution

The operator can clone any task template in a project and then replace the clone's whole Step graph through the API. Two routes:

- `POST /projects/:projectId/task-templates/:templateId/clone` produces an independent copy of an existing template under a new name.
- `PUT /projects/:projectId/task-templates/:templateId/steps` replaces the clone's entire Step graph in one atomic call.

Replace is guarded by a validator with exactly two tiers. Errors block the save and name the reason with a stable code; the graph is rejected whole and nothing is written. Warnings are returned with a successful save, are never persisted, and never block anything — they tell the operator that the graph they just saved will behave in a way they may not have intended (no review Step; the same Agent implements and reviews; a pull request with no regression Step, so Merge readiness will sit at `regression-pending` by design).

Structure is immutable once used. A template that any Task references is never structurally modified — the runtime still reads output kinds, prior output kinds, base Step, and execution mode from the live template Step, so editing a used template would change or break Chains already in flight. To change a used template, clone it again and edit the clone. Canonical templates, which the repository owns and canonical prompt sync maintains, are never editable through this surface at all.

Prompts are self-contained per template: whoever edits structure edits the prompt text alongside it, in the same call. There is no prompt assembly engine, no partials, and no inheritance from the source template after the clone.

Separately, the `Route: implementation=<agent>` allowlist is deleted. The line now resolves to any Agent in the same project and is refused only by the rules that already govern `stepOverrides`: the Agent must exist, must not be archived, must hold a grant on the target Repo, and must not violate the integrator or compound-implementation bindings.

## User Stories

1. As an operator, I want to clone an existing task template, so that I can start from a known-runnable graph instead of assembling one from nothing.
2. As an operator, I want the clone to carry the source template's description unless I supply my own, so that a clone is self-describing without extra work.
3. As an operator, I want the clone to carry the source template's variables, so that instantiating the clone takes the same inputs as the original.
4. As an operator, I want the clone to carry every field of every source Step — name, assignee type, assignee Agent, output kind, prior output kinds, layer, Approval gate, opens-pull-request, base Step, attachments-from-previous, requires-commit, spawn policy, runner, and prompt text — so that the clone is a faithful copy I can instantiate immediately.
5. As an operator, I want the clone's webhook configuration to be empty, so that cloning a trigger template never silently duplicates a webhook endpoint or shares a secret.
6. As an operator, I want a clone under a name already taken in the project to be refused with a named code, so that I never have two templates competing for one name.
7. As an operator, I want a clone under a canonical or registered-legacy name to be refused with a named code, so that I cannot shadow a repository-owned template with a hand-made one.
8. As an operator, I want a clone of a template that is not in the addressed project to be refused, so that a copied-and-pasted id from another project fails loudly rather than leaking a graph across the project boundary.
9. As an operator, I want cloning to be allowed even when the source template is canonical or already in use, so that the two canonical graphs are the normal starting points for authoring.
10. As an operator, I want the clone response to return the new template with its Steps, so that I can drive the next call without a second read.
11. As an operator, I want to replace a template's whole Step graph in one call, so that add, remove, reorder and per-field edit are one operation with one outcome instead of four endpoints with four failure modes.
12. As an operator, I want the server to assign dense Step indexes from my array order, so that I never have to compute or renumber indexes myself.
13. As an operator, I want `baseFromStepIndex` in my payload to refer to positions in the array I submitted, so that reordering Steps does not require me to rewrite base references against indexes that do not exist yet.
14. As an operator, I want the replace to be atomic, so that a rejected graph leaves the template exactly as it was and a partial graph is never persisted.
15. As an operator, I want the replace response to include the resulting template, so that I can see the dense indexes the server assigned.
16. As an operator, I want the replace response to include every warning of the resulting graph rather than a delta, so that I always see the full current risk picture and never have to reconstruct it from earlier responses.
17. As an operator, I want a replace on a canonical template refused with a named code, so that a repository-owned graph cannot drift out from under canonical prompt sync.
18. As an operator, I want a replace on a template that any Task references refused with a named code, so that a Chain already running cannot have its Steps changed underneath it.
19. As an operator, I want a prompt-text-only edit to obey the same in-use rule as a structural edit, so that there is exactly one rule to remember about when a template is editable.
20. As an operator, I want the refusal to tell me to clone again, so that the recovery path from an in-use template is obvious.
21. As an operator, I want an empty Step array refused, so that I cannot leave a template that instantiates into nothing.
22. As an operator, I want a graph whose first Step is not an Agent Step refused, so that the Chain's first Step is always executable.
23. As an operator, I want a graph whose first layer holds more than one Step refused, so that an auto-started Chain cannot deadlock with siblings that were never enqueued.
24. As an operator, I want a graph whose layers are not non-decreasing by Step index refused, so that layer order and Step order can never disagree.
25. As an operator, I want a `baseFromStepIndex` that does not name an earlier Step in a strictly lower layer refused, so that a Step can never branch from a Step that has not finished.
26. As an operator, I want a consumed prior output kind that no earlier layer produces refused, so that a Step can never wait for an attachment that will never exist.
27. As an operator, I want two Steps producing the same output kind refused, so that a consumer can never be ambiguous about which Step it reads.
28. As an operator, I want a Step that declares the same prior output kind twice refused, so that a typo cannot silently double an attachment.
29. As an operator, I want an Approval gate on a Step that shares its layer with another Step refused, so that a graph cannot be saved that throws at Chain activation.
30. As an operator, I want a Step whose Agent is missing, archived, or in another project refused, so that a graph cannot be saved that no runner will ever claim.
31. As an operator, I want a violation of the merge-integrator sentinel binding — in either direction — refused, so that neither a real model Agent can take the merge-execution Step nor the sentinel can take an ordinary Step.
32. As an operator, I want each error to carry a stable code and, where the fault belongs to one Step, that Step's index, so that a model driving the API can correct the exact Step without parsing prose.
33. As an operator, I want exactly one error reported per rejected save in a deterministic order, so that repeated submissions of the same bad graph give me the same answer and I can fix faults one at a time.
34. As an operator, I want a warning when the saved graph has no review Step, so that I notice an unreviewed graph without being blocked from saving it.
35. As an operator, I want a warning when the same Agent both implements and reviews, so that I notice a self-review before I run it.
36. As an operator, I want a warning when a Step opens a pull request and the graph has no regression Step, so that I know in advance that Merge readiness will sit at `regression-pending`.
37. As an operator, I want warnings never to be stored anywhere, so that a warning cannot become stale state that later contradicts the graph.
38. As an operator, I want Repo grants checked at instantiation rather than at authoring, so that a graph can be authored before its target Repo is chosen.
39. As an operator, I want a structure replace concurrent with an instantiation of the same template to serialize, so that a Chain is never materialized from a mix of two different graphs.
40. As an operator, I want instantiation to read and validate the graph inside the same transaction that creates the Tasks, so that a Chain's Tasks and Step relations always come from one graph.
41. As an operator, I want a clone, a replace and an instantiation to work end to end, so that the activated Chain runs the structure I authored.
42. As an operator writing a Direct brief, I want `Route: implementation=` to accept any Agent in my project, so that I am not confined to three hardcoded names.
43. As an operator, I want a `Route:` line naming an Agent that does not exist refused with the existing code, so that the failure vocabulary does not grow a second dialect.
44. As an operator, I want a `Route:` line naming an archived Agent, an Agent with no grant on the target Repo, or an Agent that violates the integrator or compound-implementation invariants refused with the existing codes, so that removing the allowlist removes no safety.
45. As an operator, I want the routing governance document to stop naming an allowlist, so that the documented contract and the enforced contract agree.
46. As an operator, I want both new routes and every error and warning code documented in the operator API handbook, so that a model driving the API can discover the surface without reading the server.
47. As a platform maintainer, I want the handbook's coverage of the two new routes asserted by an automated test, so that the handbook cannot silently fall behind the routes.
48. As a platform maintainer, I want canonical templates untouchable through this surface, so that canonical prompt sync keeps its closed contract.
49. As a platform maintainer, I want a non-canonical clone to remain invisible to canonical prompt sync, so that authoring cannot perturb the sync contract in either direction.
50. As a platform maintainer, I want template shape to stay free of merge safety, so that a hand-authored graph can never merge unverified code: a graph with no mechanical tail simply records complete and is never merged, and a graph with a tail but no regression evidence stops at `regression-evidence-missing` or `missing-authorization`.

## Implementation Decisions

### Scope of the authoring surface

- Two new routes are added to the operator API, both nested under the project so the project is always part of the address: `POST /projects/:projectId/task-templates/:templateId/clone` and `PUT /projects/:projectId/task-templates/:templateId/steps`.
- There is no from-scratch creation route. Clone is the only creation path, and the two canonical templates are the practical roots of the clone tree.
- There is no per-field or per-Step mutation route. `PUT .../steps` is the single structural mutation, which is why no cascade, renumbering, or partial-update policy has to be defined.

### Clone contract

- Request body: `{ "name": string, "description"?: string }`. `name` is trimmed and non-empty; `description` when present replaces the source description, otherwise the source description is copied verbatim.
- Response: `201` with the created template including its Steps ordered by Step index, in the same projection the existing template read route returns (Steps include their assignee Agent).
- Copied: `description`, `variables`, and every Step with every Step field — `name`, `assigneeType`, `assigneeAgentId`, `prompt`, `outputKind`, `priorOutputKinds`, `layer`, `stepIndex`, `approvalGate`, `opensPullRequest`, `baseFromStepIndex`, `attachmentsFromPrevious`, `requiresCommit`, `spawnPolicy`, and `runner`.
- Cleared on the clone: every webhook field — secret, repo, payload mapping, paused-at, and replay window. Trigger fires and Tasks belong to the source and are not copied.
- The source template must belong to `:projectId`; otherwise `template_not_in_project`.
- The requested name must be free in the project (`template_name_taken`) and must not resolve through the canonical identity registry to a canonical or registered-legacy name (`template_name_reserved`).
- Clone does not run the validator. The source is by definition a graph that already exists, and the clone is byte-identical to it apart from identity and webhook configuration.
- The clone is a plain, non-canonical template: canonical prompt sync ignores it, exactly as it ignores any other name outside the canonical inventory.

### Structure replace contract

- Request body: `{ "steps": Step[] }`. Each `Step` carries the same fields as a cloned Step except `stepIndex`. The server assigns dense `stepIndex` values `1..n` from array order.
- `baseFromStepIndex` in the payload refers to positions in the submitted array (1-based), which after assignment are exactly the persisted Step indexes. This is what makes reordering a pure array operation for the caller.
- Response: `200` with `{ "template": <template with steps>, "warnings": Warning[] }`. `warnings` describes the resulting graph in full, never a delta against the previous graph.
- The whole graph is replaced in one transaction: the existing Steps are removed and the submitted Steps created in their place. Step row identities are not preserved across a replace; nothing may reference them, which the in-use refusal guarantees.
- Refusals specific to the target template, checked before the validator: `template_not_in_project` when the template is not in the addressed project; `template_canonical` when the template's name resolves through the canonical identity registry (canonical or registered-legacy); `template_in_use` when any Task references the template or one of its Steps.
- The in-use rule is uniform. A prompt-text-only submission is a replace like any other and is refused with `template_in_use` on a used template, even though the instantiated Task already carries its own copy of the composed prompt. One rule, no exceptions to remember.

### Validator

- The validator is a pure function over a normalized graph plus resolved Agent facts (`id`, `name`, `projectId`, `archivedAt`) for every assignee named in the graph. It returns either the first error or the complete warning list. Database reads belong to the caller so that the same validator runs inside the replace transaction without owning a transaction of its own.
- Errors are reported one at a time, first error wins, evaluated in this fixed order so a caller sees a deterministic answer for a given graph:

  1. `graph_empty` — the Step array is empty.
  2. `first_step_not_agent` — the first Step's assignee type is not `AGENT`.
  3. `first_layer_not_single` — the first layer contains more than one Step.
  4. `layer_order_invalid` — layers are not non-decreasing by Step index.
  5. `base_step_invalid` — a `baseFromStepIndex` does not name an earlier Step in a strictly lower layer.
  6. `prior_kind_unproduced` — a consumed prior output kind is not produced by any Step in a strictly earlier layer.
  7. `output_kind_duplicate` — two Steps declare the same output kind.
  8. `prior_kind_duplicate` — one Step declares the same prior output kind twice.
  9. `approval_gate_in_parallel_layer` — a Step carries an Approval gate while its layer holds more than one Step.
  10. `assignee_invalid` — an `AGENT` Step names no Agent, or names an Agent that is missing, archived, or in another project; or a `HUMAN` Step names an Agent.
  11. `integrator_binding_invalid` — the merge-integrator sentinel binding fails in either direction for some Step.

  Within one code, the lowest offending Step index is reported.
- The integrator check reuses the platform's existing canonical binding rule verbatim rather than restating it: a Step whose output kind resolves to the integrator role may bind only the sentinel Agent, and the sentinel Agent may bind only such a Step. Nothing about that rule is relaxed for hand-authored graphs.
- Warnings are computed on the graph that was saved and returned with the `200`. They are never stored and never affect the status:
  - `no_review_step` — no Step's output kind resolves to a review role.
  - `same_agent_implements_and_reviews` — one Agent is the assignee of both an implementation-role Step and a review-role Step.
  - `pull_request_without_regression` — some Step sets `opensPullRequest` and no Step's output kind resolves to the regression role, so Merge readiness will report `regression-pending` by design.
- Role classification for warnings uses the platform's existing output-kind to Step-role mapping. An output kind with no known role contributes to no warning; unknown output kinds remain legal, because free-form graphs are the point of this feature.
- Repo grants are not checked at authoring time. Authoring has no Repo context; instantiation keeps its existing grant check unchanged.

### Error envelope and HTTP statuses

- Authoring refusals travel as a distinct refusal type from template instantiation refusals, with its own code union, and are rendered through the existing refusal-to-response mapping so the wire shape stays consistent with the rest of the API: `{ "error": <message>, "code": <stable code> }`, plus `"stepIndex"` when the fault belongs to one Step.
- The existing refusal status union is widened to admit `422`. The status rule for this surface is: `404` for addressing (`template_not_in_project`), `409` for state and name conflicts (`template_canonical`, `template_in_use`, `template_name_taken`, `template_name_reserved`), and `422` for every validator error.
- Instantiation refusal codes and their existing `400` statuses are unchanged.

### Concurrency

- Structure replace and instantiation share one protocol: a Serializable transaction that first takes a row lock on the `TaskTemplate` row (`SELECT ... FOR UPDATE`), through a template-row lock helper added alongside the platform's other lock helpers.
- Instantiation currently reads the template graph before its transaction and re-reads only the Agent rows inside it. It is changed to re-read the full graph inside the transaction, after taking the template lock, and to run its structural validation against those re-read rows. A Chain whose Tasks came from one graph and whose Step relations point at another must be impossible.
- Replace performs its in-use count inside the same locked transaction, so an instantiation cannot commit between the count and the write.
- The two orderings are both correct and both observable: replace first, then instantiation materializes the new graph; instantiation first, then replace is refused with `template_in_use`.

### Route allowlist removal

- The hardcoded implementation-route Agent set is deleted, together with the `implementation_route_unknown_agent` refusal code and its entry in the status mapping; that code becomes unreachable and is removed rather than left behind.
- `Route: implementation=<agent>` continues to be parsed only for the Direct template and continues to be refused when it collides with an explicit `stepOverrides` entry for the same Step. Resolution now looks the name up among the project's Agents and reuses the existing override refusal vocabulary: not found, archived, missing Repo grant, integrator binding, compound implementation. The re-read-under-lock rename check is unchanged.
- `stepOverrides` behaviour is unchanged in every respect.

### Documentation

- The operator API handbook gains an entry for each new route with its path and method spelling taken from the route definitions, its required and optional JSON fields, its success status, its refusal codes with statuses, its warning codes, and a `curl` example — matching the shape of the existing entries in the Task templates section.
- The handbook's current statement that there is no create-template route is removed, since it becomes false.
- The routing governance document's paragraph on the `Route:` line is rewritten to describe resolution against the project's Agents and the refusal rules that apply, with no allowlist and no named Agent set.
- The operator API docs test is extended to assert the two new routes are documented; today it only inspects the Tasks section, so it gains a section-scoped lookup for the Task templates section.

## Testing Decisions

### What makes a good test here

A good test states an operator-visible outcome: a status code, a stable refusal code, the persisted graph, the returned warnings, or the shape of the Chain that gets activated. It never asserts which module computed the answer, what the validator's internal signature is, how many queries ran, or which Step row ids were produced. A test that would still pass after the whole authoring implementation is moved to a different module — but would fail if the operator got a different answer — is the right test.

### The seam

**One seam carries the entire feature: the HTTP application seam** — the API app built over a real PostgreSQL test database, driven with `createApp(db).request(...)` in the existing `.dbtest.ts` harness. This is the highest seam available and it already exists: it is where template instantiation, step overrides, dispatch binding and trigger behaviour are all tested today. Everything in the Acceptance list is expressible there:

- clone field fidelity, cleared webhook fields, and the three clone refusals;
- add, remove, reorder, and each editable field, verified by reading the persisted graph back through the same seam;
- each of the eleven validator error codes from a minimal failing graph, and each of the three warnings alongside a `200` with nothing persisted for it;
- `template_canonical` and `template_in_use`, including the prompt-text-only case;
- the replace/instantiate race;
- the end-to-end clone to replace to instantiate to activation path;
- the `Route:` line accepting any valid same-project Agent and refusing with the existing codes.

**No new seam is added.** A unit seam over the validator function is explicitly rejected: every one of its outcomes is reachable from the HTTP seam with a small payload, and a second seam would pin the validator's signature and duplicate the same eleven assertions one level lower.

**One existing lower seam is touched, not extended**: the module-level instantiation seam that drives `instantiateTemplate` against a stubbed Prisma client already owns tests for `Route:` parsing and for instantiation refusal codes. The allowlist removal changes what those existing tests assert; no new tests are added there, and the new behaviour's authoritative coverage stays at the HTTP seam.

**One existing non-code seam is extended**: the operator API docs test, which reads the handbook file and asserts route entries. It gains assertions for the two new routes. This is the seam the repository already uses to keep the handbook honest.

### Modules under test

Through the HTTP seam: the two new authoring routes and the validator behind them; template instantiation, for the transactional re-read and the `Route:` resolution; Chain activation, only insofar as the end-to-end test observes a Chain activated from an edited graph. Through the docs seam: the operator API handbook.

### Prior art

- `template-overrides.dbtest.ts` — the closest model: a project/environment/Agents/Repo/template fixture, a small request helper over `createApp(db).request(...)`, assertions on status plus `body.code`, and assertions that nothing was persisted on refusal (`task.count()`, `taskActivity.count()`, `run.count()` all zero). Its `archiveUnderHeldLock` and `renameUnderHeldLock` helpers — a second Prisma client that holds a row lock in an open transaction while the request under test runs — are the pattern the replace/instantiate race test follows, with the template row in place of the Agent row.
- `template-dispatch-binding.dbtest.ts` — already asserts the `Route:` line's refusal codes at the HTTP seam, including the allowlist refusal that this change removes; it is the home for the new `Route:` expectations.
- `chain.dbtest.ts` and the parallel-review dbtests — prior art for asserting the shape of an activated Chain, which the end-to-end test needs.
- `scripts/operator-api-docs.test.mjs` — prior art for its own extension: a section slice plus a per-route marker lookup, asserting required fields, refusal statuses, and the presence of a `curl` example.

### Verification

`npm run lint`, `npm run test:snapshot-scan`, the extended operator API docs test, and the full suite must be green. Local pre-gate verification stays targeted to the touched database test files per the repository's test rules; the full database suite belongs to the Merge gate.

## Out of Scope

- No web UI page and no visual editor. The web client's existing template usage (listing templates, instantiating one, patching trigger webhook configuration) is unchanged.
- No from-scratch template creation. Clone is the only creation path.
- No copy-on-write and no template versioning. A used template is immutable; the recovery path is to clone again.
- No prompt assembly engine: no partials, no inheritance, no shared prompt fragments between templates.
- No changes to Chain activation semantics, the Merge gate tail, or any downstream merge enforcement. Merge safety stays where it is; template shape is free precisely because the platform cannot merge unverified code.
- No changes to `agents/**/*.md` and no changes to canonical prompt sync behaviour.
- No runner changes.
- No template deletion surface beyond what already exists.
- No new authentication or authorization surface: both routes take the same operator bearer token as their siblings.
- No changes to `stepOverrides`.

## Further Notes

- **Why immutability rather than copy-on-write.** A Task stores `templateId` and `templateStepId`, and the runtime still reads its prior output kinds, output kind, base Step and mechanical execution mode from the live template Step at claim and activation time — the composed prompt is the only thing snapshotted into the Task. There is no per-instantiation snapshot to fall back on, and building one is a much larger change than this feature needs. Refusing to edit a used template is the smallest rule that makes structural edits safe.
- **Why template shape can be free.** The platform cannot merge unverified code regardless of graph shape. A Chain with no mechanical tail simply records complete and is never merged. A Chain with a tail but no regression Step reaches Merge readiness and reports `regression-pending`, surfacing as `regression-evidence-missing`; the merge executor independently stops with `missing-authorization`. That is why `pull_request_without_regression` is a warning and not an error.
- **Assumption — error envelope field naming.** The brief specifies the validator error body as `{ code, message, stepIndex? }`. The API's house envelope is `{ error: <message>, code, ... }`, already used for the existing `422` refusal on this service. The spec maps the brief's `message` onto the house `error` field rather than adding a second copy of the same text. The stable contract — the code strings and the statuses — is unaffected.
- **Assumption — statuses the brief left open.** `template_not_in_project` answers `404` (the addressed resource is not in the addressed project, as the existing template read route already answers for a missing template); `template_name_taken` and `template_name_reserved` answer `409` (name conflicts), keeping `422` exclusively for graph validation.
- **Assumption — `requiresCommit`.** The brief's field enumeration omits it while also saying every step with all step fields. It is a real Step column that controls whether a successful Run must advance the workspace commit, so it is copied by clone and editable through replace. The acceptance criterion that clone copies every step field is what governs.
- **Assumption — warning shape.** A warning is `{ code, message, stepIndex? }` with `stepIndex` present only when a single Step is implicated; `same_agent_implements_and_reviews` and `no_review_step` are graph-level and omit it.
- **Assumption — review and implementation roles for warnings.** Review Step and implementation Step are resolved through the platform's existing output-kind to Step-role mapping rather than through a new list, so the warnings track the roles the rest of the platform already recognises.
- **Assumption — payload bounds.** The replace payload is bounded to keep a single call finite: at most 64 Steps (matching the existing step-override ceiling), Step and template names bounded like the existing template name input, and prompt bodies bounded like the existing large-text inputs on this service. Exceeding a bound is a request-schema rejection, not a validator error code.
- **Assumption — deterministic error order.** The brief says first error wins without fixing an order; the spec fixes the brief's own listing order, with the lowest offending Step index winning inside a code, so the same graph always produces the same answer.
- **Flagged for a later change, deliberately not done here.** `agents/README.md` states that there is no authoring API for template structure. After this change that sentence reads as absolute while being true only of canonical templates, which these routes refuse outright. The brief puts `agents/**/*.md` out of scope, so the wording is left alone and recorded here as a follow-up.
- **Vocabulary.** This spec uses the project glossary: Chain, Step, Approval gate, Merge gate, Merge readiness, Lease. Template and template Step refer to the authoring-time definitions from which a Chain and its Steps are instantiated; workflow and pipeline appear only inside the canonical templates' display names.
