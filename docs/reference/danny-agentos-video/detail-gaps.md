# 细节差距清单（原版 AgentOS 视频 × 本项目）

> 口径：逐份 `records/*/record.md` 过一遍**画面里实际出现的 UI 细节/交互/字段**（不是功能大项），逐条判定我方覆盖情况。
> 判定符号：✅ 已覆盖（已实现或已写进某批次条目）· 🟡 半覆盖（批次有大项、缺这个细节）· ❌ 未覆盖（任何批次都没提）· 🚫 已裁不做（decisions.md 明确关闭）。
> 现状依据：2026-08-15 前端/API 审计（`apps/web/src/pages` 八页、`packages/api/src/app.ts`）；批次依据：`docs/BACKLOG-V2.md`；裁决依据：`decisions.md`。
> 会话查看器细节（批次 4 扩容）与权限执行面（§13）今日已单独入账，本文只做核对，不重复展开。

---

## 1. 全局导航 / 侧栏 / 项目

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| 侧栏 15 项导航（Inboxes/Activity/Tasks/Goals/Sessions/Costs/Skills/Environments/Agents/Templates/Files/Knowledge/Repos/Connections/Admin） | Intro 0:00:00 | 🟡 | 我方 7 项。缺的每一项都在各自批次/长尾里，但**没有一条批次条目说"侧栏要随之扩项"**——每个新页落地时顺手加导航即可，不单列 |
| 顶部项目切换器：色块首字母图标 + 项目名 + 红色未读徽标（`M MMO Game 24`） | Intro 0:00:00 | 🟡 | 切换器我方有（Shell.tsx ProjectSwitcher）；**项目级聚合徽标数字没有**（我方只有 Inbox openCount）。批次 1 只写了 "Inbox 未读徽标" |
| `Inboxes` 导航项右侧红色未读徽标 `17` | Intro 0:00:00 | ✅ | 已实现 + 批次 1 有条目 |
| 侧栏底部：绿点 `Runner / Running` | Files 0:07:00 等全片 | ✅ | 批次 1 已写 |
| 悬停 Runner 弹出 `Local runner` 浮层：`1 of 1 runner online`、runner 名 `agentos-runner-1`、`Busy` 徽标、`Last heartbeat 20s ago`、`Daemon version 1.0.0`、`Claude CLI 2.1.226`、`Disk free 132.4 GB`、`Refreshes every 30s` | Runner 0:21:50 | 🟡 | 批次 1 只说"Runner 在线状态"。**浮层的这 7 个字段没写**——对自托管尤其有用（磁盘满、CLI 版本漂移是真实故障源）。建议并入批次 1 |
| 侧栏底部 `Settings` / `Sign out` | 全片 | 🟡 | Settings 页批次 1 已写（修错链）；**Sign out 我方完全没有**（无登出入口）。单用户自托管下低价值，但开源后有人会问 |
| 页面 tooltip（悬停导航项显示名称）、浏览器状态栏 URL | Tasks 0:19:10 | ❌ | 不值得做（浏览器原生行为） |

---

## 2. Tasks 看板

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| 五列看板 `Backlog / Todo / Doing / Review / Done`，列头带数量 | Tasks 0:09:10、Intro 0:25:50 | 🟡 | 我方只有 4 列，**缺 Backlog**。一行枚举值 + 一列 UI，顺手补 |
| 空列占位 `Drop tasks here` | Tasks 0:09:10 | ✅ | 已实现（Tasks.tsx:301） |
| 卡片拖拽换列 | Tasks 0:09:10 | ✅ | 已实现 |
| Done 列头 `Archive All` 一键归档 | Tasks 0:03:20 | ❌ | 我方无归档概念。dogfood 一周后 Done 列就会糊住，价值真实、成本极低 |
| 任务卡：**子任务进度 `9/9 subtasks`** | Tasks 0:09:10 | ❌ | 我方任务无父子 subtasks（用 chainId 平铺链），卡片上无此字段。见 §4 结构差异条 |
| 任务卡：成本 `$59.13` | Tasks 0:09:10 | ✅ | 已实现（money()） |
| 任务卡：agent 头像+名、`Once` 计划类型、相对时间（`× 20m ago` / `✓ 6d ago`）、状态徽标（Idle/running/Triggered）、三点菜单 | Tasks 0:09:10 | ✅ | 均已实现 |
| 任务卡二级状态行 `Write spec · running`（当前活跃子任务名+状态） | Tasks 0:11:30 | ❌ | 依赖 subtasks 结构。看板上一眼知道"卡在哪一步"，是原版信息密度的关键，价值高 |
| 卡片 `Triggered` 蓝色徽标（区分触发器创建的任务） | Tasks 0:17:50 | ❌ | 批次 2 做 webhook 执行但没说标注来源。低成本 |
| 顶部标签页 `My Tasks / Tasks / Automations / Triggers / Archived` | Tasks 0:09:10 | 🟡 | 批次 2 做 cron/webhook **执行**，但没有任何条目说要给它们做**列表 UI 与入口**。这是"做了看不见"的典型漏账 |
| `+ Create Task` 常驻右上角 | Tasks 0:09:10 | ✅ | 已实现 |

---

## 3. 新建任务表单

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| `Blank task` / `From template` 双标签 | Tasks 0:09:30 | ✅ | 已实现（Tasks.tsx:140） |
| 字段 Title / Prompt | Tasks 0:09:30 | ✅ | 已实现 |
| `Attachments (optional)` 虚线 `+ Upload` 拖拽上传 | Tasks 0:09:40 | ❌ | 我方无附件。**原版整条九步链靠附件传 spec/plan**（每步读父任务附件），我方靠 outputs + 分支文件。属"另一条路"，但附件对人手工投喂需求文档很有用 |
| `Agent (optional)` 下拉含 `No agent (manual task)` | Tasks 0:09:30 | ✅ | 已实现 |
| `Assignee (optional)` 下拉 | Tasks 0:09:30 | ✅ | 已实现 |
| `Due date (optional)` + 提示 `Display only — no automatic reminders` | Tasks 0:09:40 | ❌ | 明说只是展示用。单用户 dogfood 不值得做 |
| `Schedule` 三单选 `Run Once / Scheduled / Recurring` | Tasks 0:09:50 | 🟡 | 我方 DB 有 scheduleKind，**表单里没有这组单选**。批次 2 做执行侧，UI 侧漏账 |
| `Cron Expression` 输入框 + 三行示例文案（`0 9 * * *` 等） | Tasks 0:09:50 | 🟡 | 同上，批次 2 只写 scheduler 轮询。示例文案是零成本的可用性 |
| `Available in all projects` 开关 | Tasks 0:09:50 | ❌ | 跨项目任务。单人多项目场景下弱需求，不建议做 |
| From template：Template 下拉显示 `模板名 (22 tasks)` | Tasks 0:10:00 | 🟡 | 长尾 Templates 条目有"From template 弹窗预览"，**没提下拉里显示任务数** |
| From template：变量表单 `Feature description` / `Feature branch name (e.g. feat/inbox-search)` / `Additional details` 文件选择 | Templates 0:10:10–0:10:20 | ✅ | 长尾 Templates 条目的 `{{var}}` 展开覆盖；文件型变量属附件范畴 |
| `Will create` 只读预览区，列出将建任务 + `(depends on spec)` 依赖注解 | Templates 0:10:10 | ✅ | 长尾条目明写 "From template 弹窗预览" |

