### Goal
Every JSON route answers a missing or malformed request body with 400 and a named refusal instead of 500.

### Background (verified on main 79f46fd6, reproduced against production 2026-08-31)
`readJson` in `packages/api/src/app.ts` is the shared body parser for every JSON route:
`schema.parse(await request.json())`. A body that fails the Zod schema throws `ZodError`, which
`app.onError` maps to 400 `Validation failed` with issues. A body that is empty or not JSON makes
`request.json()` throw a `SyntaxError`, which no handler recognises, so the fallback logs it and
returns 500 `Internal server error`.

Reproduction (any task id, no state change):
- `POST /tasks/missing-task/chain/hold` with no body -> 500
- same with body `not json` -> 500
- same with body `{}` -> 400 Validation failed (correct)
- `PATCH /tasks/missing-task` with no body -> 500

A caller (an operator model driving the API) cannot tell this 500 from a real server fault and
retries or escalates. The repository rule is fail loud with a named code, not a generic 500.

### Change
- In `readJson`, catch the JSON parse failure and throw a refusal that `app.onError` already maps
  (`refusal("invalid-json", "Request body must be valid JSON")` -> 400), or map `SyntaxError` from
  body parsing in `app.onError`; pick whichever keeps a single mapping point. Do not swallow other
  errors.
- An empty body on a route whose schema accepts an empty object may stay a validation error; the
  point is that no request body shape reaches the 500 fallback.

### Out of scope
- No change to any route's schema or to the Zod 400 payload shape.
- No change to the `/runner/*` and `/session/*` protocols beyond inheriting the same parser fix.

### Acceptance
- Test: empty body and `not json` body on `POST /tasks/:taskId/chain/hold` and `PATCH /tasks/:taskId`
  return 400 with the named code; `{}` still returns the Zod 400; a valid body is unaffected.
- `docs/operator-api.md` documents the 400 `invalid-json` refusal once in the conventions section
  (per `AGENTS.md` same-change rule) and the operator-api docs test stays green.
- `npm run lint`, `npm run test:snapshot-scan`, and the full suite are green.
