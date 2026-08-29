# Anneal

A control plane that runs engineering work as chains of agent tasks against
git repositories. This glossary is the domain vocabulary: specs, plans, and
reviews should use these terms and no synonyms.

## Language

**Chain**:
An ordered set of tasks instantiated from one canonical template, sharing one
`chainId` and one chain branch. Each task in it is a **Step**; a step starts
only after its predecessor's durable success.
_Avoid_: workflow, pipeline (use only for the templates' display names)

**Step**:
One task inside a **Chain**, bound to a template step that fixes its prompt,
assignee role, and output kind. Steps are the chain's control-flow unit;
**Slices** are the plan's work unit — they are not the same thing.

**Slice**:
One vertically-cut unit of implementation work produced by planning: a
demonstrable path through the system that fits a single fresh context window.
Slices carry `id`, `title`, `blocked_by`, and `risk`, and are worked by
implementer subagents.
_Avoid_: ticket, issue (upstream vocabulary; write slice)

**Frontier**:
The set of slices whose blockers are all done. Implementation works the
frontier at maximum concurrency; a plan is judged partly by how wide it keeps
the frontier.

**Merge gate**:
The chain-tail verification that must pass before a chain's branch may merge:
lint, types, and tests run by a gate worker in a clean environment. Gate
evidence belongs to the chain tail only; review steps never run the gate.

**Merge readiness**:
The mechanical chain step that validates durable **Merge gate** evidence
against current repository state, obtains the merge **Lease**, and authorizes
the exact merge. It performs no semantic review.

**Lease**:
The time-bounded claim a runner holds on a run, kept alive by heartbeats. An
expired lease returns the run to the queue. The merge Lease is a separate
global claim: **Merge readiness** obtains it and hands it to merge execution so
only one chain integrates at a time.

**Specification of record**:
The single authoritative statement of what to build, which every later step
obeys: the approved spec for a compound chain, the task brief for a direct
chain. Materialized into the **Chain workspace** by the chain's first working
step.

**Chain workspace**:
The `.chain/<branchName>/` directory on the chain branch holding the
materialized spec, slices, and decisions. Stripped from the mainline at merge;
the chain branch is archived with it intact.

**Blind review**:
The two independent review passes (separate models, one fully isolated from
prior step attachments) pinned to the same implementation range. Their
findings go to a single **Disposition** step.

**Disposition**:
The per-finding ruling step after review: each finding is fixed, rejected
with a reason, or accepted as follow-up. No finding is dropped silently.

**Approval gate**:
A chain step that halts until the operator approves its persisted output
through the inbox. The human-in-the-loop point for un-grilled cards.

## Relationships

- A **Chain** has many **Steps**; one step materializes the **Specification
  of record** into the **Chain workspace**
- Planning turns the specification into **Slices**; implementation works the
  **Frontier** they form
- **Blind review** produces findings; **Disposition** rules on each
- The **Merge gate** produces exact-head evidence; **Merge readiness** validates
  it under the merge **Lease** and hands the claim to merge execution

## Flagged ambiguities

- "ticket" vs "slice": upstream skills say ticket; this platform says slice
  everywhere, including in prompts vendored from upstream. Resolved: slice.
- "gate" alone previously meant either the merge gate or an approval gate.
  Resolved: write **Merge gate** or **Approval gate** in full.
