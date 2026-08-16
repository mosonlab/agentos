# 架构_技术栈讲解

## 时间线记录

### [0:06:10]
- 触发动作：画面继续显示 `Claude Managed Agents overview` 文档页；鼠标停在正文标题附近，静态帧未显示明确的点击或滚动动作。
- 左栏状态：Claude Platform Docs 的 Managed Agents 文档导航；顶部搜索框显示 `Search`，快捷键提示为 `⌘ K`。`First steps` 下的 `Overview` 处于选中状态，其他可见项包括 `Quickstart`、`Build in Console`、`Migration`；`Define your agent` 下有 `Agent setup`、`Tools`、`MCP connector`、`Permission policies`、`Agent Skills`；`Configure agent environment` 下有 `Cloud environment setup`、`Cloud sandbox reference`、`Self-hosted sandboxes`；`Delegate work to your agent` 下有 `Start a session`、`Session operations`、`Session event stream`、`Session budgets`、`Subscribe to webhooks`。底部全局区显示用户 `Danny`、`Admin · Postcrafts ...` 和下拉箭头；Runner 状态、`Settings`、`Sign out` 未见。顶部项目/产品切换器为 `Claude Platform Docs`，顶栏 `Managed Agents` 选中，旁边有 `Messages`、`Admin`、`Resources`。
- 右栏顶部：面包屑 `Managed Agents > First steps`；标题 `Claude Managed Agents overview`；副标题 `Pre-built, configurable agent harness that runs in managed infrastructure. Best for long-running tasks and asynchronous work.`；右上有 `Copy page` 按钮及下拉箭头。页面顶部导航还显示 `{ } API reference`、显示器图标、`English` 下拉和 `Console` 按钮。
- 右栏主体：
  - 对比表：标题行 `Messages API`、`Claude Managed Agents`；字段 `What it is`，示例值分别为 `Direct model prompting access`、`Pre-built, configurable agent harness that runs in managed infrastructure`；字段 `Best for`，示例值分别为 `Custom agent loops and fine-grained control`、`Long-running tasks and asynchronous work`。
  - 说明段落：Claude Managed Agents 提供运行 Claude 自主代理所需的 harness 和 infrastructure；无需自行构建 agent loop、tool execution 和 runtime，托管环境支持读文件、运行命令、浏览网页和安全运行代码，并提供 prompt caching、compaction 等能力。
  - 蓝色提示框：`Claude Managed Agents is also available on Claude Platform on AWS, with some differences in feature availability and session behavior.`，并链接到 `Claude Managed Agents in the Cloud Platform on AWS guide`。
  - 三个入口卡片：`Quickstart`（`Create your first agent session`）、`Start a session`（`Create a session and send your first event`）、`Reference`（`Event types, rate limits, CLI flags, and other lookup tables`）。
  - 下方开始 `Core concepts` 区块，文字为 `Claude Managed Agents is built around four concepts:`，表格内容在画面下方未完整显示。
- 页面目录结构：
  - `Claude Platform Docs`
    - `Managed Agents`
      - `First steps`
        - `Overview`（当前页）
        - `Quickstart`
        - `Build in Console`
        - `Migration`
      - `Define your agent`
      - `Configure agent environment`
      - `Delegate work to your agent`
    - 当前页 `Claude Managed Agents overview`
      - 对比 `Messages API / Claude Managed Agents`
      - `Core concepts`
        - `How it works`
        - `When to use Claude Managed Agents`
        - `Supported tools`
        - `Beta access`
- 旁白要点：系统构建在 Claude 托管代理之上；平台通过 SDK 启动会话等能力。当前画面展示了托管代理文档，说明它是预构建、可配置、运行在托管基础设施上的 agent harness，适合长时间运行任务和异步工作。

