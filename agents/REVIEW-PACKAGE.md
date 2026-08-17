# 历史批量过目呈裁件 — 原十角色提示词（DECISIONS #19 管线产物）

> **Superseded routing evidence (2026-08-17):** 本件只保存早期 prompt
> 形成与裁决历史，不再定义 active roster、模型、runner、review delegation
> 或模板。当前唯一配置 authority 是 `agents/roles/*.md` 与
> `packages/db/prisma/agent-contract.ts`；当前评审职责以
> `agents/roles/review-coordinator.md` 为准。

历史产物清单：`agents/foundational.md`（共享底座）、当时的 `agents/roles/` 十角色、`agents/skills/` 两技能（plan-mode、review-report）、`agents/README.md`。此数量与下方拓扑均已 superseded；互盲对照稿的关键原文只作为沿革保留。

历史管线执行情况：① writing-for-agents 起草十角色 → ② 三承重角色互盲双写 → ③ 其余角色交叉评审 → ④ 与当时九步实现对齐。该过程不授权复建已删除角色或旧模型路由。

## 裁定（Leo，2026-08-15，审讯 8 问全落）

1. IPE 给 inbox 权限；阻塞时先做完不依赖答案的独立步，再报「阻塞步+最小决策」挂起等恢复；可问范围仅限「计划不可执行/自相矛盾」，设计意见不许问。（挂起语义系事实修正：runner 的 inbox 为 WAITING_INBOX 挂起-恢复机制，不存在边等边干。）
2. 计划评审第四评审员 = 第二次 feasibility pass，coordinator 自行 brief 风险区，不见第一轮报告。
3. 第 6 步代码评审复用 feasibility/scope-guardian/coherence 三件套打 implementation diff。
4. seed 的 Plan 步 `approvalGate` 改回 `false`（照 BLUEPRINT §10），修复归 codex 并行写手。
5. inboxAccess 维持最小名单：default/spec/plan/senior-dev/IPE 有，评审四件套与 librarian 无。
6. skill 仅 plan-mode 与 review-report 两个，不再拆。
7. 互盲过程稿 `agents/.blind-codex/` 删除，原文摘录以本件分歧节为准。
8. seed 读 agents/ 的导入改造压到试点开跑前，暂不动。

## 术语对齐（第 ④ 步）

- 九步实现已落地（`packages/api/src/templates.ts` + seed 模板步骤），运行时按步注入 "Persist the final `<outputKind>` output … through the AgentOS task output endpoint" 与 "Read the prior template steps' persisted outputs"。全部 prompt 的产出侧措辞已从 blueprint 的 attach 改为 **persist as the task's output**，输入侧改为 **provided / prior steps' persisted outputs**。
- 发现一处 packages 侧与 BLUEPRINT 不符（非本票范围，仅呈报）：seed 把第 2 步 Plan 也设了 `approvalGate: true`，BLUEPRINT §10 明确 step 2 no gate。plan 的 role prompt 按 foundational 的门语义写（gated 时只能停 review），两种情形都兼容，但请裁定 seed 是否改回。

## 角色摘要（10）

| 角色 | 文件 | 要点 |
|---|---|---|
| default | roles/default.md | 通用工卒；产出=任务点名的交付物落盘+activity 说明；歧义时 inbox 并按最优解释继续 |
| spec | roles/spec.md | 规格六要素（问题/场景行为/数据接口/边界失败/明确不做/验收方式）；歧义取最简读法并标注 assumption；门约束+就绪即 inbox |
| plan | roles/plan.md | 首轮=spec→编号计划；修订轮=must-fix 全改、should-fix 逐条采纳或一句话拒绝、评审没碰的不动；挂 plan-mode 技能 |
| senior-dev | roles/senior-dev.md | 实现或改评审项；偏离计划须记 activity；must-fix 全清、便宜安全的 should-fix 顺手做；无关失败要记录不背锅；阻塞才 inbox |
| review-coordinator | roles/review-coordinator.md | **历史职责，已 superseded**：当时只派活与合并；当前角色以单会话证据评审为准，不再散子代理 |
| feasibility | roles/feasibility.md | 单 lens：能不能建起来；判据=对着真仓核对而非合理性；lens 外只报「导致不可建」的 |
| scope-guardian | roles/scope-guardian.md | **已删除的历史角色**：其 scope lens 已并入 Review Coordinator |
| coherence | roles/coherence.md | **已删除的历史角色**：其 coherence lens 已并入 Review Coordinator |
| implementation-plan-executioner | roles/implementation-plan-executioner.md | 忠实执行不翻案；先通读计划做步骤—代码映射；小失配做最小调整并记录；E2E 属于本步；逐步 commit 引用计划步号 |
| librarian | roles/librarian.md | wiki 对齐真实行为；错页比缺页糟（要删）；只写现状不写沿革；代码与 wiki 冲突以代码为准 |

