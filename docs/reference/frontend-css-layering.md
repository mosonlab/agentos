# Frontend CSS layering contract

The current contract is the post-convergence state described in
[`docs/wiki/batch-frontend-convergence.md`](../wiki/batch-frontend-convergence.md).
The old Batch 0 contract—an unlayered legacy component sheet outranking Tailwind
utilities—is retired.

## Current layer order

`apps/web/src/styles.css` remains the single stylesheet. Tailwind v4 emits preflight in
`@layer base` and utilities, including shadcn classes, in `@layer utilities`. The surviving
generic element rules from the former compatibility sheet also live in `@layer base`.
Theme variables in `:root` and `.dark` may remain unlayered because they declare custom
properties only.

The invariant is enforced by `apps/web/src/tests/styles.test.tsx`: no unlayered class rule may
declare a non-custom-property. The test walks the built asset, detects class selectors even
when they are qualified by an element, and has a live negative-control fixture. A utility on a
component is therefore allowed to override a generic base declaration in the normal way.

## Consequences for component work

- Do not add a legacy class selector or an unlayered component rule to make a utility win.
  Put shared behavior in the owning primitive, use a token-backed utility at the call site, or
  add a properly layered base rule when the behavior is genuinely global.
- Removing a class token is not enough to prove parity. Move every declaration and state rule
  deliberately, including hover, checked, disabled, placeholder, focus, and last-child
  behavior. The current selector ledger is
  [`docs/plans/selector-destinations.md`](../plans/selector-destinations.md).
- Preserve semantic attributes when converting controls. `Input` emits `type="text"` by
  default, but production call sites should still state `text`, `number`, `password`, or
  `search` explicitly. Native `Select` is a local wrapper in
  `apps/web/src/components/ui/select.tsx`, not a Radix Select.
- A raw control and a primitive control are not automatically equivalent. Existing primitive
  utilities such as shadows, focus rings, placeholder colors, disabled opacity, and height can
  be live even when the old component class is gone. Compare the host's computed properties,
  not only the legacy-token scan.
- Portals remain React-tree descendants even when they are not DOM descendants. A row menu,
  popover, or dialog action needs an explicit bubbling test when the row itself is clickable.
- Generic base rules are the right place for browser-wide defaults; Markdown list markers are
  utilities on the rendered list elements. Do not reintroduce a special unlayered `.md ul`
  exception.

## When to add or change a layer

Use `@layer base` only for a genuine element-level or global default. Use component utilities
and variants for component behavior. Do not create `@layer legacy`: there is no remaining
legacy component surface for that layer to represent, and a new layer would obscure the
normal utility-over-base contract.

Any future change to the layer boundary requires, at minimum:

- a built-CSS assertion that the new selector lands in the intended layer;
- a semantic/SSR test for changed DOM attributes or host structure;
- state coverage for disabled, placeholder, focus, hover, portal, and empty/error paths where
  applicable; and
- a browser comparison at the responsive boundary and in both light and dark themes.

The exact checks and current failure catalogue are maintained in the frontend convergence wiki
page; this reference intentionally records only the reusable cascade rule.
