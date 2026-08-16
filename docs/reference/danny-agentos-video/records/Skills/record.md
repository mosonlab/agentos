# Skills
## 时间线记录

### [0:06:30]
- 触发动作：讲解切入前的过渡画面，仍停留在 Claude Platform Docs 的文档页；不是 AgentOS 的 `Skills` 产品界面。
- 左栏状态：文档站左侧有搜索框和文档导航，包括 `First steps`、`Overview`、`Quickstart`、`Build in Console`、`Migration`、`Define your agent`、`Agent setup`、`Tools`、`MCP connector`、`Permission policies`、`Agent Skills`、`Configure agent environment` 等；`Start a session` 处于选中状态。
- 右栏顶部：站点顶部导航显示 `Messages`、`Managed Agents`、`Admin`、`Resources`，右侧有 `API reference`、语言选择 `English` 和 `Console`；当前文档主标题为 `Creating a session`。
- 右栏主体：文档说明创建 session 需要 `agent ID` 和 `environment ID`；代码示例区有 `cURL`、`CLI`、`Python`、`TypeScript`、`C#`、`Go`、`Java`、`PHP`、`Ruby` 标签，并展示使用 `agent ID`、`environment ID` 创建 session 的命令和 YAML 示例；下方区块标题为 `Seed the session with initial events`。右侧目录列出 `Creating a session`、`Seed the session with initial events`、`Override agent configuration for a session`、`Set a session budget`、`MCP authentication through vaults`、`Starting the session`、`Next steps`。
- 页面目录结构：`Claude Platform Docs` → 文档导航 → `Start a session` → `Creating a session` → `Seed the session with initial events`；右侧为本页目录。
- 旁白要点：字幕为“我开始开发自己的东西，但那个稍后再谈。”这是进入 AgentOS Skills 讲解前的过渡，不应记录为 Skills 页面功能。

### [0:06:40]
- 触发动作：从技能列表进入 `Plan Mode` 技能详情页；画面位于详情页，鼠标停在顶部 `Edit` 按钮附近。
- 左栏状态：顶部项目切换器显示黄色 `M` 图标与 `MMO Game`，右侧红色徽标 `24` 和下拉箭头；导航项依次为 `Inboxes`（红色徽标 `17`）、`Activity`、`Tasks`、`Goals`、`Sessions`、`Costs`、`Skills`、`Environments`、`Agents`、`Templates`、`Files`、`Knowledge`、`Repos`、`Connections`、`Admin`，当前选中 `Skills`；底部全局区显示绿色状态点 `Runner`、状态 `Running`，以及 `Settings`、`Sign out`。
- 右栏顶部：返回箭头；标题 `Plan Mode`；绿色状态标签 `Published`；按钮 `Edit`、黄色按钮 `Republish`，以及三点更多菜单。
- 右栏主体：
  - `Details` 区块：字段 `Source`，示例值 `Custom`；字段 `Skill Name`，示例值 `plan`；字段 `Created`，示例值 `Aug 1, 2026`；字段 `Published`，示例值 `Aug 1, 2026`。
  - `Content` 区块：代码/Markdown 预览框，内容包含 Markdown 文件中的 YAML front matter：`name: plan`、`displayTitle: Plan Mode`、`description: Enter plan mode - Research and produce a plan for the user's approval without making any changes. No edits, no writes, no non-readonly tool calls until the user approves.`；下方显示 `# Plan mode`，底部有可展开的 `Show more`。
- 页面目录结构：`Plan Mode` → `Details`、`Content`；内容预览下还有 `Show more` 展开入口。
- 旁白要点：技能可以通过类似 `/plan` 的命令调用；`Plan Mode` 是一个技能，技能内容定义了代理在规划模式下应如何工作。

### [0:06:49]
- 触发动作：点击 `Edit`，从 `Plan Mode` 详情页切换到编辑表单。
- 左栏状态：左侧仍为 `MMO Game` 项目导航；项目徽标 `24`、`Inboxes` 徽标 `17` 可见；`Skills` 为当前选中项。本帧底部全局区不在画面内，不记录 `Runner`、`Settings` 或 `Sign out` 的可见状态。
- 右栏顶部：返回箭头；标题 `Edit Skill`；右上角按钮 `Cancel` 与黄色 `Save`。
- 右栏主体：
  - 基础设置区：`Display Title` 字段，控件为单行文本输入框，示例值 `Plan Mode`。
  - 调用设置：`Invocation Slug` 字段，控件为带固定前缀 `/` 的输入框，示例值 `plan`。
  - 作用域设置：`Available in all projects`，控件为开关，画面中为关闭状态。
  - 内容编辑区：标题 `SKILL.md`；控件为可滚动多行代码/Markdown 文本编辑器。可见内容包括关于 spec 是 source of truth、读取任务、调查代码库、`pnpm` monorepo、`packages/sim`、`packages/protocol`、`apps/server`、`apps/client`、`CLAUDE.md`、构建顺序，以及 `Goal`、`Spec` 等规划输出要求。