---

## 4. Task 详情页

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| **父任务 + 子任务树结构**（1 父 9 子，子任务有独立 agent/prompt/审批/依赖） | Tasks 0:10:30–0:10:40 | 🟡 | 结构性差异：我方是 `chainId + chainIndex` 平铺链，无父子。decisions §12 已裁"编排归模板"，所以不必照抄嵌套；但**看板与详情页缺"链条整体视图"**——批次 2 有"闸门消息标注链条上下文"，那是消息侧，页面侧仍缺。建议补一条"任务详情显示所属链条与各步状态" |
| `Details`：Agent / Assignee / Schedule / Requires approval 开关（含 `Off (Assign an agent first)`、`On (Locked — task is done)` 三态文案） | Tasks 0:10:30、0:12:00 | ✅ | 字段与开关均已实现；三态禁用文案是细节，可顺手 |
| `Details`：`Dependencies: ✓ Write spec` / `Add dependencies` | Tasks 0:11:10、0:12:00 | ❌ | 我方无显式依赖字段（靠 chainIndex 隐式）。中价值，可并入上面的"链条视图"一条 |
| `Prompt` 区块 `Show more / Show less` 折叠 | Tasks 0:10:30 | ✅ | 已实现（ShowMore lines=8） |
| `Attachments N` 区块 + 文件卡（名+大小 `4.6 KB`）+ `+ Upload` | Tasks 0:11:40 | ❌ | 同 §3 附件条 |
| 附件点击 → 文件预览弹窗（文件名+大小、`Download`、`X`、滚动正文渲染代码块/标题、加载态） | Tasks 0:11:50–0:12:06 | 🟡 | 批次 4 有"任务产出 outputs 渲染为 Markdown"，覆盖了"看正文"；**弹窗形态 + Download 未提**。用 outputs 渲染即可，不必做弹窗 |
| `Subtasks N/M` 区块：拖拽手柄、复选框、链接图标、`🔒1` 依赖锁+数量、标题（完成后划线+绿勾）、黄色 `Approval` 标签、日历图标、agent/指派人标签、`>` 展开箭头、`+ Add subtask...` | Tasks 0:10:40–0:13:40 | ❌ | 整个区块我方没有。若维持"链条不嵌套"的裁决，此项大部分不做；但 `Approval` 徽标语义与"当前第几步"需要在链条视图里等价表达 |
| 悬停 `Approval` 标签 tooltip：`requires approval before unblocking dependents` | Tasks 0:10:50 | ❌ | 一句 title 属性的成本，对理解闸门语义帮助大。建议并入批次 2 |
| 子任务行日历图标 → 日期选择器弹窗（月份导航 + `▷ Start now` + `Clear`） | Tasks 0:11:20 | 🟡 | `Start now`（手动立刻启动某一步）是真需求；日期排期不是。批次 2 的链式推进应带一个"手动放行/立刻开跑"按钮 |
| `Activity N` 区块：agent 时间线日志（含 `✅ ... — done.` 摘要、`PR: #7 — ... · branch 'x' · draft/unmerged`、`Status: 3 fixed / 0 blocked / 19 follow-ups`）+ `Add a comment...` 输入框 | Tasks 0:11:40、0:13:50 | ✅ | Activity + 评论框已实现；PR/分支可点链接批次 4 已写 |
| `Runs N` 表格：`Started / Duration / Status / Cost / Tokens / Result` | Tasks 0:12:08、0:12:10 | ✅ | 批次 4 已写"run 表加 Cost/Tokens 两列"；我方已有 Started/Duration/Status/Cost/Branch/Failure class |
| Runs 表 `Show subtask sessions` 勾选 + `↻ Refresh` | Tasks 0:13:50 | 🟡 | 勾选依赖 subtasks 结构；等价需求是"看整条链的所有 run"。并入链条视图 |
| 任务详情顶部 `✓ Mark Done`（黄）/ `Edit` / `⋮` | Tasks 0:10:30 | ✅ | 已实现 |

---

## 5. Triggers（触发器）

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| Triggers 列表表格：`Name / Mode(Template) / Target / Status(Enabled) / Last Fired / Fires` + 描述副行 + 三点菜单 + `+ New Trigger` | Tasks 0:16:50 | 🟡 | 批次 2 做 webhook 执行，**无列表 UI 条目**。`Fires 601` 这种计数是"这东西真在跑"的唯一可见证据 |
| 触发器详情顶部：`Template` 标签 + 绿 `Enabled` + `⏸ Pause` + 黄 `⚡ Fire now` | Tasks 0:17:40 | ❌ | `Fire now`（手动触发一次做验证）价值高，调试 webhook 必备 |
| `Name` / `Description` 字段 | Tasks 0:17:40 | 🟡 | 同列表条 |
| `Show on task board` 开关 + 说明 `...show its primary task on the kanban. Child tasks stay hidden.` | Tasks 0:17:20 | ❌ | 防止高频触发器（601 次）淹没看板。若我方接 webhook 高频源才需要；当前 dogfood 无高频源，**不建议做** |
| `Default variables` 区块：变量名 + 红色 `required` 标签 | Tasks 0:17:20 | 🟡 | 批次 2 写了 "payload→变量映射"，未提 required 标注与默认值 UI |
| `First-task auto-start` 下拉（`Always auto-start`） | Tasks 0:17:20 | ❌ | 触发后是否自动开跑。低成本、中价值 |
| `Replay window (seconds)` = 300 防重放 | Tasks 0:17:20 | 🟡 | 批次 2 只写 "secret 校验"。防重放是幂等性问题，外部 webhook 必然重投，**建议明确写进批次 2** |
| `Recent fires` 列表（每次触发的任务名 + running/done + 时间戳） | Tasks 0:17:20 | 🟡 | 同列表条，属触发器详情页 |
| `Save changes` 按钮 | Tasks 0:17:30 | ✅ | 表单常规 |