### [0:06:20]
- 触发动作：画面已显示为文档中的 `Start a session` 页面；导航当前位于对应位置并选中该项，页面正文为会话创建说明。静态抽帧只能确认这一结果状态，不能确认具体点击或滚动方式。
- 左栏状态：`Delegate work to your agent` 区域的 `Start a session` 处于选中状态；可见相邻项 `Session operations`、`Session event stream`、`Session budgets`、`Subscribe to webhooks`、`Define outcomes`、`Authenticate with vaults`、`Manage agent context`、`Access GitHub`、`Attach and download files`、`Build persistent memory`、`Advanced orchestration`、`Multiagent orchestration`、`Scheduled deployments`。下方有 `Reference`、`Managed Agents reference`，以及 `Working with files`、`Files API`、`PDF support`、`Images and vision`。底部全局区仍显示 `Danny`、`Admin · Postcrafts ...` 和下拉箭头；Runner 状态、`Settings`、`Sign out` 未见。顶部产品/项目切换器仍为 `Claude Platform Docs`，`Managed Agents` 仍选中。
- 右栏顶部：标题 `Creating a session`；正文说明 `A session requires an agent ID and an environment ID.`，并强调 agent 是有版本的资源。右侧页内目录标题为 `Creating a session`，目录项有 `Seed the session with initial events`、`Override agent configuration for a session`、`Set a session budget`、`MCP authentication through vaults`、`Starting the session`、`Next steps`。
- 右栏主体：
  - 第一段代码示例区块：语言标签 `cURL`、`CLI`（选中）、`Python`、`TypeScript`、`C#`、`Go`、`Java`、`PHP`、`Ruby`，右上有复制图标。CLI 示例为：`ant beta:sessions create`、`--agent "$AGENT_ID"`、`--environment-id "$ENVIRONMENT_ID"`。
  - 版本固定说明：通过对象传入 agent，可精确控制运行的版本并独立进行新版本 rollout。
  - 第二段代码示例区块：同样为多语言标签，`CLI` 选中；YAML 示例字段为 `agent`、`type: agent`、`id: $AGENT_ID`、`version: 1`、`environment_id: $ENVIRONMENT_ID`，外层命令显示 `ant beta:sessions create <<YAML` 和结束标记 `YAML`。
  - `Seed the session with initial events` 区块：说明 `initial_events` 是可选的初始事件数组，按顺序发送；支持 `user.message` 和 `user.define_outcome` 事件，最多 50 个；非空列表会在创建会话的同一调用中启动 agent loop，空列表则只创建处于 `running` 状态的会话。
  - 下方出现第三个代码区块的顶部，文本以 `SEEDED_SESSION_ID=$(ant beta:sessions create \` 和 `--transform id --raw-output <<YAML` 开始。
- 页面目录结构：
  - `Managed Agents`
    - `Delegate work to your agent`
      - `Start a session`（当前页）
        - `Creating a session`
          - 创建会话
          - `Seed the session with initial events`
          - `Override agent configuration for a session`
          - `Set a session budget`
          - `MCP authentication through vaults`
          - `Starting the session`
          - `Next steps`
- 旁白要点：SDK 能让用户启动这些会话；示例功能包括启动一个 session，并设置 MCP 连接、文件 API 等能力。

### [0:06:30]
- 触发动作：当前页面仍为 `Creating a session`；相较上一抽帧，左侧导航已显示到较上方位置，`Start a session` 仍处于选中状态，正文没有发生功能切换。静态帧不能确认造成这一变化的具体交互。
- 左栏状态：顶部重新显示 `First steps`（`Overview`、`Quickstart`、`Build in Console`、`Migration`）、`Define your agent`（`Agent setup`、`Tools`、`MCP connector`、`Permission policies`、`Agent Skills`）、`Configure agent environment`（`Cloud environment setup`、`Cloud sandbox reference`、`Self-hosted sandboxes`），其后是 `Delegate work to your agent` 下选中的 `Start a session`，并可见 `Session operations`、`Session event stream`、`Session budgets`、`Subscribe to webhooks`。底部仍是 `Danny`、`Admin · Postcrafts ...`；Runner 状态、`Settings`、`Sign out` 未见。顶部 `Managed Agents` 选中。
- 右栏顶部：标题 `Creating a session`；右侧页内目录仍为 `Creating a session`、`Seed the session with initial events`、`Override agent configuration for a session`、`Set a session budget`、`MCP authentication through vaults`、`Starting the session`、`Next steps`。
- 右栏主体：
  - `Creating a session` 的两个代码示例仍可见，第二个示例明确展示以 YAML 对象固定 agent 版本：`type: agent`、`id: $AGENT_ID`、`version: 1`、`environment_id: $ENVIRONMENT_ID`。
  - `Seed the session with initial events` 的说明和第三个 CLI/YAML 示例仍在下方；代码块顶部可见 `SEEDED_SESSION_ID`、`initial_events` 相关内容。
  - 各代码块均提供语言切换标签 `cURL`、`CLI`、`Python`、`TypeScript`、`C#`、`Go`、`Java`、`PHP`、`Ruby` 与复制按钮。
