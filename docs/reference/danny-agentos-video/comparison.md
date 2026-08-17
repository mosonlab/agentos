# 原版 AgentOS（Danny Postma）× 本项目 功能对比与补齐建议

> 依据：26 分钟演示视频逐段分析（15 份经 Sol 校验的模块记录，见 `records/`；截图见 `frames/`；时间轴见 `segments.json`）× 本仓库现状盘点（2026-08-15）。
> 排序：按「日常单人使用价值 > 补齐核心闭环（可观测性）> 门面功能」，同价值按成本升序。
> 结论口径：**做 / 简化做 / 后做 / 不做**。"最佳方案"仅对 做/简化做 给出。

---

## 优先级总览

| # | 差距项 | 价值 | 成本 | 结论 |
|---|--------|------|------|------|
| 1 | Sessions 会话查看器 UI | 高 | 中 | 做 |
| 2 | Tasks 收尾三件套（cron 执行、webhook 触发器、链式自动推进） | 高 | 低中 | 做 |
| 3 | Files 文件模块（含路径设计落地） | 高 | 中 | 简化做 |
| 4 | Templates 管理 UI + 变量展开 | 高 | 中 | 做 |
| 5 | Goals 协调器（orchestrator 自动派下一轮） | 高 | 高 | 做 |
| 6 | Activity 全局活动流 | 中高 | 低中 | 简化做 |
| 7 | Skills 管理页 | 中高 | 低中 | 做 |
| 8 | 侧栏全局区（Runner 状态、项目徽标、Settings 页） | 中 | 低 | 做 |
| 9 | Environments / Repos 管理 UI | 中 | 低中 | 简化做 |
| 10 | Connections(MCP) 页增强 | 中 | 低 | 简化做 |
| 11 | Inbox 结构化问卷（多选+推荐项+进度） | 中 | 中 | 简化做 |
| 12 | YAML 配置化 + CLI 同步 | 中高 | 高 | 后做（分阶段） |
| 13 | Costs 费用面板 | 中 | 中 | 后做（接开源，用户已定） |
| 14 | Inbox 移动端 PWA + 推送 | 中 | 高 | 后做 |
| 15 | Knowledge 知识库 | 低中 | 中 | 后做 |
| 16 | Admin 管理台（超出 Secrets 的部分） | 低 | 中 | 不做 |
| 17 | 本地/云 Runner 混合路由（Grok worker 等） | 低（单人场景） | 高 | 不做 |
| — | i18n 中英切换 / 亮色模式（原版没有，本项目自主需求） | — | 低 | 已定案，方案见 grilling 共识 |

---

## 逐项明细

### 1. Sessions 会话查看器 UI —— 做
**原版做法**（`records/Activity/record.md`，帧 16:12–16:45）：Sessions 列表（开始时间/任务/时长/状态/结果/`local` 环境标签/Refresh）；点进单会话：`Live` 徽标、消息数/工具调用数（示例 293 tool calls）/涉及文件数、`Files touched` 折叠区、实时消息流（代理文本、代码片段、工具调用参数、read_file 路径与返回）、**底部输入框可直接向运行中的代理发消息**。
**我方现状**：数据层完备（`Session`+`SessionEvent` 每会话 250+ 事件全量入库，schema:667-712），**无任何 UI**（无 /sessions 路由）。
**差距**：纯 UI 缺失，数据白采了。
**最佳方案**：新增 Sessions 页 + 会话详情页，轮询 `/runs/:runId/events` 渲染消息流；tool call 折叠展示；`Files touched` 从事件聚合。"向运行中代理发消息"可后置（依赖 runner 支持注入，先做只读查看即可覆盖 80% 价值）。

### 2. Tasks 收尾三件套 —— 做
**原版做法**（`records/Tasks/record.md`）：Recurring cron 任务真实执行（Automations 列表含 Last Run/Recent sessions）；触发器 webhook 实际接收外部事件（客服 webhook Fires 601 次，Replay window、Default variables、First-task auto-start）；任务链批准后自动解锁下一步（九步链自动流水）。
**我方现状**：模型全有（scheduleKind/cron/Trigger/chainId），但 **cron 执行未接线、webhook 缺密钥校验、follow-up 需手动 enqueue**。
**差距**：都是"最后一公里"的接线活。
**最佳方案**：① scheduler 轮询 cron 到期任务入队；② webhook 路由加 secret 校验 + payload→变量映射；③ 任务完成/批准时自动将 `chainIndex+1` 置为 TODO。三件都是小改动，收益是自动化闭环真正跑起来。

