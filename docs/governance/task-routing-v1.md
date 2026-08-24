# Task Routing Contract v1

Version: 1.1

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
- Direct：模板跳步（跳①②③④），保⑤→⑥a→⑥b→⑦→⑥c→⑨，⑧可选；无 spec/plan；实现步用 senior-dev 角色（executioner 硬前提是既存 plan）。
- Full Assurance：全链。

Direct is a formal chain route, not an exemption from review or exact-head human acceptance. Full Assurance is required when the Product Contract calls for specification, planning, plan review, or revised-plan implementation authorization.

## Critical classification

Critical means only that the work touches persisted data or performs an irreversible external action. No other condition makes a task Critical by itself.

Critical is a risk label, not a child-model route. Step ⑤ keeps every native child on Luna max; the Sol-high root must inspect a risk slice's boundary, rollback behavior, and acceptance evidence before integration, and a child cannot perform an irreversible external action. A ⑦ repair diff that touches structural risk uses sol:high. Here, `persisted data` means runtime-created user or system data, including its schema, that must survive a version change. Structural risk means a change to a public interface, persisted data, a component boundary, or a foundational dependency.

## Full Assurance eleven-step final table

This is the target shape of the seeded `compound-engineer-workflow` template and the authoritative chain table for this contract:

| 步 | 角色 | (入口, model, effort) | 要点 |
| --- | --- | --- | --- |
| ① spec | spec | CODEX, sol, high | 根据 Product Contract 产出可供 plan agent 直接执行的完整 specification；人工闸 |
| ② plan | plan | CLAUDE, fable-5, medium | 产物=垂直切片集，一片一文件：{id, title, delivers, blocked_by[], acceptance[], files_hint[]}；切片判据：纵穿全层、独立可演示、单上下文窗装得下；宽重构走 expand→migrate（分批）→contract；plan 会话 session-id 落链分支文件 |
| ③ 计划评审 | review-coordinator | PI, openai-codex/gpt-5.6-sol, high | 作者为 Fable，评审异厂；检查：粒度/依赖边真伪/该合该拆三问、每片「能演示什么」、每条验收判据在基点 commit 为红 |
| ④ 计划修订 | plan-reviser | CLAUDE, fable-5, medium | resume ②会话（同模型同档；显式 session-id，禁 `--last`）；跨链步 resume 实测不通过则新窗读②③产出；不服 findings 须列明理由不得静默略过；实施授权闸在本步后 |
| ⑤ 实现 | executioner | CODEX root 使用 executioner Agent 的 model、reasoning effort 与 service tier；子代理固定 luna, max | 保留 approved slice DAG，root 按实时 dependency frontier 调度，但按上下文与写入所有权组合 assignment，不做一切片一进程；子代理经 multi_agent_v2 spawn，模型固定 luna:max，最多八个 child threads（root 不计），在受控资源上限内尽量填满所有可安全并行的 slots；并发写入者各用独立 worktree，首个结果后保留一个长驻 Luna merger，通常七个 implementers 加一个 merger；结果就绪即依赖安全地合入，无全 wave 屏障；Implementation 只运行 assignment 窄验收、一次 affected-workspace compile 或 typecheck，以及跨 assignment seam tests，不跑 repository-wide suite 或正式 Merge Gate；失败在原 child 做一次有界纠正，再由 root 接管；risk slice 仍可由 Luna 实现，但 root 合入前核查 risk boundary、rollback 与 acceptance，child 禁止不可逆外部动作；整案单次 push，PR 仍由 platform 创建 |
| ⑥a 代码评审（Sol 路） | review-coordinator-sol | PI, openai-codex/gpt-5.6-sol, high | base=⑤启动前冻结 commit，head=⑤记录的结束 commit，审完整 integrated diff；同一会话先完成 Standards pass 并闭合 findings，再单独执行逐项引用治理文本的 Spec pass，合并为一份报告；findings 仅持久化为 TaskStepOutput，不写入或推送链分支 |
| ⑥b 代码评审+终裁（Opus 路） | review-coordinator-opus | CLAUDE, opus-5, medium | workspace 以⑤记录的结束 commit 做 fetch-level isolated detached checkout；claim 以 non-report metadata 提供 immutable base/head；先将独立 Standards/Spec 评审持久化为 intermediate TaskStepOutput，成功写入后才解锁并读取⑥a，再按正典合并矩阵终裁 must-fix 清单（Sol 独报须验证后采纳）；最终报告与 provider session id 仅落 platform output |
| ⑦ 修复 | senior-dev | CODEX, sol, medium | 按封闭 must-fix 清单修；修复 diff 触及任一结构风险升 sol:high（本合同的 product-owner 裁定） |
| ⑥c 回归核销 | regression-verifier | PI, openai-codex/gpt-5.6-sol, medium | 从完整 persisted review package 读取闭合 must-fix、⑥b 终裁与修复结果，对完整修复 diff 做窄范围 semantic verification；语义通过后只运行一次 exact-head mechanical gate，并绑定结构化 verdict；不 resume ⑥b 的 Opus session |
| ⑧ wiki | librarian | CODEX, terra, medium | 自 luna:high 改此（luna:high 违「Luna 一律 max」硬禁令；Terra $2/$12） |
| ⑨ 人工 PR 审查 | 人工闸 | — | 不变 |

