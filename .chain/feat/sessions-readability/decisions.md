# Plan decisions: Sessions readability rework

Load-bearing decisions of the plan step, revised against the plan review
(SPR-001 through SPR-004) and written so a fresh context inherits the why
without either session's transcript. Entries 4, 5, 6, 7 and 9 were rewritten
in the revision; the finding that overturned each is named in its reason.
The specification of record is `spec.md` beside this file; slice files live in
`slices/`.

## 1. No standalone prefactor slice

Choice: the plan opens with no prefactoring slice; slice 04 carries the only
"make the change easy" move inside itself.

Rejected: a dedicated prefactor slice extracting shared list infrastructure or
splitting the Sessions page module.

Reason: every primitive the work needs already exists — the hover-card
component (one consumer, the sidebar Runner popover), the native select, the
storage wrapper with its in-memory degrade, the relative-time formatter with
its over-a-month absolute fallback, the pure normalizer seam, and the icon
module. Splitting the page module is forbidden by the spec (X3: both surfaces
stay in the one Sessions page module). The one genuine easing move is
architectural, not extractive: slice 04 introduces the projection as a typed
pass over the normalizer and switches the page to render nodes before any
behaviour rules pile in, so slices 05, 06, 08 and 09 add producers and caps to
a vocabulary that already renders — which is why 04 sits at the root of the
detail track rather than after the rules.

## 2. Two independent tracks, two roots

Choice: the list track roots at slice 01 and the detail track at slice 04;
both have empty `blocked_by` and the deepest chain is three slices
(01 → 02 → 03).

Rejected: a single linear sequence; also a shared "foundations" slice both
tracks depend on.

Reason: the list and the detail share no code path — the list consumes
`GET /sessions`, the detail consumes the event stream through the Session
stream module — so serializing them buys nothing, and a shared foundation
slice would be a horizontal layer with nothing demoable. Both tracks edit the
Sessions page module, but in disjoint regions (the list components above the
detail components), so that is a merge concern, not a prerequisite.

## 3. Filters blocked by grouping (03 after 02)

Choice: slice 03 lists both 01 and 02 as blockers.

Rejected: running filters parallel to grouping, blocked only by 01.

Reason: the spec's L14/L26 rule — filtering applies before grouping and before
the five-row cap, so a filtered day shows the five newest matching Sessions —
is only expressible as a red acceptance criterion once grouping exists. Landing
filters first would either drop that criterion (an integration gap discovered
at merge time) or state it conditionally (not verifiable). One extra level of
depth on an otherwise-shallow graph is the cheaper price.

## 4. The detail track's rule slices all hang directly off 04

Choice: slices 05 (prose merges), 06 (output caps), 08 (markers) and 09
(operator input) each block only on 04.

Rejected: chaining them into a sequence; in the original plan, bundling
merges, markers and input into one slice.

Reason: each adds producers or caps to the node vocabulary and renderer that
04 establishes, and none is a prerequisite for any other — prose coalescing
does not depend on markers existing, caps do not depend on either. They edit
the same module, which is a merge concern, not a dependency. Keeping them
parallel holds the detail track's critical path at two while widening the
frontier after 04 from two slices to four.

## 5. Slice 04 declares all four node kinds but produces two

Choice: the `StreamNode` union — including `input` and `marker` — is declared
in slice 04, while the marker producers land in slice 08 and the input
producer in slice 09.

Rejected: declaring kinds as they gain producers, giving slices 08 and 09 a
type change on top of a rule change.

Reason: the spec fixes the vocabulary at exactly four kinds (D3) and makes the
projection the single place that decides node kind (D4). Declaring the full
union up front means slices 08 and 09 each add one producer and one small
renderer to a stable type, instead of widening a union that the other rule
slices are typing against concurrently. The type shape is inlined in slice 04
because it encodes the decision (final as a flag, not a fifth kind; ToolCall
unchanged) more precisely than prose.

## 6. Slice 07 carries `risk: true`; every other slice `risk: false`

Choice: slice 07 (completed-but-unseen indicator) is flagged risky. The other
eight slices are not.

Rejected: flagging nothing, on the argument that a browser-local record is a
disposable cache rather than product data. That was the original plan's
choice and the plan review overturned it (SPR-001).

Reason: the risk flag marks persisted data or an irreversible external action,
and it marks them by mechanism, not by how valuable the data is. Slice 07
writes a per-Project record through the browser storage wrapper, which writes
`window.localStorage` — a store that outlives the page, the tab and the
process. Disposability bounds the blast radius; it does not move the write out
of the persisted category. It also cannot be un-shipped on the server: a
wrong key shape or wrong baseline semantics is corrected only as each
operator's browser picks up new code, which is exactly the irreversibility the
flag exists to surface. Nothing else in the plan touches the API, the
database, or any external system — the spec forbids all three — so no other
slice is flagged. Correcting the flag changed no dependency edge and cost no
frontier width.

## 7. Nine slices: three list, four detail, one indicator, one caps

Choice: nine slices — 01-03 on the list, 04 plus 05, 08 and 09 on the detail
projection, 06 for output caps, 07 for the unseen indicator.