---

## 6. Automations（cron）

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| Automations 表格：`Title / Agent / Schedule(人类可读，如 "At 01:00 AM, only on Monday") / Status / Last Run` + 三点菜单 | Tasks 0:18:40 | 🟡 | 批次 2 做 cron 执行，**无列表 UI**。cron 表达式→人话（cronstrue 一行）是零成本的可用性 |
| 行可展开 → `Recent sessions:`（时间 · 状态）+ `View all sessions →` 链接 | Tasks 0:18:50 | 🟡 | 同上 |
| `Paused` 黄色状态（可暂停某条自动化） | Tasks 0:18:40 | ❌ | 一个 enabled 布尔。低成本，建议并入批次 2 |
| 空状态：闪电图标 + `No automations yet` + 说明 + `Create Automation` 按钮 | Tasks 0:19:00 | ❌ | 空状态设计属批次 0/1 通用规范，不单列 |

---

## 7. Goals 列表与详情

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| Goal 卡：状态徽标 running/done、`0 of 10 done`、进度条、`$0.30 / $100.00`、归档+删除图标 | Goals 0:19:10、0:22:30 | ✅ | 均已实现（Goals.tsx:110-125） |
| Goal 卡底部：`Iteration 4` · `Active: Senior Dev` · `<1h elapsed` | Goals 0:19:10 | 🟡 | elapsed 已有；**Iteration 与 Active agent 缺**。批次 5 写了"迭代/预算显示"（详情页），卡片上没写。零成本，建议一并 |
| `Archived Goals` 视图 + `Back to goals` + 卡片上的归档/恢复/删除 | Goals 0:22:50 | ❌ | 我方无归档目标视图。目标完成后列表会堆积，价值中等、成本低 |
| Goal 详情顶部：`running` + 黄色 `Runner online` 状态标 | Goals 0:19:20 | 🟡 | 我方统计卡里有 Runner，位置不同。可忽略 |
| 顶部控制按钮 `Nudge` / `Pause` / `Restart session` / `Adjust limits` / 红 `Cancel goal` | Goals 0:19:20、Costs 0:21:00 | 🟡 | 后端已有 `/goals/:id/pause`，**前端一个按钮都没接**。批次 5 只写 DoD/事件流/护栏，**运行控制面漏账**。`Nudge`（催一把）与 `Restart session` 在 dogfood 里就是救命按钮 |
| 规格摘要区 + `Show more` + `Started from spec: farming.md` | Goals 0:19:20 | ✅ | 我方有 Spec 标签页，等价 |
| 状态横条 `Senior Dev working — iteration 4` | Goals 0:19:20 | 🟡 | 同 Iteration/Active agent 条 |
| 四张统计卡：`DoD progress = 0 done · 0 waived · 10 open` / `Spend` / `Iteration` / `Active agent` | Goals 0:19:20 | 🟡 | 我方有 DoD progress/Spend/Stuck threshold/Runner。**缺 Iteration、Active agent；缺 waived 语义**（"豁免"是弱证据处理的出口，与 §8 护栏"弱证据=继续"配套）。建议 waived 进批次 5 |
| 五个标签页 `Definition of Done / Progress log / Sessions / Orchestrator / Results` | Goals 0:19:20 | 🟡 | 我方有 DoD/Progress log/Spec。批次 5 已写 Orchestrator 事件流。**Sessions 与 Results 两页缺**：Sessions 可由批次 4 的 /sessions 带 goal 过滤覆盖；**Results（产出文件表 `File / Size / Updated`）缺**，见下条 |
| `Results` 表：`plan-phase-1.md 32.7 KB 14/08/2026, 09:23:25` 等产出文件列表 | Goals 0:20:55 | ❌ | 依赖 Files 模块。长尾 Files 条目落地后应加一个 goal 级过滤视图。价值真实（"agent 到底产出了什么"） |
| DoD 正文结构：`Spec:` 引用 + `Codebase intel for implementers`（校验过的代码事实）+ `Success Criteria` 按 Phase 分组 + 逐条 checkbox + `End-to-end acceptance` + `Per-phase process followed` | Goals 0:19:30–0:20:00 | 🟡 | 批次 5 只说"DoD 清单（生成→确认→自动打勾）"。**DoD 生成器的产出结构没规定**——原版这套（分阶段 + 端到端 + 过程性条目）是让循环收敛的关键，应写进 `dod-generator` 提示词规格 |
| Orchestrator 事件流：`Dispatched iteration 4 — session task created for X` / `Routed iteration 4 → X（附路由理由文本）` / `Session completed – router re-evaluating`，倒序 + 可展开 | Goals 0:20:10–0:20:40 | ✅ | 批次 5 已写（`Routed iteration N → <agent> (phase)`）；**路由理由文本**这个细节值得强调：原版每条 Routed 都带一句"为什么选它"，是唯一能审计路由质量的东西 |
| Goal 完成/待批准 → 发 Inbox 系统消息（`Goal complete: X ✓ — 8 of 8 criteria met after 15 iterations. Total spend: $5.95.` / `Goal ready for approval: X — DoD with 10 criteria...`） | Inboxes 0:14:40 | ❌ | 批次 5 未提通知。**"睡觉时系统自己跑"的收口就是这两条消息**，否则得自己去刷页面。价值高、成本极低 |

---

