# Baseline screenshots — before the frontend-convergence batch

Captured at commit `82b1de5` (code state `3f712b5`), i.e. **before W1**, per plan ruling R-3. These
are the batch's only appearance evidence: W13 deletes the legacy stylesheet, after which the "before"
cannot be reconstructed from the branch. W16/E5 compares against **these exact files**, and G2 is
checked against `agents-toggle-*.png`.

- **Viewport:** 1440 × 1000 CSS px, `deviceScaleFactor: 2` (page frames are 2880 × … px files).
- **Browser:** Google Chrome, `--headless=new`, `--force-color-profile=srgb`, `--hide-scrollbars`,
  with its own `--user-data-dir`.
- **Full-page frames** are clipped to `documentElement.scrollHeight`, so a page taller than the
  viewport (`taskdetail-*`) is captured whole.

## The 20 frames

| File | What |
|---|---|
| `agents-{light,dark}.png` | `#/agents` |
| `taskdetail-{light,dark}.png` | `#/tasks/tsk_impl` |
| `goals-{light,dark}.png` | `#/goals` |
| `secrets-{light,dark}.png` | `#/secrets` |
| `tasks-{light,dark}.png` | `#/tasks` |
| `projects-{light,dark}.png` | `#/projects` |
| `connections-{light,dark}.png` | `#/connections` |
| `inbox-{light,dark}.png` | `#/inbox` |
| `agents-toggle-{light,dark}.png` | Agents detail → Capabilities tab, switches close up at 3× — **G2's only evidence**. Shows the knob in both the checked and the unchecked position, so knob size, the 3px inset and the 17px travel are all readable. |
| `tasks-board-{light,dark}.png` | The Tasks kanban board at 2×, including columns in their resting state |

R-3 asks for 18; this is 20, because both targeted shots were taken in **both** themes rather than
only in the comparison theme. Nothing was skipped.

**Batch 4 addendum.** The harness now also serves `/sessions` and `/sessions/:id` (and its run
fixtures carry a `session` with the token columns), and `shoot.mjs` captures `sessions-{light,dark}`
and `sessiondetail-{light,dark}`. Those four frames have **no baseline counterpart** — the pages did
not exist at `82b1de5` — so they are not part of the W16/E5 pairwise comparison. They exist so the
batch's headline page is inside the visual-regression tool rather than outside it.

**Batch 1 addendum.** The harness also captures `settings-{light,dark}`. These two
frames have no baseline counterpart. It also captures `agents-edit-{light,dark}`
for the model picker and `agents-prompt-{light,dark}` for the read-only Foundation.
The targeted Agents crop ignores the new Tools card's eight switches so it
continues comparing the pre-existing binding switches whose 3px baseline drift
it was created to measure.

## Reproducing them (W16/E5 re-shoots the identical frames)

`harness/` is committed for exactly that reason — E5 requires a pairwise comparison at the same
viewport against the same data, which nobody can do from prose alone. It is documentation, outside
the build: nothing imports it, and it does not affect `npm run build`, `npm run test` or
`npm run typecheck`.

```sh
node docs/plans/baseline-screenshots/harness/server.mjs &          # fixture control plane, :8787
cd apps/web && VITE_API_URL=http://127.0.0.1:8787 VITE_API_TOKEN=fixture \
  npx vite --port 5199 --strictPort &
node docs/plans/baseline-screenshots/harness/shoot.mjs <output-dir>
```

`server.mjs` is a throwaway fixture control plane: it answers the ~20 GET endpoints the pages poll
with fixed, deterministic data (fixed timestamps, no `Date.now()`), so two runs of `shoot.mjs` differ
only where the CSS differs. It exists so the pages render populated instead of showing a connection
`ErrorNotice`, and it deliberately never touches the real database.
