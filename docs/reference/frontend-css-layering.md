# Frontend CSS layering contract

Batch 0 deliberately leaves the legacy rules in `apps/web/src/styles.css` unlayered.
Tailwind v4 emits preflight in `@layer base` and utilities (including shadcn classes) in
`@layer utilities`. For normal declarations, an unlayered rule wins over every layered
rule regardless of selector specificity. This is load-bearing compatibility behavior:
legacy classes keep their established appearance while their colors resolve through the
new theme tokens.

## Consequences for component work

- A legacy class wins over a shadcn utility when both set the same property. Neutralize
  shadcn defaults at the primitive/wrapper boundary when an internal element has no
  matching legacy selector.
- Do not replace a deliberate React inline style with a utility on an element whose
  legacy class sets the same property. Inline declarations win; layered utilities do not.
  Keep the inline declaration or add a narrow unlayered modifier rule.
- The form rule uses selectors such as `input[type="text"]`. An input's DOM default is
  text-like, but the attribute selector only matches when the `type` content attribute is
  present. `Input` therefore emits `type="text"` by default, and every call site also
  declares its semantic type (`text`, `number`, `password`, or `search`) explicitly.
- Preflight loses only for properties the legacy stylesheet actually declares. For
  example, legacy Markdown list spacing did not override preflight's `list-style:none`;
  `.md ul` and `.md ol` now restore their marker types explicitly.

The web regression tests parse the production CSS asset to verify that representative
legacy selectors remain unlayered, Tailwind utilities remain in `utilities`, and the
Markdown reset remains in `base`. They also lock the five call sites that require inline
overrides and reject `<Input>` calls without an explicit type.

## When to consider a `legacy` layer

Consider wrapping the legacy segment in `@layer legacy` only when a later batch is ready
to migrate the whole component surface systematically: inventory every overlapping
property, define the layer order intentionally, and compare every route/state in both
themes. Doing so changes the winner for all shadcn defaults at once, including internal
elements that the legacy selectors never targeted. It therefore requires component-by-
component visual and interaction verification and is not a safe review-fix refactor.