- 页面目录结构：`Edit Skill` → 基础字段（`Display Title`、`Invocation Slug`、`Available in all projects`）→ `SKILL.md` 编辑器；页头操作为 `Cancel`/`Save`。
- 旁白要点：可以编辑规划技能；技能包含运行规则和提示词内容，还可以进一步添加文件。

### [0:06:50]
- 触发动作：在 `SKILL.md` 编辑表单中向下滚动，展示技能内容的后续部分；前一帧顶部字段已滚出视口。
- 左栏状态：左侧项目导航仍显示 `MMO Game`，`Inboxes` 徽标 `17` 和技能导航列表仍可见，当前仍处于技能编辑页面；左栏底部仅露出 `Runner`（绿色状态点、`Running`），`Settings`、`Sign out` 未出现在本帧。
- 右栏顶部：编辑页标题区域已滚出画面；主体继续显示 `SKILL.md` 编辑器。
- 右栏主体：
  - `SKILL.md` 区块：滚动文本编辑器中可见编号规则，包括读取任务、调查代码库、思考实施顺序与权衡、遇到歧义时先询问用户，以及生成包含 `Goal`、`Spec` 等部分的计划。
  - `Files` 区块：标题 `Files`；说明文字表示可以添加文件并在技能中使用；中间显示文件图标和空状态文案 `No files attached yet`，并有用于添加文件的空状态区域/按钮。
- 页面目录结构：`Edit Skill` → `SKILL.md` → `Files`；`Files` 当前为空。
- 旁白要点：技能不仅有提示词，还可以添加文件；字幕随后提到技能也能运行 Python 脚本，并且代理能访问文件系统。

### [0:23:40]
- 触发动作：切换到代码编辑器中的 `.agentos/agents/code-agent.yaml`，展示代理配置文件。
- 左栏状态：VS Code 风格的 `EXPLORER`；工作区根目录 `AGENTOS`，展开 `.agentos/agents`，选中 `code-agent.yaml`；同目录可见多个 agent `.yaml` 文件，包括 `code-reviewer.yaml`、`decomposer.yaml`、`default-agent.yaml`、`diagnostic-agent.yaml`、`librarian.yaml`、`pentest-agent.yaml`、`pentest-coordinator.yaml`、`plan-agent.yaml`、`plan-executor.yaml`、`plan-reviewer.yaml`、`research-agent.yaml`、`review-coordinator.yaml`、`senior-dev.yaml`、`spec-agent.yaml`、`test-agent.yaml`、`wiki-linter.yaml`；展开 `skills`，可见 `analyze-branch-bugs.md`、`decompose.md`、`interview.md`、`pentest-methodology.md`、`plan.md`、`test.md`、`update-wiki.md` 等 Markdown 技能文件。左侧活动栏包含文件、搜索、源代码管理等图标，其中源代码管理显示徽标 `2`，扩展/警告图标显示黄色警告。
- 右栏顶部：窗口标题 `code-agent.yaml — agentos`；编辑器标签 `code-agent.yaml`；右侧打开 `claude.exe` 面板，顶部显示 `Claude Code v2.1.221`、`Sonnet 5 with high effort · Claude Max`、路径 `~/Development/agentos`，并提示 `1 MCP server needs authentication · run /mcp`；顶部还有 `Update` 按钮。
- 右栏主体：
  - YAML 配置区：字段 `slug: code-agent`、`name: Code Agent`、`description: Senior Programmer Agent`、`model: claude-opus-4-6`、`scope: project`、`status: draft`。
  - `tools` 区块：`enabled: true`、`disabled: []`。
  - 技能/代理区块：`skills: []`；`mcpAgentosEnabled: true`；`mcpConnections:` 下有 `https://api.githubcopilot.com...`；`spawnableAgents:` 下有 `- test-agent`；`maxNestingDepth: 1`；`memoryEnabled: true`。
  - 运行环境区块：`environment: Default`；`repos:` 下有 `- agentos`；`initScripts:` 下有 `- Setup`。
  - 系统提示词区块：`system: |`，正文以 `You are a Senior Programmer...` 开头，下面有 `## Workflow` 和编号步骤 `Understand the task`、`Branch`、`Investigate`、`Implement`、`Commit & push`、`Review`。
  - 终端/代理面板：显示 `/model` 菜单及 `Set model to Sonnet 5 and saved as your default for new sessions`；底部显示 `Sonnet 5`、`Effort: high`、`manual mode on`、`1 agent`。