## 8. New Goal 表单 / 限额

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| `Describe objective` / `Start from spec` 双模式 | Costs 0:21:30 | 🟡 | 我方只有一个 spec 文本域。双模式是"贴一份 spec 文件 vs 写一句目标"的区别，成本低 |
| `Constraints & preferences (optional)` 多行框（原版填的是流程约束：每阶段先 plan 再 review） | Costs 0:21:30 | ❌ | 我方无。但 decisions §8 把 phase-gating 做成**硬规则**，这块被架构吸收了，**不建议做** |
| `Planning agent (optional)` 下拉 + 说明"默认 agent 没有 repo 访问权，需选带 repo 的 agent" | Costs 0:21:30 | ❌ | 批次 5 未提"谁跑第一轮 planning"。中价值，一个下拉 |
| `Spend cap (USD)` + `$0.30 spent so far.` 辅助文案 | Costs 0:21:00 | ✅ | 已有 spendCap；辅助文案零成本 |
| `Wall-clock limit (hours)` | Costs 0:21:00 | ✅ | 已有 |
| `Stuck threshold (iterations)` | Costs 0:21:00 | ✅ | 已有 + 批次 5 护栏条 |
| `Session budget (minutes)` (5-480) + `Grace period (minutes)` (1-120)，说明"nudge 后强停"，下次 session 生效 | Costs 0:21:00 | ❌ | 单 session 的软收尾机制（先催后杀），比硬超时体面。中价值；decisions §8 未收 |
| `Adjust limits` 弹窗（运行中改限额，含数字微调控件、生效时机说明） | Costs 0:21:00 | 🟡 | 见 §7 控制按钮条 |
| `Execution` 下拉 `Local runner (subscription)` / `Cloud (Claude Managed Agents, API billing)` | Costs 0:21:30 | 🚫 | decisions §10 混合路由不做 |
| `Plan agent runtime` / `Worker runtime`（Claude / Grok when possible，默认 grok-4.6，忙时回退） | Runner 0:22:10 | 🚫 | 同上不做（我方 per-agent runnerPreference 已覆盖等价能力） |

---

## 9. Inboxes

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| `Active` / `Archived` 双标签 | Inboxes 0:14:40 | 🟡 | 我方是 Active/Answered。语义不同（已答 ≠ 已归档），差别小，可不改 |
| 列表行字段：复选框、状态圆点、发送者、状态标签 `Awaiting reply`、主题、预览、相对时间、来源 `MMO Game Inbox`、三点菜单 | Inboxes 0:14:40 | 🟡 | 我方有发送者/OPEN 徽标/标题/摘要/时间/渠道。**缺复选框批量选择、三点菜单**。批量归档在消息堆积后才有价值，中等 |
| 顶部 `New Message`（人主动给 agent 发消息） | Inboxes 0:14:40 | ❌ | 我方 Inbox 只能被动回。"直接给某 agent 发一条起个活"是很顺手的入口，但与"建任务"重复，**不建议做** |
| `Archive all` 按钮 | Inboxes 0:15:40 | ❌ | 低成本、真需求（17 条未读的清理）。建议并入批次 3 |
| 详情页 `← Back to Inboxes`、`Updated just now`、刷新图标、红色删除图标 | Inboxes 0:14:50 | 🟡 | 我方无刷新/删除。删除低价值；**刷新**可用轮询替代 |
| 消息正文富渲染：Markdown 加粗、**两列状态表格**（`Thing / Status`：init.sh ✅ completed、mongod/redis、Workspaces built 4/4、Run ⏸ blocked on you）、有序列表 | Inboxes 0:14:50 | ❌ | 我方消息正文是否 Markdown 渲染未见证据。**agent 用表格汇报会话状态**是极高信息密度的做法，渲染能力是前提。建议并入批次 3（渲染层）+ 写进 agent 提示词规范 |
| 黄色边框提示条 `The agent is waiting for your reply before continuing.` | Inboxes 0:14:50 | 🟡 | 我方有 approval gate 徽标，无这条显式阻塞提示。零成本文案 |
| 开放式回复框 `Type your answer...` → 提交后 agent 立即恢复并回信，形成 You/Agent 交替线程；原消息自动折叠 | Inboxes 0:15:00–0:15:10 | ✅ | 我方线程 + 回复框已实现，闭环已通 |
| 结构化问卷卡片：`Question 1 of 2 — <短标题>` 黄色进度条、题干、选项（含每项说明文字）、黄色 `Recommended` 标签、`Other / Provide your own answer`、`Back` / `Next` / `Submit` | Inboxes 0:15:50–0:16:00 | ✅ | 批次 3 全覆盖（decisions §7 schema 已定） |
| 问卷卡片**之外**仍并存独立开放式回复框 | Inboxes 0:15:50 | 🟡 | 决议 §7 只写表单化。"答完问卷还能补一句"是真实需求，一行 UI |
| 消息按来源标注 `MMO Game Inbox`（多收件箱） | Inboxes 0:14:40 | ❌ | 单用户单项目为主，不值得做 |
| 移动端 PWA：顶栏、卡片流、底部 5 项导航（Inbox/Goals/+/Sessions/Tasks）、系统推送 | Inboxes 0:15:40 | 🚫 | 远期（decisions §10 后做） |

---

## 10. Sessions 会话查看器（今日已入账，仅核对）

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| Sessions 列表：`Started / Task / Duration / Status / Result` + `Refresh` | Activity 0:16:20 | ✅ | 批次 4 |
| 行内 `local` 环境标签、状态 Waiting/Running/Done、结果 Success | Activity 0:16:20 | 🟡 | 批次 4 写了列表但没写 `local`/runner 标签。我方多 runner 后端（CLAUDE/CODEX/PI），**标 runner 类型比原版更有用**，建议补 |
| 详情顶部：agent 名 + `Running` 徽标 + `local` + `Refresh`；元信息 `Task / In progress / Started ...` | Activity 0:16:30 | ✅ | 批次 4 |
| 统计条：`Live` 绿点 + `43 messages` + `293 tool calls` + `2 files` | Activity 0:16:30 | ✅ | 批次 4 明写 |
| `Files touched` 折叠区（带计数徽标） | Activity 0:16:30 | ✅ | 批次 4 明写 |
| 消息流：agent 文本、代码片段带绝对路径、tool call 参数与返回（read_file 的 target_file/offset/content） | Activity 0:16:30 | ✅ | 批次 4 明写（含折叠展开） |
| 底部 `Type a message...` 向运行中 agent 发消息 | Activity 0:16:30 | ✅ | 批次 4 已标"后置" |
| 会话完成态：`Done` 徽标、`29m 54s / 8.9K tokens / Started ...`、`Session ended — open in SDK to start a new one.`、`Open SDK ↗` | Tasks 0:12:50 | 🟡 | tokens/时长批次 4 有；`Open SDK` 是原版云端特有，**不做** |
| 子代理报告以 `<agent-message source="child" agent="X" subtask="Y">` 格式嵌在流里 | Tasks 0:12:50 | ❌ | decisions §12 已收敛评审为单会话不散子代理，**不需要** |

