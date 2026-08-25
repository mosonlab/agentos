# Task Routing Contract v1

Version: 1.2

Status: Active

## Applies to

This contract governs the design, creation, dispatch, and routing of AgentOS tasks, task chains, and task templates. Every runnable task or chain requires one versioned Product Contract; a chain does not create a separate contract per step.

## Authority boundaries

The Product Contract fixes the objective, scope, acceptance criteria, evidence, risk boundaries, stopping conditions, and dependencies. Within those boundaries, the dispatcher and execution chain may choose implementation details.

The human user holds dispatch authority. Work stays in the current session unless the user explicitly requests a task chain. Complexity, risk, or an available template may support recommending a chain, but none authorizes creating or dispatching one.

Changing the objective, scope, acceptance criteria, required evidence, authority, or risk boundary requires a new Product Contract version and product-owner approval. Any downshift of the selected route, effort, or safeguards requires the same approval.

Model and effort routing follows the operator's current routing policy. Select the implementation role and record the routing snapshot at dispatch. Rerouting uses a new process and a new snapshot; an active Agent does not change model or effort in-session. Model and effort belong in agent configuration, not task prompts.

## Minimum Product Contract

A runnable task or chain records:

- Contract ID and version.
- Objective.
- In-scope and out-of-scope work.
- Acceptance criteria and required evidence.
- Risks, authority boundaries, and stopping conditions.
- Dependencies and prerequisites.
- The routing snapshot defined below.

SPEC and Plan are optional. The Product Contract is not.

## Task tiers

Work done directly in the current session is outside these tiers and does not require a Product Contract. The tiers apply only after the human user explicitly requests a task chain.

Choose the shortest tier that satisfies the Product Contract. This contract defines three tiers:

- 顺手小活：本窗直接做，不上看板。
- Direct：没有 spec/plan；八个 task node 跨七个 execution layer：实现 → 并行 Sol/盲 Opus 评审 → Opus 终裁 → 修复 → 回归 → 就绪 → 机械合并。实现步默认用 senior-dev-luna，命中 persisted data、defense-list 或无法枚举的 cross-cutting 风险时在派发前改用 senior-dev-high（executioner 硬前提是既存 plan）。
- Full Assurance：全链。

Direct is a formal chain route, not an exemption from review or exact-head
mechanical authorization. Full Assurance is required when the Product Contract
calls for specification, planning, plan review, or revised-plan implementation
authorization.

## Critical classification

Critical means only that the work touches persisted data or performs an irreversible external action. No other condition makes a task Critical by itself.

Critical is a risk label, not a child-model route. Step ⑤ keeps every native child on Luna max; the Sol-high root must inspect a risk slice's boundary, rollback behavior, and acceptance evidence before integration, and a child cannot perform an irreversible external action. A ⑦ repair diff that touches structural risk uses sol:high. Here, `persisted data` means runtime-created user or system data, including its schema, that must survive a version change. Structural risk means a change to a public interface, persisted data, a component boundary, or a foundational dependency.

## Full Assurance canonical execution graph

The seeded `compound-engineer-workflow` has thirteen task nodes across twelve
execution layers. A layer becomes eligible together; its successor layer is
eligible only after every task in the preceding layer is `DONE`. A failed,
parked, stopped, or otherwise non-`DONE` sibling blocks the join. There is no
partial join or timeout fallback.

`chainIndex` is the stable node ordinal. `chainLayer` is the execution key, so
the two review siblings have distinct ordinals but the same layer. The console
shows both the node ordinal and the dense execution-layer position; equal-layer
rows are parallel siblings, not serial predecessor/successor rows.

| 节点 / layer | 角色 | (入口, model, effort) | 要点 |
| --- | --- | --- | --- |
| ① / 1 spec | spec | CODEX, sol, high | 根据 Product Contract 产出可供 plan agent 直接执行的完整 specification；人工闸 |
| ② / 2 plan | plan | CLAUDE, fable-5, medium | 产物=垂直切片集，一片一文件：{id, title, delivers, blocked_by[], acceptance[], files_hint[]}；切片判据：纵穿全层、独立可演示、单上下文窗装得下；宽重构走 expand→migrate（分批）→contract；plan 会话 session-id 落链分支文件 |
| ③ / 3 计划评审 | review-coordinator | PI, openai-codex/gpt-5.6-sol, high | 检查切片的可演示性、依赖边、合并/拆分、迁移顺序，以及每条验收判据在冻结基点为红 |
| ④ / 4 计划修订 | plan-reviser | CLAUDE, fable-5, medium | resume ②会话（同模型同档；显式 session-id，禁 `--last`）；跨链步 resume 不可用时新窗读取②③产出；实施授权闸在本步后 |
| ⑤ / 5 实现 | executioner | CODEX root 使用 executioner Agent 的 model、reasoning effort 与 service tier；子代理固定 luna, max | 保留 approved slice DAG，root 按实时 dependency frontier 调度；子代理经 multi_agent_v2 spawn，最多八个 child threads；并发写入者各用独立 worktree，合并按依赖安全顺序；Implementation 只运行窄验收、affected-workspace compile/typecheck 和跨 assignment seam tests，不跑 repository-wide suite 或正式 Merge Gate |
| ⑥a / 6 Sol 代码评审 | review-coordinator-sol | PI, openai-codex/gpt-5.6-sol, high | 与⑥b同时可领取。一个 Sol high session 对同一实现范围依次完成 Standards 和 Specification 两轴，持久化一份 immutable `sol-findings`；不启动嵌套评审子进程 |
| ⑥b / 6 盲 Opus 代码评审 | review-coordinator-opus | CLAUDE, claude-opus-5, medium | 与⑥a同时可领取。使用同一 pinned implementation base/head 的隔离 checkout，持久化 immutable `blind-findings`；整个任务和 provider session 都不能读取 Sol 或其他 review evidence |
| ⑥c / 7 Opus 终裁 | review-adjudicator-opus | CLAUDE, claude-opus-5, medium | ⑥a与⑥b均 `DONE` 后才可领取。新 provider session 先验证两份 immutable 输出、状态和 pinned base/head，再读取报告，输出涵盖每个 finding id 的 immutable `must-fix`；不恢复盲评审会话 |
| ⑦ / 8 修复 | senior-dev | CODEX, sol, medium | 按封闭 `must-fix` 清单修；修复 diff 触及任一结构风险升 sol:high |
| ⑧ / 9 回归核销 | regression-verifier | PI, openai-codex/gpt-5.6-sol, medium | 新 Sol session 在精确修复 head 上读取终裁和修复结果，核销每个 must-fix；语义通过后运行一次 exact-head mechanical gate，并绑定结构化 verdict |
| ⑨ / 10 wiki | librarian | CODEX, terra, medium | 将内部文档更新为 delivered code 的当前行为 |
| ⑩ / 11 合并就绪 | review-coordinator | server-owned mechanical | 控制面重算 PR head、defense-list 和 exact-head PASS 证据，输出 merge authorization；不运行模型 |
| ⑪ / 12 机械合并 | merge-integrator | mechanical sentinel | 重新验证授权和 live PR 条件后执行合并；不运行模型 |

