# Runner

## 时间线记录

### [0:21:30]
- 触发动作：从 `Goals` 列表进入/打开新目标创建流程，画面显示 `New Goal` 表单；鼠标停留在左栏 `Goals` 上。
- 左栏状态：顶部项目切换器为 `MMO Game`，左侧黄色方块头像为 `M`，右侧红色徽标 `23`，带下拉箭头。导航项依次为 `Inboxes`（红色徽标 `16`）、`Activity`、`Tasks`、`Goals`（选中）、`Sessions`、`Costs`、`Skills`、`Environments`、`Agents`、`Templates`、`Files`、`Knowledge`、`Repos`、`Connections`、`Admin`。底部全局区显示绿色状态点、`Runner`、`Running`，以及 `Settings`、`Sign out`。
- 右栏顶部：标题 `New Goal`；未见页签、搜索框或顶部操作按钮。
- 右栏主体：
  - 目标基本信息：`Title` 文本框，示例值 `Convert repo to Nuxt 4`。
  - 目标输入模式：两个切换项 `Describe objective`（黄色高亮选中）和 `Start from spec`。
  - 目标描述：`Objective` 多行文本框，提示语为 `Describe the outcome you want. Agents will explore, plan a Definition of Done for your approval, then loop until it's met.`。
  - 约束：`Constraints & preferences (optional)` 多行文本框，已填入以 `Each phase of work must be planned first by a planning agent, then implemented by senior dev agents against that plan. After every Plan agent, a Plan Review Coordinator agent must run to review the plan...` 开头的工作流程约束。
  - 规划代理：`Planning agent (optional)` 下拉选择框，当前值 `No agent (manual task)`；说明文字为运行第一个 planning task，需选择附带 repo 的 agent——`the default agent has no repo access`；留空则使用组织默认 agent。因此若规划任务需要仓库，应选择已附加 repo 的 agent。
  - 执行方式：`Execution` 下拉选择框，当前值 `Cloud (Claude Managed Agents, API billing)`；说明为从第一次迭代开始生效，批准后本地目标会等待空闲 runner，而不是回退到 cloud。
  - 限额：`Spend cap (USD)` 输入框示例值 `50`；`Wall-clock limit (hours)` 输入框示例值 `24`；`Stuck threshold (iterations)` 输入框示例值 `4`。
  - 表单操作：黄色按钮 `Create goal`，旁边是 `Cancel`。
- 页面目录结构：`New Goal` → `Title` → 输入模式（`Describe objective` / `Start from spec`）→ `Objective` → `Constraints & preferences (optional)` → `Planning agent (optional)` → `Execution` → `Spend cap (USD)` / `Wall-clock limit (hours)` / `Stuck threshold (iterations)` → `Create goal` / `Cancel`。
- 旁白要点：说明此前这些代理都在云端管理，使用 Anthropic 构建的 API，成本很高；字幕此刻提到每天大约花费 `$500`。

### [0:21:40]
- 触发动作：从目标创建表单切换到左栏 `Costs` 页面。
- 左栏状态：顶部项目切换器仍为 `MMO Game`，项目徽标 `23`；`Inboxes` 徽标 `16`；`Costs` 选中。底部仍为绿色 `Runner`、`Running`、`Settings`、`Sign out`。
- 右栏顶部：标题 `Costs`；说明文字为 `Total Anthropic spend from the cost ledger — task runs, dreams, goal routing and credential checks. The per-agent and per-day breakdowns below cover finalized task runs only.`；右上角时间范围下拉框为 `Last 30 days`。
- 右栏主体：
  - 汇总指标：`$5531.00`，标注 `this window`；`1929 runs`；`avg $2.82/run`。
  - `Daily total` 区块：右上角 `$5330.15 this window`；主体是按日期分组的多色堆叠柱状图，横轴可见 `Jul`、`Aug 1`、`Aug 5`、`Aug 9` 等日期刻度；柱顶/上方显示每日金额串。
  - `By agent` 区块：表格列名为 `Agent`、`Cost`、`Runs`、`Avg/run`、`Cache hit`。可见示例行包括 `Senior Dev` — `$1484.62`、`313`、`$4.74`、`96%`；`Plan Agent` — `$665.07`、`122`、`$5.45`、`90%`；`Senior Dev` — `$539.87`、`80`、`$6.75`、`97%`；`Plan Agent` — `$290.33`、`29`、`$10.01`、`94%`；`Code Reviewer` — `$257.76`、`133`、`$1.94`、`94%`；`Plan Executor` — `$210.17`、`19`、`$11.06`、`97%`。下方还有更多 agent 行。
  - `By model` 区块：彩色比例条和模型图例，能看到 `opus-5`、`fable-5`、`opus-4-8`、`sonnet-5`、`sonnet-4-6`、`haiku-4-5`、`haiku-4-5-20251001` 等；第一项旁可见 `$1458.88`、`26%`。
  - `Top runs in window` 区块：下方表格的列名可见 `Cost`、`Agent`、`Task`、`Model`。
