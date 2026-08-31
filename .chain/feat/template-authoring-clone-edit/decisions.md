# Plan decisions: template authoring clone-and-edit

Each entry names the choice, alternatives rejected, and rationale so a fresh
implementation context inherits the authoring decisions.

## D1. The refusal envelope lands inside the clone tracer bullet

Choice: slice 01 owns the clone route and the shared authoring refusal type,
complete code union, optional step index, and 404/409/422 mapping. Slice 02
depends on 01 and consumes that envelope for replace.

Rejected: retaining the former standalone slice as an internal-only prefactor;
giving that prefactor a synthetic endpoint solely to demonstrate it.

Reason: PLAN-PR-001 correctly found that the prefactor had no standalone
operator-visible outcome and its compatibility checkbox was already green.
Folding it into clone removes one initial frontier slot and adds the 01-to-02
edge, but every remaining slice is now a demonstrable vertical cut.

## D2. Validator split into three error groups plus warnings

Choice: 03 owns ordering and base errors, 04 output-kind errors, 05 gate,
assignee and integrator errors, and 06 all warnings. Each is blocked only by
02, which creates the pure validator frame, fixed order, and `graph_empty`.

Rejected: one slice for all eleven errors and three warnings; one slice per
code.

Reason: four natural groups keep each slice reviewable, preserve a wide
frontier after replace, and give each group an independent base-red HTTP test.

## D3. The shared database fixture begins with replace

Choice: 02 creates the shared authoring fixture and request helpers used by
03-07 and 09. Slice 01 keeps a small clone-specific fixture.

Rejected: putting a fixture in the removed prefactor; making clone depend on
replace.

Reason: a fixture must land with its first consumer, while clone needs little
of the larger graph and race setup.

## D4. Handbook assertions land with the documentation they verify

Choice: 01 writes and asserts the clone entry; 02 writes and asserts the
replace entry and removes the obsolete no-authoring sentence; 03-06 add and
assert only their own error or warning codes. Slice 09 contains no handbook
work.

Rejected: deferring all handbook assertions to the former combined end-to-end
slice; a standalone docs
slice; dependency edges added only to avoid concurrent edits of one test.

Reason: PLAN-PR-004 and PLAN-PR-007 correctly found the deferred criteria
non-executable and handbook work independent of activation. Each docs change
now has a base-red automated assertion in its owning vertical slice. Ordinary
merge overlap is not a true prerequisite.

## D5. The shared mutex decision includes every participating lock class

Choice: instantiation takes the template-row mutex before re-reading the graph
and evaluating graph-dependent checks in its Serializable transaction. Replace
takes the same mutex before deleting and creating template-step rows.
Instantiation takes it before predecessor Task, Agent and grant locks and
before Task inserts acquire foreign-key reference locks on template and
template-step rows. The lock comment documents both concrete route paths.

Rejected: keeping a pre-transaction read and checking a digest later; claiming
replace takes only the template row; asserting a global order without auditing
existing template writers.

Reason: one row mutex is simpler than a second digest protocol. PLAN-PR-008
correctly identified omitted step-row and foreign-key locks. Slice 02 audits
writers before claiming the order is cycle-free: writers taking template and
step locks must take template first, while step-only and template-only writers
must not acquire the other class later. Slice 07 proves both real HTTP
orderings.

## D6. Replace deletes and recreates step rows

Choice: replace deletes all old step rows and creates the submitted rows with
dense indexes. The in-use check counts Tasks referencing either the template
or one of its step ids while the template mutex is held.

Rejected: diffing rows in place to preserve ids.

Reason: immutable-after-use guarantees no legitimate references, and whole
replacement avoids cascade, identity-remapping and renumbering policies.

## D7. Canonical identity comes from the existing registry

Choice: `template_canonical` and `template_name_reserved` use
`canonicalTemplateIdentity`, covering current and registered-legacy names.

Rejected: checking only two current names; adding a persisted canonical flag.

