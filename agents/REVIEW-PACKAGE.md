# 批量过目呈裁件 — 10 角色提示词（DECISIONS #19 管线产物）

产物清单：`agents/foundational.md`（共享底座）、`agents/roles/` 10 角色、`agents/skills/` 2 技能（plan-mode、review-report）、`agents/README.md`（形态契约：frontmatter 与 schema Agent/Skill 字段一一对应，可被 seed 导入）。互盲对照稿存 `agents/.blind-codex/`。

管线执行情况：① writing-for-agents 起草 10 角色 → ② 三承重角色互盲双写（codex exec Sol+high，输入仅 BLUEPRINT 规格原文；产出结构差异明显，无污染信号）→ ③ 其余 7 角色单轮 codex 交叉评审 → ④ 术语与 packages/api 九步实现（templates.ts，已落地）对齐。

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
| review-coordinator | roles/review-coordinator.md | 只派活与合并，绝不自己评/自己改；评审互不见报告；合并规则=去重留 lens、冲突记双方+裁定、严重度看后果、空类别显式声明 |
| feasibility | roles/feasibility.md | 单 lens：能不能建起来；判据=对着真仓核对而非合理性；lens 外只报「导致不可建」的 |
| scope-guardian | roles/scope-guardian.md | 单 lens：与 spec 的贴合，双向抓（creep+shortfall），每条 finding 点名 spec 行 |
| coherence | roles/coherence.md | 单 lens：内部自洽（步骤矛盾/悬空依赖/命名漂移/契约不一致），每条引矛盾两端 |
| implementation-plan-executioner | roles/implementation-plan-executioner.md | 忠实执行不翻案；先通读计划做步骤—代码映射；小失配做最小调整并记录；E2E 属于本步；逐步 commit 引用计划步号 |
| librarian | roles/librarian.md | wiki 对齐真实行为；错页比缺页糟（要删）；只写现状不写沿革；代码与 wiki 冲突以代码为准 |

路由与权限（frontmatter）：按 DECISIONS #6 —— 规划/评审类 model claude；senior-dev、IPE model codex；librarian runner pi + model openai-codex/gpt-5.6-luna。`inboxAccess` 最小授权：default/spec/plan/senior-dev/IPE 有，评审四件套与 librarian 无。collaborators 仅 review-coordinator 非空（三评审员）。

## 互盲分歧项（3 承重角色，逐条呈裁）

一致处已定案合入（senior-dev 两版方向几乎全同：计划服从+有界偏离、must-fix 全清、无关失败记录、阻塞才 inbox；此外从盲写稿吸收了「先通读计划做映射」「空类别显式声明」「重复不升级严重度」「评审独立性」四点一致方向的改进）。以下为实质分歧，未抹平：

### 分歧 1 — IPE 的 inbox 权限与阻塞处置

- **我稿（原）**：`inboxAccess: false`。计划步不可能执行时：继续做剩余独立步，任务停 review，activity 记明阻塞步。理由：BLUEPRINT 的 IPE 原文无 inbox；停滞由 runner 停滞检测兜底。
- **盲写稿**：`inboxAccess: true`。「If the plan is internally contradictory, impossible in the granted repository, or requires a human choice, stop at the narrow blocker, preserve completed valid work, and use the Inbox with concrete evidence and the smallest decision needed to continue.」
- **我的倾向**：采纳授权（true）但合成处置——inbox 报「阻塞步+最小决策」的同时继续做不依赖答案的独立步（与 foundational 的 non-blocking inbox 语义一致）。理由：walk-away 流程里无 inbox 的阻塞=整条链静默卡死到人看板为止；BLUEPRINT §2 也说 inbox 是 stuck 时的唯一打断通道，不限角色。**当前文件已按此倾向落**，若 Leo 裁回 false 改一行即可。

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
