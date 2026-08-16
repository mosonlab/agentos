# Batch 0 — Frontend base archive

Status: current at `189b7c9` (`fix(web): restore behavior across CSS layer boundary`).

This is the batch-level archive for the frontend foundation migration. It is written for
the next batch that changes `apps/web`: it describes the shipped shape, the traps that
static checks do not see, and where to extend the web test bench.

The mechanism-level CSS contract lives in [`docs/reference/frontend-css-layering.md`](../reference/frontend-css-layering.md).
Read that page for the cascade model; use this page for the decisions, failure catalogue,
and operational rules of the whole batch. The source requirements and execution plan are
[`docs/specs/batch-0-frontend-base.md`](../specs/batch-0-frontend-base.md) and
[`docs/plans/batch-0-frontend-base-plan.md`](../plans/batch-0-frontend-base-plan.md).

## What shipped

Batch 0 moved the web app's styling base to Tailwind v4 plus shadcn/ui-backed primitives.
The shadcn components use Radix primitives where a behavior-preserving primitive exists.
The batch added 81 packages to the lockfile. React, ReactDOM, and Vite were not upgraded:
the final versions are React 19.2.8, ReactDOM 19.2.8, and Vite 7.3.6. The package manager
remains npm workspaces.

The old hand-written stylesheet is still present as a compatibility surface. Its surviving
legacy selectors are intentionally unlayered, while Tailwind preflight is in `@layer base`
and generated utilities/shadcn utilities are in `@layer utilities`. Legacy variable names
are aliases to the new theme roles, so the minimal-tier pages continue to render without a
mixed-base period.

### Theme and token shape

- The `.dark` block preserves numeric parity for the 42 dark visual tokens that formed the
  old palette. Dark mode is a re-expression of the old colors, not a new tint.
- A complete light `:root` block was added. It is a warm-paper counterpart to the dark
  warm-olive palette, with explicit values for surfaces, text, borders, status pills, code
  blocks, sidebar chrome, focus rings, and controls.
- `--surface-input` is the input background token. It is deliberately separate from
  shadcn's `--input`, which remains the border role. This is the resolved AMB-2 choice.
- `--scrim` owns the Dialog overlay color (`rgba(4,4,2,.68)` in dark mode), and
  `--surface-run-detail` owns the expanded run-detail surface (`#1b1810` in dark mode).
  Other batch-specific roles include `--code-background`, `--modal-shadow`,
  `--border-soft`, `--faint`, `--primary-hover`, `--primary-soft`, the destructive and
  status trios, and `--link`.
- Legacy aliases such as `--ink-0` through `--ink-5`, `--fg*`, `--line*`, `--accent*`,
  and the status names resolve to those theme roles. Surviving legacy rules consume tokens;
  stray legacy `rgba()`/`hsl()` color literals were replaced with tokens or `color-mix()`
  derivations.