- 页面目录结构：`Costs` → 时间范围（`Last 30 days`）→ 汇总指标 → `Daily total` → `By agent` → `By model` → `Top runs in window`。
- 旁白要点：展示高额 Anthropic 支出，并说明每天成本约为 `$500`，随后转入把运行器部署到虚拟机的解决方案。

### [0:21:48]
- 触发动作：返回 `Goals` 列表。
- 左栏状态：`Goals` 选中；顶部 `MMO Game`、徽标 `23`，`Inboxes` 徽标 `16`；底部显示绿色 `Runner`、`Running`、`Settings`、`Sign out`。
- 右栏顶部：标题 `Goals`；右上角有带归档图标的 `Archive` 和黄色 `+ New Goal` 按钮。
- 右栏主体：唯一可见目标卡片为 `Farming`；状态徽标 `running`，右侧有删除图标；进度 `0 of 10 done`；费用 `$0.30 / $100.00`；进度条尚未推进；底部状态 `Iteration 4`、`Active: Senior Dev`、`<1h elapsed`。
- 页面目录结构：`Goals` → 顶部操作（`Archive` / `+ New Goal`）→ 目标卡片 `Farming` → 完成数 / 费用 / 进度条 / 当前迭代与活动 agent。
- 旁白要点：说“终于把它部署在虚拟机上”，并表示可以看到一个 runner 正在运行。

### [0:21:50]
- 触发动作：鼠标移到左下角 `Runner`，打开本地 runner 信息浮层。
- 左栏状态：`Goals` 仍选中；顶部项目与徽标不变；底部 `Runner` 为绿色在线状态并显示 `Running`，其上方弹出 runner 详情；`Settings`、`Sign out` 仍可见。
- 右栏顶部：仍为 `Goals`，右上角为 `Archive` 与 `+ New Goal`。
- 右栏主体：`Farming` 目标卡片仍为 `running`，显示 `0 of 10 done`、`$0.30 / $100.00`、`Iteration 4`、`Active: Senior Dev`、`<1h elapsed`。
- 浮层主体：标题 `Local runner`；状态摘要 `1 of 1 runner online`；runner 名称 `agentos-runner-1`；黄色状态徽标 `Busy`；`Last heartbeat` 为 `20s ago`；`Daemon version` 为 `1.0.0`；`Claude CLI` 为 `2.1.226 (Claude Code)`；`Disk free` 为 `132.4 GB`；底部提示 `Refreshes every 30s`。
- 页面目录结构：`Goals` → `Farming` 运行中目标；全局 `Runner` → `Local runner` 浮层 → 在线数量 / runner 名称与状态 / heartbeat / daemon 与 CLI 版本 / 磁盘空间 / 刷新频率。
- 旁白要点：说明这是一个运行在 Hetzner 上的 `$10` 虚拟机，并展示本地 runner 正在工作。