### 3. Files 文件模块 —— 简化做（含路径设计落地）
**原版做法**（`records/Files/record.md`，帧 06:57–07:59）：Files 页按 Project/Global 作用域浏览 Root 层级；名称/Size/Modified 列 + `...` 菜单；New Folder/New File/Upload；内置编辑器（Markdown 查看/编辑/Preview/Download/Save/未保存离开确认）；面包屑 + 路径复制；**权限模型：agent 只能访问指定文件夹、读写分离（可写不可删）、操作走 MCP、服务端校验拦截**；存储用 Cloudflare R2。
**我方现状**：仅 `FileObject` 模型 + task output 上传端点；无 UI、无上传、无权限执行、`AGENTOS_FILES_ROOT` 死配置。
**最佳方案（=路径设计最终提案，待拍板）**：不用 R2，本地磁盘版：
```
~/.agentos/                      # 隐藏：机器自管（runs 工作区 / logs / cache）
~/Documents/agentos/             # 明处：AGENTOS_FILES_ROOT 落地点（Files 模块的 Root）
├── _global/                     #   Global 作用域
└── <项目名>/                    #   Project 作用域（files/、knowledge/ 预留）
```
代码仓库不动（`~/Documents/claude_projects/`）。Files 页做浏览/上传/编辑/下载；权限沿用现有 `FilesystemGrant` 模型（folderPath 字段已存在但未启用），MCP 文件操作走服务端 `inside()` 校验（该函数已有）。与原版结构等价，仅存储介质换本地磁盘。

### 4. Templates 管理 UI + 变量展开 —— 做
**原版做法**（`records/Templates/record.md`）：From template 建任务时选模板（显示任务数如 "22 tasks"），填 `{{feature_description}}`/`{{branch_name}}` 等变量，`Will create` 预览将创建的任务树；模板 YAML 用 `include` 复用子模板、`parent`/`unblocked_by` 表依赖、`requires_approval` 设审批门、并行 review 组。
**我方现状**：`TaskTemplate`+`TaskTemplateStep`+instantiate API 已有；**无 UI、无变量展开、无种子模板**。
**最佳方案**：① prompt 中 `{{var}}` 替换（instantiate 时传入 variables）；② 建任务弹窗加 "From template" 分支 + Will create 预览；③ 照原版 Compound Engineering Workflow 造一个种子模板。**2026-08-17 supersession:** 完整链的当前角色/模型以 `packages/db/prisma/agent-contract.ts` 为准，Plan Reviser 是 CLAUDE/Opus High，不再使用本比较稿早期的 Sol 分配。模板编辑器可后置，先 JSON/DB 手工维护。

### 5. Goals 协调器 —— 做
**原版做法**（`records/Goals/record.md`，19:10–20:57）：DoD checklist 驱动开放循环；Orchestrator 标签页展示事件流（Dispatched / Routed / Session completed – router re-evaluating）；协调器依据 progress log+DoD+实现内容自动选下一位 agent；phase-gating（Plan→Plan Review→Implementation）；日常节奏"早上给规格、跑数小时、晚上审 PR"。
**我方现状**：Goal/DoD/进度日志/护栏（spendCap 等）全有，**缺协调器决策逻辑**（无自动派发下一轮、无自动勾 DoD）。
**最佳方案**：一个 orchestrator 会话循环：session 结束→用小模型读 progress log+DoD→输出 {下一个 agent, 任务 prompt, 或判定完成/卡住}→入队。护栏字段现成，接上即可。这是原版最核心的"睡觉时系统自己跑"能力。

### 6. Activity 全局活动流 —— 简化做
**原版做法**：Activity 页 = 跨任务的实时动态流。**我方现状**：`TaskActivity` 有数据、无全局页。
**最佳方案**：新增 /activity 路由，聚合查询近期 TaskActivity+Session 状态变化，倒序时间线；轮询刷新即可，不做 websocket。

### 7. Skills 管理页 —— 做
**原版做法**（`records/Skills/record.md`）：Skills 页查看/编辑/发布技能，`/plan` 式 invocation slug，Display Title、`Available in all projects` 开关；技能本体是 `SKILL.md`（Markdown + YAML front matter），可附文件。
**我方现状**：Skill 模型（PROMPT/FILE）+绑定 API 有；无独立管理页（只能在 Agent 详情里绑定），无编辑器。
**最佳方案**：新增 /skills 页：列表+Markdown 编辑器+发布状态；沿用现有 kind 字段；文件技能上传后置。

### 8. 侧栏全局区 + Settings 页 —— 做
**原版做法**（帧 3.png 等）：侧栏顶部项目切换器（图标+名称+未读徽标），Inboxes 徽标；底部 Runner（绿点 Running）/Settings/Sign out。
**我方现状**：7 项导航，"Settings" 错链到 /secrets，无 Runner 状态显示，无徽标。
**最佳方案**：① 新建真正的 Settings 页（承载语言/主题切换 + runner 信息）；② 侧栏底部加 Runner 在线状态（API 已有 heartbeat 数据）；③ Inbox 未读数徽标（一个 count 查询）。与 i18n/亮色模式同批实施。

