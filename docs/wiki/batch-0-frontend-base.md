# Batch 0 — Frontend base archive

Status: foundation facts retained; the current styling contract is at
[`batch-frontend-convergence.md`](batch-frontend-convergence.md), current at `48c9e54`.

This page keeps the frontend foundation knowledge that remains true after convergence. The
old descriptions of “full-tier” and “minimal-tier” pages, and the old unlayered legacy CSS
contract, are no longer current.

## Theme and token shape

- The `.dark` block preserves the dark visual-token values used by the application. Light mode
  has an explicit warm-paper palette for surfaces, text, borders, status pills, code blocks,
  sidebar chrome, focus rings, and controls.
- `--surface-input` is the input background role; shadcn's `--input` remains the border role.
- `--scrim` owns the Dialog overlay color and `--surface-run-detail` owns the expanded
  run-detail surface. Other batch-specific roles include `--code-background`, `--modal-shadow`,
  `--border-soft`, `--faint`, `--primary-hover`, `--primary-soft`, status trios, and `--link`.
- Legacy variable names are no longer a component styling API. New code should consume the
  semantic theme roles through the `@theme inline` mapping in `apps/web/src/styles.css`.
- Light text contrast is checked against the surfaces where text actually renders, including
  code, sidebar, accent, status, and destructive surfaces. Testing every text color only on
  `--background` is insufficient.

## Browser and primitive contracts

### Input semantics

The form rule is attribute-sensitive. An omitted input `type` is text-like to the browser, but
does not match a selector written as `input[type="text"]`. The shared `Input` therefore emits
`type="text"` by default, and production call sites keep explicit `text`, `number`,
`password`, or `search` semantics. `SecretValueInput` remains masked and
`goal-limit-inputs.tsx` retains the numeric `min` and `step` constraints.

The current convergence page records the remaining host differences: raw controls and
primitive controls can have different live defaults for shadow, focus, placeholder, disabled
state, or height. A change to either host needs a computed-style comparison and explicit
disabled/placeholder coverage.

### Preflight and browser defaults

Tailwind preflight resets user-agent defaults in `@layer base`. Markdown output consequently
needs explicit list marker utilities: the renderer places `list-disc` and `list-decimal` on
the corresponding lists. Other browser-default-sensitive elements should be checked when
introduced; spacing alone does not restore a reset marker or heading size.

### Radix and portals

Generated shadcn internals can introduce defaults on nodes that application selectors never
target. The current primitives neutralize or avoid those defaults where the existing DOM
contract requires it. A portal is outside the trigger's DOM ancestry but still bubbles through
the React tree: `RowMenu` stops propagation on the portaled menu content as well as the trigger
wrapper. Any new row-level menu, popover, dialog action, or clickable card needs the same
review and an interaction test.

The generated component files retain the v3-era shadcn shape (`forwardRef`, `ElementRef`, no
`data-slot`). The v4-era template upgrade is separate work; do not mix the two vintages
casually.

## Web test bench

Web tests use Node's built-in test runner and `tsx`, not Vitest or Jest:

```json
"test": "TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx --test src/**/*.test.tsx"
```

The `TSX_TSCONFIG_PATH` prefix is required because the solution TypeScript config contains
project references while tests import production `@/*` aliases and JSX. The bench uses:

- SSR for DOM attributes and host semantics such as input types and primitive structure;
- jsdom for React-tree event propagation and Radix portal behavior;
- the built-CSS parser for layer placement, preflight markers, token checks, and the broad
  no-unlayered-class invariant; and
- storage tests for blocked browser storage, in-memory fallback, tombstones, and healthy-key
  reads.

Build before running the web suite because the CSS tests read the emitted asset:

```sh
npm run build -w @agentos/web
npm test -w @agentos/web
```

For the current pass/fail boundary and the exact migration guards, use
[`batch-frontend-convergence.md`](batch-frontend-convergence.md), not the older test counts
that belonged to the pre-convergence tree.

## Scope boundary

The frontend foundation remains a web-only concern. The current convergence batch changes
`apps/web/src/**`, with no API or schema contract, migration, runner, or service restart.
The current CSS layer rule and rollback behavior are documented in the
[frontend CSS layering contract](../reference/frontend-css-layering.md) and the convergence
archive.
