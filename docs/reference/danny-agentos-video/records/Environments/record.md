# Environments
## 时间线记录

### [0:05:40]
- 触发动作：正在编辑一个环境；从后续帧可见，随后将 Networking 从 `Unrestricted` 切换为 `Limited`。
- 左栏状态：画面左侧只露出导航栏右边缘，但可见顶部项目切换器的项目名尾部和红色徽标 `24`，以及另一项红色徽标 `17`；结合相邻完整帧，项目为 `MMO Game`，底部全局区为绿色状态点 `Runner` / `Running`、`Settings`、`Sign out`。
- 右栏顶部：返回箭头；标题 `Edit Environment`；右上角按钮 `Cancel`、黄色主按钮 `Save`。未见标签页、搜索框。
- 右栏主体：
  - 基本信息：`Name`，单行文本输入框，示例值 `Default`；黄色开启状态开关 `Available in all projects`。
  - Packages：`pip` 单行输入框，示例值 `pandas, numpy, requests`；`npm` 单行输入框，示例值 `cheerio, lodash`。
  - Networking：单选控件 `Unrestricted`（当前选中）与 `Limited`（未选中）。
- 页面目录结构：`Edit Environment` → 基本信息（Name、Available in all projects）→ Packages（pip、npm）→ Networking（Unrestricted、Limited）→ 操作（Cancel、Save）。
- 旁白要点：环境是代理运行的边界；可以配置网络访问是 unrestricted 还是 limited，并把代理的运行能力限制在指定范围内。

### [0:05:50]
- 触发动作：点击 Networking 的 `Limited` 单选项，展开受限网络配置，并在文本区域中填写允许访问的主机。
- 左栏状态：项目切换器为 `MMO Game`，顶部红色徽标 `24`；`Inbox` 红色徽标 `17`；导航项包括 `Activity`、`Tasks`、`Goals`、`Sessions`、`Costs`、`Skills`、`Environments`、`Agents`、`Templates`、`Files`、`Knowledge`、`Repos`、`Connections`、`Admin`；底部为 `Runner`（绿色点，`Running`）、`Settings`、`Sign out`。
- 右栏顶部：返回箭头、`Edit Environment`；`Cancel`、`Save`。
- 右栏主体：
  - 基本信息：`Name` 文本输入框，值 `Default`；`Available in all projects` 开关为开启。
  - Packages：`pip` 输入框值 `pandas, numpy, requests`；`npm` 输入框值 `cheerio, lodash`。
  - Networking：`Limited` 单选项已选中，`Unrestricted` 未选中。
  - 受限网络设置：`Allowed hosts (one per line)` 多行文本框，示例值 `api.front.com`。
  - 权限开关：`Allow MCP servers` 开启；`Allow package managers` 开启。
- 页面目录结构：`Edit Environment` → 基本信息 → Packages → Networking（Limited → Allowed hosts、Allow MCP servers、Allow package managers）→ 操作。
- 旁白要点：只允许访问 `api.front.com`；如果引擎在该环境中只能访问这个主机，就永远无法访问 GitHub，即使代理本身有访问权限，基础层也会阻止它。

### [0:06:00]
- 触发动作：保持在受限网络的环境编辑页，光标移开输入区域；画面展示完整配置及其生效范围。
- 左栏状态：项目 `MMO Game`；顶部红色徽标 `24`，`Inbox` 红色徽标 `17`；`Environments` 位于左侧导航中；底部全局区显示绿色点 `Runner`、状态 `Running`、`Settings`、`Sign out`。
- 右栏顶部：返回箭头、标题 `Edit Environment`；按钮 `Cancel`、`Save`。
- 右栏主体：`Name`=`Default`；`Available in all projects` 开启；`Packages` 下 `pip`=`pandas, numpy, requests`、`npm`=`cheerio, lodash`；`Networking` 选择 `Limited`；`Allowed hosts (one per line)` 中为 `api.front.com`；`Allow MCP servers` 和 `Allow package managers` 均开启。
- 页面目录结构：环境编辑器 → 名称/项目可用范围 → 包管理依赖 → 网络模式 → 允许主机与附加服务权限 → 保存或取消。
- 旁白要点：这是把安全边界和访问规则全部构建进环境的方式；这些能力构建在 Claude 托管代理之上。