- 页面目录结构：与 [0:06:20] 相同，为 `Managed Agents > Delegate work to your agent > Start a session > Creating a session`，页内包含会话创建、初始事件、会话配置覆盖、预算、vault 认证、启动和后续步骤。
- 旁白要点：讲解者表示这些基础能力已经由 Claude 平台建好，自己只是在其上构建 API，并开始开发自己的功能。

### [0:23:20]
- 触发动作：画面已显示为本地 VS Code 项目；项目文件树展开到 `.agentos/agents`，并打开 `code-agent.yaml`。右侧同时可见 Claude Code 终端面板。
- 左栏状态：这里不是 Claude Platform Docs 的应用侧栏，而是 VS Code 活动栏与 Explorer。Explorer 根目录为 `AGENTOS`，可见 `.agent`、`.agentos`；`.agentos/agents` 已展开并选中 `code-agent.yaml`，同目录文件包括 `code-reviewer.yaml`、`decomposer.yaml`、`default-agent.yaml`、`diagnostic-agent.yaml`、`librarian.yaml`、`pentest-agent.yaml`、`pentest-coordinator.yaml`、`plan-agent.yaml`、`plan-executor.yaml`、`plan-reviewer.yaml`、`research-agent.yaml`、`review-coordinator.yaml`、`senior-dev.yaml`、`spec-agent.yaml`、`test-agent.yaml`、`wiki-linter.yaml`。`skills` 文件夹展开，列出 `analyze-branch-bugs.md`、`decompose.md`、`interview.md`、`pentest-methodology.md`、`plan.md`、`test.md`、`update-wiki.md`；下方还有 `template-tasks`、`templates`、`.sync.json`。活动栏的源代码管理图标有徽标 `2`，扩展图标有警告徽标。左下角可见设置齿轮，带蓝色徽标 `1`；底部 VS Code 状态/全局区可见 `OUTLINE`（提示 `No symbols found in document 'code-agent.yaml'`）和 `TIMELINE`，未见 Runner、`Sign out`。
- 右栏顶部：VS Code 顶部标题为 `code-agent.yaml — agentos`；编辑器标签为 `code-agent.yaml`，面包屑为 `.agentos > agents > code-agent.yaml`。右侧编辑器标签为 `claude.exe`；Claude Code 面板顶部显示终端身份 `dannypostma@MacBook-Pro-2 agentos % claude`、`Claude Code v2.1.221`、`Sonnet 5 with high effort`、`Claude Max`、路径 `~/Development/agentos`。有黄色提示 `1 MCP server needs authentication · run /mcp`；命令区出现 `/model`，结果为 `Set model to Sonnet 5 and saved as your default for new sessions`。顶部还有 `Update` 按钮。
- 右栏主体：
  - 编辑器区块：文件 `code-agent.yaml`，YAML 字段依次可见 `slug: code-agent`、`name: Code Agent`、`description: Senior Programmer Agent`、`model: claude-opus-4-6`、`scope: project`、`status: draft`。
  - 工具与扩展配置：`tools` 下 `enabled: true`、`disabled: []`；`skills: []`；`mcpAgentosEnabled: true`；`mcpConnections` 下示例值 `https://api.githubcopilot.com/mcp`；`spawnableAgents` 下示例值 `test-agent`；`maxNestingDepth: 1`；`memoryEnabled: true`。
  - 环境与仓库：`environment: Default`；`repos` 下示例值 `agentos`；`initScripts` 下示例值 `Setup`。
  - 系统提示词区块：`system: |-`，正文开头为 `You are a Senior Programmer. You receive implementation requests or bug reports ...`，下方有 `## Workflow`，并可见编号流程：`Understand the task`、`Branch`（包含 `Feature: claude/feat/<short-description>`、`Bug fix: claude/fix/<short-description>` 等分支命名示例）、`Investigate`、`Implement`、`Commit & push`、`Review`。