- The light contrast fixes include `--primary: #7d5d00`,
  `--muted-foreground: #5f5748`, and `--faint: #6b6252`. These values are validated on
  the surfaces where the text actually renders; see [Contrast is a surface matrix](#contrast-is-a-surface-matrix).

### Page tiers

The five full-tier pages are `Tasks`, `TaskDetail`, `Agents`, `Goals`, and `Secrets`, plus
the shared chrome in `Shell.tsx` and the exported primitives in `components/ui.tsx`.
Their markup uses the new utility and shadcn-backed surface where that is behaviorally
one-to-one, while bespoke kanban, event-log, metric, and key/value patterns remain custom
legacy classes on theme tokens.

The three minimal-tier pages are `Connections`, `Inbox`, and `Projects`. Their page files
were intentionally left at zero migration diff: they continue to use their old DOM and
class names, and the alias/legacy CSS surface makes them work in both themes. They are
reserved for their later full rewrites (Connections, Batch 3 Inbox questionnaire work,
and the later Projects work). `App.tsx` banners and shared chrome were handled separately;
“minimal” does not mean the whole application shell was untouched.

The batch also adds guarded browser storage, system/light/dark switching with a no-flash
bootstrap, and a dev-only deterministic acceptance fixture. Routes, API payloads, polling,
and the existing data model did not change.

## Failure-mode field guide

These are the failure modes that remain possible when a later batch edits this mixed
legacy/layered surface. Each entry starts with a symptom that can be grepped in source or
seen in the built DOM/CSS, then gives the mechanism and the guard that exists now.

### 1. Replacing an inline declaration with a utility

**Symptom.** A class such as `className="row items-start"`, `className="row gap-1.5"`,
`className="page pb-0"`, or `className="projectMark size-[18px] text-[10px]"` is present,
but the element still has the old centered alignment, gap, padding, or project-mark size.
The built asset contains selectors such as `.row{align-items:center}` outside a layer and
`.items-start{align-items:flex-start}`/`.gap-1.5{gap:...}` inside `utilities`.

**Root cause.** A normal declaration outside every cascade layer beats a normal declaration
inside any layer, regardless of specificity. The utility is therefore not an override.
React inline style is stronger than both and was the correct compatibility escape hatch.

**Guard now.** The five affected inline-style sites remain explicit: the two Tasks layout
values (`alignItems: "flex-start"` and `gap: 6`), the App connection-banner bottom padding,
the TaskDetail status-select width, and the Shell project-mark dimensions. The CSS
regression test in `apps/web/src/tests/styles.test.tsx` checks the built layer placement and
the source intent for those declarations. Keep a deliberate inline style when its legacy
host class owns the same property; do not “clean it up” into a Tailwind utility without
first proving that no unlayered selector wins.

### 2. An `Input` without `type` is not the old text input

**Symptom.** `<Input />` renders as an ordinary browser text control, but the old form rule
`input[type="text"]` does not match it. A Secrets value control can visibly become a plain
text box, and a Goals limit control can lose its number semantics. Grep for `<Input` and
inspect the rendered attribute, not only the React prop type.

**Root cause.** The browser treats an omitted input type as text-like behavior, but an
attribute selector only matches when the `type` content attribute exists. The selector
`input[type="text"]` does not match `<input>` with no `type` attribute. The password case
is worse: if `type="password"` is dropped while migrating, the value silently becomes
visible as `type="text"`.

**Guard now.** The shadcn `Input` wrapper emits `type="text"` by default, and every
production `<Input>` call site declares its semantic type. `SecretValueInput` fixes
`type="password"`; `GoalLimitInputs` fixes all four `type="number"` controls and their
`min`/`step` constraints. `input-semantics.test.tsx` uses SSR markup to check the default,
the masked secret field, all four numeric fields, and the source tree for missing explicit
types.

### 3. Tailwind preflight removes browser defaults that legacy CSS never restored

**Symptom.** Markdown `- item` and `1. item` render without markers even though `.md ul`
and `.md ol` still have margin and padding rules. A Goals card heading matches the text
size of surrounding content instead of the old `h3` size. The built asset contains
Tailwind's `ol,ul,menu{list-style:none}` in `base`.

**Root cause.** Preflight resets user-agent defaults in `@layer base`. The unlayered legacy
stylesheet only wins for properties it explicitly declares; spacing does not restore a
missing `list-style`, and a generic `h3` reset does not get its old UA size back just
because `.goalCard h3` has other declarations.

**Guard now.** The unlayered legacy rules explicitly restore `.md ul { list-style: disc }`,
`.md ol { list-style: decimal }`, and `.goalCard h3 { font-size: 1.17em }`. The built-CSS
parser test verifies that preflight is in `base` and both marker rules are unlayered. The
same sweep confirmed that buttons and tables in use already have explicit rules; there are
no app `hr`, `img`, or `fieldset` call sites requiring restoration.

### 4. Radix/shadcn internal classes can win when no legacy selector targets the node

**Symptom.** Switching to the generated Tabs primitives produces a second chrome layer:
`TabsList` emits `bg-muted h-9 p-1` and its internal trigger defaults remain visible.
Dialogs become narrower or gain unexplained spacing because the generated content defaults
include `max-w-lg gap-4`. The overlay becomes the stock dark `bg-black/80` instead of the
theme scrim. These strings are grep-able in `components/ui/{tabs,dialog}.tsx` and in the
built CSS.

**Root cause.** The generated internal element has no matching old selector. The unlayered
legacy rules cannot override a property they never declare, so the shadcn utility defaults
apply normally. This is different from a utility placed on a legacy host: there is no
legacy winner at all.

**Guard now.** `Tabs` and `Segmented` were returned to direct button groups, preserving the
old DOM, order, repeat-click callback behavior, and accessibility shape rather than
shipping the extra Radix list chrome. The Dialog wrapper explicitly neutralizes the
defaults with `max-w-none gap-0`, and the modal wrapper does the same where needed. The
overlay consumes `bg-[color:var(--scrim)]`. `primitives.test.tsx` locks the direct-button,
`section`, and `span` host semantics. Do not remove a wrapper-level neutralization merely
because its class looks redundant.

### 5. A portaled menu is not protected by the trigger's wrapper

**Symptom.** Clicking a row menu's `Delete` item removes the task or agent and then also
fires the row's `onClick`, navigating to `/tasks/<deleted-id>` or `/agents/<deleted-id>`.
The trigger's `<span className="menuWrap" onClick={...}>` looks protected in source, but
the failure only appears when the portaled `[role="menuitem"]` is clicked.

**Root cause.** `DropdownMenuContent` is rendered through a portal. In the DOM it is not
inside `menuWrap`; in the React tree it still bubbles toward the row. Stopping propagation
on the trigger wrapper therefore cannot stop a click on the portaled content. The resulting
second action can be a navigation to an object that no longer exists.

**Guard now.** `RowMenu` also stops click propagation on `DropdownMenuContent`. The test
`apps/web/src/tests/row-menu.test.tsx` mounts the real React 19 + Radix menu in jsdom and
asserts `selected === 1` while the containing row remains at `rowClicks === 0`. Any new
portaled menu, popover, dialog action, or row-level click handler needs the same event-tree
review; DOM ancestry alone is not enough.

### Other migration traps worth recognizing

The shadcn generated files are from the Tailwind v3-era template family: they use
`React.forwardRef` + `React.ElementRef`, have no `data-slot`, and use `h-4 w-4` rather than
`size-4`. Batch 0 removed the known-invalid `animate-*` and
`origin-[--radix-…]` classes, but it did not upgrade the component vintage or add an
animation dependency. Batch 1 will receive newer v4-era generated components, so two
generations may coexist temporarily. This is already tracked in
[`docs/BACKLOG-V2.md`](../BACKLOG-V2.md); keep the differences visible until Batch 1 does a
deliberate, repository-wide upgrade.

## Contrast is a surface matrix

The original six reported contrast numbers were arithmetically correct, but they all
measured text against `--background`. That was the wrong test set: the text actually sits
on `--code-background`, `--sidebar`, `--accent`, status backgrounds, and other surfaces.
With the old light values, four real combinations were below the 4.5:1 small-text target:

| Actual foreground/surface | Old ratio |
| --- | ---: |
| `primary` on `code-background` | 4.24 |
| `muted-foreground` on `accent` | 4.19 |
| `faint` on `code-background` | 4.15 |
| `faint` on `sidebar` | 4.15 |

The method for future theme work is therefore: enumerate every text role by actual render
location, include small/dim text and tinted status surfaces, and calculate each
foreground/background pair. “All text on `--background`” is not a sufficient proxy.

The executable check is in `apps/web/src/tests/styles.test.tsx`, in the test named
`light text tokens meet 4.5:1 on every surface where small text is rendered`. It reads the
light token block from source, computes WCAG relative luminance/contrast, and checks the
actual combinations: body levels on background, primary label on primary, primary on code,
muted on accent, faint on code/sidebar, green/amber/violet pills, and destructive notices.
Run it after building the web asset because the same file also parses the production CSS:

```sh
npm run build -w @agentos/web
npm run test -w @agentos/web
```

The repository-wide equivalent is `npm run build && npm test`; the final batch result was
59/59. If a new component introduces a surface, add its text/surface pair to this matrix
at the same time as the component.

## The web test bench

Before Batch 0, `apps/web` had no tests. The existing 45 tests came from API (22), Inbox
(5), and Runner (18). The final suite is 59/59: 14 new web tests plus those existing 45.
The web package deliberately uses Node's built-in test runner and `tsx`, not Vitest or Jest:

```json
"test": "TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx --test src/**/*.test.tsx"
```

The `TSX_TSCONFIG_PATH=tsconfig.app.json` prefix is an intentional deviation from the
short command in the plan. The solution `tsconfig.json` contains only project references;
without the prefix, `tsx` cannot resolve the production `@/*` alias or automatic JSX when a
test imports a shadcn primitive. `@types/jsdom` is also present so the jsdom tests remain
under web typecheck.

The bench has four complementary layers:

- `renderToStaticMarkup` tests DOM attributes and host semantics: explicit input types,
  password masking, numeric constraints, direct button-group structure, and the
  `section`/`span` hosts restored by the wrappers.
- jsdom tests exercise React-tree event behavior where a static string cannot help. The
  RowMenu test uses the real Radix portal and checks that selection does not reach the row.
- `styles.test.tsx` parses the built CSS to locate representative selectors in their
  cascade layers, checks the five inline-style intent sites, checks preflight marker
  restoration, and runs the WCAG surface matrix.
- `storage.test.tsx` covers key-specific degraded storage: blocked get/set/remove,
  in-memory values, tombstones, and preserving healthy-key reads. This is the one
  deliberate runtime behavior change: storage failure degrades to session state instead
  of crashing startup.

### Where the next batch should add tests

Put web regressions beside these files under `apps/web/src/tests/`. Use SSR markup for
attribute/DOM contract changes, jsdom for React event propagation and portal behavior, and
the built-CSS parser for layer, preflight, token, and dead-utility claims. New Radix
components should get a test for their internal default classes whenever a legacy wrapper
is expected to neutralize them. New row/card interactions should get a portal/bubbling test
when a menu or popover is involved. New light-theme surfaces must extend the WCAG matrix
with their actual rendered backgrounds.

TypeScript, Vite build, and existing API tests cannot discover these failures: all three
can be green while an attribute selector misses, a UA default has been reset, a generated
class adds a second chrome layer, or a portaled click navigates after deletion. A rendered
assertion is required for each of those contracts. The web bench is not a replacement for
the live browser behavior matrix; it is the fast guard for the mechanisms that the browser
walk is most likely to miss in code review.

## Coupling, backlog, and future layering

### Files and conflict surface

The product implementation scope is:

- `apps/web/**`;
- the root `package-lock.json`;
- `packages/db/prisma/acceptance-fixture.ts`; and
- one `db:fixture` script line in `packages/db/package.json`.

`packages/api`, `schema.prisma`, migrations, and the root `package.json` were untouched.
There is no API/schema/build-contract change and no database migration. This is why the
batch has almost no semantic conflict with the other batches. The expected shared conflict
is textual lockfile overlap; rerunning `npm install` is the convergence step.

### C-9 and the acceptance fixture

The fixture cleanup now deletes the fixed `openThread` and `answeredThread` message owners
as well as task-owned messages, so thread-owned messages with `taskId = null` are not left
behind. The fixture has an independent successful typecheck:

```sh
npx tsc packages/db/prisma/acceptance-fixture.ts --noEmit --module NodeNext \
  --moduleResolution NodeNext --target ES2022 --esModuleInterop --skipLibCheck
```

The C-9 request for a persistent `prisma/` typecheck target was intentionally not added.
This is an existing gap also present in `seed.ts`, not a Batch 0 regression. Folding
`prisma/` into the package build target would collide with `rootDir: "src"` or change the
package's `dist/index.js` output contract; adding a second config or package script would
expand the allowed file surface. The backlog item is to revisit that build contract, not to
pretend the independent command is a persistent target.

### Do not casually add `@layer legacy`

The legacy segment remains unlayered on purpose: it is the compatibility weight that keeps
the existing pages stable while the new utilities and shadcn wrappers are introduced. A
future batch may consider wrapping it in `@layer legacy` only when it is ready to inventory
every overlapping property, choose an explicit layer order, and compare every route/state
in both themes.

That change moves the cascade winner for the entire component surface at once. It opens the
door for shadcn defaults on internal nodes that legacy selectors never target—exactly the
Tabs `bg-muted h-9 p-1`, Dialog width/gap, and overlay-color failures above—so it requires
component-by-component neutralization plus visual and interaction verification. Batch 0
leaves the legacy segment unlayered and keeps the affected wrappers and call sites
neutralized locally; it does not reopen the whole cascade.

## Verification boundary

The final automated gates were green:

- `npm run typecheck`: all six workspaces;
- `npm run build`: green, Vite transformed 1,914 modules;
- `npm test`: 59/59;
- React 19.2.8, ReactDOM 19.2.8, and Vite 7.3.6 unchanged;
- built-CSS layer parsing, the WCAG surface matrix, and the red-to-green negative controls.

Three things were not actually exercised in the review-fix environment because they require
a browser and/or Postgres: new `189b7c9` screenshots and visual focus/viewport review, the
remaining §8.5 browser behavior matrix and real first-paint/no-JS walk, and the Postgres
fixture `reset → actions → reset` idempotency run (including the browser walk around it).
They are explicitly **not counted as passed**, and they are not described here as product
defects; they remain Leo's PR-review decision or follow-up work.

The PR description records the same boundary and points to this archive. For a new frontend
batch, start with this page and the [CSS layering contract](../reference/frontend-css-layering.md),
then extend the web tests before changing a wrapper, input type, portal, token surface, or
cascade layer.
