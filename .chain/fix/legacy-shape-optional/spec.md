DB: legacy template shapes match the optional flag each step declares

After this chain, a registered legacy generation can describe a step as optional, so a prompt-only rollover of a graph that carries an optional step matches its deployed rows instead of being refused by canonical sync.

Route: implementation=senior-dev-luna - the change mirrors PR #455 exactly (one comparison, one optional record field, one fixture assertion) and is fully witnessed by unit tests; it is also the Claude-routed trial chain after the Linux VM cutover, so the Mac runners must claim it.

Background:

`packages/db/src/canonical-template-transition.ts` identifies a deployed canonical template row against the closed list of retired graphs in `legacyTemplateGenerations` through `shapeMatches`. Every field of a step is compared with the registered `LegacyStepRecord`, except two that were hard-coded when the fields were introduced: `provisionDependencies` had to be `true` on every step, and `optional` still has to be `false` on every step (the `step.optional !== false` clause in `shapeMatches`).

PR #455 fixed the first one after canonical sync refused three consecutive Mac deployments on 2026-09-04 with `canonical-prompt-sync-refused`: the `pre-optional-review-omission` generation could never match the deployed rows because their review steps carry `provisionDependencies = false`. The fix gave `LegacyStepRecord` an optional `provisionDependencies` (defaulting to `true` for entries registered before the field existed) and compared each step against it.

`optional` has the same shape of defect. Since PR #452 the current source graphs contain optional steps (direct step 8, compound step 12). The next prompt-only rollover registered for either graph will need a generation whose shape carries `optional: true` on that step; today `shapeMatches` would reject the deployed rows and sync would refuse to touch any step referenced by instantiated tasks, exactly as before #455. The dbtest for the deployed rollover still forces `optional: false` on every fixture row (`packages/db/src/canonical-prompt-sync.dbtest.ts`, the "sync rolls the deployed pre-optional-review prompt generation once" test), which is what hides the gap.

Changes:

1. In `packages/db/src/canonical-template-transition.ts`, add `optional?: boolean` to `LegacyStepRecord` with a comment stating it defaults to `false` for generations registered before optional steps existed, and change the `shapeMatches` clause to `step.optional !== (expectedStep.optional ?? false)`. Do not mark any existing registered generation optional: every retired graph predates optional steps and their rows are all `optional = false`.
2. In `packages/db/src/canonical-template-transition.test.ts`, add a test proving that a generation whose shape marks one step `optional: true` matches persisted rows carrying that step as `optional: true` and does not match rows where it is `optional: false`, and that a generation without the field still requires `optional: false`.
3. Leave `packages/db/src/canonical-prompt-sync.dbtest.ts` as it is: its fixture rows are the deployed `pre-optional-review-omission` rows, which genuinely are all `optional = false`.

Out of scope:

- Registering a new legacy generation or changing any prompt digest.
- `successorPromptDrift`, `legacyGenerationMatches` beyond the shape comparison, and `sync-canonical-prompts.ts`.
- The `provisionDependencies` comparison landed by PR #455.
- Any change outside `packages/db`.

Constraints:

- The write set is `packages/db/src/canonical-template-transition.ts` and `packages/db/src/canonical-template-transition.test.ts`.
- Every existing registered generation must keep matching exactly the rows it matched before: no `optional` field is added to any existing entry.
- No new export, no configuration, no compatibility path.

Acceptance:

1. `packages/db/src/canonical-template-transition.test.ts` contains the three assertions in Changes 2 and they pass.
2. All existing tests in that file pass unchanged, including "registered generations require an explicit true dependency-provisioning value" and "optional review omission is a registered prompt-only rollover in both templates".
3. `RUNNER_WORKSPACE_ROOT=$(mktemp -d) npm run test -w packages/db`, `npm run lint -w packages/db`, and `npm run typecheck -w packages/db` are green; `test:db` evidence comes from the merge gate.
