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