当前路由已取代本件早期 frontmatter：Specification Writer 与 Planner = CLAUDE/Fable Medium；Plan Reviser、IPE、Frontend Developer、Senior Developer = CLAUDE/Opus High；Review Coordinator = CODEX/Sol High；Librarian = CODEX/Luna High。具体值与权限只读 `agents/roles/*.md` 和 `packages/db/prisma/agent-contract.ts`；旧的 Codex implementation、PI Librarian、四件套 reviewer 与 delegation 说法均不得用于新任务。

## 互盲分歧项（3 承重角色，逐条呈裁）

一致处已定案合入（senior-dev 两版方向几乎全同：计划服从+有界偏离、must-fix 全清、无关失败记录、阻塞才 inbox；此外从盲写稿吸收了「先通读计划做映射」「空类别显式声明」「重复不升级严重度」「评审独立性」四点一致方向的改进）。以下为实质分歧，未抹平：

### 分歧 1 — IPE 的 inbox 权限与阻塞处置

- **我稿（原）**：`inboxAccess: false`。计划步不可能执行时：继续做剩余独立步，任务停 review，activity 记明阻塞步。理由：BLUEPRINT 的 IPE 原文无 inbox；停滞由 runner 停滞检测兜底。
- **盲写稿**：`inboxAccess: true`。「If the plan is internally contradictory, impossible in the granted repository, or requires a human choice, stop at the narrow blocker, preserve completed valid work, and use the Inbox with concrete evidence and the smallest decision needed to continue.」
- **终裁（见上方裁定 1）**：授权 true，处置顺序=先做完不依赖答案的独立步，再 inbox 挂起等恢复（挂起语义按 runner 实际机制修正），可问范围收窄到不可执行类阻塞。理由：walk-away 流程里无 inbox 的阻塞=整条链静默卡死到人看板为止；BLUEPRINT §2 也说 inbox 是 stuck 时的唯一打断通道，不限角色。

### 分歧 2 — 计划评审的第四评审员来源

- **我稿（原）**：第二次 feasibility pass，brief 指向第一轮覆盖最薄的高危步（与 seed 的 spawnPolicy `[feasibility, scope-guardian, coherence, feasibility]` 一致；BLUEPRINT §10 说「four different review agents」但只点名三个）。
- **盲写稿**：「Use an additional plan-review specialist only when that agent is explicitly named in the runtime collaboration list; never invent an agent identity.」即名册没有第四人就只跑三份。
- **我的倾向**：保留第二次 feasibility pass（否则违背 blueprint 的 four reviews 硬数），但吸收盲写稿的独立性要求：第二 pass 的差异化由 coordinator 自己判断风险区来 brief，**不给它看第一轮报告**（已按此落稿）。代价：两轮 feasibility 可能仍有重叠。备选=盲写稿立场（只跑三份，等名册真加第四 lens）。

### 分歧 3 — 代码评审步（第 6 步）没有专属 code-review specialist 时怎么办

- **我稿（原）**：复用 feasibility/scope-guardian/coherence 三件套对 implementation diff 各走自己的 lens（三个 reviewer 的 prompt 均写成接受 plan 或 diff 两种 artifact）。
- **盲写稿**：「For implementation review, spawn the code-review specialists explicitly provided in the runtime collaboration list. Do not repurpose plan-only specialists as code reviewers.」——但名册 #11 只有 10 角色、无 code-review specialist，此立场下第 6 步 coordinator 无人可派，契约落空。
- **我的倾向**：复用三件套（已按此落稿）。BLUEPRINT 提到的 "code-review specialists" 在名册裁定里不存在，复用是不发明新角色前提下唯一能跑通第 6 步的路。备选=为 v1.1 名册新增 code-review lens 角色（需 Leo 加名册，超本票权限）。

## 交叉评审（其余 7 角色，codex Sol+high 单轮）

spec / feasibility / scope-guardian / coherence / librarian 五角色 clean。3 条 findings 全部采纳修订：

1. `[default]` 缺职责：完成判据只认「文件落在 repo/文件夹」，排除了产出为 MCP 动作等非文件交付的通用任务。已改为「任务要的结果送达其要求的目的地（commit / task output / granted MCP 动作）」。
2. `[plan]` 缺职责：blueprint 要求 plan 写到 task 上（activity），我稿只记了文件位置。已改为 activity 里落 approach summary + step list。
3. `[plan]` 协作矛盾：「change nothing the review did not touch」一刀切会挡住 must-fix 修复必然牵连的连带改动。已改为「除 findings 外只改其修复所迫使的连带处，且在 activity 点名」。

评审判据四类（缺职责/越权/协作矛盾/路由冲突）中，越权与路由冲突为零。