- 页面目录结构：工作区 `AGENTOS` → `.agentos` → `agents` → `code-agent.yaml`；并列 `skills` 目录（其中为 `*.md` 文件）；右侧为 `claude.exe` 代理终端面板。
- 旁白要点：旁白称代理都格式化为 YAML 文件，又称技能、模板也都是 YAML 文件并便于版本化和同步；这是旁白说法。画面能直接核实的是：代理配置使用 `.yaml`，技能目录使用 `SKILL.md`/`*.md`，技能内容可以包含 YAML front matter。因此不能把“技能/模板均为 YAML 文件”作为已核实的技能文件格式。

### [0:23:50]
- 触发动作：在 Explorer 中选择 `spec-agent.yaml`，从 `code-agent.yaml` 切换到规格代理配置；编辑器滚动到配置与系统提示词开头。
- 左栏状态：仍是 `AGENTOS/.agentos/agents` 文件树；`spec-agent.yaml` 高亮选中；可见其他 agent YAML 文件，以及 `skills` 目录中的 `interview.md`、`plan.md` 等 Markdown 文件；底部/活动栏仍为 VS Code 工具图标，源代码管理徽标 `2` 可见。
- 右栏顶部：编辑器标签 `spec-agent.yaml`；顶部窗口标题 `spec-agent.yaml — agentos`；右侧仍有 Claude Code 面板边缘和 `Update` 控件。
- 右栏主体：
  - YAML 元数据：`slug: spec-agent`、`name: Spec Agent`、`description: Helps with /interview skills`、`model: claude-opus-4-8`、`scope: project`、`status: published`。
  - 工具与技能：`tools.enabled: true`、`tools.disabled: []`；`skills:` 下有 `- interview`；`mcpAgentosEnabled: true`；`mcpConnections: []`；`spawnableAgents: []`；`maxNestingDepth: 1`；`memoryEnabled: false`。
  - 环境与仓库：`environment: Default`；`repos:` 下有 `- agentos`；`initScripts: []`。
  - 系统提示词：`system: |`，标题 `# Spec Agent`；正文说明该代理把模糊的 feature description（以及可选的现有 draft spec）转化为规格；下方有 `## Inputs`，并写明 feature description 为 mandatory、现有 spec draft 为 optional，还说明可 standalone 或 inside a pipeline 两种调用方式。
- 页面目录结构：工作区 `AGENTOS` → `.agentos` → `agents` → `spec-agent.yaml`；配置层级为元数据 → `tools`/`skills` → MCP 与可生成代理 → 环境/仓库/脚本 → `system` 提示词。
- 旁白要点：演示另一个 `Spec Agent` 配置，说明代理可指定模型（画面中为 `claude-opus-4-8`）、技能（`interview`）、作用域、状态、环境、仓库和系统提示词等参数。