### [0:06:10]
- 触发动作：离开环境配置演示，画面切换到 Claude Platform Docs 的托管代理概览页。
- 左栏状态：文档导航顶部为搜索框 `Search`（带快捷键提示 `⌘ K`）；`First steps` 下 `Overview` 选中，另有 `Quickstart`、`Build in Console`、`Migration`；`Define your agent` 下有 `Agent setup`、`Tools`、`MCP connector`、`Permission policies`、`Agent Skills`；`Configure agent environment` 下有 `Cloud environment setup`、`Cloud sandbox reference`、`Self-hosted sandboxes`；`Delegate work to your agent` 下有 `Start a session`、`Session operations`、`Session event stream`、`Session budgets`、`Subscribe to webhooks` 等。底部账户区显示 `Danny`，`Admin · Postcrafts ...`，带下拉箭头。此页没有 AgentOS 左栏的 Runner/Settings/Sign out 区。
- 右栏顶部：面包屑 `Managed Agents > First steps`；页面标题 `Claude Managed Agents overview`；副标题说明这是运行在托管基础设施中的预构建、可配置代理 harness，适合长时间运行任务和异步工作；右上有 `Copy page`（带下拉箭头）。站点顶栏有 `Messages`、选中的 `Managed Agents`、`Admin`、`Resources`（下拉）、`API reference`、显示器图标、语言 `English`（下拉）、`Console` 按钮。右侧目录为 `Core concepts`（当前项）、`How it works`、`When to use Claude Managed Agents`、`Supported tools`、`Beta access`。
- 右栏主体：
  - 对比表：列名 `Messages API`、`Claude Managed Agents`；行名 `What it is`、`Best for`。示例内容分别为 `Direct model prompting access` / `Pre-built, configurable agent harness that runs in managed infrastructure`，以及 `Custom agent loops and fine-grained control` / `Long-running tasks and asynchronous work`。
  - 说明段落：Managed Agents 提供运行 Claude 自主代理所需的 harness 和基础设施；代理可读文件、运行命令、浏览网页并安全运行代码；支持 prompt caching、compaction 等优化。
  - 蓝色提示框：`Claude Managed Agents is also available on Claude Platform on AWS, with some differences in feature availability and session behavior. See Claude Managed Agents in the Claude Platform on AWS guide.`
  - 三个快捷卡片：`Quickstart`（`Create your first agent session`）、`Start a session`（`Create a session and send your first event`）、`Reference`（`Event types, rate limits, CLI flags, and other lookup tables`）。下方开始 `Core concepts` 区块。
- 页面目录结构：文档站点 → Managed Agents → First steps → Overview → 页面概览/对比表/说明/提示 → Quickstart、Start a session、Reference → Core concepts；右侧为页内目录。
- 旁白要点：此帧是对前述“构建在 Claude 托管代理之上”的文档旁证；字幕只说到“这一切都构建在 Claude 托管代理之上”。

### [0:08:30]
- 触发动作：在仓库编辑页中打开 `Environment` 标签；尚未添加环境文件。
- 左栏状态：顶部项目切换器为 `MMO Game`，红色徽标 `24`；`Inbox` 红色徽标 `17`；`Environments` 等导航项可见；底部显示绿色点 `Runner`、`Running`、`Settings`、`Sign out`。
- 右栏顶部：返回箭头；标题 `Edit Repo`；标签页 `General` 与当前选中的 `Environment`；右上仅见 `Cancel`。
- 右栏主体：环境说明文字 `Environment files are mounted relative to /workspace/vibeville/ in agent sessions. Values are encrypted at rest.`；空状态提示 `No environment files configured.`；按钮 `+ Add .env file`；黄色按钮 `Save All`。
- 页面目录结构：`Edit Repo` → 标签页（General、Environment）→ 环境文件说明 → 环境文件列表（空）→ Add `.env` file / Save All。
- 旁白要点：可以添加任意文件，尤其是需要注入会话的环境变量，例如安全地注入凭证。

### [0:08:40]
- 触发动作：继续停留在仓库的 `Environment` 标签；鼠标指向环境文件说明区域，未发生页面切换。
- 左栏状态：`MMO Game` 项目；徽标 `24`；`Inbox` 徽标 `17`；左侧可见 `Environments`、`Agents`、`Templates`、`Files`、`Knowledge`、`Repos`、`Connections`、`Admin`；底部 `Runner` 为 `Running`，并有 `Settings`、`Sign out`。
- 右栏顶部：`Edit Repo`；`General`/`Environment` 标签，`Environment` 选中；`Cancel`。
- 右栏主体：环境文件会相对于 `/workspace/vibeville/` 挂载到代理会话；说明明确写着 `Values are encrypted at rest.`；当前为 `No environment files configured.`；可用操作为 `+ Add .env file` 和 `Save All`。
- 页面目录结构：仓库编辑 → Environment → 挂载路径/静态加密说明 → 空环境文件区 → 添加或保存。
- 旁白要点：这些值在存储时会被加密；讲解者提到其底层是 Google 的某个 token encryption system，但表示自己记不清具体名称。