---

## 11. Agents

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| 列表列：勾选框 / `Name` / `Model` / `Status` / `Updated` + 三点菜单 | Agents 0:03:40 | 🟡 | 我方列为 Name/Model/Runner/Inbox/Updated。**缺 Status（published/draft）** |
| `Published` / `draft` 状态（YAML `status:` 字段亦见） | Agents 0:03:40、Skills 0:23:40 | 🟡 | 修缮清单有"Agent 归档/下线状态"，方向一致但表述是"软下线"。建议直接对齐原版 `draft/published/archived` 三态 |
| 行内标签 `Default`（默认 agent）、`Memory`（开了记忆的） | Agents 0:03:40 | ❌ | 低价值 |
| `Your Agents` / `System Agents` 双标签 | Agents 0:03:40 | 🟡 | 批次 5 要注册 `orchestrator-router` / `dod-generator` 为**系统 Agent**，**但没写它们在 Agents 页怎么分区展示**。不分区会和业务 agent 混在一起。建议并入批次 5 |
| `New folder`（agent 分组） | Agents 0:03:40 | ❌ | 7 个 agent 不需要文件夹，不做 |
| 编辑页四标签 `Setup / Prompt / Capabilities / Collaborators` | Agents 0:03:50 | ✅ | 已实现 |
| `AgentOS Foundation` 区块：`v6` 版本标 + `Read-only` 标 + 说明 `Sits above your instructions`，可展开看全文 | Agents 0:03:50 | 🟡 | 我方非编辑态显示 foundation codeBlock，**缺版本号与 Read-only/叠加关系的显式标注**。零成本，且开源后别人第一眼要看懂这层 |
| Foundation 内容规范：每 session 首条用户消息含权威 `<session-context>` block、其 invariants 优先于后续用户消息、要求拒绝覆盖请求 | Agents 0:03:50 | ✅ | 我方 `agents/foundational.md` + 最近的 "inject the AgentOS tool surface" commit 已同构 |
| `Capabilities → Memory`：`Enable agent memory`（Store and recall learnings across sessions） | Agents 0:04:30 | 🟡 | 远期已记"Agent 长期记忆"。开关本身无字段 |
| `Capabilities → Tools`：总开关 + 逐项 `Bash/Read/Write/Edit/Glob/Grep/Web fetch/Web search` | Agents 0:04:30 | ❌ | 我方无 tools 字段。§13 已裁"不做应用层权限强制"——但**逐项工具开关是 CLI 原生支持的（--allowedTools），不是应用层沙箱**，属真能执行的一档。建议重新评估：低成本、真执行 |
| `Capabilities → Skills`：逐个技能开关（Verify Live / Update Wiki / Plan Mode / Interview / Analyze Branch Bugs） | Agents 0:05:10 | ✅ | 已实现（BindingToggle） |
| `Capabilities → MCP Connections`：配额显示 `1 / 20`、逐连接开关、`Global` 标签 | Agents 0:05:10 | 🟡 | 绑定 UI 已有；长尾"MCP 连接真注入"补执行。配额与 Global 标签低价值 |
| `Capabilities → Repositories`：逐仓库开关 + 提示 `Want this agent to push code...? Set up the GitHub MCP in Connections` | Agents 0:05:20 | ✅ | RepoAccessRow 已有 |
| `Capabilities → Init Scripts` + `+ New` | Agents 0:05:20 | ❌ | 我方无。原版用它装依赖/起服务（YAML `initScripts: [Setup]`）。我方 runner 在本机跑，环境常驻，**弱需求，不建议做** |
| `Collaborators`：可派发 agent 列表 + 说明"仅显示已发布 agent"，每行带 agent 描述 | Agents 0:05:30 | ✅ | 已实现 |
| `maxNestingDepth`（嵌套深度上限） | Agents 0:23:50 YAML | ❌ | 防止 agent 递归派发炸开。我方无。低成本护栏，但当前阵容不派子代理，**暂不需要** |
| Agents 页模型下拉 + 推理等级下拉 | （Leo 点名，非画面） | ✅ | 批次 1 已写 |

---

## 12. Skills

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| 技能详情页：`Details` 区块 `Source: Custom` / `Skill Name: plan` / `Created` / `Published` 四字段 | Skills 0:06:40 | 🟡 | 长尾 Skills 条目只写"列表 + md-editor + 发布状态"。字段级未展开，可实现时对齐 |
| 顶部 `Published` 绿标 + `Edit` + 黄 `Republish` + 三点菜单 | Skills 0:06:40 | ✅ | "发布状态"已在长尾条目内 |
| `Content` 区块预览 Markdown（含 YAML front matter：`name` / `displayTitle` / `description`）+ `Show more` | Skills 0:06:40 | 🟡 | front matter 结构是"技能=SKILL.md"的载体约定，**长尾条目没写这个格式**。与 YAML export/import 条目相关，建议一并定义 |
| 编辑表单：`Display Title` 输入 | Skills 0:06:49 | 🟡 | 未展开 |
| 编辑表单：`Invocation Slug`（带固定 `/` 前缀，如 `/plan`） | Skills 0:06:49 | ❌ | 技能的调用方式。我方 Skill 是绑定式注入而非斜杠调用，**机制不同，不必照抄**；但 slug 作为标识仍需要 |
| 编辑表单：`Available in all projects` 开关 | Skills 0:06:49 | 🟡 | 我方 Skill 有无 scope 未核。低成本 |
| `SKILL.md` 多行编辑器 | Skills 0:06:49 | ✅ | 长尾条目已接 `@uiw/react-md-editor` |
| `Files` 区块：附加文件 + 空态 `No files attached yet` | Skills 0:06:50 | ✅ | 长尾条目已标"附件后置" |
| 技能可运行 Python 脚本（仅旁白） | Skills 0:06:50 | ❌ | 旁白未见画面，且我方 agent 本机可直接跑脚本，不做 |

---

