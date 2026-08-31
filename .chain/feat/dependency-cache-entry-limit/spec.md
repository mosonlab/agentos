### Goal
The runner dependency cache retains enough entries that routine chain runs hit the cache instead of thrashing on entry-limit evictions.

### Background
`packages/runner/src/dependency-cache.ts` caps retained dependency snapshots at `DEPENDENCY_CACHE_ENTRY_LIMIT = 4`. Production runner logs (2026-08-31) show 50 hits / 26 misses / 15 evictions; every miss condition is `entry-missing` and every eviction condition is `entry-limit` - with multiple repositories and lockfile variants live at once, four entries thrash. A cache hit materializes workspace dependencies in about 12s end to end; a miss pays install (~21s) plus publish (~10s) on top.

### Changes
1. Raise `DEPENDENCY_CACHE_ENTRY_LIMIT` from 4 to 12 in `packages/runner/src/dependency-cache.ts`.
2. Update any tests that assert the literal limit; retention and eviction logic is otherwise unchanged.

### Out of scope
- No new configuration surface (no environment variable for the limit).
- No changes to cache format, key derivation, integrity validation, locking, or usage accounting.
- No merge-gate changes: its isolated `npm ci` is a deliberate design decision and must not be touched.

### Constraints
- Eviction stays usage-ordered exactly as today; only the numeric cap changes.
- Fail-loud paths (`integrity-refusal` and friends) are untouched.
- Disk growth is bounded by the cap only; this change introduces no size-based retention.

### Acceptance
- Retention tests pass with the new limit; a test proves the 13th distinct key evicts the least-recently-used entry and the 12th does not.
- `npm run lint` green; the runner test suite green.