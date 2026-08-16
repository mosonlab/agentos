# 对标补齐决议（2026-08-15，grilling 定案）

经两轮 /grilling（前夜需求对齐 + 本日 17 项终审）达成的全部共识。本文档是唯一决议源；执行清单见 `docs/BACKLOG-V2.md`。内部分析文档保持中文（语言政策见 §2）。

## 1. 产品定位与开源

- **单用户自托管**工具，与原版同构：每人跑自己的一套，不做多租户/用户系统（Admin 页维持不做）。
- **将开源，License = MIT**（所接组件均 MIT/Apache，无传染冲突）。
- 开源第一版定位：可用 + 可自行修改，不追求全渠道全功能。
- 秘密卫生已查证干净（.env 从未入库、无历史 token），开源前无需洗 git 历史。

## 2. 语言政策

| 范围 | 语言 |
|---|---|
| 代码 / 注释 / commit / agent 提示词 / 种子数据 / README 与用户文档 | 英文 |
| UI 默认语言 | 英文（zh 走字典切换，Leo 日常用中文） |
| 飞书卡片等出站文案（现有 2 处硬编码中文） | 英文化 |
| docs/reference 内部分析文档 | 中文，不迁移；发布前再定是否随仓库公开 |

现状：agent 提示词（`agents/foundational.md`、`agents/roles/*.md`）已全英文，政策一半已成事实。

## 3. 前端底座（推倒时机：现在，历史最低成本点）

- **保留** React 19 + Vite 7；**新增** Tailwind v4 + shadcn/ui（明暗主题走 shadcn 主题令牌，现有 ~45 个 CSS 变量色值映射为自定义主题）。
- **不加**路由库与状态管理库（单人应用，手写导航 + fetch + 轮询足够）。
- 开源组件三件（均按批次到货再装）：`@uiw/react-md-editor`（Skills）、SVAR React File Manager（Files UI）、SurveyJS 渲染层（Inbox 问卷；Creator 商业版不用）。
- 存量 8 页迁移入批次 0；亮色模式不再手写 45 变量覆盖组，随主题令牌落地。
- i18n 方案不变（zh/en 字典 + context hook，~548 处字符串，机械代理批量抽取），与底座切换正交。

## 4. 路径与文件存储

- `~/.agentos/`：隐藏，机器自管（runs 工作区、logs、cache）。runner 现 `RUNNER_WORKSPACE_ROOT=/tmp/agentos-runs` 迁此。
- `~/Documents/agentos/`：明处 Files Root，`_global/` + `<项目名>/`。
- 代码仓库原位不动；`AGENTOS_FILES_ROOT` 死配置（查证零引用）删除。
- **存储介质 = 本地磁盘**（不用 R2）；但按 §6 留**存储薄接口**，将来可切 R2/S3。
- MCP 访问接口与服务端权限校验照原版结构：`FilesystemGrant` + `inside()`。
- `frames/`（36MB 截图）已 gitignore，markdown/JSON 全入库。✅ 已执行

## 5. 数据库

- Postgres（`DATABASE_URL`），现状健康：模型完整、无死路由、180 测试文件。
- 原则（Leo 授权按此执行）：**schema 改动跟随所属批次、每批独立 migration，不做一次性大重设计**。
- 已定改动：Inbox 表单重构（§7）、删除死模型 `Trigger` / `Automation` / `InboxConnectionWindow`（批次 2 顺手）、`FileObject` 在 Files 批次自由重设计。

## 6. 可插拔接缝（只在确定会换的边界交抽象税）

1. **通知渠道适配器**：`packages/inbox` 抽 `NotificationAdapter` 接口，飞书为其一实现；`InboxChannel` 枚举去硬编码。**只做接口 + 飞书实现**，Slack/Telegram/邮件留给社区/后续。
2. **Files 存储接口**：本地盘先行，R2/S3 留位。
3. 已天然可插、不再加抽象：runner 后端（`CLAUDE|CODEX|PI` 枚举 + 适配器）、模型路由（per-agent DB 字段）。
4. 设计哲学（半年后视角）：不把今日模型短板焊进架构；护栏（预算/闸门/熔断/审批）往厚做，它们比模型能力长寿；模型 ID 只准出现在配置。

## 7. Inbox 结构化问卷（推倒重写，不留双轨）

- 废除 `kind: TEXT|MULTIPLE_CHOICE` + `choices` + `selectedChoiceId`，一切提问统一为表单：
  - `InboxMessage.form = { questions: [{ id, title, body?, type: single|multi|text, options: [{id, label, description?, recommended?}], allowOther }] }`
  - `InboxDecision.answers = { [questionId]: { choiceIds: [], otherText? } }`
- 前端分页渲染 + 进度 + Back/Next + Recommended 高亮 + Other；不做条件分支（保持平铺）。
- 一次性迁移脚本转存量数据。波及面已查清（4 处）：API decision 端点、workflow 校验、Inbox.tsx、飞书卡片投递。

## 8. Goals 协调器（自研，"睡觉时系统自己跑"）