Full Assurance runs specification and planning through implementation, a
parallel two-route review layer, a deterministic Opus join, repair, fresh
post-fix regression, documentation, server-side readiness, and mechanical
merge. Step ⑤ uses `executioner` because a persisted Plan exists. Direct skips
①–④ and uses `senior-dev-luna` by default at its implementation node, while
`senior-dev-high` remains an allowed dispatch-time root under the repository
routing rules. Either Direct Codex root receives the same platform-pinned Luna
max native-child capability; non-implementation steps do not.

## Review structure

Steps ⑥a and ⑥b are a parallel blind-review layer; ⑥c is its only join
successor. Review reports live only in immutable TaskStepOutput/platform output,
never on the chain branch. The first completing reviewer merely persists its
report; it cannot activate adjudication. The control plane activates ⑥c once,
only when both review tasks are `DONE`; retrying a failed branch preserves the
other valid report and re-evaluates the same join.

Both review nodes receive the same immutable implementation base/head and run
from detached checkouts pinned to that range. Sol produces a single integrated
two-axis report. Blind Opus has no route to Sol's report for the lifetime of its
task/session, including after it persists `blind-findings`. The fresh Opus
adjudicator verifies both outputs and their range before reading either one,
then produces a separate `must-fix` report with exactly one disposition for
every finding in the two source reports. It does not resume the blind-review
conversation. P0/P1 findings are must-fix; P2 findings remain recorded.

Luna may write only when the implementation root enforces independent
worktrees, bounded authority, narrow acceptance tests, and root review of risk
boundaries. After repair, the dedicated Sol-medium regression verifier runs in
a fresh session on the repaired head, accounts for the adjudicated must-fix
list over the complete fix diff, and binds the exact accepted head to its
verdict.

## Human approval placement

`Task.approvalGate` is the sole runtime authority for an Agent step. A role persists its output and finishes; the control plane moves a gated task to REVIEW and an ungated task to DONE. An Agent may ask a blocking Product Contract question, but it does not create a second approval request merely because its artifact is a specification or plan.

Place the fewest gates that preserve human judgment:

- Add a specification gate only when ① resolves product behavior, acceptance semantics, or a data-contract ambiguity left open by the approved Product Contract.
- Do not gate ② before independent review. In Full Assurance, put implementation authorization after reviewed-plan closure at ④.
- Keep ⑤, the parallel ⑥a/⑥b layer, ⑥c, ⑦, ⑧, and ⑨ automatic inside approved boundaries.
- The server-owned readiness node and mechanical integrator enforce exact-head authorization before merge. Head, base, required-check, or material-evidence drift invalidates that authorization and stops the mechanical tail.

Direct has no planning gates. Gate selection is recorded at dispatch; an active
Agent does not rewrite it.

## Per-chain routing snapshot

Record this block when creating or materially rerouting a chain:

```text
Routing Contract: v1.2
Tier: Direct
Implementation Agent: senior-dev-luna
Critical: no
Reason: Bounded change; Direct review and exact-head acceptance remain intact.
```

If risk or ambiguity increases during execution, pause before the newly unsafe work and reroute. If rerouting changes a Product Contract boundary, return to the product owner for approval. New work uses the current routing contract; active work keeps its recorded snapshot until explicitly rerouted.

## Merge Integrator

The canonical templates already include the mechanical tail: server-owned merge
readiness follows the librarian (or regression in Direct), then
`merge-integrator` executes only with a current exact-head authorization. The
integrator stops on drift, failed checks, missing PR identity, or conflict; it
does not make an approval decision or silently renew evidence.

Existing chains instantiated before layered scheduling retain their stored
prompts, assignments, runs, sessions, and linear behavior. Canonical sync keeps
the former seven-node Direct and twelve-node Full templates under deterministic
`-legacy-v1` identities rather than rewriting instantiated work. New chains use
the eight-node/seven-layer Direct or thirteen-node/twelve-layer Full graph.
