# Code review — batch frontend-convergence (retire the legacy stylesheet)

**Verdict: FAIL — 2 must-fix, 5 should-fix.**

Reviewed: `refs/heads/agentos/cmsvovk8i0052mpyj7wnhdvis/run-1` @ `3eb2347` (24 commits), against
baseline `3f712b5`. Note the task record's `targetBranch`
(`agentos/cmsvovk5t004kmpyj175z7zpf/run-1`) sits at `e28f746` and carries the spec only; the
implementation is on the branch above. Everything below was re-derived from the diff and the files
themselves — no claim in the plan, the commit messages, the activity log or
`docs/plans/selector-destinations.md` was accepted as authority, and every gate was re-run here.

## Per-section verdicts

Judged separately, so a defect in one does not block another.

| Spec section | Verdict | Basis |
|---|---|---|
| **A — retire `styles.css`, keep the element/pseudo rules in `@layer base`** | **PASS** | Loss check clean (below). Every element/pseudo rule of the 463-line sheet is present in the 95-line replacement; the 30 `:root` aliases were dropped with zero surviving consumers; `font-size:13px` lands inside `layers:['base']` and after preflight's `html` rule in the built CSS. |
| **B — convert call sites to primitives** | **FAIL** | Both must-fix findings live here. |
| **C — regression tests** | **PASS**, with SF-1 | The invariant itself genuinely holds: an independent broad scan of the shipped CSS finds **0** unlayered class rules. The test is live, not vacuous (negative control below turns it red). Its selector regex has a hole. |
| **D — gates** | **PASS** | All four gates re-run green here; see the gate table. The implementer's numbers reproduce exactly, including the one that looks like a failure. |
| **E — manual walks + deviation ledger** | **PASS**, with SF-3/SF-4/SF-5 | The two sweeps and their measurements hold up. The ledger has accuracy defects, and its own stated residual risk ("error states are covered by neither sweep") is exactly where must-fix 1 landed. |

## Gates, re-run

| Gate | Result |
|---|---|
| `npm run build -w @agentos/web` | exit 0 — `dist/assets/index-D8vP9amu.css` 43.09 kB |
| `npm test -w @agentos/web` | exit 0 — tests 14, pass 14, fail 0 |
| `npm run typecheck` (root, all workspaces) | exit 0 |
| `bash docs/plans/legacy-class-check.sh` | 0 hits, exit 0 |
| `npm test --workspaces` | **exit 1**, but *not* a test failure: 185 tests, 184 pass, 0 fail, 1 skip. The non-zero exit is `npm error Missing script: "test"` for `@agentos/cli` and `@agentos/db` (`/tmp/rev-fulltest.log:204-218`). Both packages already lacked a `test` script at `3f712b5`, so this exit predates the batch. The implementer's reported counts are exact. |

`npm install` was required first in this workspace (`tsc: command not found`, exit 127, before it) —
an environment fact, not a defect.

## Loss check (heredoc whole-file overwrites) — clean

The implementation step ran with `Write`/`Edit` disabled, so every file write was a whole-file
`cat > … <<EOF` overwrite. Silent deletion is invisible to typecheck and tests, so it was checked
by mechanism, three independent ways:

1. **Declaration comparison** — every `export`/`const`/`function` name in each modified `.tsx` at
   `3f712b5` vs the branch, reporting only names whose count decreased. Zero decreases.
   (`ui.tsx`: 72 exports, all baseline names present.)
2. **Identifier multiset comparison** — all string literals replaced by a sentinel, then the
   identifier multiset diffed per file. No identifier lost outside the intended class-name churn.
3. **Brace-balanced `className` scan** — a multi-line-aware scanner extracting only the text inside
   `className="…"` / `className={…}` and matching it against the retired sheet's 126 class names:
   **0**. (A naive scan over all string literals reported 105 hits; those were `variant`/`tone`
   props such as `"green"`, `"amber"` — false positives, not residue.)

`styles.css` (463 → 95) was read in full on both sides: the deletions are the 126 class rules and
the 30 aliases, both in scope; every element, `*`, `a`, `h1..h4` and `::-webkit-scrollbar*` rule
survived. A grep for orphaned alias tokens (`--ink-*`, `--fg*`, `--line*`, `--red*`, `--radius-ctl`,
…) across `apps/web/src` returns nothing.

**Heredoc escaping accidents: none found.** No truncated class string, no empty template literal,
no `${…}` evaluated early. The backtick-heavy files (`ui.tsx`, `select.tsx`'s
`bg-[image:linear-gradient(…)]`) are byte-correct, and `styles.test.tsx` lines 100-EOF are
**byte-identical** to `3f712b5`.