## 13. Templates

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| 模板 YAML `variables:` 段（变量声明 + `attach_to: [parent]`） | Templates 0:25:20 | 🟡 | 长尾条目写了 `{{var}}` 展开，**变量的声明结构（类型/必填/附着目标）未定义** |
| 任务节点：`key` / `title`（含 `{{branch_name}}`）/ `prompt` | Templates 0:25:20 | ✅ | 我方 TaskTemplateStep 等价 |
| `include: <template-task>` 复用子模板；独立的 `.agentos/template-tasks/*.yaml` 目录 | Templates 0:25:20–0:25:40 | ❌ | 模板任务的复用机制。我方模板是扁平 step 列表。**九步链只有一条，复用价值不高，不建议做** |
| `parent:` / `unblocked_by: [x]` 表达层级与解锁依赖 | Templates 0:25:30 | 🟡 | 我方 chainIndex 是线性序。原版 `unblocked_by` 支持并行分叉（4 个并行 reviewer）；decisions §12 已裁并行评审为过度设计，**线性够用** |
| `requires_approval: true` 设在模板任务上（+注释说明闸门该设在哪一步） | Templates 0:25:30 | ✅ | 我方 approvalGate 已有；批次 2 修缮清单已处理"手动任务带闸不发卡" |
| 模板任务的 `consumes:` 声明输入变量及类型（`key: branch_name, type: text`） | Templates 0:25:40 | 🟡 | 同变量结构条 |
| 模板任务 prompt 内置 Git 工作流硬约束（从最新 main 建分支、逐里程碑绿色提交、push 后立刻开 **draft** PR、末条消息输出分支名+PR URL+摘要、`Do not merge`） | Templates 0:25:40 | ✅ | 我方 executioner 提示词已同构（`agents/roles/*`），且 V1.5 有"一链一 PR"挂账 |
| 种子模板 `Compound Engineering Workflow (22 tasks)` / `Multiplan Implementation (N phases)` | Tasks 0:10:00 | ✅ | 长尾条目已写种子模板（decisions §12 单链九步）。**注意：长尾条目文字仍写"轻链(5步)/重链(7步)两条"，与 §12 的"废除轻/重链、单链九步"矛盾——账目须更正** |
| 模板管理 UI（列表/编辑器） | — | 🟡 | 长尾只写"From template 弹窗预览"，**模板本体的增删改 UI 未提**（comparison 说"先 JSON/DB 手工维护"）。开源后别人改模板需要它，可等 YAML import 覆盖 |

---

## 14. Files

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| 页头：标题 + 副标题 `Browse and manage stored files` + `Project`/`Global` 作用域切换 | Files 0:07:00 | ✅ | 长尾 Files 条目 + decisions §4（`_global/` + `<项目名>/`） |
| 当前位置 `Root` + 复制路径图标 | Files 0:07:00 | 🟡 | 面包屑/复制路径未在条目里点名，SVAR 组件应自带 |
| `New Folder` / `New File` / `Upload` 三按钮 | Files 0:07:00 | ✅ | 条目内 |
| 表格列 `Name / Size / Modified` + 行尾 `...` 菜单 | Files 0:07:00 | ✅ | 条目内 |
| 根目录约定：`goals/`、`plans/`、`specs/`、`reviews/`、`prs/`、`runs/`、`mnt/` | Files 0:07:00 | 🟡 | decisions §4 只定了 `_global/` + `<项目名>/`（下留 `files/`、`knowledge/`）。**原版这套按产物类型分目录的约定，是 agent 提示词里硬编码路径（`specs/<slug>.md`、`plans/<branch>.md`）的前提**。我方 agent 提示词若要引用固定路径，须先把这层目录约定定下来。建议补进 Files 条目 |
| `.versions/` 目录（文件版本历史） | Files 0:07:00 | ❌ | 版本化由 git 覆盖（我方产物大多进仓库），不做 |
| 文件页：面包屑 `Files > goals > agressive-spider > implementation-review.md` + 复制图标 | Files 0:07:40 | ✅ | 同上 |
| 文件元信息行：`12.5 KB` · `Modified Aug 13, 2026` · **`agent:agent_01Sf...`（创建者 agent ID）** | Files 0:07:40 | ❌ | "这文件谁写的"——多 agent 并行时的溯源。低成本，建议进 Files 条目 |
| 内置编辑器：带行号的 Markdown 编辑区 + `Preview` / `Download` / `Save` | Files 0:07:40 | ✅ | 条目内（"浏览/上传/编辑/下载"） |
| 未保存离开确认 `You have unsaved changes. Leave anyway?` | Files 0:07:53 | 🟡 | comparison §"可借鉴细节"提到了，**BACKLOG 条目里没有**。一个 beforeunload |
| 权限：agent 只能访问指定文件夹、可写不可删、走 MCP、服务端 `inside()` 校验 | Files 0:07:20–0:07:30 | ✅ | 长尾条目明写 FilesystemGrant + inside() |
| 存储 Cloudflare R2 | Files 功能清单 | 🚫 | decisions §4：本地磁盘 + 存储薄接口 |

---

## 15. Repos / Environments

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| Repos 表：`Name / URL / Credential / Updated` + 行菜单 `Edit`/`Delete` + `+ Add Repo` | Repos 0:08:10 | ✅ | 长尾"Env/Repos CRUD"覆盖（我方 Connections 页已有只读 Repos 表） |
| 编辑页 `General` / `Environment` 双标签 | Repos 0:08:20 | 🟡 | 条目只说"简单 CRUD 页" |
| `Repository URL` / `Name` | Repos 0:08:20 | ✅ | — |
| `Mount Path` + 说明 `Custom directory name under /workspace/. Mounts at: /workspace/vibeville` | Repos 0:08:20 | ❌ | 我方 runner 在本机克隆到工作区，挂载路径语义不同，**不建议照做** |
| `Description` + 说明 `Shown to agents in session context` | Repos 0:08:20 | ❌ | "这仓库是干什么的"注入 session context——**低成本、真有用**（多仓时 agent 不再瞎猜）。建议进 Env/Repos 条目 |
| `Credential Key` + 说明 `References an encrypted credential stored in Settings > Credentials` | Repos 0:08:20 | ✅ | 我方 Secrets 页 + secret 注入已真执行 |
| `Available in all projects` 开关 | Repos 0:08:20 | 🟡 | 低价值 |
| 仓库 `Environment` 标签：`+ Add .env file`、`Save All`、说明"相对 /workspace/<repo>/ 挂载，Values are encrypted at rest"、空态 | Environments 0:08:30 | 🟡 | **按仓库挂 .env 文件**（不只是环境变量）——我方是 secret 注入为环境变量。真实差距：很多项目要的是一个 `.env` 文件落盘。中价值，建议进 Env/Repos 条目 |
| Environment 编辑页：`Name` + `Available in all projects` | Environments 0:05:40 | ✅ | 条目内 |
| Packages：`pip` / `npm` 输入框 | Environments 0:05:40 | 🚫 | comparison §9 已定"我方模型没有此字段，用 init script 顶"——而 init script 我方也不做，实为**本机环境常驻**替代 |
| Networking：`Unrestricted` / `Limited` + `Allowed hosts (one per line)` + `Allow MCP servers` / `Allow package managers` 开关 | Environments 0:05:50 | 🚫 | decisions §13：网络限制为未接线元数据，改为 UI 诚实标注 + OS 层隔离 |

