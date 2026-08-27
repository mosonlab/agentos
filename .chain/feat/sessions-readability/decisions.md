# Plan decisions: Sessions readability rework

Load-bearing decisions of the plan step, written so a fresh-context revision
inherits the why without this session's transcript. The specification of
record is `spec.md` beside this file; slice files live in `slices/`.

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
behaviour rules pile in, so slices 05 and 06 add producers and caps to a
vocabulary that already renders — which is why 04 sits at the root of the
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

## 4. Caps parallel to merge rules (05 and 06 independent)

Choice: slices 05 and 06 each block only on 04.

Rejected: chaining 06 after 05.

Reason: the line-clamp helper and its application to tool arguments, results
and text nodes depend on the node rendering 04 establishes, not on the merge,
dedup, marker or input rules 05 adds. They edit the same module, which again is
a merge concern, not a dependency; keeping them parallel keeps the detail
track's critical path at two.

## 5. Slice 04 declares all four node kinds but produces two

Choice: the `StreamNode` union — including `input` and `marker` — is declared
in slice 04, while their producers land in slice 05.

Rejected: declaring kinds as they gain producers, giving 05 a type change.

Reason: the spec fixes the vocabulary at exactly four kinds (D3) and makes the
projection the single place that decides node kind (D4). Declaring the full
union up front means slice 05 adds projection rules and two small renderers to
a stable type, instead of widening a union that slice 06 may be typing against
concurrently. The type shape is inlined in slice 04 because it encodes the
decision (final as a flag, not a fifth kind; ToolCall unchanged) more
precisely than prose.

## 6. Every slice carries `risk: false`

Choice: no slice is flagged as risky.

Rejected: flagging slice 07 (seen state) because it writes browser storage.

Reason: the risk flag marks persisted data or irreversible external actions.
Nothing in this plan touches the API, the database, or any external system —
the spec forbids all three. Slice 07 writes a per-browser localStorage record
that is disposable by design: the spec itself specifies replacing it when
unparseable, and the worst failure is unread dots resetting once. That is a
client-side cache, not persisted product data in the sense the gate protects.

## 7. Seven slices, no finer

Choice: seven slices — three list, three detail, one indicator.

Rejected: splitting 04 into projection-function and rendering slices; merging
02 into 01; merging 06 into 04.

Reason: a projection without a renderer is a horizontal layer — not demoable,
and its acceptance would assert internals. Slice 04 is the largest slice, but
it is one coherent tracer bullet (events in, collapsed tool groups on screen)
and fits a fresh context: the normalizer it extends is ~320 lines and the
detail components it rewrites are ~150. Conversely, 01 without grouping is
already demoable (a scannable slim list), so 02 stays separate to keep 01's
review surface small — 01 is the slice that rewrites the existing table tests,
which is the plan's largest test-migration burden. Caps stay out of 04 so 04's
acceptance is about structure, not tuning.

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

## 9. Boundary requirements map to guard criteria, not slices

Choice: spec requirements that assert non-change — Debug events and Files
touched untouched (D18), the polling contract unchanged, no API change — have
no slice of their own; they are enforced by the "existing tests pass" and
guard-suite criteria every slice carries.

Rejected: a final verification slice re-checking the boundaries.

Reason: a slice must build something demoable; "nothing changed" is verified
by the suites that already pin the behaviour, and chain-level evidence
(including the repository Merge Gate) stays outside the slice set by the task
contract.