---

## must-fix

### MF-1 — `ErrorNotice` collapses a multi-child `.notice` into one flex item (lens: coherence; confirmed by construction)

`ErrorNotice` wraps its message in a `<span>`:

```tsx
// apps/web/src/components/ui.tsx:331-333
export const ErrorNotice = ({ message, onRetry }: { message: ReactNode; … }) => (
  <div className={cn(NOTICE, NOTICE_ERROR)}>
    <span>{message}</span>
```

The batch **widened `message` from `string` to `ReactNode`** (baseline `ui.tsx:158` had
`message: string`) so that `App.tsx`'s rich banner could be routed through it, and converted the two
`ConnectionBanner` branches:

```tsx
// apps/web/src/App.tsx:40  (was App.tsx:38-44 at 3f712b5: <div className="notice error"> with the children inline)
<ErrorNotice message={<>控制面拒绝了操作员身份（{error.status}）。检查仓库根 <code>.env</code> 的 <code>OPERATOR_TOKEN</code>，
  它由 <code>vite.config.ts</code> 的 <code>{apiBase}</code> 代理注入。</>} />
// apps/web/src/App.tsx:50
<ErrorNotice message={<>无法连接控制面（{apiBase}）。先启动 <code>npm run dev:api</code>。</>} />
```

`NOTICE` is `flex gap-[10px]` (`ui.tsx:317`), reproducing the retired
`.notice { display:flex; gap:10px }` (`styles.css:401-405` at `3f712b5`). Under flex layout each
element child and each contiguous text run is its own flex item. Baseline `App.tsx:38-44` therefore
laid out **9 flex items with eight 10px gaps** on a single non-wrapping line; the branch lays out
**one**, so the eight inter-chip gaps disappear and the text reflows as an ordinary wrapped
paragraph. `App.tsx:50` loses two gaps the same way (3 items → 1).

**Failure scenario:** a fresh clone with no `OPERATOR_TOKEN` — which the build itself warns about
(`[agentos/web] OPERATOR_TOKEN is not set …; the control plane will answer 401`) — renders this
banner as its default state, visibly different from `3f712b5`. It is recorded in neither §14 nor
§15 of `docs/plans/selector-destinations.md`, and it falls precisely inside that document's stated
residual risk ("Empty states, error states … are covered by neither" sweep, lines 323-325), so
nothing caught it.

It is also internally inconsistent: three lines away, `App.tsx:69` keeps
`<div className={NOTICE}>未知路由 <code>{path}</code>。</div>` with direct children, i.e. the same
component class laid out two different ways in one file.

**Remedy:** render `{message}` directly when it is not a string — e.g.
`{typeof message === "string" ? <span>{message}</span> : message}` — or restore the raw
`<div className={cn(NOTICE, NOTICE_ERROR)}>…</div>` at `App.tsx:40` and `:50`. If the wrapped
paragraph is preferred on its merits, it must be recorded as a §14 delta with that justification.
`GapNotice` (`ui.tsx:322-329`) keeps its baseline `<span>` and needs no change.

### MF-2 — the raw-element→primitive audit was scoped by a false premise; three unrepaired deltas follow (lens: scope; confirmed)

`apps/web/src/pages/Projects.tsx:49-55` justifies the W16 deviation-5 repair and closes with:

> `Only these two call sites converted from a raw element.`

and `selector-destinations.md:§15 row 5` restates it as "Two Projects inputs were raw `<input>`".
That is false. Counting raw form elements per file, `3f712b5` → branch:

```
Agents.tsx 4→0   Goals.tsx 1→0   Inbox.tsx 1→0   Projects.tsx 3→1
Secrets.tsx 1→0  TaskDetail.tsx 1→0   Tasks.tsx 5→0
```

**16** raw controls became primitives, and at baseline *every one of them was unclassed* — they were
styled solely by the element rule `styles.css:233-240` (`padding:9px 11px`, `font-size:12.5px`,
`outline:0`, `:focus{border-color:var(--primary)}`, and no `:disabled` or `::placeholder` rule at
all). So the exact reasoning in the comment applies to all 16, not 2.

The height limb of that reasoning does hold up: `Select` (`ui/select.tsx:21`) carries no height
utility and `Textarea` only `min-h-[60px]`, both inert here, so only the two Projects `<input>`
hosts could collapse to `h-9` — and both were repaired. But three other deltas were not:

