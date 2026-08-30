Lane C12 (PR #282) 把 runner backend health 收进了一个 deep module，但 `packages/api/src/runner-cli-availability.ts` 没能一起退役：未授权的 `run-claim.ts` 仍在直接消费它的持久化格式读取函数。

C12 如实报告了这一点并停在 fence 上，是正确行为。剩下的工作是让 `run-claim.ts` 改走 module interface，然后删掉旧文件——按 00-COMMON 的原则，替换旧路径的改动应该在同一次里删掉旧路径，这次只是被 ownership 切开了。

另附 C12 的一条判断，不要当缺陷重开：brief 说 `sync-canonical-prompts.ts:457` 是「第四份 projection」，实际是第三份 operator alert 投递；它属于独立的 `@anneal/db` executable，让它消费 API module 会把包依赖方向弄反，所以 C12 故意没动。

上下文在 records/anneal-deepen-12-20260829/LEDGER.md。

Route: implementation=senior-dev-luna