- Claude Code 终端区块：显示 `Sonnet 5`、`Effort: high` 和 `manual mode on · 1 agent`；终端下方另有 Bash 输出，提到已生成并保存 `agents-overview.md` 与 `agents-overview.png`，并说明图示流程为 `You → Goal → Tasks (todo → doing → review → done) → Agents`。
- 终端下方还明确说明 `agents-overview.md` 与 `agents-overview.png` 均为 `untracked`，不会被自动带入提交。
- 页面目录结构：
  - `AGENTOS`
    - `.agent`
    - `.agentos`
      - `agents`
        - `code-agent.yaml`（当前文件）
        - 其他 agent YAML 文件
      - `skills`
        - 多个技能 Markdown 文件
      - `template-tasks`
      - `templates`
      - `.sync.json`
    - 当前 YAML 配置
      - 基本身份与版本字段
      - tools / skills / MCP 配置
      - 可生成 agent 与嵌套深度
      - memory / environment / repos / initScripts
      - system workflow
    - 旁侧 `claude.exe` 终端
- 旁白要点：讲解者说“最后要展示”的是每个项目都有一个 AgentOS 文件，用来模拟在线内容；此帧展示了项目目录、多个 agent 配置和 `code-agent.yaml`。

### [0:23:30]
- 触发动作：当前为 `code-agent.yaml` 的近距离视图，鼠标指向 `.agentos` 及 `agents` 文件夹附近；没有观察到字段被编辑或保存，静态帧只能确认画面结果，不能确认具体缩放或其他交互方式。
- 左栏状态：Explorer 的 `AGENTOS > .agentos > agents` 展开；`code-agent.yaml` 选中。可见完整的 agent YAML 文件列表，包括 `code-reviewer.yaml`、`decomposer.yaml`、`default-agent.yaml`、`diagnostic-agent.yaml`、`librarian.yaml`、`pentest-agent.yaml`、`pentest-coordinator.yaml`、`plan-agent.yaml`、`plan-executor.yaml`、`plan-reviewer.yaml`、`research-agent.yaml`、`review-coordinator.yaml`、`senior-dev.yaml`、`spec-agent.yaml`、`test-agent.yaml`、`wiki-linter.yaml`。`skills` 下可见 `analyze-branch-bugs.md`、`decompose.md`、`interview.md`、`pentest-methodology.md`、`plan.md`、`test.md`、`update-wiki.md`。Explorer 标题栏可见新建文件、新建文件夹、刷新、折叠全部目录四个操作按钮。VS Code 活动栏源代码管理徽标为 `2`，扩展图标有警告徽标；左下角设置齿轮及其徽标在当前裁切中不可完整确认。没有应用侧栏的 Runner、`Sign out` 或项目切换器。
  - 右栏顶部：编辑器标签 `code-agent.yaml`，面包屑 `.agentos > agents > code-agent.yaml`；顶部窗口标题 `code-agent.yaml — agentos`。右侧 Claude Code 面板被画面裁切，本帧仅能读到标签 `claude.exe`、面板左侧可见的 Claude Code 信息片段、`MCP` 认证警告、`/model` 及其结果片段和下方 `Sonnet 5`、`manual...` 片段；完整的版本、模型、订阅和路径信息不在本帧可验证范围，不能从相邻帧补写。