- 原版为 AgentOS 内建自研（与 Claude/Codex 官方 `/goal` 命令无关，同名撞车；实现细节视频未披露，仅行为可见）。
- **行为对齐原版**：Goal 详情页加 DoD 清单（生成→Leo 确认→自动打勾）+ Orchestrator 事件流标签页（`Routed iteration N → <agent> (phase)`）+ 迭代计数 + 预算条。
- **机制**：API 内路由循环——goal 关联 session 结束 → 路由判定读 DoD 状态 + progress log + session 摘要 → 输出 `{action: dispatch|complete|stuck, agent, prompt, dodUpdates}` → 走现有 Task 入队。
- **系统 Agent 规矩**（2026-08-15 补充定案）：路由判定（`orchestrator-router`）与 DoD 生成（`dod-generator`）均注册为**系统 Agent**（标记 system、不可派发、只做决策），模型/推理档位在 Agents 页统一配置（初始 Luna 级廉价档）。今后任何常驻模型调用一律照此注册为系统 Agent，禁止硬编码模型名。
- **Phase-gating 为硬规则**（plan → plan review → implementation，未过闸不给下游 agent 入路由候选）。
- **护栏三条**（判定细节参考 pi-goal 并跟进其更新：勾选须逐条证据、弱证据=继续、3 轮无进展熔断）：最大迭代数、预算上限（costUsd 累加）、零进展判 stuck → 发 Inbox 问 Leo。
- **不引入**：官方 `/goal`（单 session 作用域，V1 不需要，将来作 session 内防泄气的可选优化）、LangGraph/CrewAI（与 runner 架构冲突）。

## 9. Costs

- 后做。届时先评估 cc-switch（Leo 在用，能看按日期的历史 token 消费；但分不出 per-agent/goal 归因）；总账视角够用即零成本，需要归因再自研：Prisma groupBy 聚合 API + Recharts 三图（时间趋势 / agent·模型堆叠柱 / Top runs），约 2-3 人天，零新增基建。
- 不接 Helicone（2026-03 起维护模式）、不上 Langfuse（自托管栈过重）；将来要 prompt 级 trace 再评估 Langfuse。

## 10. 17 项分档终审（全部通过）

- **做**：1 Sessions 查看器（自研，参考 Langfuse trace 树；发消息后置）· 2 Tasks 三件套 · 4 Templates（{{var}}+From template 预览+九步链种子模板）· 5 协调器（§8）· 7 Skills 页（接 md-editor）· 8 Settings+侧栏全局区
- **简化做**：3 Files（§4）· 6 Activity 流（shadcn Timeline，轮询）· 9 Env/Repos CRUD · 10 Connections 重写（96 行页整页重做；参考 MCP Inspector）· 11 Inbox 问卷（§7）
- **后做**：12 YAML+CLI（**Phase 1 export/import 因开源提前进长尾**——兼作种子 agent 发行载体；Phase 2 diff/pull/push、Phase 3 task 创建维持远期）· 13 Costs（§9）· 14 PWA · 15 Knowledge（视频仅导航项+Librarian 线索，无对标物）
- **不做**：16 Admin · 17 本地/云 Runner 混合路由
- 原版技术盘点结论：他基建全买现成（Managed Agents SDK/R2/Hetzner/MongoDB），业务层全自研（API/Orchestrator/数据模型）；前端未披露。我方自研面与其高度重合，无错位。

## 11. 遗漏补入项

- **Agents 页模型/推理等级下拉**（Leo 点名）：claude/codex 模型下拉 + 推理等级下拉，字段已有，纯 UI → 批次 1。
- **开箱体验**（开源生死项）→ 开源发布批次：英文 README+quickstart、docker-compose（Postgres 必需）、种子 agent YAML、runner 安全显著警示（裸机执行任意命令）+ 远程访问文档（走反向代理/Tailscale；鉴权已有 operator/runner/session 三态 token，无需新登录系统）、`pg_dump` 备份文档。
- **Agent 长期记忆**（原版 `memoryEnabled`）：真实缺口，记入远期。

## 12. 执行方式（dogfood）

- 用 AgentOS 开发 AgentOS：批次任务写成 spec 投喂系统，spec→plan→执行链走现有 Tasks/闸门；批次 2 前链式推进手动放行，批次 5 后 Goal 全自动。
- **自举隔离**（无需另行克隆）：平台实例跑 master 工作副本；agent 在 runner 工作区的独立克隆里开发并提 PR，互不冲突。合并后空闲时重启平台吃进新版（含 migration）；批次 0 这类大改动选无 run 在跑时合并。
- **单链定义**（2026-08-16 终版：废除轻/重链之分，一条链照抄原版九步；落地为一个种子 TaskTemplate，小任务由模板跳步解决，编排归模板不归阵容）：
  ① spec(fable:medium)＋闸门 → ② plan(fable:medium)＋闸门 → ③ 计划评审 review-coordinator(sol:high/CODEX，单会话三镜片：可行性/范围/一致性＋一次重点复查，跨厂商天然成立) → ④ plan 新会话按评审修订 → ⑤ 实现 executioner(sol:medium) → ⑥ 代码评审 review-coordinator → ⑦ senior-dev(sol:high) 修复 → ⑧ librarian(luna:xhigh/CODEX) 更新 wiki → ⑨ 人审 PR 合并。
  - **卡点只有两处＋终审**（2026-08-16 对照原版视频修正）：闸门仅在 ① spec 与 ② plan（与原版 Approval 徽章 1:1）；③–⑧ 全自动流转不再请示，人最后在 ⑨ 用 PR 审查兜底。修订步原多设的一道闸已删。
  - **阵容收敛至 7**（与原版视频执行者 1:1）：default/spec/plan/review-coordinator/executioner/senior-dev/librarian。plan-reviser、scope-guardian、coherence 已删除；feasibility 因有任务历史外键暂不可删，退役搁置（催生"agent 归档/下线"需求）。三个评审镜片并入 review-coordinator 提示词（`agents/roles/review-coordinator.md` 已重写，不再散子代理，因此可跑 Sol/CODEX）。
  - 实战依据：2026-08-16 首单 Sol 单会话评审（批次 0 SPEC）未散子代理即产出 6 条带代码证据的 must-fix，证明单审质量足够，多代理评审矩阵为过度设计。
