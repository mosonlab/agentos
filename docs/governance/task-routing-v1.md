# Task Routing Contract v1

Version: 1.0

Status: Active

## Applies to

This contract governs the design, creation, dispatch, and routing of AgentOS tasks, task chains, and task templates. Every runnable task or chain requires one versioned Product Contract; a chain does not create a separate contract per step.

## Authority boundaries

The Product Contract fixes the objective, scope, acceptance criteria, evidence, risk boundaries, stopping conditions, and dependencies. Within those boundaries, the dispatcher and execution chain may choose implementation details.

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

Incidental work done directly in the current session is not a runnable task. The Product Contract requirement applies starting with the Direct tier.

Choose the shortest tier that satisfies the Product Contract. This contract defines three tiers:

- 顺手小活：本窗直接做，不上看板。
- Direct：模板跳步（跳①②③④），保⑤→⑥a→⑥b→⑦→⑥c→⑨，⑧可选；无 spec/plan；实现步用 senior-dev 角色（executioner 硬前提是既存 plan）。
- Full Assurance：全链。

Direct is a formal chain route, not an exemption from review or exact-head human acceptance. Full Assurance is required when the Product Contract calls for specification, planning, plan review, or revised-plan implementation authorization.

## Critical classification

Critical means only that the work touches persisted data or performs an irreversible external action. No other condition makes a task Critical by itself.

Critical is a risk label, not an implementation-role route. It tightens effort under the active tier: a ⑤ slice that touches persisted data or performs an irreversible external action uses sol:high, and a ⑦ repair diff that touches structural risk uses sol:high. Here, `persisted data` means runtime-created user or system data, including its schema, that must survive a version change. Structural risk means a change to a public interface, persisted data, a component boundary, or a foundational dependency.

## Full Assurance eleven-step final table

This is the target shape of the seeded `compound-engineer-workflow` template and the authoritative chain table for this contract:

| 步 | 角色 | (入口, model, effort) | 要点 |
| --- | --- | --- | --- |
| ① spec | spec | CLAUDE, fable-5, medium | 不变；product owner 与 Fable 对话产出；人工闸 |
| ② plan | plan | CLAUDE, fable-5, medium | 产物=垂直切片集，一片一文件：{id, title, delivers, blocked_by[], acceptance[], files_hint[]}；切片判据：纵穿全层、独立可演示、单上下文窗装得下；宽重构走 expand→migrate（分批）→contract；plan 会话 session-id 落链分支文件 |
| ③ 计划评审 | review-coordinator | CODEX, sol, high | 作者为 Fable，评审异厂；检查：粒度/依赖边真伪/该合该拆三问、每片「能演示什么」、每条验收判据在基点 commit 为红 |
| ④ 计划修订 | plan-reviser | CLAUDE, fable-5, medium | resume ②会话（同模型同档；显式 session-id，禁 `--last`）；跨链步 resume 实测不通过则新窗读②③产出；不服 findings 须列明理由不得静默略过；实施授权闸在本步后 |
| ⑤ 实现 | executioner | CODEX 父会话 sol, medium + 子代理 luna, max | 切片逐片按正典入口 (a)/(b) 路由（链即入口 (b) 结构），触及 persisted data 或不可回滚外部动作的切片改 sol:high；父会话按 blocked_by 拓扑分层 wave 调度，同 wave 并行，每子代理一 worktree，屏障处串行合入并跑测试，整案单次 push；子代理经 multi_agent_v2 spawn 且档位写死。fan-out 启用 hard gate（先实测：spawn schema、子代理 model/effort 生效证据、worktree 创建/回收、并发上限、失败清理），任一项不可证明则过渡态=逐片 luna:max 串行（一片一新进程） |
| ⑥a 代码评审（Sol 路） | review-coordinator-sol | CODEX, sol, high | base=⑤启动前冻结链 head，head=⑤交付 head，审完整 integrated diff；`codex exec review`，custom prompt 注入 Fowler smell 基线与「Spec 轴每条 finding 引 spec 原文」；findings 按正典 finding 结构落 docs/reviews/<chain>/sol-findings.md 并推链分支 |
| ⑥b 代码评审+终裁（Opus 路） | review-coordinator-opus | CLAUDE, opus-5, high | 盲审：先独立完成两轴评审（Standards/Spec）并落盘，再读⑥a，按正典合并矩阵终裁 must-fix 清单（Sol 独报须验证后采纳）；session-id 落链分支文件 |
| ⑦ 修复 | senior-dev | CODEX, sol, medium | 按封闭 must-fix 清单修；修复 diff 触及任一结构风险升 sol:high（本合同的 product-owner 裁定） |
| ⑥c 回归核销 | review-coordinator-opus | CLAUDE, opus-5, high | 对全部 must-fix 修复 diff 整体回归核销（exact-head=人工验收对象）；优先 resume ⑥b（显式 session-id），实测不通过则独立新窗 |
| ⑧ wiki | librarian | CODEX, terra, medium | 自 luna:high 改此（luna:high 违「Luna 一律 max」硬禁令；Terra $2/$12） |
| ⑨ 人工 PR 审查 | 人工闸 | — | 不变 |

