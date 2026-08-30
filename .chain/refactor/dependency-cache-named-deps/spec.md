Lane C5 (PR #292) 把 runner 侧的 test-only positional 参数改成了 named dependency bundle，并把 21 个 `as ClaimedTask` 测试 cast 换成 honest literals。但 `packages/runner/src/dependency-cache.ts` 自身仍保留着同一种 positional collaborator interface——它落在 C5 那次 fence 放宽的精确路径之外。

同一形状、同一包、已经有现成的目标形态可抄（`ExecuteClaimDependencies`）。属于小而干净的收尾。

上下文在 records/anneal-deepen-12-20260829/LEDGER.md。

Route: implementation=senior-dev-luna