---

## 16. Connections（MCP）

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| 页头 `Manage MCP server connections for your agents.` + `+ Add connection` | MCP 0:08:00 | ✅ | 长尾 Connections 整页重写 |
| GitHub 连接卡：图标 + `Connected` 状态标 | MCP 0:08:00 | ✅ | 条目内 |
| 字段 `Profile: PR only`（权限档位） | MCP 0:08:00 | 🟡 | 条目明标"Profile 后置" |
| 字段 `Repos: A, B, C +16 more`（该连接可访问的仓库） | MCP 0:08:00 | ❌ | 低价值 |
| 字段 `Last verified: Aug 1, 2026` | MCP 0:08:00 | 🟡 | 条目明标"后置"。**但连通性自检（点一下测试连接）对 dogfood 价值不低**——MCP 配错了现在没有任何反馈 |
| `Update Token` / 红色 `Disconnect` 按钮 | MCP 0:08:00 | ✅ | 编辑表单覆盖 |
| 分区 `Global (org-level)` vs `Project-specific`，各列 MCP URL + `Manage` | MCP 0:08:00 | 🟡 | 条目写了"作用域标签"。org-level 在单用户下退化为"全局"，语义保留即可 |

---

## 17. Costs

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| 页头说明"总 Anthropic 支出来自 cost ledger——task runs / dreams / goal routing / credential checks；下方按 agent 与按日仅覆盖已结算 run" | Runner 0:21:40 | 🟡 | 远期 Costs 条目。**"哪些开销被算进来"这句口径说明**值得抄——我方 costUsd 现在只覆盖 task run，goal routing 与系统 agent 调用会漏计 |
| 时间范围下拉 `Last 30 days` | Runner 0:21:40 | 🟡 | 远期 |
| 汇总三指标：`$5531.00 this window` / `1929 runs` / `avg $2.82/run` | Runner 0:21:40 | 🟡 | 远期（decisions §9 Recharts 三图） |
| `Daily total` 按日多色堆叠柱状图 | Runner 0:21:40 | 🟡 | 远期 |
| `By agent` 表：`Agent / Cost / Runs / Avg-run / Cache hit` | Runner 0:21:40 | 🟡 | **`Cache hit %` 这一列没在决议里出现**——90-97% 的缓存命中率是判断提示词结构是否稳定的直接指标，比总花费更有诊断价值 |
| `By model` 彩色比例条 + 模型图例 | Runner 0:21:40 | 🟡 | 远期 |
| `Top runs in window` 表：`Cost / Agent / Task / Model` | Runner 0:21:40 | ✅ | decisions §9 明写 Top runs |

---

## 18. Knowledge

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| 侧栏 `Knowledge` 导航项；流程图节点 `KNOWLEDGE (what it knows)`；九步链有 `Update wiki` 步（Librarian 维护 `wiki/` 下文章，产出如 `wiki/server/tick-loop.md`，含 Key Files / 步骤 / D&C 说明） | Intro 0:02:00、Tasks 0:13:50 | ✅ | 我方 librarian 已在链条第 ⑧ 步；**wiki 落在代码仓库里**，不需要独立 Knowledge 模块。远期条目保留即可 |

---

## 19. YAML / CLI / 架构讲解

| 原版细节 | 出处时间戳 | 判定 | 差距 / 归属批次 |
|---|---|---|---|
| 目录结构 `.agentos/{agents,skills,template-tasks,templates}` + `.sync.json` + `config.json` | Agents 0:23:50、Templates 0:25:40 | 🟡 | 长尾"YAML Phase 1 export/import"未定目录结构与同步状态文件（`.sync.json` 记录 drift 基线）。实现时要定 |
| agent YAML 全字段：`slug/name/description/model/scope/status/tools{enabled,disabled}/skills/mcpAgentosEnabled/mcpConnections/spawnableAgents/maxNestingDepth/memoryEnabled/environment/repos/initScripts/system` | Agents 0:23:50 | 🟡 | 我方字段是子集（缺 tools/memory/maxNestingDepth/initScripts）。export/import 按**我方现有字段**导即可，不必补齐原版字段 |
| 技能存为 `*.md`（YAML front matter + 正文），非 YAML | Skills 0:23:40 | 🟡 | 见 §12 front matter 条 |
| `agentos --help`：`login/logout/whoami/init/pull/push/status/diff/task/help`，`--cwd`、`--server`；`status` 看 drift、`diff` 看差异 | Agents 0:24:10 | 🟡 | 长尾只做 Phase 1 export/import；Phase 2 diff/pull/push 在远期。**账目一致，无漏** |
| 本地 Claude Code 会话里让 CLI 直接在 AgentOS 建目标/任务并携带讨论上下文；CLI 自动判断该用哪些 agent | Tasks 0:24:40–0:25:10 | 🟡 | 远期 Phase 3。原版画面里这个能力**当场失败了**（CLI 无 create-project），说明它自己也没做完，优先级可放心压后 |
| 架构：建在 Claude Managed Agents 之上（session = agent ID + environment ID，`initial_events` 播种，版本锁定，vault 认证，session budget，webhook 订阅） | 架构 0:06:20 | 🚫 | 我方走本机 runner + CLI，路线不同（decisions §10 已认定"自研面高度重合，无错位"） |

---

## 20. 已裁不做（列出不展开）

- 🚫 `Admin` 管理台（decisions §1/§10）
- 🚫 本地/云 Runner 混合路由：`Execution` 下拉、`Plan agent runtime` / `Worker runtime`、Grok worker、忙时回退云端、Inbox 里的 `Local runner fallback → cloud` 系统消息（§10）
- 🚫 应用层权限强制/沙箱：Environment networking（Unrestricted/Limited/allowed hosts）、Allow MCP servers/package managers、filesystem grants 的执行、每 agent MCP 开关的执行（§13；改为 UI 诚实标注 + OS 层隔离）
- 🚫 Cloudflare R2 存储（§4，改本地磁盘 + 薄接口）
- 🚫 Claude Managed Agents / SDK 会话托管、`Open SDK` 入口（架构路线不同）
- 🚫 移动端 PWA + 系统推送（§10 后做，非本期）
- 🚫 Environment pip/npm 包管理（本机环境常驻替代）

