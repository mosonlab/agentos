# Frontend convergence archive

Status: current at `48c9e54` (review fixes for the frontend convergence batch).

This page describes the current `apps/web` styling contract. It supersedes the temporary
mixed legacy/layered contract in the Batch 0 archive and in the old CSS-layering reference.
The source requirements and execution plan remain useful for intent, but this page is the
place to learn what the landed system does.

## What changed

The eight application pages—`Agents`, `Connections`, `Goals`, `Inbox`, `Projects`,
`Secrets`, `TaskDetail`, and `Tasks`—plus `App`, `Shell`, and goal-limit inputs now use
Tailwind utilities, design tokens, and the shared shadcn-backed primitives instead of the
126-name legacy class vocabulary. The old class rules are gone from `apps/web/src/styles.css`
and from the migrated JSX. There is no API, schema, persistence, runner, or launchd change.

The visual contract was preservation, not a redesign. Existing geometry and color values are
carried by primitive variants, token-backed arbitrary utilities, and a small number of
call-site overrides. The batch therefore changes the styling mechanism while keeping the
rendered application substantially the same.

## The current cascade contract

`apps/web/src/styles.css` is still the single stylesheet, but it is no longer a compatibility
sheet of unlayered component selectors. It now holds the theme variables and the small set of
generic/base declarations that remain necessary. Generic element rules are in `@layer base`;
Tailwind and shadcn utilities are in `@layer utilities`. Normal utilities can therefore win
over the base defaults.

The only intentionally unlayered declarations are custom-property definitions such as the
light `:root` and `.dark` token blocks. The web style test rejects any unlayered class rule
that declares a non-custom-property. No new CSS file, `<style>` tag, `@layer legacy`, or
unlayered component rule was introduced.

The important consequence for future work is simple: a utility on an element is now a real
override of a generic base rule. Do not recreate the old escape hatch by adding an unlayered
class selector. Put shared behavior in the primitive that owns it, or use a narrow utility at
the call site.

## Where the behavior lives

### Tokens and base rules

- [`apps/web/src/styles.css`](../../apps/web/src/styles.css) defines the light/dark token
  values, the Tailwind `@theme inline` mapping, and the layered base rules.
- The old legacy aliases and component selectors are not a supported styling API. New work
  should use semantic token roles (`background`, `foreground`, `muted`, status roles, and so
  on), not resurrected color literals or old class names.
- Markdown markers are utility classes on the rendered list elements. Preflight remains in
  `base`; `list-disc` and `list-decimal` are in `utilities`, and the rendered Markdown output
  carries those classes.

### Shared primitives

- [`components/ui/button.tsx`](../../apps/web/src/components/ui/button.tsx) and
  [`components/ui/badge.tsx`](../../apps/web/src/components/ui/badge.tsx) own the legacy
  button, pill, status, disabled-state, and focus geometry through `cva` variants. The
  variants pin properties such as font weight, shadow, and disabled opacity where the old
  host depended on them. Legacy button variants also restore pointer events and the
  `not-allowed` cursor for disabled buttons; the icon variant deliberately remains separate.
- [`components/ui/input.tsx`](../../apps/web/src/components/ui/input.tsx),
  [`components/ui/textarea.tsx`](../../apps/web/src/components/ui/textarea.tsx), and
  [`components/ui/table.tsx`](../../apps/web/src/components/ui/table.tsx) retain the
  dimensions, padding, typography, and row-border behavior required by existing call sites.
  `TableBody` owns both the row hover and the final-cell border removal; header rows do not
  receive the body hover.
- [`components/ui/select.tsx`](../../apps/web/src/components/ui/select.tsx) is a native
  `<select>` wrapper, not Radix Select. It supplies the shared control geometry, a CSS
  gradient chevron, and the required native behavior. Its disabled appearance is neutralized
  at the two sites that were previously raw controls with no disabled rule.
- [`components/ui.tsx`](../../apps/web/src/components/ui.tsx) remains the shared barrel and
  owns reusable layout/content shapes such as `Page`, `ROW`, `NOTICE`, `CHOICE`, and table,
  menu, Markdown, modal, and segmented-group helpers. Rich `NOTICE` messages render their
  React nodes directly; plain string messages retain their span wrapper so the 401 banner and
  other rich notices keep their intended flex items.
- [`components/ui/dialog.tsx`](../../apps/web/src/components/ui/dialog.tsx) and
  [`components/ui/progress.tsx`](../../apps/web/src/components/ui/progress.tsx) were left
  unchanged. Their existing behavior is part of the current primitive surface.

### Pages and shell

Every page was migrated, including the three pages that Batch 0 deliberately left for later:
`Connections`, `Inbox`, and `Projects`. Raw controls in the page files were converted to the
shared primitives while preserving semantic attributes, handlers, and keys. In particular:

- `Input` emits `type="text"` by default, while call sites retain explicit `text`, `number`,
  `password`, or `search` semantics. Secret fields stay masked and goal-limit fields retain
  their numeric `min`/`step` constraints.
- The two Projects form inputs opt back into the old auto-height and placeholder color because
  those raw hosts had no primitive height or placeholder rule at baseline. The Inbox reply
  textarea has the same placeholder compatibility pin.
- The 16 converted raw controls retain the accessible focus-visible ring that existing
  primitives already had. This is an accepted state delta, not a resting-state geometry
  change. The two converted disabled selects explicitly restore full opacity/default cursor;
  legacy selects had no disabled rule.