### 9. Environments / Repos 管理 UI —— 简化做
**原版做法**：Environments 编辑页（pip/npm 包、Unrestricted/Limited 网络、allowed hosts、Allow MCP servers/package managers 开关、仓库 .env 文件挂载）；Repos 页（URL/Mount Path/Description/Credential Key 引用/Available in all projects）。
**我方现状**：两者 DB+API 完整，无 UI。
**最佳方案**：各一个简单 CRUD 页（表单直接映射现有字段）。pip/npm 包配置我方模型没有，暂不加字段，用 init script 顶。

### 10. Connections(MCP) 页增强 —— 简化做
**原版做法**（`records/MCP/record.md`）：Global(org-level)/Project-specific 作用域、Profile（如 "PR only"）、可用仓库列表、Last verified、Update Token、Disconnect。
**我方现状**：Connections.tsx 仅 96 行列表，无 config 编辑。
**最佳方案**：加连接编辑表单（transport/config/allowedOperations/凭证引用），显示作用域。Last verified/Profile 属锦上添花，后置。

### 11. Inbox 结构化问卷 —— 简化做
**原版做法**（`records/Inboxes/record.md`）：多题问卷（每题多选项+说明+黄色 Recommended+Other 自定义+`Question 1 of 2` 进度+Back/Next/Submit）；开放问题阻塞任务并显示 `blocked on you`；回复后代理立即恢复（实测往返演示）。
**我方现状**：InboxMessage/InboxDecision 支持单条选择题和文本回复；无多题问卷、无 Recommended 标注、无进度。
**最佳方案**：扩展 decision payload 为题目数组（含 recommended 标记），前端分页渲染。阻塞/恢复机制已有。

### 12. YAML 配置化 + CLI —— 后做（分阶段）
**原版做法**（`records/架构_技术栈讲解`、`records/Agents`、`records/Repos`）：`.agentos/agents/*.yaml` 定义代理全量配置（slug/model/tools/skills/mcpConnections/spawnableAgents/maxNestingDepth/memoryEnabled/environment/repos/initScripts/system）；技能为 `SKILL.md`；`agentos` CLI：auth/init/pull/push/status/diff/task，可从本地 Claude 讨论直接创建目标/会话并携带上下文、自动选代理。
**我方现状**：`Project.yamlDocument` 空字段 + CLI stub（437 字节）。
**建议路径**：Phase 1 只做 `export/import`（DB↔YAML 双向序列化，先解决"配置可版本化"）；Phase 2 做 diff/push/pull；Phase 3 做 `task`/目标创建。价值真实（配置进 git、本地编辑），但工程量大，不阻塞前面各项。

### 13–15. 后做项
- **Costs**（`records/Costs`、`records/Runner`）：原版有时间范围筛选、总支出、按日堆叠柱状图（按 agent/model 分组）、Cost/Runs/Avg-run/Cache-hit 表、Top runs、目标级 Spend cap（我方 spendCap 已有）+ Session budget/Grace period。用户已定：后做，优先接现成开源计费面板，我方 `costUsd` 字段可直接喂数。
- **Inbox PWA + 推送**：原版移动端卡片流+底部导航+系统推送。价值真实（离开电脑处理阻塞），但 PWA+Push 基建成本高，等桌面闭环稳定后再做。
- **Knowledge**：视频里只出现导航项和 wiki 提及（Update wiki 子任务），信息量不足以指导设计，等原作者后续内容或自身需求明确再做。

### 16–17. 不做项
- **Admin 管理台**：单人自用，Secrets 页已覆盖实际需求；多用户权限/审计属过度设计。
- **本地/云 Runner 混合路由**（Plan agent runtime=Claude / Worker runtime=Grok、忙时回退云端等）：原版为省 $500/天 API 费而生；我方本地 runner 已是主路径，无此痛点。

---

## 原版可借鉴的设计细节（实施时参考）
- 任务卡：`子任务进度 9/9` + 成本 `$10.97` + 代理状态徽标，信息密度高且不乱。
- Approval 黄色标签悬停提示 "requires approval before unblocking dependents"——审批语义一目了然。
- 空看板列显示 "Drop tasks here"；Done 列一键 Archive All。
- 触发器 `Replay window (seconds)` 防重放、`Show on task board` 控制子任务不上看板。
- 未保存变更离开确认（Files 编辑器）。
- Foundation prompt 只读叠加 + 自定义 instructions 可编辑的双层提示词展示。