1. **Placeholder colour, `Inbox.tsx:220`.** Exactly three converted raw elements carry a
   `placeholder`: the two Projects inputs (repaired with `placeholder:text-foreground/50`) and
   `<Textarea rows={5} className="shadow-none" … placeholder="Write a reply…" />`. The third takes
   `Textarea`'s pinned `placeholder:text-muted-foreground` (`ui/textarea.tsx:17`) where the raw
   `<textarea>` at `3f712b5:Inbox.tsx:200` took preflight's `currentColor` at 50% — the identical
   delta the Projects comment identifies, unrepaired. `shadow-none` was applied at this site, so the
   site *was* visited; only this property was missed.
2. **Disabled selects.** Exactly two converted controls have a `disabled` prop —
   `TaskDetail.tsx:156` (`disabled={pending}`) and `Tasks.tsx:180`
   (`disabled={form.assigneeType === "HUMAN"}`). `Select` adds
   `disabled:cursor-not-allowed disabled:opacity-50` (`ui/select.tsx:21`). The retired sheet has no
   `select:disabled` rule — its only `:disabled` rules are `.btn:disabled` (`:186`) and
   `.toggle:disabled` (`:224`) — so both rendered at full opacity at baseline. `Tasks.tsx:180` is
   disabled whenever the assignee is `HUMAN`, a default state of the new-task form.
3. **Focus ring on all 16 hosts.** The primitives add `focus-visible:ring-1 focus-visible:ring-ring`
   (`input.tsx:25`, `textarea.tsx:17`, `select.tsx:21`) where the legacy rule gave focus only
   `border-color: var(--primary)` with `outline:0`. §14.1 records the new `Select` gaining
   `shadow-sm` and §14.2 records a *pill* gaining a focus ring — so the ledger's own precedent says
   this belongs in it, and it is absent.

Related, same root cause and same fix pass: `ui/button.tsx:14` carries
`disabled:pointer-events-none`, which suppresses the cursor on disabled buttons, where
`.btn:disabled { opacity:.45; cursor:not-allowed }` (`styles.css:186`) showed `not-allowed`. No
legacy button variant restores it (`grep cursor ui/button.tsx` → nothing), and `opacity` parity *is*
handled (`disabled:opacity-45` on each legacy variant). ≥6 disabled button sites are affected.

**Failure scenario:** open `/tasks` and the new-task form renders the assignee select at 50% opacity
with a not-allowed cursor against a full-opacity baseline; the Inbox reply placeholder renders in
`--muted-foreground` instead of 50% body colour; every disabled button shows an arrow cursor instead
of `not-allowed`.

**Remedy:** correct the claim at `Projects.tsx:55` (16 sites converted, all unclassed, all styled by
`styles.css:233-240`) and the matching §15 row; then either neutralise the four deltas at the
affected sites (`placeholder:text-foreground/50` at `Inbox.tsx:220`;
`disabled:opacity-100 disabled:cursor-default` at `TaskDetail.tsx:156` and `Tasks.tsx:180`;
`disabled:cursor-not-allowed` on the legacy Button variants) or record each in §14 with its
justification. Do not close this on the sweeps: neither sweep covers disabled or placeholder states.

---

## should-fix

### SF-1 — the layer guard's selector regex misses element-qualified class selectors (lens: feasibility, extra pass)

```ts
// apps/web/src/tests/styles.test.tsx:64
const CLASS_TOKEN = /(?:^|[\s,>+~()])\.[A-Za-z_-]/;
```

The dot must be at the start or follow whitespace/`,`/`>`/`+`/`~`/`(`, so any selector whose class
tokens are *all* glued to a preceding element or class name is invisible to the check:

```
MISS    td.legacyProbe     MATCH   .row
MISS    button.btn         MATCH   .table td.right
MISS    input.small        MATCH   .notice.error
```

Demonstrated end-to-end against the shipped CSS. Appending an unlayered `td.legacyProbe{color:red}`
to `dist/assets/index-D8vP9amu.css` and re-running: `✔ no unlayered class rule styles the app`,
14/14 pass. The control — appending `.rowProbe{display:flex}` — turns it red
(`✖ no unlayered class rule styles the app`, fail 1), so the test is live and its layer walker,
`declaresAppearance` filter and brace tracking are all correct; only this one regex is narrow.

**This is not a live defect.** Re-running the same walk with the broad regex `/\.[A-Za-z_-]/` over
the shipped CSS finds **0** unlayered class rules, so the batch's central invariant does hold — and
the retired sheet contained no element-qualified class selector at rule start, so re-adding *that*
file would still be caught. What is at risk is the future: this is the batch's only mechanical guard
on the layer inversion, and unlayered rules beat every layered utility regardless of specificity.

**Remedy:** widen to `/\.[A-Za-z_-]/` after stripping bracketed attribute values (`@`-prefixed
selectors are already filtered out one line above), and add `td.legacyProbe{color:red}` as a fixture
so the widening is itself protected.