### [0:25:10]
- 触发动作：继续在 VS Code 中查看 `spec-agent.yaml`，同时在右侧 Claude Code 面板显示一次实际任务运行后的结果；左侧 Explorer 向下滚动，暴露更多工作区文件。
- 左栏状态：`spec-agent.yaml` 仍高亮；`agents` 列表中可见 `diagnostic-agent.yaml`、`librarian.yaml`、`pentest-agent.yaml`、`pentest-coordinator.yaml`、`plan-agent.yaml`、`plan-executor.yaml`、`plan-reviewer.yaml`、`research-agent.yaml`、`review-coordinator.yaml`、`senior-dev.yaml`、`spec-agent.yaml`、`test-agent.yaml`、`wiki-linter.yaml`；`skills` 展开并可见多个 `.md` 技能文件；下方还可见 `template-tasks`、`templates`、`.sync.json`、`config.json`、`.brainstorm`、`.claude`、`.expect`、`.github` 等目录/文件。
- 右栏顶部：左侧编辑器标签 `spec-agent.yaml`；顶部窗口标题 `waiting — agentos`；右侧 Claude Code 标签 `waiting`，显示 Claude Code 版本、模型信息、`1 MCP server needs authentication · run /mcp`；终端顶部有新建/布局/锁定等按钮。
- 右栏主体：
  - YAML 编辑区：仍显示 `spec-agent` 的字段，包括 `model: claude-opus-4-8`、`status: published`、`skills: - interview`、`mcpConnections: []`、`spawnableAgents: []`、`maxNestingDepth: 1`、`memoryEnabled: false`、`environment: Default`、`repos: - agentos`、`initScripts: []`；系统提示词区域中 `## Inputs`、`## Discovering your inputs`、`## Which skill to use` 等标题被选中/高亮。
  - Claude Code 运行结果区：用户输入 `Create cnaary project in AgentOS for me with cli`；结果摘要说明已搜索 `1 pattern`、读取 `2 files`、列出 `2 directories`；随后确认 `agentos` CLI 只能在已有项目上执行 `agentos init`，没有创建新项目的命令，MCP 工具中也没有 `create_project`；用户拒绝回答后续澄清问题。面板底部显示 `Worked for 27s`。
  - 运行状态区：输入提示符下方显示 `Sonnet 5`、`Effort: high`、`Context: 7% used`、`auto mode on (shift+tab to cycle)`、`1 agent`，以及 `high · /effort`。
- 页面目录结构：VS Code 工作区 → `.agentos/agents/spec-agent.yaml` 与 `skills`/`templates` 等目录；右侧为 `waiting` Claude Code 会话 → 用户请求 → 搜索/读取结果 → 代理判断与用户拒绝澄清 → 运行统计。
- 旁白要点：旁白说明可以很容易地调整配置，这对模板特别有帮助；画面也体现了配置改变后代理按指定技能和上下文执行任务、发现能力边界并请求澄清。

## 功能清单

- 在 AgentOS `Skills` 页面查看技能详情、来源、名称、创建/发布时间和 Markdown 内容。
- 通过 `/plan` 形式的 invocation slug 调用技能。
- 创建、编辑、保存、发布/重新发布技能；支持 `Edit`、`Save`、`Cancel`、`Republish`。
- 为技能设置 `Display Title`、`Invocation Slug` 和 `Available in all projects` 作用域开关。
- 画面中代理配置是 `.yaml`；技能以 `SKILL.md`/`.md` 保存，并可在 Markdown 中使用 YAML front matter。
- 在 `SKILL.md`/`*.md` 中维护技能的提示词、工作流、输出格式和行为约束。
- 给技能添加文件，并在技能中使用文件。
- 在 `.agentos/agents/*.yaml` 中配置代理的 `slug`、`name`、`description`、`model`、`scope`、`status`。
- 配置代理的工具启用/禁用列表、技能列表、MCP 开关与连接、可生成代理、嵌套深度、记忆开关。
- 配置默认运行环境、仓库和初始化脚本。
- 在代理 YAML 的 `system` 多行字段中定义代理系统提示词与工作流。
- 代理配置可以是项目级；技能编辑页还提供 `Available in all projects` 开关，用于设置技能是否对所有项目可用。
- 代理支持 standalone 与 pipeline 内部两种调用模式（在 `Spec Agent` 系统提示词中可见）。
- 代理运行时可搜索、读取文件、列出目录并报告上下文使用量和运行耗时。
- 代理在能力或需求不明确时可以请求澄清，并识别 CLI/MCP 当前不支持的操作。

## 仅旁白提及（画面未见）

- 可以运行一个 Python 脚本：截图中只看到旁白提到该能力，未见实际脚本控件或执行过程。
- 代理能访问文件系统：截图未展示具体文件系统权限面板或文件操作调用，仅在左侧 Explorer 和旁白中间接体现。
- 可以通过 CLI 或配置快速创建新技能/代理：截图展示了配置和编辑界面，但没有直接展示创建技能/代理的 CLI 命令或新建流程。
- 旁白称“技能都是 YAML 文件”，并称“模板都是 YAML 文件”；画面只直接显示代理配置为 `.yaml`，而技能为 `SKILL.md`/`*.md`，其中 Markdown 内容可含 YAML front matter。因此该旁白说法与画面文件扩展名不一致，不能作为技能文件格式的已证实事实。
- 字幕 [0:25:16] 提到“完整功能实施，里面有变量”；画面未展示足以确认的变量字段、变量机制或变量执行过程，不进一步推导具体功能。