### [0:08:50]
- 触发动作：鼠标仍在说明文字附近；环境配置页保持不变，未添加 `.env` 文件。
- 左栏状态：项目切换器 `MMO Game`，徽标 `24`；`Inbox` 徽标 `17`；`Environments` 导航项可见；底部全局区为 `Runner`（绿色点、`Running`）、`Settings`、`Sign out`。
- 右栏顶部：返回箭头、`Edit Repo`；`General` 与选中的 `Environment` 标签；`Cancel`。
- 右栏主体：说明 `Environment files are mounted relative to /workspace/vibeville/ in agent sessions. Values are encrypted at rest.`；空状态 `No environment files configured.`；`+ Add .env file` 与 `Save All`。
- 页面目录结构：`Edit Repo` → `Environment` → 环境文件挂载和加密说明 → 空列表 → 添加/保存。
- 旁白要点：所有内容都被保存，即便系统遭到黑客攻击，也以安全方式存储；环境变量可用于给代理授予访问权限。

### [0:09:00]
- 触发动作：鼠标移到左栏 `Skills`，出现悬浮提示 `Skills`，浏览器左下角状态链接显示 `https://www.postmaos.com/skills`；主体仍停留在 Environment 标签。
- 左栏状态：`MMO Game` 项目；顶部红色徽标 `24`；`Inbox` 红色徽标 `17`；`Skills` 被鼠标悬停但未切换，`Environments` 仍为当前相关页面；底部为 `Runner`（绿色点、`Running`）、`Settings`、`Sign out`。
- 右栏顶部：`Edit Repo`；`General`、选中的 `Environment`；`Cancel`。
- 右栏主体：`Environment files are mounted relative to /workspace/vibeville/ in agent sessions. Values are encrypted at rest.`；`No environment files configured.`；`+ Add .env file`；`Save All`。
- 页面目录结构：仓库编辑 → Environment → 加密环境文件配置 → 添加 `.env` 文件/保存；左侧另有可跳转的 Skills 区。
- 旁白要点：具体例子是通过环境变量授予代理访问只读 MongoDB 数据库的权限；也可以授予它任意所需的访问权限；这是系统的基础。

## 功能清单

- 为代理创建和编辑运行环境，设置环境名称（示例 `Default`）。
- 用 `Available in all projects` 将环境设为所有项目可用。
- 配置 Python `pip` 包（示例 `pandas, numpy, requests`）和 `npm` 包（示例 `cheerio, lodash`）。
- 在 `Unrestricted` 与 `Limited` 网络模式之间选择。
- 在 `Allowed hosts (one per line)` 中按行配置允许访问的域名，例如 `api.front.com`。
- 在基础层限制网络访问，阻止代理访问未列入允许列表的资源（例如 GitHub）。
- 控制 `Allow MCP servers` 和 `Allow package managers` 两项能力。
- 保存或取消环境配置（`Save`、`Cancel`）。
- 在仓库的 `Environment` 标签中添加 `.env` 文件，使用 `+ Add .env file` 和 `Save All` 管理环境文件。
- 将环境文件相对于 `/workspace/vibeville/` 挂载到 agent sessions。
- 对静态保存的环境变量/凭证加密（`Values are encrypted at rest.`）。
- 通过环境变量将凭证安全注入会话。
- 使用环境变量授予代理数据库等资源的访问权限，例如只读 MongoDB 数据库，也可授予其他访问权限。
- 页面展示环境文件为空时的状态 `No environment files configured.`。
- AgentOS 导航中可进入 `Environments`、`Agents`、`Skills` 等模块，并显示 `Runner` 的 `Running` 状态。
- 相关文档说明 Claude Managed Agents 提供托管基础设施、文件读取、命令运行、网页浏览和安全代码运行能力，并支持长时间运行和异步任务。

## 仅旁白提及（画面未见）

- 代理之间可以沟通（当前截图没有展示代理间通信界面）。
- 环境会从底层阻止代理访问“不应接触的资源”的具体安全机制；截图只展示允许主机配置，没有展示拦截结果。
- 代理有一个个人访问令牌（截图未显示令牌字段或具体值）。
- 这些凭证/变量存储在 Google 的某个 token encryption system 上；讲解者未说出确切系统名称，截图只显示泛化说明 `Values are encrypted at rest.`。
- 即使被黑客攻击，存储内容仍然安全（截图未展示攻击或恢复流程）。
- 只读 MongoDB 数据库的具体连接信息、权限配置或实际访问操作均未出现在截图中。
- 可以给代理“任何访问权限”的具体权限列表或授权流程未展示。
- “一切构建在 Claude 托管代理之上”是旁白概念；截图虽出现 Claude Platform Docs，但没有显示 AgentOS 与托管代理之间的具体集成配置。