### SF-2 — `legacy-class-check.sh` extracts `className` line-by-line and cannot see multi-line `cn(` calls (lens: feasibility)

```bash
# docs/plans/legacy-class-check.sh:40
n=$(grep -oE 'className=("[^"]*"|\{`[^`]*`\}|\{[^}]*\})' "$f" | …)
```

`grep` is line-oriented, so a `className={cn(` whose arguments wrap — 31 such sites in
`apps/web/src` — contributes nothing to the scan. The checker reports 0 and exits 0, which is the
correct answer here (my brace-balanced multi-line scanner independently confirms 0 residue), but the
gate would keep reporting 0 if residue were reintroduced inside a wrapped `cn(`.

**Remedy:** replace the `grep`/`tr` pipeline with a brace-balanced extractor (`perl -0777` or a
small Python script) that reads whole files, and check it in with a deliberately wrapped fixture.

### SF-3 — `TableRow` hover now applies to header rows too (lens: scope)

```tsx
// apps/web/src/components/ui/table.tsx:68
"transition-colors hover:bg-[color:var(--row-hover)] data-[state=selected]:bg-muted"
```

The legacy rule was `tbody`-scoped (`.table tbody tr:hover`, `styles.css:293` at `3f712b5`). Since
`TableHeader` renders a `TableRow`, header rows now take the row-hover background, which they never
had. Invisible to the computed-style sweep, which never hovers.

**Remedy:** move the hover to `TableBody` as `[&_tr]:hover:bg-[color:var(--row-hover)]`, matching the
`[&_tr:last-child>td]:border-b-0` already there, or scope it with `[&:not(thead_tr)]`.

### SF-4 — §13's "intentional drops, collected" is incomplete; three baseline-dead selectors are presented as relocated (lens: coherence)

`docs/plans/selector-destinations.md` §13 lists two intentional drops and calls the list collected.
Three further legacy rules were dead at `3f712b5` and are instead given live destinations:

- `:91` — `.iconBtn.danger:hover` (`styles.css:198` at `3f712b5`) → RowMenu's `text-destructive focus:…`. No element ever carried
  both `iconBtn` and `danger`: `iconBtn` appears once in the whole baseline tree
  (`ui.tsx:184` at `3f712b5`, the dropdown trigger), never with `danger`. The cited destination
  styling also already existed at baseline (`ui.tsx:188` at `3f712b5`, unchanged by this batch), so
  the row documents a relocation that did not happen.
- `:186-187` — `.choice.on` and `.choice.on .radio` → `Inbox.tsx` `CHOICE`. `className="choice"` is
  never combined with `on` at baseline, and `CHOICE` (`Inbox.tsx:26`) implements only the base and
  hover, no selected state — so the mapping overstates what the destination contains.

No rendering consequence today; the cost is that the parity ledger — the document a maintainer will
trust to know what the app is supposed to look like — asserts coverage it does not have.

**Remedy:** move these three rows into §13 as dead-at-baseline drops, with the grep that shows it.

### SF-5 — `.goalCard .top` is documented as landing on `ROW` but is inlined (lens: coherence)

`selector-destinations.md:204` maps `.goalCard .top` → `ui.tsx` `ROW`; `Goals.tsx:121` writes
`<div className="flex items-center gap-[10px]">` instead, which is byte-identical to `ROW`
(`ui.tsx:34`) rather than a reference to it. Rendering is unaffected; the ledger and the code
disagree, and a future edit to `ROW` will silently skip this one site.

**Remedy:** use `ROW` at `Goals.tsx:121`, or correct the row to say the string was inlined.

---

## Open questions, recorded rather than resolved

- **`/tasks/tsk_impl` horizontal overflow.** The implementer flagged a 52px horizontal overflow at a
  500px viewport. It sits outside this batch's ≤900px assignment, so it is not a finding against this
  work, but it is unowned and should be filed rather than lost.
- **`npm test --workspaces` exits 1 repo-wide** because `@agentos/cli` and `@agentos/db` have no
  `test` script. Pre-existing at `3f712b5` and out of this batch's scope; worth an `--if-present`
  fix so the aggregate gate can be trusted by future reviewers.

## What was verified independently, not taken on trust

Three of the six W16 deviation claims were re-derived rather than read: tailwind-merge deleting a
preceding `leading-*` behind a font-size utility (reproduced); `.hint` having no standalone rule and
therefore being inert at 12 of 13 sites (checked against all 9 Agents call sites); and `.table td`
outranking `.small` on specificity (checked by hand). The layer position of `font-size:13px`, the
`.flex`-in-`utilities` assertion, the 0-residue class scan and every gate above were re-run in this
workspace.
