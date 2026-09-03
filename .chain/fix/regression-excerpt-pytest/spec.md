Goal: when a managed repository's merge gate runs pytest, a Regression FAIL records the failing test node ids and assertion lines in the excerpt instead of "no per-test output in gate log".

Background: `packages/runner/runtime-tools/regression-verification.sh` extracts the failure excerpt from the gate log with shapes taken from node:test output: `not ok` lines, `✖`/`×` markers, `AssertionError`, `Error:`, and file context matched by `\.(test|spec|dbtest)\.[cm]?[jt]sx?`. pytest prints none of those. Its failure shapes are: a `FAILED <path>::<name>[ - <message>]` or `ERROR <path>::<name>` line in the short test summary, section headers `____ <name> ____`, assertion detail lines starting with `E   `, and node ids of the form `<path>.py::<name>`. The word-factory repository (registered project `word-factory`, gate `scripts/merge-gate.sh` -> `scripts/pytest_regression_gate.py`) additionally prints a machine line `PYTEST-REGRESSION: UNMET ...` and a JSON line `PYTEST-REGRESSION-RESULT {...}` naming business failures and unknown failures. With the current extractor every pytest gate FAIL for that repository lands as `<stage>: no per-test output in gate log`, so the review-fail step cannot see which test failed. Tests for the extractor live in `packages/runner/src/regression-verification-script.test.ts`.

Changes:
1. In the extractor, treat a line matching `^\s*(FAILED|ERROR)\s+\S+\.py::` as a failure marker (same handling as `not ok`), and a line containing `\S+\.py::\S+` as file context (same handling as the `.test.js` context), so the node id is retained with the failure.
2. Treat lines starting with `E   ` (pytest assertion detail) as assertion lines while a failure is open, under the same 32-line adjacency bound as the existing `Error:` handling.
3. Treat a line matching `^[A-Z][A-Z0-9-]*: (UNMET|FAIL|FAILED|ERROR)\b` (repository gate verdict lines such as `PYTEST-REGRESSION: UNMET`) as a failure marker so a repository-level verdict line is always recorded even when per-test lines are cut by the worker's tail.
4. Add test cases to `packages/runner/src/regression-verification-script.test.ts` with a pytest-shaped gate log (short summary with two FAILED lines, one `E   assert` block, one `PYTEST-REGRESSION: UNMET` line) asserting the excerpt contains both node ids, the assertion line, and the verdict line, and does not contain the "no per-test output" fallback for that stage; and one case proving node:test extraction is unchanged.
5. Update `docs/runbooks/add-a-project.md` "Full-tail readiness" with one paragraph stating which pytest output shapes the excerpt recognizes, so a Python repository's gate does not need to emit TAP.

Out of scope: no change to gate-worker scripts (`run-gate.sh`, `gate-dispatch.sh`), to `docs/repo-contract/merge-gate.sh`, or to word-factory; no change to the MAX_LINES cap or the stage attribution rules; no generic "any line with FAIL" heuristic.

Constraints: existing node:test excerpt behaviour and all current test cases stay byte-identical in output; the extractor remains a single inline script inside regression-verification.sh (no new file in the runtime-tools bundle, which is inventoried by release tests); no emoji in project files.

Acceptance:
- `npm run test -w packages/runner` is green, including the new pytest-shaped cases.
- `npm run lint` and `npm run typecheck` are green.
- The runtime-tools inventory tests (`release-snapshot`, `build-runtime-tools`) still list exactly the same six files.
- `docs/runbooks/add-a-project.md` names the recognized pytest shapes (FAILED/ERROR node id lines, `E   ` lines, repository verdict lines).