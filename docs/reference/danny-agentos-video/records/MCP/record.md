# MCP

## 时间线记录

### [0:08:00]
- 触发动作：当前位于左栏 `Connections` 页面；鼠标指针停在 GitHub 连接卡片的 `Update Token` 附近，未见明确点击结果。画面展示 MCP 连接管理区域。
- 左栏状态：顶部项目切换器为 `MMO Game`，左侧黄色头像方块显示 `M`，右侧有红色徽标 `24` 和下拉箭头。导航项依次为 `Inboxes`（红色徽标 `17`）、`Activity`、`Tasks`、`Goals`、`Sessions`、`Costs`、`Skills`、`Environments`、`Agents`、`Templates`、`Files`、`Knowledge`、`Repos`、`Connections`、`Admin`；当前选中 `Connections`。底部全局区显示绿色状态点、`Runner`、`Running`，以及 `Settings`、`Sign out`。
- 右栏顶部：标题 `Connections`；副标题 `Manage MCP server connections for your agents.`；右上角按钮 `+ Add connection`。
- 右栏主体：
  - 区块 `GitHub`：GitHub 图标；状态标签 `Connected`。字段 `Profile`，示例值 `PR only`；字段 `Repos`，示例值 `Awesome-Black-Friday-Cyber-Monday, cog-stable-diffusion, ControlNet +16 more`；字段 `Last verified`，示例值 `Aug 1, 2026`。底部控件为 `Update Token` 按钮和红色 `Disconnect` 按钮。
  - 区块 `Global (org-level)`：一条全局连接记录 `Ahrefs`；示例 URL `https://api.ahrefs.com/mcp/mcp`；右侧有 `Manage` 按钮和外部链接图标。
  - 区块 `Project-specific`：一条项目级连接记录 `GitHub MCP`；示例 URL `https://api.githubcopilot.com/mcp`；右侧有 `Manage` 按钮和外部链接图标。
- 页面目录结构：
  - `Connections`
    - `GitHub`（连接状态、Profile、Repos、Last verified、Update Token、Disconnect）
    - `Global (org-level)`
      - `Ahrefs`（MCP URL、Manage）
    - `Project-specific`
      - `GitHub MCP`（MCP URL、Manage）
- 旁白要点：旁白说代理显然需要 MCP 访问，因此展示一个小的 MCP 访问区域，并以 GitHub 连接为例说明可接入外部工具：“所以，我有一个小的MCP访问区域，我们可以有GitHub。”

### [0:08:10]
- 触发动作：从左栏 `Connections` 切换到 `Repos` 页面，展示项目的 GitHub repository 连接；鼠标点击/打开了该行最右侧的三点更多菜单，菜单展开显示 `Edit` 与 `Delete`。
- 左栏状态：顶部项目切换器仍为 `MMO Game`，黄色 `M` 图标，红色徽标 `24` 和下拉箭头。`Inboxes` 仍有红色徽标 `17`；导航项为 `Inboxes`、`Activity`、`Tasks`、`Goals`、`Sessions`、`Costs`、`Skills`、`Environments`、`Agents`、`Templates`、`Files`、`Knowledge`、`Repos`、`Connections`、`Admin`；当前选中 `Repos`。底部全局区显示绿色状态点、`Runner`、`Running`，以及 `Settings`、`Sign out`。
- 右栏顶部：标题 `Repos`；副标题 `Manage GitHub repository connections for your agents.`；右上角黄色按钮 `+ Add Repo`。
- 右栏主体：
  - 区块为 repository 表格。表头依次为 `Name`、`URL`、`Credential`、`Updated`，最右侧为行操作区域。
  - 示例行：`Name` = `vibeville`；`URL` = `dannypostma/vibeville`；`Credential` = `GITHUB_PAT_VIBEVILLE`；`Updated` = `Aug 1, 2026`。
  - 行操作：最右侧三点菜单已展开，包含 `Edit`（铅笔图标）和红色 `Delete`（垃圾桶图标）。
- 页面目录结构：
  - `Repos`
    - repository 表格
      - 列：`Name`、`URL`、`Credential`、`Updated`
      - `vibeville`
      - 行操作：`Edit`、`Delete`
- 旁白要点：旁白补充说明这是他的 game，并指出其中有一个 repo：“my game. It has the Fiberfill repo.” 画面中对应展示的是 repository 管理表及 `vibeville` 示例行。

## 功能清单

- 在 `Connections` 页面集中管理代理使用的 MCP server connections。
- 通过 `+ Add connection` 添加新的 MCP 连接。
- 连接 GitHub，并显示 `Connected` 状态。
- 为 GitHub 连接配置/查看 `Profile`，示例为 `PR only`。
- 查看 GitHub 连接可用的 repositories，并用 `+16 more` 表示其余仓库。
- 查看连接的 `Last verified` 时间。
- 使用 `Update Token` 更新 GitHub token。
- 使用 `Disconnect` 断开 GitHub 连接。
- 区分 `Global (org-level)` 与 `Project-specific` 两种连接作用域。
- 管理全局 `Ahrefs` MCP 连接及其 URL `https://api.ahrefs.com/mcp/mcp`。
- 管理项目级 `GitHub MCP` 连接及其 URL `https://api.githubcopilot.com/mcp`。
- 在 `Repos` 页面管理代理使用的 GitHub repository connections。
- 通过 `+ Add Repo` 添加 repository 连接。
- 以表格查看 repository 的 `Name`、`URL`、`Credential`、`Updated` 信息。
- 对 repository 记录执行 `Edit` 和 `Delete`。
- 在项目切换器中查看/切换项目 `MMO Game`。
- 左栏显示 `Inboxes` 和项目级数量徽标。
- 查看全局 `Runner` 状态，当前为 `Running`。

## 仅旁白提及（画面未见）

- 无。旁白提到的 MCP 访问区域、GitHub 连接和 repository 功能均在截图中有对应界面；“不是那么激动人心”属于评价，不是未展示的功能。
