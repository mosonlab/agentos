Remove the approved internal orphan surfaces so the tracked tree contains only code and chain artifacts with a current owner.

Background: the simplification survey at eff35471496e401c22bd3aa1a7d6a1864d3ca291 found eleven private Web symbols with no production, test, static-import, registry, reflection, or dynamic-loader consumer; one unregistered API dry-run script plus one unused re-export; and three .chain specs whose implementation commits already landed on main even though the files still claim pending dispatch. The direct and compound merge contracts require .chain artifacts to remain on the chain branch and be absent from the landed merge tree.

Changes:
1. Delete currentPath and currentQuery from apps/web/src/lib/router.tsx, useDismiss from apps/web/src/lib/hooks.ts, LOCALES from apps/web/src/lib/i18n-core.ts, and IconRepos, IconActivity, IconChevronRight, IconTrash, IconEdit, IconCheck, and IconFolder from apps/web/src/components/icons.tsx.
2. Delete packages/api/src/agent-template-dry-run.ts and delete only the runnerFor re-export from packages/api/src/execution.ts. Preserve every active template, execution, and runner-selection path.
3. Delete exactly .chain/auto-deploy-quiet-window/spec.md, .chain/chain-branch-handoff/spec.md, and .chain/runner-host-config-isolation/spec.md. Do not modify chain creation, merge sanitization, merge executor, or workflow templates.

Out of scope: SIM-API-PUBLIC-001 API route removal; Phase-0 CLI retirement; GitHub idempotency investigation; other Web export demotion; Prisma schema or migrations; release, deploy, gate-worker, merge-gate, or merge-automation changes; unrelated cleanup discovered during implementation.

Constraints: preserve all current runtime, API, UI, locale, route, template-instantiation, and runner behavior. Add no compatibility aliases, replacement helpers, or new record location. Let any unexpected consumer fail loudly and stop rather than broadening the change.

Acceptance: git grep restricted to tracked paths outside .chain finds none of the eleven deleted Web symbol names or the execution.ts runnerFor re-export; packages/api/src/agent-template-dry-run.ts is absent; git ls-tree -r HEAD .chain contains exactly .chain/simplify-internal-orphans/spec.md on the chain branch, and the sanitized merge candidate plus post-merge main read-back contain no .chain entries; focused Web and API tests pass; Web and API typecheck/build pass; public snapshot scan still classifies every tracked path; apart from the required current-chain spec, git diff contains only the enumerated deletions and mechanically necessary test expectation changes; scripts/merge-gate.sh --expect-head <exact candidate head> reports MERGE GATE: PASS for the final head.