- 右栏主体：
  - YAML 顶部配置：`slug: code-agent`、`name: Code Agent`、`description: Senior Programmer Agent`、`model: claude-opus-4-6`、`scope: project`、`status: draft`。
  - 工具配置：`tools.enabled: true`、`tools.disabled: []`、`skills: []`。
  - MCP 与 agent 编排：`mcpAgentosEnabled: true`；`mcpConnections` 示例 `https://api.githubcopilot.com/mcp`；`spawnableAgents` 示例 `test-agent`；`maxNestingDepth: 1`。
  - 运行环境：`memoryEnabled: true`、`environment: Default`、`repos` 示例 `agentos`、`initScripts` 示例 `Setup`。
  - `system: |-` 长文本：开头为 `You are a Senior Programmer. You receive implementation requests or bug reports and deliver ...`；`## Workflow` 下可见 `Understand the task`、`Branch`、`Investigate`、`Implement`、`Commit & push`、`Review`，显示该 YAML 还能承载代理的行为规范和工作流指令。
- 页面目录结构：
  - `AGENTOS`
    - `.agentos`
      - `agents`
        - `code-agent.yaml`
        - `code-reviewer.yaml`
        - 其他 agent YAML
      - `skills`
        - 技能 Markdown 文件
    - `code-agent.yaml` 内容
      - 代理元数据
      - 工具、技能、MCP
      - 可生成代理与记忆
      - 环境、仓库、初始化脚本
      - 系统提示词与工作流
- 旁白要点：明确说明每个项目都有一个 `agent.os` 文件，模拟在线内容；代理被格式化为 YAML 文件。

### [0:23:40]
- 触发动作：画面恢复为较宽/较完整的 VS Code 视图，底部终端面板已收起，因此编辑器纵向空间增加并显示到工作流后续行；文件仍从第 1 行开始，未见向下滚动证据。
- 左栏状态：与前一帧相同，`AGENTOS > .agentos > agents > code-agent.yaml` 选中；左侧仍列出多个 agent YAML 与 `skills` Markdown 文件。VS Code 活动栏源代码管理徽标 `2`，扩展图标带警告徽标；左下角可见设置齿轮，带蓝色徽标 `1`。应用级 Runner、`Sign out` 和顶部项目切换器不可见。
- 右栏顶部：`code-agent.yaml — agentos`；编辑器标签 `code-agent.yaml`；右侧 Claude Code 面板显示 `claude.exe`、`Claude Code v2.1.221`、`Sonnet 5 with high effort`、`Claude Max`、`~/Development/agentos`、`1 MCP server needs authentication · run /mcp`，并显示 `Sonnet 5`、`Effort: high`、`manual mode on · 1 agent`。
- 右栏主体：
  - YAML 顶部字段仍可见：`slug: code-agent`、`name: Code Agent`、`description: Senior Programmer Agent`、`model: claude-opus-4-6`、`scope: project`、`status: draft`。
  - 配置字段仍可见：`tools.enabled: true`、`tools.disabled: []`、`skills: []`、`mcpAgentosEnabled: true`、`mcpConnections: https://api.githubcopilot.com/mcp`、`spawnableAgents: test-agent`、`maxNestingDepth: 1`、`memoryEnabled: true`、`environment: Default`、`repos: agentos`、`initScripts: Setup`。
  - `system` 区块：长文本继续展示代理工作流，包括 `Understand the task`、`Branch`、`Investigate`、`Implement`、`Commit & push`、`Review`。可见的具体约束包括：从 `main` 创建新分支；分支名使用小写和连字符且不得有空格；Feature 使用 `claude/feat/<short-description>`、Bug fix 使用 `claude/fix/<short-description>`；实现时只做完成任务所需的最小修改；不加入无关重构、功能或清理；不加入臆测性的错误处理或抽象；只写解释“为什么”的非显然注释；不得引入 injection、XSS 等安全漏洞；完成后只暂存修改过的文件、提交聚焦于“为什么”而不是“做了什么”的简洁信息、push branch，并生成 review 子任务交给 Review Agent。
