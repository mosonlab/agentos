Lane C3 (PR #289) 把 merge recovery 的拒绝理由做成了 enumerated refusal code 并持久化，但只在它 owned 的路径内完成。`recoveryIsReopenableLegacyRefusal` 仍按两个 failureReason 常量匹配散文，且是活的：定义在 `packages/api/src/merge-tail-state.ts:77`，调用点在 `merge-base-drift-worker.ts` 三处与 `merge-tail-state.ts:116`。

结果是同一个语义现在有两套并存机制——typed code 一套、prose matching 一套。这正是 deepening 程序本该消灭的形状，只因为 ownership fence 挡在中间而留下了半截。C3 自己在交付报告里报了这条。

另：`adoptRecoveryHead` 仍抛出面向 operator 的整句英文，但 C3 的 worker 已改为依据 durable CAS facts 分类、不再匹配该文本，所以那句话本身不再是协议的一部分。

这是本轮 deepening 遗留里我认为最该做的一条。证据与全部上下文在 records/anneal-deepen-12-20260829/LEDGER.md。行号会漂移，锚点是符号名。

Route: implementation=senior-dev