### [0:22:00]
- 触发动作：停留在 `Goals` 列表页；相较 0:21:50，`Local runner` 信息浮层已关闭，画面没有切换到新目标表单。
- 左栏状态：顶部项目切换器为 `MMO Game`，左侧黄色方块头像为 `M`，右侧红色徽标 `23`，带下拉箭头。导航项依次为 `Inboxes`（红色徽标 `16`）、`Activity`、`Tasks`、`Goals`（选中）、`Sessions`、`Costs`、`Skills`、`Environments`、`Agents`、`Templates`、`Files`、`Knowledge`、`Repos`、`Connections`、`Admin`。底部全局区显示绿色状态点、`Runner`、`Running`，以及 `Settings`、`Sign out`。
- 右栏顶部：标题 `Goals`；右上角有带归档图标的 `Archive` 和黄色 `+ New Goal` 按钮。
- 右栏主体：唯一可见目标卡片为 `Farming`；状态徽标 `running`，右侧有删除图标；进度 `0 of 10 done`；费用 `$0.30 / $100.00`；进度条尚未推进；底部状态 `Iteration 4`、`Active: Senior Dev`、`<1h elapsed`。
- 页面目录结构：`Goals` → 顶部操作（`Archive` / `+ New Goal`）→ 目标卡片 `Farming` → `running` 状态 / 删除操作 / 完成数 / 费用预算 / 进度条 / 当前迭代与活动 agent / 耗时。
- 旁白要点：说明可以看到 runner 正在运行，并继续承接云端成本与本地虚拟机运行的介绍。

### [0:22:10]
- 触发动作：从 `Goals` 列表进入 `New Goal` 表单，并定位/滚动到执行配置区域；鼠标位于 `Plan agent runtime` 附近，画面未显示值发生变化。
- 左栏状态：画面为裁切后的局部左栏，底部可见 `Running`；完整全局导航状态不可见。
- 右栏顶部：处于表单下半部分；顶部约束文本框的末尾可见。
- 右栏主体：`Execution` 为 `Local runner (subscription)`；`Plan agent runtime` 为 `Claude`；`Worker runtime` 为 `Grok when possible`；下方解释文字明确显示 worker 优先在 runner 上使用 daemon 提供的模型，默认 `grok-4.6`，runner 忙碌、离线或限流时回退到 Claude cloud；数值为 `50` / `24` / `4`；`Create goal` 与 `Cancel` 可见。
- 运行时辅助说明：`Plan agent runtime = Claude` 时，每个 `plan-writing/review session` 在 runner 上运行 Claude，且 `The goal router stays on Claude.`
- 页面目录结构：`New Goal` → `Execution` → `Plan agent runtime: Claude` 与 `Worker runtime: Grok when possible` → 预算、时钟和卡住阈值 → `Create goal` / `Cancel`。
- 旁白要点：说自己喜欢把 planners 放在字幕所写的 `fable` 上；随后说明所有计划代理应在 cloud 运行、所有工作代理应在 grok 上运行。

### [0:22:20]
- 触发动作：继续展示运行时配置，鼠标停在 `Worker runtime` 标签附近；没有改变下拉值。
- 左栏状态：仍是裁切的局部左栏，底部显示 `Running`；完整项目切换器、徽标和大部分导航不可见。
- 右栏顶部：仍为 `New Goal` 表单的下半部分。
- 右栏主体：可见 `Plan agent runtime` = `Claude`、`Worker runtime` = `Grok when possible`；`Plan agent runtime` 辅助说明为每个 `plan-writing/review session` 在 runner 上运行 Claude，且 `The goal router stays on Claude.`；worker 说明中的默认模型为 `grok-4.6`，并说明在 runner 不可用时回退到 Claude cloud；`Spend cap (USD)` = `50`、`Wall-clock limit (hours)` = `24`、`Stuck threshold (iterations)` = `4`；底部为 `Create goal` / `Cancel`。
- 页面目录结构：`New Goal` → 执行来源 → 计划代理运行时 / 工作代理运行时 → 预算、时钟和卡住阈值 → 提交或取消。
- 旁白要点：强调 `grok 4.6` 很快、自己很喜欢使用它，并表示这些运行时映射也可以设置。

### [0:22:30]
- 触发动作：从 `New Goal` 表单返回 `Goals` 列表，并向下滚动到已完成目标区域。
- 左栏状态：顶部项目切换器为 `MMO Game`，项目徽标 `23`；`Inboxes` 徽标 `16`；`Goals` 选中；底部绿色 `Runner`、`Running`、`Settings`、`Sign out`。
- 右栏顶部：列表已向下滚动，页面标题和顶部操作不在视口中。
- 右栏主体：显示多个已完成目标卡片，每张卡片都有黄色 `done` 徽标、归档/操作图标和删除图标、完成数、黄色满进度条、费用与预算、迭代和耗时：
  - `Butchering`：`10 of 10 done`；`$59.17 / $125.00`；`Iteration 9`；`2h elapsed`。
  - `Fighting v1`：`22 of 22 done`；`$212.42 / $200.00`；`Iteration 30`；`18h elapsed`。
  - `Mining`：`11 of 11 done`；`$158.51 / $250.00`；`Iteration 15`；`15h elapsed`。
  - `Fences`：`10 of 10 done`；`$128.81 / $100.00`；`Iteration 15`；`14h elapsed`。
  - `Climbing`：`9 of 9 done`；`Iteration 11`；`2h elapsed`；费用右侧部分被画中画遮挡。
  - `Natural regrowth`：`12 of 12 done`；`Iteration 7`；`1h elapsed`；费用右侧部分被画中画遮挡。
  - 底部还露出下一项 `Toolbelt` 的标题和 `done` 徽标。