In summary, Full Assurance runs specification and planning through implementation, two-route review, must-fix closure, regression verification, optional documentation, and exact-head human PR review. Step ⑤ uses `executioner` because a persisted Plan exists. Direct skips ①–④ and uses `senior-dev` at ⑤.

## Review structure

Steps ⑥a, ⑥b, and ⑥c form the two-route blind-review flow. ⑥a independently reviews the integrated diff. ⑥b completes and persists its own Standards/Spec review before reading ⑥a, then performs final adjudication. After ⑦ closes the must-fix list, ⑥c verifies the complete repair diff and binds human acceptance to the verified exact head.

Luna may write only when the dispatch route's safeguards and rollback conditions have been verified. Blind review requires the adjudicator to persist an independent review before reading the other route. Findings carry a stable ID, location, evidence, and severity; P0/P1 findings are must-fix. After repair, the adjudicator verifies the complete must-fix diff, and that verified exact head becomes the human-review target.

## Human approval placement

`Task.approvalGate` is the sole runtime authority for an Agent step. A role persists its output and finishes; the control plane moves a gated task to REVIEW and an ungated task to DONE. An Agent may ask a blocking Product Contract question, but it does not create a second approval request merely because its artifact is a specification or plan.

Place the fewest gates that preserve human judgment:

- Add a specification gate only when ① resolves product behavior, acceptance semantics, or a data-contract ambiguity left open by the approved Product Contract.
- Do not gate ② before independent review. In Full Assurance, put implementation authorization after reviewed-plan closure at ④.
- Keep ⑤, ⑥a, ⑥b, ⑦, ⑥c, and ⑧ automatic inside approved boundaries.
- Require ⑨ exact-head human authorization before merging a pull request or performing a public, production, destructive, migration, or restore action. Head, base, required-check, or material-evidence drift invalidates that authorization.

Direct normally has only ⑨ when it opens a pull request. Gate selection is recorded at dispatch; an active Agent does not rewrite it.

## Per-chain routing snapshot

Record this block when creating or materially rerouting a chain:

```text
Routing Contract: v1.0
Tier: Direct
Implementation Agent: senior-dev
Critical: no
Reason: Bounded change; Direct review and exact-head acceptance remain intact.
```

If risk or ambiguity increases during execution, pause before the newly unsafe work and reroute. If rerouting changes a Product Contract boundary, return to the product owner for approval. New work uses the current routing contract; active work keeps its recorded snapshot until explicitly rerouted.

## Merge Integrator

Version 1 ends at ⑨ human exact-head authorization. After the separately governed Merge Integrator is implemented, append a mechanical merge execution step after ⑨ (label ⑩, execution ordinal twelve). The integrator stops on drift, failed checks, or conflict and returns to renewed human authorization; it does not make the approval decision.

Version 1 uses deterministic dispatch-time routing. It does not require a runtime router or a replacement template.
