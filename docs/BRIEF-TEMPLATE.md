# Feature brief template

A direct chain carries no spec or plan phase: the brief passed as the
`description` at template instantiation is the specification of record. Every
step of the chain reads it — the implementer builds from it, reviewers judge
the diff against it, the fix step treats it as the boundary. Write it with the
six sections below, in this order.

## Sections

### Goal

One sentence: what exists after this chain that does not exist today. No
implementation detail.

### Background

Why this work is needed and what root cause it addresses. State the current
behavior and the mechanism behind it, naming the actual code concepts
(models, functions, invariants) so the implementer can anchor the brief to the
repository without guessing.

### Changes

A numbered list. Each item must be independently checkable against the diff:
a reviewer should be able to tick it off or flag it missing. Name concrete
fields, routes, and validation points. If an item has a non-obvious rule
inside it (ordering, one-cut migration, a validation edge), state the rule in
the item itself.

### Out of scope

Explicit negative list. Name the adjacent work this chain must not touch,
including things a capable implementer would be tempted to fix in passing.
Reviewers and the fix step enforce this list as a hard boundary; an unlisted
temptation is an invitation.

### Constraints

Behavioral rules that hold across all items: failure semantics (fail loud, no
silent fallback), compatibility requirements, invariants that must survive
the change. Omit the section only when the Changes items already carry every
rule.

### Acceptance

Mechanically checkable criteria: migrations apply, named validations reject
named bad inputs, named suites are green, observable properties hold. Each
criterion should be verifiable without judgment calls. This section is what
"done" means; if a criterion cannot be checked mechanically, rewrite it until
it can.

## Discipline

- Changes and Acceptance must cover each other: every change has at least one
  acceptance criterion that would catch its absence, and no criterion tests
  something outside the listed changes.
- Out of scope is mandatory, even when it feels obvious.
- The brief states requirements and boundaries, not implementation steps.
  Environment rules and role behavior live in the agent prompts; code facts
  live in the repository. Do not restate either.

## Routing

Implementation has three routes:

- **senior-dev-luna** (template default): a brief with mechanical Acceptance
  is work that tier finishes under the chain's review and regression tail.
- **senior-dev**, with the reason on the same line, when the hazard is one
  the acceptance suite cannot witness even when stated: concurrency and
  transaction-boundary semantics, lock or lease ownership windows,
  cross-module contract migrations. A sol route without a reason is a brief
  defect.
- **frontend-dev** for frontend implementation work (UI components, pages,
  client-side behavior).

Tier answers how hard the diff is; chain shape answers how settled the spec
is — a brief that cannot reach mechanical Acceptance is compound-shaped
regardless of tier.

Direct-template instantiation parses and validates the `Route:` line and applies
it to the implementation step. A line starting with `Route:` that does not
match the grammar exactly is refused at instantiation rather than silently
ignored. Explicit `stepOverrides` are a separate API
mechanism; do not supply both for that step. Compound and custom templates do
not interpret Route-looking prose.

## Skeleton

```
<Goal — one sentence.>

Background: <current behavior, mechanism, root cause.>

Changes:
1. <Checkable item.>
2. <Checkable item.>

Out of scope: <explicit negative list.>

Constraints: <cross-cutting behavioral rules, if not already in Changes.>

Acceptance: <mechanical criteria, covering every change.>
```