- 页面目录结构：`Goals` 列表 → 已完成目标卡片 → 目标名 → 完成数 / 进度条 / `done` 状态 / 费用预算 / 迭代与耗时 / 归档与删除操作。
- 旁白要点：以“现在已经运行起来，而且这非常……”收尾，承接对本地 runner 和按 agent 类型分配运行时的总结。

## 功能清单

- 组织/项目切换器：当前项目为 `MMO Game`，显示项目徽标和数量徽标。
- 左栏导航至 `Goals`、`Costs` 等模块，并显示 `Inboxes` 未读徽标。
- 全局 `Runner` 在线状态入口，显示 `Running`。
- 本地 runner 监控浮层：在线数量、runner 名称、`Busy` 状态、heartbeat、daemon version、Claude CLI 版本、磁盘剩余空间、自动刷新频率。
- 创建目标：填写标题、目标描述、约束与偏好。
- 目标创建模式：`Describe objective` 或 `Start from spec`。
- 可选 `Planning agent`，支持手动任务或指定代理；说明 repo 附件和组织默认 agent 行为。
- 目标执行来源选择：`Cloud (Claude Managed Agents, API billing)` 或 `Local runner (subscription)`。
- 本地执行等待空闲 runner，不因 runner 忙碌而自动回退 cloud；运行时说明还支持在 runner 忙碌、离线或限流时回退到 Claude cloud。
- 独立配置 `Plan agent runtime` 与 `Worker runtime`，示例为 `Claude` 和 `Grok when possible`。
- `Plan agent runtime = Claude` 时，每个 `plan-writing/review session` 在 runner 上运行 Claude，且 `The goal router stays on Claude.`
- Grok worker 使用 daemon 提供的模型，默认 `grok-4.6`；计划/审查会话可在 runner 上运行 Claude。
- 目标治理参数：`Spend cap (USD)`、`Wall-clock limit (hours)`、`Stuck threshold (iterations)`。
- 目标列表显示运行中/完成状态、完成数、进度条、费用/预算、迭代次数、当前活动 agent 和耗时。
- 目标列表支持 `Archive`、删除目标和新建目标。
- `Costs` 页面提供时间范围筛选、总支出、运行次数、平均每次运行成本。
- 成本按日以堆叠柱状图展示，并按 agent、model 分组。
- 成本表显示 `Cost`、`Runs`、`Avg/run`、`Cache hit` 等指标；下方有 `Top runs in window`。
- 云端 Anthropic API 费用可被集中审计，旁白所述当前日成本约 `$500`。

## 仅旁白提及（画面未见）

- 代理此前全部在云端托管/管理，使用 Anthropic 构建的 API。
- 每天大约花费 `$500`。
- 运行器已部署到 Hetzner 虚拟机；旁白称该虚拟机约 `$10`。
- 云端运行配置中提到 `dangerously skip permissions` 和 `grok yolo mode`；截图未显示这些具体配置文字。
- 目标可以明确指定“只在本地运行器上运行”。
- 旁白称希望把 planners 放在 `fable` 上；画面实际可见的运行时值为 `Claude` 和 `Grok when possible`，未见名为 `fable` 的控件值。
- 旁白概括的路由意图是所有计划代理在 cloud、所有工作代理在 grok 上运行；画面只显示可分别配置 `Plan agent runtime` 与 `Worker runtime`，未显示完整的批量规则或保存结果。
- 旁白称 `grok 4.6` 非常快且很喜欢使用它；画面仅在说明文字中显示默认模型 `grok-4.6`。