---

## 21. 建议新增账目（可直接粘进 BACKLOG-V2）

按价值排序。括号内为建议归属批次。

1. **（批次 5）Goal 生命周期通知**：`Goal ready for approval: X — DoD 含 N 条` 与 `Goal complete: X ✓ — N of N 满足，历经 M 轮，共花费 $Z` 两条系统消息发 Inbox。——"睡觉时系统自己跑"的收口，没有它就得手动刷页面。
2. **（批次 5）Goal 运行控制面**：详情页接 `Nudge` / `Pause`（后端已有端点）/ `Restart session` / `Adjust limits` 弹窗 / `Cancel goal`。——目前一个按钮都没有，跑歪了只能等超时。
3. **（批次 2）Automations / Triggers 列表 UI 与 Tasks 页标签页**：`My Tasks / Tasks / Automations / Triggers / Archived` 五标签；Automations 表（Title/Agent/Schedule 人类可读/Status/Last Run、行展开 Recent sessions、可暂停）；Triggers 表（Name/Mode/Target/Status/Last Fired/Fires）+ 详情页（Pause / **Fire now** / Default variables 含 required / First-task auto-start / **Replay window 防重放** / Recent fires）。——批次 2 只做执行不做界面，等于"做了看不见、也没法调试"。
4. **（批次 2）链条视图**：任务详情显示所属链条的全部步骤与状态（第几步 / 各步 agent / 闸门位置 / 已完成与待跑），看板卡片显示 `n/m 步` 与当前活跃步名（`Write spec · running`）。附：`Approval` 徽标 tooltip；当前待跑步的"立刻开跑"按钮。——原版 `Subtasks 9/9` 的等价物，我方现在完全看不出一条链跑到哪。
5. **（批次 3）Inbox 消息正文 Markdown 渲染 + Archive all + 阻塞提示条**：支持加粗/列表/**表格**（agent 用 `Thing | Status` 表汇报会话状态）；黄色 `The agent is waiting for your reply before continuing.`；列表批量选择 + Archive all。——问卷重构已在批次 3，渲染层顺手一起。
6. **（批次 1）Runner 浮层字段**：runner 名、Busy/Idle、last heartbeat、daemon 版本、CLI 版本、磁盘剩余、30s 自动刷新。——自托管的三大故障源（盘满、CLI 版本漂移、心跳断）全在这一屏。
7. **（批次 5）DoD 结构规范 + waived 语义**：`dod-generator` 产出须含 Spec 引用、代码事实核对段、按 Phase 分组的成功标准、端到端验收、过程性条目；统计卡加 `Iteration` / `Active agent` / `done · waived · open` 三态。——护栏"弱证据=继续"需要 waived 这个出口，否则循环卡死。
8. **（批次 1/2）Tasks 看板补齐**：Backlog 列、Done 列 `Archive All`、`Archived` 视图、触发器来源徽标。——dogfood 一周 Done 列就糊。
9. **（长尾 Files）目录约定 + 产出溯源**：定死 `specs/ plans/ reviews/ goals/<slug>/ runs/` 的根目录约定（agent 提示词硬编码路径的前提），文件元信息显示创建者 agent，未保存离开确认。——不先定约定，agent 写文件的路径会各写各的。
10. **（批次 5 / Agents 页）系统 Agent 分区**：Agents 页加 `Your Agents` / `System Agents` 双标签，agent 加 `draft/published/archived` 三态（与修缮清单的"软下线"合并为一条）。——批次 5 要注册两个系统 agent，不分区就会和业务阵容混在一起。

其余建议补账（价值递减，可随批次顺手）：
- （长尾 Env/Repos）仓库 `Description` 注入 session context；按仓库挂 `.env` 文件。
- （长尾 Connections）连接连通性自检（`Last verified` + 手动测试按钮）。
- （批次 4）会话列表标注 runner 类型（CLAUDE/CODEX/PI），比原版的 `local` 标签更有用。
- （批次 5）`New Goal` 加 `Start from spec` 模式与 `Planning agent` 下拉。
- （远期 Costs）`Cache hit %` 列 + 成本口径说明（goal routing / 系统 agent 调用要不要计入）。
- （批次 1）Agent 编辑页 foundation 区块标 `v6` + `Read-only` + "叠加在你的指令之上"。
- **账目更正**：长尾 Templates 条目仍写"轻链(5 步)/重链(7 步)两条"，与 decisions §12 终版"废除轻/重链、单链九步、小任务靠模板跳步"矛盾，须改写。

### 判断为不值得做的 ❌（及理由）

- **`Due date` 任务到期日**：原版自己标注"Display only — no automatic reminders"，纯装饰。
- **`New Message`（人主动给 agent 发消息）**：与"建一个任务"功能重叠，多一条入口只多一份状态机。
- **`Available in all projects` 系列开关**（任务/技能/仓库/环境）：单人多项目下，跨项目共享用 `_global/` 作用域已够，每个实体都挂一个开关是纯负担。
- **`Show on task board` / 多收件箱来源标注**：为高频外部 webhook（601 次触发）设计，我方没有这个量级的外部输入源。
- **`Init Scripts` / Environment pip-npm 包**：原版每 session 起一次性容器才需要装环境；我方 runner 跑在常驻本机，环境就位。
- **`.versions/` 文件版本目录**：产出物大多进 git，版本化由 git 承担。
- **agent `New folder` 分组、`maxNestingDepth`、`Memory/Default` 行标签**：7 个 agent 的阵容用不上分组；当前阵容不派子代理，嵌套护栏无的放矢。
- **模板 `include` / `template-tasks` 复用机制、`unblocked_by` 并行分叉**：§12 已裁单链线性、评审收敛为单会话，复用与分叉都失去了对象。
- **`Open SDK ↗`、`<agent-message source="child">` 格式、Mount Path**：原版云端架构的产物，与本机 runner 路线不对应。
- **`Sign out`**：单用户自托管，token 三态已够；开源后若真要多设备访问，走反向代理鉴权（§11 已定）而不是应用内登录态。