- The shared shell in [`components/Shell.tsx`](../../apps/web/src/components/Shell.tsx),
  [`App.tsx`](../../apps/web/src/App.tsx), and `goal-limit-inputs.tsx` uses utilities for the
  responsive layout and overlay. At `900px` and below the sidebar becomes a wrapping row, the
  sidebar foot is hidden, padding is reduced, and the overlay becomes full-bleed. The exact
  breakpoint is an arbitrary utility variant, not a new theme breakpoint.

The `RowMenu` portal still stops click propagation at the portaled menu content. A row-level
click handler must not be assumed to be protected by DOM ancestry around its trigger.

## Non-obvious constraints and failure modes

### Partial rollback is unsafe

After the stylesheet switch, the stylesheet and call sites are one rollback unit. Reverting
only the stylesheet restores the old unlayered selectors, which beat migrated utilities and
can produce a mixed, worse state. Reverting only a page restores class names with no rules
behind them and can leave it unstyled. If this batch must be undone, revert the whole batch and
re-land a coherent replacement.

### Token removal is not proof of parity

The committed [`legacy-class-check.sh`](../plans/legacy-class-check.sh) checks exact tokens in
whole files, including wrapped `cn(...)` calls, and its self-test proves that multiline residue
is visible. The built-CSS test separately walks innermost rules and rejects every unlayered
class selector, including element-qualified forms such as `td.someClass`. It strips bracketed
attribute values before looking for class tokens so a selector such as `a[href$=".pdf"]` is not
misread.

These checks prove removal and layer placement, not visual relocation. When deleting a legacy
selector, account for its hover/checked/disabled/last-child state and every declaration. The
selector-destination ledger is [`docs/plans/selector-destinations.md`](../plans/selector-destinations.md);
update it when a future migration moves or intentionally drops a rule.

### Primitive host asymmetry is deliberate for now

Some existing primitive hosts had live shadcn utilities that raw controls did not. The batch
preserves that baseline rather than normalizing every host: 13 raw-control/button sites carry
explicit `shadow-none`-style overrides where necessary, while shared primitive defaults stay
intact. Removing one of those pins can add a shadow or alter a control height without changing
the legacy-token count.

### Tailwind merge can delete a paired leading utility

An arbitrary font-size utility can conflict with an existing `leading-*` utility in the
Tailwind merge step. The modal/card title path now restates its intended leading after setting
the 13.5px size. Any future constant that combines an arbitrary font size with a primitive
must pin both properties together.

### Native controls and browser state are easy to miss

The migrated select is deliberately native; do not replace it with Radix Select as a cleanup
unless the behavior and appearance contract is re-planned. Disabled and placeholder states
were not visible in the ordinary route sweeps, so a new control change needs explicit tests for
those states. Likewise, a visual sweep of only populated resting pages will not cover empty,
error, or second-click content.

## Deliberate decisions

- Preserve the current rendering under the layer inversion. Arbitrary pixel utilities and
  primitive variants are preferred when that is what preserves the baseline; stock shadcn
  geometry is not an implicit target.
- Use a native select wrapper and keep the existing `dialog` and `progress` primitives.
- Make `Page` a component because its responsive padding and repeated layout contract span
  many pages. Treat extending an existing `cva` variant as moving an existing visual value to
  its owning primitive, not as inventing a new token.
- Put surviving generic rules in `@layer base`, and put Markdown list markers on JSX as
  utilities. This keeps the layer invariant general instead of making exceptions for old
  selectors.
- Keep the stylesheet as one file and make this batch one atomic styling change. No schema,
  API, migration, runner, or service restart is part of the design.

## Verification boundary

The final reviewed code passed the following gates after the build ran first:

- `npm run build -w @agentos/web`;
- `npm test -w @agentos/web` — 15/15, including the element-qualified-selector guard;
- `npm run typecheck` across the workspaces;
- the committed checker over all 36 tracked `.tsx` files — zero residue;
- `npm test --workspaces` — 186 total, 185 passed, 0 failed, and one pre-existing opt-in
  race probe skipped.

The root `npm test --workspaces` form still exits non-zero because `@agentos/cli` and
`@agentos/db` have no `test` script. The root `npm test` uses `--if-present`; this aggregate
script gap is pre-existing and outside the batch.

The implementation's route and pixel sweeps found no computed text/geometry differences in
their fixtures. Accepted visible differences are the raw-select `shadow-sm` band, the
Connections agent-pill focus ring, the `color-mix()` solid fallback on browsers without
support, and the focus-visible ring on the 16 converted raw controls. Review fixes after that
sweep were verified by emitted CSS and SSR rather than by a second browser capture, so the
401 rich notice, Inbox placeholder, and disabled-button cursor remain worth checking in a live
browser when this batch is next touched.

## Deferred work

- Stage two—the visual-language pass—is intentionally unscheduled. The current ugly spots are
  Agents detail grouping, Tasks board column sizing, Secrets grouping, and TaskDetail reading
  order; they are inputs to that pass, not fixes in this batch.
- The stale-`dist` ordering gap in `styles.test.tsx` remains in `docs/BACKLOG-V2.md`.
- The shadcn v4-era template upgrade remains a separate batch; this code still contains the
  v3-era generated component shape.
- `/tasks/tsk_impl` can overflow by 52px at a 500px viewport. The assigned ≤900px walk is
  clean, so the narrower behavior remains unowned rather than silently “fixed” here.
- Empty/error/second-click states and a captured Textarea frame need broader browser fixtures
  if a future batch changes those paths.

Start with this page, then inspect the primitive owning the behavior and the built-CSS tests
before changing a shared wrapper, form semantic, portal, token, or cascade rule.