In summary, Full Assurance runs specification and planning through implementation, two-route review, must-fix closure, regression verification, optional documentation, and exact-head human PR review. Step ⑤ uses `executioner` because a persisted Plan exists. Direct skips ①–④ and uses `senior-dev-luna` by default at ⑤, while `senior-dev-high` remains an allowed dispatch-time root under the repository routing rules. Either Direct Codex root receives the same platform-pinned Luna max native-child capability; non-implementation steps do not.

## Review structure

Steps ⑥a, ⑥b, and ⑥c form the two-route blind-review flow. Review reports and session records live only in TaskStepOutput/platform output and never on the chain branch. ⑥a independently reviews the integrated diff and persists its findings there. ⑥b receives the immutable implementation base/head as non-report claim metadata and runs from a fetch-level isolated detached checkout pinned to ⑤'s recorded end commit; it completes and persists its own Standards/Spec review before the successful write unlocks ⑥a, then performs final adjudication. After ⑦ closes the must-fix list from predecessor outputs, ⑥c uses the dedicated Sol-medium regression verifier to read the complete persisted review package, verify the complete repair diff, and run the one exact-head mechanical gate that binds acceptance to the verified head.

Luna may write only when the implementation root enforces independent worktrees, bounded authority, narrow acceptance tests, and root review of risk boundaries. Blind review requires the adjudicator to persist an independent review before reading the other route. Findings carry a stable ID, location, evidence, and severity; P0/P1 findings are must-fix. After repair, the dedicated Sol-medium regression verifier accounts for the adjudicated must-fix list over the complete fix diff, and that verified exact head becomes the acceptance target.

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
Routing Contract: v1.1
Tier: Direct
Implementation Agent: senior-dev
Critical: no
Reason: Bounded change; Direct review and exact-head acceptance remain intact.
```

If risk or ambiguity increases during execution, pause before the newly unsafe work and reroute. If rerouting changes a Product Contract boundary, return to the product owner for approval. New work uses the current routing contract; active work keeps its recorded snapshot until explicitly rerouted.

## Merge Integrator

Version 1 ends at ⑨ human exact-head authorization. After the separately governed Merge Integrator is implemented, append a mechanical merge execution step after ⑨ (label ⑩, execution ordinal twelve). The integrator stops on drift, failed checks, or conflict and returns to renewed human authorization; it does not make the approval decision.

Version 1 uses deterministic dispatch-time routing. It does not require a runtime router or a replacement template.