Rejected: splitting 04 into projection-function and rendering slices; merging
02 into 01; merging 06 into 04. Also rejected, and originally chosen: one
combined slice carrying prose merges, markers and operator input together.

Reason: a projection without a renderer is a horizontal layer — not demoable,
and its acceptance would assert internals. Slice 04 is the largest slice, but
it is one coherent tracer bullet (events in, collapsed tool groups on screen)
and fits a fresh context: the normalizer it extends is ~320 lines and the
detail components it rewrites are ~150. Conversely, 01 without grouping is
already demoable (a scannable slim list), so 02 stays separate to keep 01's
review surface small — 01 is the slice that re-points the existing table
tests, which is the plan's largest test-migration burden. Caps stay out of 04
so 04's acceptance is about structure, not tuning.

The original combined rule slice was three vertical deliverables wearing one
slice's clothes, and the plan review said so (SPR-004): prose coalescing,
system markers and operator input each produce a distinct operator-visible
result, each has its own pure and component criteria, and each depends only on
04. Splitting them costs no depth and no frontier width — it widens the
post-04 frontier from two to four — and it makes each one's acceptance a
single demonstrable claim instead of nine bullets spanning three subjects.

One spec requirement is deliberately split across two slices: D7 bundles the
projection's drop rules with its merge and dedup rules. The drop rules are
what makes slice 04's projection produce a readable stream at all, so they
land with 04; the merge and dedup rules are slice 05's whole subject. Each
slice cites the half it owns, so no rule is claimed twice or left unclaimed.

## 8. Chain artifacts live under `.chain/feat/sessions-readability/`

Choice: this plan writes `spec.md`, `slices/` and `decisions.md` under
`.chain/feat/sessions-readability/`, copying the persisted spec there; the
spec step's earlier copy at `.chain/sessions-readability/spec.md` is left in
place.

Rejected: reusing the spec step's directory; deleting the older copy.

Reason: the plan task pins the `.chain/feat/sessions-readability/` path
explicitly, and later chain steps will resolve artifacts against the task
contract's path. Removing the spec step's file is not this step's call; the
duplication is one file and the persisted task output remains the source of
truth for the spec text.

## 9. Boundary requirements are build-description boundaries, not acceptance

Choice: spec requirements that assert non-change — Debug events and Files
touched untouched (D18), the polling contract unchanged, no API change, the
existing normalizer and its tests unchanged, the byte backstop unchanged — are
stated in each slice's build description under an explicit "boundaries this
slice preserves rather than proves" heading, and are verified by chain-level
regression, including the repository Merge Gate. They are not slice acceptance
criteria.

Rejected: a final verification slice re-checking the boundaries. Also
rejected, and originally chosen: carrying them as per-slice "existing tests
pass" and guard-suite criteria.

Reason: a slice must build something demoable, so "nothing changed" is not a
slice. But the original plan's fix was worse than the problem: every slice
ended with an unchanged-suite, lint, type and locale-guard bullet, and slice
01 additionally claimed row and nested-link navigation as acceptance. The plan
review demonstrated (SPR-002) that no application code changed between the
frozen base and the plan commit, so those criteria were green before
implementation started, for reasons having nothing to do with the slice — an
acceptance criterion that cannot go red proves nothing about the work.
Translation coverage moved with them: instead of "new copy in both locale
dictionaries", each slice that introduces copy now asserts the new strings
render under each active locale, which is red at the frozen base because the
copy does not exist. Slice 01 keeps the moved Inbox-wait assertion, which is
red, and states the re-pointing of the existing navigation tests as a
boundary rather than a criterion.

The cross-cutting constraints of the spec are placed the same way. X1
(translated copy) is no longer a per-slice dictionary chore but a per-slice
behaviour criterion: each slice that introduces copy asserts its new strings
render under both active locales. X2 (design tokens only) is already pinned by
an existing repository test on the Sessions page module that is green at the
frozen base and must stay green — chain-level regression. X3 (no new component
file; both surfaces stay in the one Sessions page module, shared logic in pure
lib modules) is a constraint on how every slice is implemented, stated here
once rather than repeated as nine identical bullets. Of the spec's user
stories, 58 (every new label translated) is satisfied by the per-slice locale
render criteria and 59 (design tokens in both themes) by the X2 guard; 61 (the
list's pure module) is carried by slice 02, which creates it, and extended by
03 and 07. X4 (removed code is
deleted, not deprecated) is a deliverable and is carried by slice 01 for the
table and by slice 04 for the per-item render conditionals.

Slice 04's stream-container criterion is the one place this rule is applied
with a seam: the plan review found (SPR-003) that the auto-scroll, new-items
and cap-notice behaviour it claimed as "existing page-level tests" has no such
tests at the frozen base. Those tests are now required work, anchored on an
assertion that is genuinely red — the new-items control counting projected
nodes rather than raw items — with the two already-passing behaviours written
alongside it in the same file as the regression net the rewrite needs. The
review asked for the test file path and an exact runnable command; slice
bodies name modules and seams, never file paths or commands, so the
build-before-test requirement is stated in prose instead. The requirement
itself is unchanged.
