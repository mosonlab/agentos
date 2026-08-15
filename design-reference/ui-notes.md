# AgentOS UI 设计参考笔记

来源：Danny Postma, "How I Built My Own AgentOS on Claude's Agent SDK (So You Can Too)"
(https://www.youtube.com/watch?v=Tos-zPxYPuc, 26 分钟)。从视频每 15 秒抽一帧共 103 帧，
挑出 44 张系统界面截图，文件名后缀 `-tNNNN` 是视频秒数。产品域名在状态栏里露出为
`postmaos.com`（路径如 `/tasks`, `/agents/<id>`, `/connections`）。

以下全部是截图里**实际看到**的内容，没有推测的部分。看不清的地方标注了「看不清」。

---

## 0. 全局视觉语言（所有截图共通）

- **主题**：暗色，但不是中性灰黑，而是**暖橄榄/棕黄调的黑**。页面背景近乎纯黑，
  内容区大面板是带黄绿倾向的深色（像 #14140c ～ #1b1a10 那一带），越靠近内容中心
  越偏「暗橄榄」。侧边栏比内容区再深一点。整体给人「终端里的 dashboard」的感觉。
- **字体**：几乎**全站等宽字体**（mono）。页面大标题（Tasks / Agents / Inboxes / Costs /
  Goals / Files）是加粗 mono，正文、表头、表单 label、按钮文字也都是 mono。唯一非 mono
  的是视频字幕（不属于 UI）。
- **主强调色 = 亮黄**（近似 #E9C64A / 金黄）。用在：主行动按钮（Create Task / Create Agent /
  New Goal / New Trigger / Upload / Save / Create goal / Save changes）、
  选中态 tab 的实心底（Inboxes 的 Active、Files 的 Project）、开启态的 toggle、
  项目头像方块、移动端底部导航中央的 + 圆钮、Goals 列表里的进度条。
- **状态色**：
  - 红：侧栏顶部项目名旁的未读总数 badge（圆角药丸、纯红底白字）、Inboxes 的未读数、
    危险操作（Cancel goal 是浅红/珊瑚色实心按钮）。
  - 绿：`Published` / `Enabled` 药丸（深绿底、绿字，1px 绿边）、Runner 的 `Running`
    小绿点、Runs 表里的 `✓ Success`、子任务完成的 ✓ 圆圈图标。
  - 琥珀/黄：`Approval` 药丸、`running` / `done` 小药丸、`Awaiting reply` 药丸、
    `Runner online` 药丸。
  - 紫/薰衣草：**agent 名字 chip**（Spec Agent / Plan Agent / Review Coordinator /
    Plan Executor / Senior Dev / Librarian），带小机器人图标；人类 assignee chip
    （`danny`）用的是人形图标，同色系。
  - 蓝紫：链接、mode 药丸 `Template`。
- **形状**：卡片/面板圆角约 8-10px，1px 极低对比描边；按钮圆角 6-8px；药丸全圆角。
  面板之间用 16-20px 间距堆叠，没有重阴影，靠底色明度差分层。
- **信息密度**：偏高但不拥挤。表格行高宽松（约 60px），行之间用极淡分隔线。
- **录屏细节**：所有截图是浏览器窗口截图，右下角有 Danny 的圆角摄像头小窗，
  底部有视频字幕条——都不是 UI 的一部分。

---

## 1. 主框架 / 左侧导航（几乎每张图都能看到）

固定宽度（约 210px）的左侧栏，从上到下：

1. **项目切换器**：黄色圆角方块 + 首字母（M / H）、项目名（`MMO Game` / `HeadshotPro`）、
   红色未读数 badge（23 / 24）、下拉 chevron。说明是多项目/多 workspace 结构。
2. **导航项**（图标 + 文字，顺序固定，全站一致）：
   `Inboxes`（带自己的红色未读数 badge，如 16/17/1）、`Activity`、`Tasks`、`Goals`、
   `Sessions`、`Costs`、`Skills`、`Environments`、`Agents`、`Templates`、`Files`、
   `Knowledge`、`Repos`、`Connections`、`Admin`。
   图标是细线风格（信封、心电图、列表、靶心、时钟回退、票据、闪电、立方体、机器人、
   文档、文件夹、书、git 分叉、链环、盾）。
3. 中间大段留白。
4. **底部固定区**：`● Runner` + 右侧灰字 `Running`（绿点）、`Settings`、`Sign out`。
   Runner 状态常驻可见 = 本地 runner 在线与否是一等信息。

选中项：整行浅色块 + 圆角，文字变白。hover 会出现小 tooltip（见 goals-list-t1155，
鼠标停在 Tasks 上弹出深色 `Tasks` 小标签）。

内容区：左侧留出较宽外边距，页面标题（H1，mono 粗体）在左上，主行动按钮在同一行最右。
标题下面常有一行灰色副标题（如 Files 的 "Browse and manage stored files"、
Inboxes 的 "Messages and updates from your agents"）。

---

## 2. 任务板 / Kanban

**`kanban-tasks-board-t1560.jpg`**
- 标题 `Tasks`，右上黄色 `+ Create Task`。
- 标题下是**分段 tab 组**（深色圆角容器里的 5 个 tab）：`My Tasks | Tasks | Automations |
  Triggers | Archived`，选中的 tab 是更亮的深色块。
- 看板 5 列：`Backlog 0`、`Todo 0`、`Doing 1`、`Review 0`、`Done 10`，每个列名右边跟一个
  计数 badge。Done 列右侧还有一个归档小图标。
- 空列显示居中灰字占位 `Drop tasks here`（明示可拖拽）。
- **任务卡**结构（Doing 列的 "Implement feat/test"）：卡片标题（mono 粗体白字）→
  调度模式 `Once` → `⇄ 0/9 subtasks` → 一行当前子任务状态 `● Write spec · idle`
  （蓝点 + 子任务名 + 状态词）。卡片右下有 `⋮` 更多菜单。
- Done 列的卡片（"Canary inbox"）多出：agent chip `🤖 Senior Dev`、`Once`、
  `✓ 34m ago`、`$ 0.39` 花费。也就是**卡片上直接显示这次任务花了多少钱**。
- 另一张 `Deep research refactoring.` 卡显示 `Review Coordi…`、`✓ 6d ago`、`$10.97`；
  `Implement feat/action-queue` 卡显示 `9/9 subtasks`、`$59.13`。

---

## 3. 任务详情

**`task-detail-full-t0870.jpg`**（页面顶部）
- 顶栏：← 返回箭头 + 任务标题 `Implement fix/fan-out-move` + 一个黄色小横杠状态标记；
  右侧 `Edit` 按钮 + `⋮`。
- **Details 卡**：两列 key/value 网格 —— `Agent: No agent`、`Assignee: Unassigned`、
  `Schedule: Run Once`、`Requires approval:` + toggle（关闭态，后面灰字
  "(Assign an agent first)"）。
- **Prompt 卡**：纯文本长 prompt，超出后折叠为 `⌄ Show more`。
- **Attachments 卡**：标题带计数 `1`；已上传文件显示为小卡（文件图标 + 文件名 +
  `4.6 KB`），旁边是虚线框的 `+ Upload` 占位块。
- 再往下是 `Subtasks 9/9`。

**`task-subtasks-closeup-t0810.jpg`**（子任务区放大，最能看清元素）
- 区块标题 `Subtasks` + 计数药丸 `9/9`，右侧 `+` 新增。
- 每行：拖拽手柄（hover 才出现的六点）→ 绿色 ✓ 圆圈（完成态）→ 依赖计数
  `⇄ 1`（表示依赖 1 个上游）→ 子任务名（**完成的用删除线**）→ 右侧一组 chip：
  可选的琥珀 `🛡 Approval`（需人工批准）、紫色 agent chip（`Spec Agent` /
  `Plan Agent` / `Review Coordinator` / `Plan Executor` / `Senior Dev` / `Librarian`）
  或人类 chip `👤 danny` → 行尾 `>` 进入。
- hover 行会额外露出两个小图标（盾/日历，推测是审批与排期的快捷设置，图标不清）。
- 底部 `+ Add subtask...`。
- 这 9 步就是他的流水线：Write spec → Plan implementation → Plan review →
  Revise plan from review → Implement → AI review → Apply review fixes →
  Update wiki → Review & Deploy。

**`task-detail-subtasks-t0660.jpg`** 同一区块的整页视图（可看到它在页面中的位置）。

**`task-comment-and-runs-t0735.jpg`**
- 任务底部有 **Activity** 流（agent 发的 markdown 消息）+ 输入框 `Add a comment...`
  （右侧一个发送图标）。
- 再下面是 **`Runs`** 区块：一个复选框 `Show session sessions`（字小看不清）+ `↻ Refresh`，
  表头 `Started | Duration | Status | Cost | Tokens | Result`，行示例
  `Aug 2, 3:24 PM · 10m 3s · done · $0.67 · 82.3K · ✓ Success`。

**`task-runs-table-t0840.jpg`**：同样的 Runs 表但有 9 行，能看清每行都是
`时间 / 时长 / done / $金额 / token 数 / ✓ Success`，金额从 $0.60 到 $2.40 不等。
上方还能看到 Activity 里 agent 写的 "Updated (2 articles)" 之类的 markdown 报告。

---

## 4. 建任务

**`new-task-modal-blank-t0600.jpg`**（Blank task）
- 全屏覆盖式面板（不是小 modal，是盖住内容区的大层），顶部 `New Task` + 右上
  `Cancel` / `Create` / 黄色 `Create & Run` 三个按钮。
- 两个 tab：`Blank task | From template`。
- 表单字段依次：`Title`（Canary）、`Prompt`（大 textarea）、`Attachments (optional)`
  （虚线 + Upload 方块）、`Agent`（下拉，值 `Senior Dev`）、`Assignee (optional)`
  （`Unassigned`）、`Due date (optional)`（dd/mm/yyyy + 日期选择器，灰字提示
  "Display-only — no automatic reminders or state changes"）、`Schedule`（单选
  `Run once` / 还有一项被字幕挡住）。

**`new-task-from-template-t0615.jpg`**（From template）
- `Template` 下拉：`Compound Engineering Workflow (22 tasks)`。
- `Feature description`（大 textarea，聚焦时黄色描边）、
  `Feature branch name (e.g. feat/inbox-search)`、`Additional details (optional)`
  （原生 `Choose file / No file chosen`）。
- **`Will create` 预览块**：等宽文本树状列出模板将生成的任务及依赖，如
  `- Implement {{branch_name}}` / `- (depends on spec)` / `- (depends on plan)`。
  即模板带 `{{变量}}` 插值。

**`new-task-template-branch-autocomplete-t0630.jpg`**：branch name 输入 `feat/` 时弹出
历史分支自动补全下拉（feat/random-quote、feat/v1、feat/toggle-task-cards、
feat/free-headshot-v3、feat/hamburger-menu、feat/submission-moderation）。

---

## 5. Agents

**`agents-list-t0225.jpg`**
- 标题 `Agents`；tab `Your Agents | System Agents`；右上 `🗀 New folder`（次级、描边按钮）
  和黄色 `+ Create Agent`。
- 表格：全选复选框 + `Name | Model | Status | Updated` + 行尾 `⋮`。
- 行示例：`Default Agent` 带灰色 `Default` 小标签、`Senior Dev`（hover 时下划线）、
  `Plan Executor`、`Review Coordinator`、`Plan Reviewer`、`Code Reviewer`、
  `Plan Agent`、`Librarian` 带 `Memory` 标签、`Spec Agent`。
- Model 列直接写模型名：`Opus 5` / `Fable 5` / `Sonnet 4.6` / `Opus 4.8`。
- Status 列统一绿色 `Published` 药丸。Updated 是日期（Aug 4-10, 2026）。

**编辑 agent** 是一个全屏层，顶部 `← Edit Agent` + `Cancel` + 黄色 `Save`，
下面 4 个 tab：`Setup | Prompt | Capabilities | Collaborators`。

- **`edit-agent-prompt-tab-t0255.jpg`**：Prompt tab。有一个可折叠的只读区
  `> AgentOS Foundation · v0 · Read-only`（右侧灰字 "this above your instructions"，
  即系统底座提示词），下面是 `Your agent instructions` 的大 textarea（等宽、
  带滚动，内容是 markdown/xml 混排的长 prompt）。底部灰字说明 agent 会继承 foundation。
- **`edit-agent-capabilities-tools-t0300.jpg`**：Capabilities tab 上半。
  - `Memory` 区块：一行 `Enable agent memory` + 副标题 "Store and recall learnings
    across sessions" + 右侧 toggle（关）。
  - `Tools` 区块：一个总开关 `Enable agent tools`（开，黄色），下面一个卡片里逐项
    toggle：`Bash / Read / Write / Edit / Glob / Grep / Web fetch / Web search`，全部开。
- **`edit-agent-capabilities-skills-mcp-repos-t0315.jpg`**：同页往下滚。
  - `Skills`：`Verify Live / Update Wiki / Plan Mode / Interview / Analyze Branch Bugs`
    逐项 toggle（只有 Plan Mode 开）。
  - `MCP Connections`：右上角有配额计数 `1 / 20`；条目 `AgentOS MCP`
    （副标题 "Inbox messaging and internal tools"，开）、`Ahrefs` 带灰色 `Global` 标签（关）、
    `GitHub MCP`（关）。
  - `Repositories`：`vibeville` + 灰字 `dannypostma/vibeville` + toggle（开）；
    下面一条提示 "Want this agent to push code, create branches, or open PRs?
    Set up the GitHub MCP in Connections"（带下划线内链）。
- **`edit-agent-collaborators-t0330.jpg`**：Collaborators tab。说明文字
  "Select which agents this agent can spawn as collaborators for subtasks.
  Only published agents are shown."；下面是 agent 列表，每条是**名字 + 一段角色描述 +
  右侧 toggle**（Default Agent / Senior Dev / Plan Executor / Review Coordinator /
  Plan Reviewer / Code Reviewer / Plan Agent / Librarian / Spec Agent）。
  描述例："You are Senior Dev — a senior engineer with strong taste and the
  discipline to ship small, correct changes."

---

## 6. Skills

**`skill-detail-plan-mode-t0405.jpg`**
- 顶栏 `← Plan Mode` + 绿色 `Published` 药丸；右侧 `Edit` 描边按钮 + 黄色 `Republish` + `⋮`。
- `Details` 卡：两列 —— `Source: Custom`、`Skill Name: plan`、`Created: Aug 1, 2026`、
  `Published: Aug 1, 2026`。
- `Content` 卡：内嵌一个更深底色的代码块，显示 skill 的 YAML frontmatter
  （`name: plan` / `displayTitle: Plan Mode` / `description: ...`）+ markdown 正文，
  折叠为 `⌄ Show more`。

---

## 7. Environments（沙箱）

**`edit-environment-limited-network-t0360.jpg`**
- `← Edit Environment` + Cancel + 黄色 Save。
- 字段：`Name`（Default）、toggle `Available in all projects`（开）、
  `Packages` 分 `pip`（占位 "pandas, numpy, requests"）和 `npm`（占位 "cheerio, lodash"）
  两个输入框。
- `Networking`：单选 `Unrestricted` / `Limited`（选中的是实心黄圆点）。选 Limited 后
  展开一个子卡片：`Allowed hosts (one per line)` textarea（值 `api.front.com`）+
  两个 toggle `Allow MCP servers`、`Allow package managers`（都开）。
  → 条件性展开的表单区用「缩进 + 内嵌卡片」表达从属关系。

---

## 8. Files / 文件查看

**`files-browser-t0450.jpg`**
- 标题 `Files` + 副标题；右上三个按钮：`🗀 New Folder`（描边）、`🗎 New File`（描边）、
  黄色 `⬆ Upload`。
- 作用域切换：`Project | Global | Root` 分段控件（Project 选中为黄底黑字），
  后面跟一个复制路径的小图标。
- 表格 `Name | Size | Modified`，文件夹行是橙色文件夹图标 + 名称，Size/Modified 为 `–`，
  行尾 `…` 菜单。目录：`.versions, goals, mnt, plans, pr, prs, reviews, runs, specs`
  —— 这是 agent 的共享文件系统布局。

**`file-viewer-markdown-t0465.jpg`**：打开单个文件时，顶部是**面包屑路径**
`← Files › goals › agentos-guide › implementation-review.md` + 复制图标，
右侧 `👁 Preview`、`⬇ Download`、黄色 `Save`（看不清是否 Edit）。
下面一行小字元信息（修改时间、`FROM agent:agent_...` 之类）。正文是等宽文本编辑区。

---

## 9. Connections / Repos

**`connections-mcp-t0480.jpg`**：标题 `Connections` + 副标题 "Manage MCP server
connections for your agents"，右上描边按钮 `+ Add connection`，主体是加载中的 spinner
（当时列表还没渲染出来）。

**`repos-list-t0495.jpg`**：标题 `Repos` + 副标题 "Manage GitHub repository
connections for your agents"，右上黄色 `+ Add Repo`。表格
`Name | URL | Credential | Updated`，行 `vibeville | dannypostma/vibeville |
GITHUB_PAT_VIBEVILLE | Aug 1, 2026`。行尾 `⋮` 展开小菜单（`✎ Edit`、红色 `🗑 Delete`）。

**`edit-repo-environment-t0510.jpg`**：`← Edit Repo` + Cancel；tab `General | Environment`。
Environment tab 内容：说明 "Environment files are mounted relative to
`/workspace/vibeville` in agent sessions. Values are encrypted at rest."，
空态居中灰字 `No environment files configured`，左下 `+ Add .env file`，
右下黄色 `Save All`。

---

## 10. Inboxes（agent↔人 的消息中枢）

**`inboxes-list-t0885.jpg`**
- 标题 `Inboxes` + 副标题 "Messages and updates from your agents"；
  `Active | Archived` 分段（Active 是黄底黑字）；右上描边按钮 `✎ New Message`。
- 列表项（一整行卡片，1px 描边，行间距 10px）：
  左侧复选框 → 发信人（`Senior Dev` 白字粗体 / `System`）+ 可选的琥珀
  `Awaiting reply` 药丸 → 第二行是标题（前面有个黄色未读小圆点，标题可带 emoji，
  如 `🙋 Canary: agent → human question`、`Goal complete: Player death ✓`）→
  第三行灰色摘要，单行省略。右侧：相对时间（`24m ago` / `2h ago` / `14h ago`）+
  第二行灰字来源 `MMO Game Inbox` + `⋮`。
- 系统消息内容举例："**8** of **8** Definition of Done criteria are met after 15
  iterations. Total spend: $5.95."、"Local runner fallback → cloud"、
  "Local runner unavailable — goal re-queued"。

**`inbox-thread-canary-t0930.jpg`**（会话详情）
- 顶部 `← Back to Inboxes`；标题行 `🟡 Canary: agent → human question`，
  右侧 `updated just now` + 刷新图标 + 红色删除图标。
- 消息以**卡片流**呈现，每张卡左上是发信方（`Senior Dev` 带机器人图标 / `You`），
  右上是时间戳；正文左对齐等宽文本。你发的消息（"Say hi"）与 agent 回复用同样的卡片，
  不做左右气泡分列。
- 底部固定一个 `Type your reply...` 输入框，右下有黄色发送按钮。

**`agent-question-blocking-reply-t0900.jpg`**（agent 提问阻塞态，重点交互）
- agent 消息里可以渲染完整 markdown：这里是一个 `Thing | Status` 表格
  （`init.sh ✅ completed`、`mongod / redis ✅ 127.0.0.1:27017 / :6379`、
  `Workspaces built ✅ 4/4 (sim, protocol, server, client)`、`Run ⏸ blocked on you`），
  下面是加粗的 **The question:** + 有序列表选项 + 行内 code。
- 输入框上方有一条**琥珀色描边的提示条**，左侧问号图标，文字
  "The agent is waiting for your reply before continuing."
- 下面是 `Type your answer...` textarea。

---

## 11. Sessions（agent 实时运行视图）

**`session-live-view-t0990.jpg`**
- 顶栏：`← Senior Dev` + 蓝色带 spinner 的 `Running` 药丸 + 灰色 `local` 标签；
  最右 `↻ Refresh`。
- 副标题行：`Task: [Goal] Farming — iteration 4  In progress  Started Aug 14, 9:25 AM`。
- **统计药丸行**：`● Live`（绿点）、`43 messages`、`293 tool calls`、`2 files`
  —— 都是深色圆角小块。
- 可折叠区 `> 🗀 Files touched  2`。
- 主体是一个**带滚动条的等宽文本流**（agent 的 system prompt / 消息原文，
  含 `<subagents>`、`<capabilities>`、`<repositories>` 这类 XML 段），
  背景比页面稍亮，右侧有细滚动条。
- 底部固定 `Type a message…` 输入框 —— **可以在 agent 运行中插话**。

---

## 12. 移动端 / PWA

**`mobile-pwa-inbox-t0945.jpg`**（窄栏，明显是手机宽度的 PWA 窗口）
- 顶栏：左侧品牌字 `AgentOS`，右侧三个圆形图标钮（✨ 魔法棒、☰ 菜单、👤 头像带红色
  未读数 17）。
- 页面标题 `Inboxes` + 副标题；`Active | Archived` 分段 + 右侧 `🗑 Archive all` 和 ✎ 图标。
- 列表项比桌面更紧凑：发信人 + 可选 `Awaiting reply` 药丸或计数 badge（`Senior Dev 3`）、
  标题、单行灰摘要、右侧相对时间。
- **底部 tab bar**（5 项）：`Inbox`（带红色 17 badge）、`Goals`、中央凸起的黄色圆形 `+`、
  `Sessions`、`Tasks`。图标风格与桌面侧栏一致。

**`mobile-pwa-question-card-t0960.jpg`**（移动端回答 agent 提问）
- agent 消息渲染 markdown 列表 + 行内 code（`apps/client/index.html → <title>`）。
- 下面是一张**问答卡**：顶部小字 `Question 2 of 2 — Placement` + 一条黄色进度条；
  加粗问题 `Where should the "!" go?`；三个**单选选项卡片**（每张：圆形 radio +
  选项标题 + 灰色 e.g. 说明；第一项右上角有琥珀 `Recommended` 标签；最后一项是
  `Other / Provide your own answer`）；底部两个并排按钮 `Back`（深色描边）和
  `Submit`（黄色实心）。
- 卡片下面仍有自由文本 `Type your answer...`。
- → 结构化提问（选项 + 推荐项 + 自由输入并存）是这个系统的关键交互。

---

## 13. Triggers（事件触发）

**`triggers-list-t1020.jpg`**：`Tasks` 页的 `Triggers` tab。右上黄色 `+ New Trigger`。
表格 `Name | Mode | Target | Status | Last Fired | Fires`：
- `Classify Front Conversation` + 灰色副标题 "Routes conversation to the correct CS rep"，
  Mode = 紫色 `Template` 药丸，Target = `Classify Front Conversation`，
  Status = 绿色 `Enabled`，Last Fired = `just now`，Fires = `601`。
- `Bug Report`（"Triggers when CS rep submits report from /admin/report-bug"），
  `22h ago`，`12`。
- 注意：**Name 列用「标题 + 说明副标题」两行**，是全站表格的通用模式。

**`trigger-detail-recent-fires-t1065.jpg`**：触发器配置页
- 字段：描述输入框、`Show on task board` toggle（副标题 "When this trigger fires,
  show its primary task on the kanban. Child tasks stay hidden."）、
  `Default variables`（`Front conversation ID (cnv_XXXXX)` + 红色 `required` 标记 + 输入框）、
  `First-task auto-start` 下拉（`Always auto-start`）、`Replay window (seconds)`（300）、
  右下黄色 `Save changes`。
- 下面独立一块 `Recent fires`：每行 `Triage cnv_1oiso7hi` + 右侧状态药丸
  （琥珀 `running` / 灰黄 `done`）+ 时间 `14/08/2026, 09:34:48`。

---

## 14. Automations（定时任务）

**`automations-list-t1140.jpg`**：`Tasks` 页的 `Automations` tab。
表格 `Title | Agent | Schedule | Status`，行可展开（左侧 `⌄`/`>` 箭头）：
- `Weekly LinkedIn Content Calendar writing | LinkedIn Calendar Agent |
  At 01:00 AM, only on Monday`（人类可读的 cron 描述）。
  展开后是内嵌区块 `Recent sessions:` + 一行 `Aug 12, 2:16 PM · Running... · Running`
  + 链接 `View all sessions →`。
- `Send current time | Default Agent | Every minute`。
- Status 列是 toggle（右侧被截断）。

---

## 15. Goals（长跑目标，本系统最有特色的一块）

**`goals-list-t1155.jpg`**：标题 `Goals`，右上 `🗄 Archive`（描边）+ 黄色 `+ New Goal`。
每个 goal 是一张宽卡：标题 `Farming` + 右侧灰色 `running` 药丸 + 删除图标；
第二行左 `0 of 10 done`、右 `$0.30 / $100.00`（花费/预算）；中间一条**黄色进度条**；
第三行灰字 `Iteration 4  Active: Senior Dev  <1h elapsed`。

**`goal-detail-definition-of-done-t1170.jpg`**（goal 详情，信息架构最丰富的一页）
- 顶部：标题 `Farming` + 灰 `running` 药丸 + 黄色 `Runner online` 药丸；
  右侧一排操作按钮 `Nudge | Pause | Restart session | Adjust limits`（都是深色描边）
  + 珊瑚红实心 `Cancel goal`。
- 下面是 goal 描述长文，折叠 `⌄ Show more`，再一行 `🗎 Started from spec: farming.md`。
- **当前活动条**：整宽深色条 `⟳ Senior Dev working — iteration 4`（带 spinner）。
- **4 个并排的指标卡**（等宽网格）：`DoD progress: 0 done · 0 waived · 10 open`、
  `Spend: $0.30 / $100.00`、`Iteration: 4`、`Active agent: Senior Dev`。
- **tab 组**：`Definition of Done | Progress log | Sessions | Orchestrator | Results`。
- Definition of Done tab 内容是 agent 生成的长 markdown（H1 标题、行内 code、
  项目符号列表），带 §refs 引用 spec 章节。

**`goal-detail-orchestrator-t1215.jpg`**：Orchestrator tab = **决策时间线**。
每条是一张卡：左侧图标（▷ 派发 / ⇉ 路由 / ✓ 完成）+ 加粗标题
（`Dispatched iteration 4 — session task created for Senior Dev`、
`Routed iteration 4 → Senior Dev`、`Session completed — router re-evaluating`）+
右侧相对时间；路由卡下面还有一段灰色**理由说明**（为什么选这个 agent）。

**`goal-detail-progress-log-t1260.jpg`**：Progress log tab = `Progress Log: Farming`
+ `Learnings` 小标题 + 一串带行内 code 的 bullet（agent 自己写的经验沉淀）。

**`adjust-limits-modal-t1275.jpg`**（唯一一个真正的居中 modal）
- 遮罩把背景压暗；modal 圆角卡片，右上 `✕`。
- 标题 `Adjust limits`，字段：`Spend cap (USD)` 100（下方灰字 "$0.30 spent so far."）、
  `Wall-clock limit (hours)` 72（数字 stepper）、`Stuck threshold (iterations)` 9、
  `Session budget (minutes)` 120（说明 "Each work session is nudged to wrap up after
  this many active minutes (5-480). Applies from the next session."）、
  `Grace period (minutes)` 10（"A session still running this long after the nudge is
  force-stopped (1-120)."）、`Execution` 下拉 `Local runner (subscription)`、
  再往下 `Plan agent runtime` / `Worker runtime` 两个并排下拉。
- **每个数字输入下面都有一句解释这个数字会导致什么行为** —— 全站的表单说明风格。

**`new-goal-form-t1290.jpg`**（建 goal）
- 单列窄表单（居中偏左），标题 `New Goal`。
- `Title`（Convert repo to Nuxt 4）→ 分段 `Describe objective | Start from spec`
  （前者黄底选中）→ `Objective` textarea（占位文字直接解释机制："Describe the outcome
  you want. Agents will explore, plan a Definition of Done for your approval,
  then loop until it's met."）→ `Constraints & preferences (optional)` textarea →
  `Planning agent (optional)` 下拉（`No agent (manual task)` + 灰字说明）→
  `Execution` 下拉（`Cloud (Claude Managed Agents, API billing)` + 说明）→
  三个并排小输入 `Spend cap (USD) 50` / `Wall-clock limit (hours) 24` /
  `Stuck threshold (iterations) 4` → 黄色 `Create goal` + 文字按钮 `Cancel`。

**`new-goal-execution-runtime-t1335.jpg`**：同表单选 `Local runner (subscription)` 时，
下方多出 `Plan agent runtime`（`Claude`）与 `Worker runtime`（`Grok when possible`）
两个下拉，各自带说明文字。

**`goals-local-runner-popover-t1320.jpg`**：Goals 页上弹出的 **runner 状态 popover**
（从侧栏底部 Runner 触发）：标题 `Local runner` + `1 of 1 runner online`，
一行 `agentos-run…` + 黄色 `New` 药丸，下面 key/value：`Last heartbeat 28s ago`、
`Daemon version 1.0.0`、`Claude CLI 2.1.235 (Claude Code)`、`Free 132.4 GB`，
底部灰字 "Refreshes every 30s"。

**`archived-goals-t1380.jpg`**：`Archived Goals` 页（右上 `🗄 Back to goals`）。
每条：标题（Player death / Agressive spider / Local chat / Event console /
Wildlife v1 / Static waterline）+ 右侧黄色 `done` 药丸 + 两个小图标；
第二行 `6 of 6 done` 与右侧 `$7.99 / $100.00`；下面**整条满格的黄色进度条**；
第三行灰字 `Iteration 15  30m elapsed`。→ 已完成的 goal 用满格黄条形成很强的视觉节奏。

---

## 16. Costs（费用仪表盘，全站唯一的彩色页面）

**`costs-dashboard-t1305.jpg`**
- 标题 `Costs` + 两行灰色说明（"Total Anthropic spend from the cost ledger — task runs,
  dreams, goal routing and credential checks..."）；右上时间范围下拉 `Last 30 days`。
- **大数字摘要行**：`$5531.00` (大号 mono) + 灰字 `this window`，同行还有
  `1929 runs`、`avg $2.82/run`。
- 左侧大卡 `Daily total`：**堆叠柱状图**，每天一根柱、按 agent/model 分色堆叠。
  配色是高饱和的霓虹色（粉红、紫、青绿、橙、黄、蓝、绿），**与全站的黄+暗橄榄形成
  强烈反差**，是唯一的彩色区域。柱子上方还有一行极小的每日金额文字。x 轴是日期。
- 右侧上卡 `By agent`：表 `Agent | Cost | Runs | Avg/run | Cache hit`，
  每行前面有一个与图例同色的圆点；Cache hit 一列是绿色百分比（96% / 90% / 97%）。
- 右侧下卡 `By model`：一条**横向占比色带**，下面是图例列表
  （opus-5 / fable-5 / opus-4-8 / sonnet-5 / sonnet-4-6 / haiku-4-5 /
  haiku-4-5-20251001）+ 右侧 `$1458.88 · 26%`。
- 页面底部还有 `Top runs in window` 表（`Cost | Agent | Task | Model`）。

---

## 17. YAML / CLI（配置即代码那一段）

这三张是 VS Code + 终端，不是产品 UI，但说明了「UI 里的一切都有 YAML 对应物」：

- **`yaml-agent-definition-t1440.jpg`**：`agentos/agents/spec-agent.yaml`，字段
  `slug / name / description / model / scope / status: published / tools: {enabled, disabled} /
  skills: [interview] / mcpAgentosEnabled / mcpConnections / spawnableAgents /
  maxNestingDepth / memoryEnabled / environment / repos / initScripts / system`，
  正文是 `# Spec Agent` 的 markdown prompt。同目录还有
  code-agent / code-reviewer / decomposer / default-agent / diagnostic-agent /
  librarian / pentest-agent / pentest-coordinator / plan-agent / plan-executor /
  plan-reviewer / research-agent / review-coordinator / senior-dev / test-agent /
  wiki-linter，以及 `skills/` 下的 md 文件和 `templates/`。
- **`yaml-template-pipeline-t1530.jpg`**：`agentos/templates/full-feature-implementation.yaml`，
  用 `variables:` + `tasks:` + 每个 task 的 `key / title / agent / prompt /
  include / parent / unblocked_by` 定义整条流水线依赖图（`{{branch_name}}` 插值）。
- **`agentos-cli-help-t1455.jpg`**：终端 `agentos --help` —— "Sync AgentOS Skills,
  Agents, and Templates between repo and server"，命令有
  `init / login / logout / whoami / pull / push / status / diff / task / help`，
  即本地 repo ↔ 服务端的双向同步。

---

## 18. 概念图（非 UI，但定义了信息架构）

**`concept-architecture-diagram-t0165.jpg`**：他自己画的 ASCII 风格框线图，深蓝黑底：

```
YOU --set a goal--> GOAL "Ship the new landing page"
   --broken down into--> TASKS (todo → doing → review → done)
   --> AGENT AGENT AGENT   (Claude agents running in the cloud)
   --each agent is equipped with--> SKILLS(how to do things) /
      KNOWLEDGE(what it knows) / FILES(what it works on)
   --> INBOX (status updates & questions) --you reply → agent resumes--> ✓ DONE
```

这张图直接对应侧边栏的导航项，可以当作 IA 的一句话总结。

---

## 给前端实现者的要点提炼

1. **暗色 + 暖橄榄底 + 单一亮黄强调色 + 全站等宽字体**，是这个界面最强的识别特征。
   彩色只出现在 Costs 图表里。
2. **状态语义靠药丸**：绿=published/enabled/success，琥珀=需要人介入（Approval /
   Awaiting reply / running），紫=agent 身份，红=危险与未读。
3. **agent 是一等公民**：任何地方出现 agent 都用同一个紫色 chip + 机器人图标；
   人类用人形图标。
4. **钱和时间到处可见**：任务卡、Runs 表、goal 卡、goal 指标卡、Costs 页都显示花费；
   goal 还有 spend cap / wall-clock / stuck threshold 三重闸门。
5. **表单字段几乎每个都配一句「这个值会导致什么」的灰色说明**，条件字段用内嵌
   子卡片展开。
6. **人机交接的界面化**：Inbox 是主通道，agent 能发结构化提问（选项 + Recommended +
   自由输入），阻塞态用琥珀提示条明示"agent 正在等你回复"，移动端 PWA 专门为这个场景存在。
7. **列表通用模式**：表格里 Name 列是「标题 + 灰色说明」两行；行尾 `⋮`；
   顶部是分段 tab；右上是一个黄色主按钮 +（可选）若干描边次按钮。
8. **详情页通用模式**：`← 标题 + 状态药丸` / 右侧操作按钮组 → Details 双列 key-value 卡 →
   长文本卡（可 Show more）→ Attachments → Subtasks → Activity → Runs。