- 页面目录结构：
  - `AGENTOS`
    - `.agentos`
      - `agents`
        - 多个 YAML agent 定义
      - `skills`
        - 多个 Markdown skill 定义
    - `code-agent.yaml`
      - metadata
      - tools / skills
      - MCP connections
      - spawnable agents
      - memory / environment / repos / init scripts
      - system workflow
- 旁白要点：强调代理配置以 YAML 文件格式表达；画面中的单个文件集中描述代理身份、模型、工具、MCP 连接、可生成代理、环境、仓库、初始化脚本，以及详细系统工作流。

## 功能清单

- 基于 Claude Managed Agents 的托管 agent harness，运行在 managed infrastructure，面向 long-running tasks 和 asynchronous work。
- 通过 Claude SDK 启动会话，并通过 API 配置会话能力。
- 创建 session 时指定 `agent ID` 和 `environment ID`。
- 通过字符串 agent ID 使用最新 agent 版本，或通过 YAML 对象锁定指定 `version`。
- 通过 `initial_events` 在创建会话时发送初始事件并启动工作。
- 支持 `user.message` 和 `user.define_outcome` 事件，最多 50 个初始事件。
- 通过 SDK/API 配置 MCP connections。
- 文件能力通过 Files API 提供；文档导航还包含 `Attach and download files`、`Files API`、`PDF support`、`Images and vision`。
- Managed Agents 提供读文件、运行命令、浏览网页和安全运行代码的能力。
- 内置 prompt caching、compaction 等运行优化。
- 文档页内提供 `How it works`、`When to use Claude Managed Agents`、`Supported tools` 和 `Beta access` 等信息入口。
- 支持 CLI 与 `cURL`、`Python`、`TypeScript`、`C#`、`Go`、`Java`、`PHP`、`Ruby` 等代码示例切换，并可复制代码。
- AgentOS 项目在 `.agentos/agents` 下以多个 YAML 文件管理 agent 定义。
- YAML 可配置 `slug`、`name`、`description`、`model`、`scope`、`status`。
- YAML 可启用/禁用工具，声明 `skills`。
- YAML 可启用 AgentOS MCP（`mcpAgentosEnabled`）并配置 `mcpConnections`。
- YAML 可声明 `spawnableAgents` 和 `maxNestingDepth`，支持 agent 编排/嵌套。
- YAML 可启用 memory（`memoryEnabled`），指定 `environment`、`repos` 和 `initScripts`。
- YAML 的 `system` 字段承载代理系统提示词和完整工作流规范。
- 项目同时包含 skills Markdown 文件，例如 `analyze-branch-bugs.md`、`decompose.md`、`plan.md`、`test.md`。
- Claude Code 终端可查看模型、effort、agent 数量和 MCP 认证状态，并通过 `/model` 设置模型。
- `system` 工作流还约束：分支名使用小写、连字符且不得有空格；实现只做完成任务所需的最小修改，不加入无关重构、功能或清理，不加入臆测性的错误处理或抽象，只写解释“为什么”的非显然注释，并避免 `injection`、`XSS` 等安全漏洞。
- Claude Code 可生成 `agents-overview.md` 和 `agents-overview.png`；截图中两者均为 `untracked`，不会自动带入提交。

## 仅旁白提及（画面未见）

- “UI”是讲解者自己的界面：截图中只看到 Claude Platform Docs 文档和 VS Code，未看到其自建 UI 的实际操作界面。
- API 对会话、MCP 和文件能力的统一配置过程：画面看到文档代码示例和本地 YAML，但没有看到讲解者自建 API 的请求或配置页面。
- “他们什么都建好了，我只是在上面构建了我的 API”这一层平台与自建 API 的具体实现细节，截图无法直接验证。
- 字幕提到的“每个项目都有一个 AgentOS 文件”是概念性描述；画面实际可见的是项目中的 `.agentos` 目录和多个 agent YAML 文件，未看到名为 `AgentOS` 或 `agent.os` 的单一文件。
- 旁白中的“模拟了在线内容”是对这些项目文件用途的说明，画面未展示对应的在线内容或同步过程。