- **模型额度策略**：Fable 只用于 plan 步（全链质量杠杆最大处）；spec 与 review-coordinator 降 opus-5:high；实现层 Sol（Luna 待验证能力后再回归）；批次间可按代码冲突面并行（前端批次等批次 0，后端批次可即行）。
- 每个 agent 所用模型在批次 1 的下拉做好后由 Leo 统一复核调整。
- 模型路由备忘：Luna(gpt-5.6-luna) 机械批量、**一律显式 max**；Sol(gpt-5.6-sol) 语义校验 high+；升级链 Luna→Sonnet→Opus；spawn 必显式指定 model（钩子强制）。
- **前端链评审例外**（2026-08-16 Leo 裁决，frontend-convergence 链 plan 闸门时定）：**前端批次的 ⑥ 代码评审用 `code-reviewer`（claude-opus-5:high / CLAUDE），不用 `review-coordinator`（Sol）。** 跨厂商对写规则在前端批次让位——主题是 CSS 层叠层级、Tailwind v4 任意值、视觉一致性，Opus 侧读得更准。代价是 ⑤ 与 ⑥ 同厂商，独立性只剩"不同 agent 不同提示词"这一层，因此**评审任务书里必须写明这是同厂商评审**，并要求评审员不把计划、实现者的提交信息与活动日志当依据，一切从 diff 和文件本身重新推导、实现者声称通过的检查一律自己重跑。③ 计划评审仍用 Sol（审的是文档不是 CSS，跨厂商在那里仍然划算）。**新建前端链时必须手动指定 ⑥ 的 assignee，不能沿用默认。** `code-reviewer` 已补 `GIT_WRITE`（评审步要提交推送评审文档）。
- **推理等级校准**（同上裁决）：`frontend-dev` 由 `claude-opus-5:xhigh` 降为 `:high`。原 xhigh 来自 Fable 配额耗尽后的"原用 Fable 处一律换 opus-5:xhigh"替换规则，是产物不是校准结果；前端实现绝大部分是照计划对照表做机械替换，难的判断在 ② plan 已经做完。**xhigh 保留给 ④ plan 修订**（要把评审发现与闸门裁决揉回长计划、还要判断驳回哪些，是链上判断密度最高且只跑一次的一步）。
- **配置生效时机**（`packages/db/src/workflow.ts:41-43`）：run 的 `model`、`runner`、`promptHash`（含 `task.description`）是在**前一步完成、`activateChainSuccessor` 创建下一步 run 的那一刻**才从 agent 记录与任务行读取的，不是建链时定死。因此链跑到一半仍可改尚未起 run 的步骤的 assignee/模型/任务书，改动会生效；已在跑或已完成的步骤不受影响。

## 13. 权限与可观测性裁决（2026-08-16 二轮查漏定案）

- 执行面审计结论：真执行的只有 repo 白名单与 secret 注入；filesystem grants、每 agent MCP 开关、GIT_READ/WRITE、Environment networking 均为未接线的 DB 元数据。
- **裁决**：不做应用层权限强制/沙箱——真隔离走 OS 层（受限 macOS 用户运行 runner，推荐；或 `RUNNER_RUN_AS_PREFIX` 套 Docker），开源批次做未执行项的 UI 诚实标注。**MCP 连接真注入单独保留**（长尾）：定性为功能补缺而非权限工程。
- 可观测性：批次 4 提前（批次 0 合并后与批次 1 并行首发），范围扩为对齐原版会话画面（渲染消息流/统计条/Files touched/run 级 Cost·Tokens/产出 Markdown 渲染），原始事件流收进折叠 Debug 视图。
- runner 并发做成配置项，默认自适应 `min(核数-1, 内存GB/4)`、下限 2；并发数=同时跑的 run 数。

## 14. 记账

- 本决议对应执行清单：`docs/BACKLOG-V2.md`（新开对标批次文件）。
- `docs/BACKLOG.md`（pilot 驱动 V1.5）不动，其三条挂账（一链一 PR 历史链、闸门富渲染、WIP 分支回收）留在原处。
