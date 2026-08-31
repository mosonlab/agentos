### Goal
`scripts/operator-api-docs.test.mjs` fails whenever an operator-facing HTTP route exists in code
without a heading in `docs/operator-api.md`, or a heading exists without a route, so the
`AGENTS.md` same-change rule is enforced by a test instead of by memory.

### Background (verified on main 79f46fd6)
All 142 routes are registered in `packages/api/src/app.ts` as `app.<verb>("<path>", ...)`.
`docs/operator-api.md` has 119 route headings of the form `### <VERB> `<path>``. The 23 routes
without a heading are exactly the `/runner/*` and `/session/*` internal protocols (runner claim,
heartbeat, events, workspace reclaim; session files, activity, output, inbox questions); they are
not operator routes and the handbook only mentions them in prose. There are 0 headings without a
route today. The existing test checks only the Tasks section (chain read, hold, resume, patch) so it
proves nothing about the other 115 routes. Earlier today a stale-docs question was answered
"the docs test is green" and that answer was only valid for the Tasks section.

### Change
1. Add a coverage test to `scripts/operator-api-docs.test.mjs`: parse `app.ts` for every
   `app.get|post|put|patch|delete("...")` registration; parse the handbook for every
   `### VERB `path`` heading; assert set equality after removing routes whose path starts with an
   internal prefix. The internal prefix list is a literal in the test (`/runner/`, `/session/`) with
   a one-line comment naming why they are excluded.
2. The test must report the exact missing and stale entries in its failure message.
3. Keep the route regex tolerant of the registration forms actually used in `app.ts`; if a route is
   registered in a way the regex cannot see, extend the regex rather than adding an exclusion.
4. Add the coverage rule to the handbook's introduction in one sentence so authors know it is
   enforced.

### Out of scope
- No new documentation for `/runner/*` or `/session/*`.
- No reordering or rewriting of existing handbook sections; the test checks presence, not order,
  except where the existing Tasks-section order test already applies.

### Acceptance
- Test passes on the current tree with zero exclusions beyond the two prefixes.
- Removing any single documented route heading, or adding a fake `app.get("/x")` in a scratch copy,
  makes the test fail and name the entry.
- `npm run lint`, `npm run test:snapshot-scan`, and the full suite are green.