Reason: the registry is already authoritative and avoids a schema migration.

## D8. Warning roles reuse platform role classification

Choice: review means the recognized Sol or blind code-review roles;
implementation means implementation or fixed-implementation; regression means
regression verification. Resolution goes through `stepRole`, including
versioned output kinds.

Rejected: counting plan review as code review; creating an authoring-only role
list.

Reason: warnings must follow the roles the runtime already recognizes.

## D9. Integrator validation reuses the canonical binding rule

Choice: `integrator_binding_invalid` wraps the result of the existing
bidirectional sentinel check after assignee validity is known.

Rejected: restating the binding rule in the authoring validator.

Reason: one authority prevents hand-authored graphs from silently weakening
the mechanical binding.

## D10. Replace reads Agent facts without locking Agent rows

Choice: replace reads all referenced Agent facts inside its transaction, with
no project filter, and hands them to the pure validator. It does not lock Agent
rows.

Rejected: taking the instantiation Agent locks during authoring.

Reason: authoring has no runtime consequence until instantiation, which locks
and re-checks every Agent. An archive after authoring is caught there, while an
authoring lock would add contention without a lasting guarantee.

## D11. Route allowlist removal remains independent

Choice: 08 has no blockers and owns Route resolution, refusal-code cleanup,
its persisted Task assignment evidence, and routing governance text.

Rejected: sequencing it after 01 or 07 because of neighboring source edits.

Reason: source overlap is a merge concern, not a behavior prerequisite, so 08
can start beside 01.

## D12. End-to-end authoring depends only on route functionality

Choice: 09 is blocked only by 02, which already depends on clone. Handbook
assertions live in their owning slices, and end-to-end activation does not wait
for 07.

Rejected: preserving the 07-to-09 edge because instantiation is later
refactored; bundling handbook coverage with activation evidence.

Reason: PLAN-PR-004 correctly found that ordinary clone, replace,
instantiation and activation do not observe the row-lock protocol. Preferred
implementation order is not a dependency. After 02, 07 and 09 can proceed in
parallel; the critical path is three slices.

## D13. Risk flags follow persisted effects

Choice: `risk: true` on 01 (creates template and step rows), 02 (deletes and
creates step rows), 07 (changes the transaction writing Tasks), and 08 (changes
which Agent id can be persisted on an implementation Task). Slices 03-06 and
09 are `false` because they add validation, ephemeral warnings, or evidence
without selecting new persisted identities or changing persisted shape.

Rejected: leaving 08 false because it adds no new table or column.

Reason: PLAN-PR-005 correctly found that Route resolution changes persisted
Task assignment. Validator refusals and warnings persist no new state.

## D14. No schema migration

Choice: use the existing template and template-step columns; add no revision,
generation or canonical flag.

Reason: immutable-after-use replaces copy-on-write, and canonical identity is
derivable from the registry.

## D15. Requirements and verification have single slice owners

Choice: slice frontmatter carries disjoint `requirements` groups and exact
verification commands. Ownership is: clone, shared refusal envelope and clone
handbook in 01; replace mechanics, strict schema, guards, `graph_empty`, lock
helper and base handbook in 02; ordered/base errors in 03; output-kind errors
in 04; gate/assignee/integrator rules and authoring-time Repo-grant timing in
05; all warnings and ephemerality in 06; serialization and locked graph re-read
in 07; Route resolution and governance in 08; clone-to-activation evidence in
09. No implementation requirement is assigned twice.

Rejected: phrases such as "new dbtest" without a path and command; acceptance
checkboxes for unchanged behavior; dependency edges used to serialize test
file edits.

Reason: PLAN-PR-006 and PLAN-PR-007 require executable base-red evidence.
Exact targeted commands live in frontmatter so slice bodies remain free of
specific file paths and code snippets. Already-green compatibility checks are
explicitly regression verification. Repository-wide lint, snapshot scan, the
full suite, and the repository Merge Gate remain chain-level evidence outside
the slice set.
