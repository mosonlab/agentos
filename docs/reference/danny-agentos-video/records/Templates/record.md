# Templates

## 时间线记录

### [0:10:10]
- 触发动作：在 AgentOS 的 `New Task` 页面选择 `From template`（相对 `Blank task`），打开模板任务创建表单；当前模板下拉框已选中 `Compound Engineering Workflow (22 tasks)`。`Feature description` 文本框处于编辑/聚焦状态但尚未填入实际描述。
- 左栏状态：顶部项目切换器显示黄色 `M` 图标、项目名 `MMO Game`，右侧红色徽标 `24` 和下拉箭头；导航项依次为 `Inboxes`（红色徽标 `17`）、`Activity`、`Tasks`、`Goals`、`Sessions`、`Costs`、`Skills`、`Environments`、`Agents`、`Templates`、`Files`、`Knowledge`、`Repos`、`Connections`、`Admin`。截图中未显示左栏底部的 Runner 状态、`Settings`、`Sign out` 区域。
- 右栏顶部：标题 `New Task`；右上角有 `Cancel` 和黄色 `Create` 按钮；模式切换为 `Blank task` / `From template`，其中 `From template` 为选中状态。
- 右栏主体：
  - `Template`：下拉选择控件，示例值 `Compound Engineering Workflow (22 tasks)`。
  - `Feature description`：多行文本框，当前为空且显示插入光标。
  - `Feature branch name (e.g. feat/inbox-search)`：单行文本输入框，当前为空。
  - `Additional details (optional) (optional)`：文件上传控件，按钮 `Choose file`，状态文本 `No file chosen`。
  - `Will create`：只读/预览区域，已显示任务生成预览，包括 `Implement {{branch_name}}`、空白占位任务，以及依赖提示 `(depends on spec)`、`(depends on plan)`、`(depends on implement)` 等；下方部分被字幕和画中画遮挡。
- 页面目录结构：`New Task` → `From template` → `Template` → `Feature description` / `Feature branch name` / `Additional details` → `Will create`（模板实例化后的任务预览）。
- 旁白要点：讲解可以从模板开始，并展示名为 `Compound Engineering Workflow` 的模板；它用于启动新功能工作流，把原本数小时的功能开发流程交给 Blend 编排。

### [0:10:20]
- 触发动作：继续在同一个 `New Task` 模板表单中填写 `Feature description`，输入示例值 `Canary task,`；模板和其他字段保持不变。
- 左栏状态：顶部项目切换器为 `MMO Game`，项目徽标 `24`；`Inboxes` 徽标 `17`；其余导航仍为 `Activity`、`Tasks`、`Goals`、`Sessions`、`Costs`、`Skills`、`Environments`、`Agents`、`Templates`、`Files`、`Knowledge`、`Repos`、`Connections`、`Admin`。底部 Runner/`Settings`/`Sign out` 未出现在截图可见范围。
- 右栏顶部：`New Task`；右上角 `Cancel`、黄色 `Create`；`From template` 选中。
- 右栏主体：
  - `Template`：下拉框，值为 `Compound Engineering Workflow (22 tasks)`。
  - `Feature description`：多行文本框，示例值 `Canary task,`，光标位于文本末尾。
  - `Feature branch name (e.g. feat/inbox-search)`：空的单行输入框。
  - `Additional details (optional) (optional)`：`Choose file` 文件选择按钮，显示 `No file chosen`。
  - `Will create`：任务预览仍以 `Implement {{branch_name}}` 开头，并列出依赖于 `spec`、`plan`、`implement` 的后续任务；下方内容被字幕/画中画部分遮挡。
- 页面目录结构：`New Task` → `From template` → `Compound Engineering Workflow (22 tasks)` → 输入功能描述 → 输入分支名 → 可选附件 → `Will create` 任务链预览。
- 旁白要点：以 `Canary task` 作为功能描述示例，说明只需添加功能解释，模板即可生成对应的完整工作流。

### [0:25:20]
- 触发动作：从 AgentOS 应用切换到 VS Code，打开 `.agentos/templates/full-feature-implementation.yaml`；编辑器滚动/定位到模板变量和 `tasks` 编排区域，光标选中 `parent`。
- 左栏状态：VS Code 的 Explorer 面板；工作区 `AGENTOS` 下展开 `.agentos`，可见 `agents`、`skills`、`template-tasks`、`templates` 等目录。`agents` 中可见 `plan-reviewer.yaml`、`research-agent.yaml`、`review-coordinator.yaml`、`senior-dev.yaml`、`spec-agent.yaml`、`test-agent.yaml`、`wiki-linter.yaml`；`skills` 中可见 `analyze-branch-bugs.md`、`decompose.md`、`interview.md`、`pentest-methodology.md`、`plan.md`、`test.md`、`update-wiki.md`；`templates` 中选中 `full-feature-implementation.yaml`，同时可见 `activity-smoke.yaml`、`bug-investigation.yaml`、`canary-phased-flow.yaml`、`first-template.yaml`、`huge-task-pipeline.yaml`、`pentest-full.yaml`、`phased-feature-implementation.yaml`、`quick-fix-workflow.yaml`、`smoke-test.yaml`。编辑器左侧还可见 `EXPLORER` 和 `AGENTOS` 标题。
- 右栏顶部：VS Code 标签页 `full-feature-implementation.yaml — agentos`；面包屑 `.agentos > templates > full-feature-implementation.yaml`。右侧另有 Claude Code 面板，顶部显示 `waiting`，模型信息 `Claude Code v2.1.221`、`Sonnet 5 with high effort · Claude Max`、路径 `~/Development/agentos`，并提示 `1 MCP server needs authentication · run /mcp`。
- 右栏主体：
  - YAML 顶部变量区：`variables:`，可见变量键 `additional_details`，并显示 `attach_to: [parent]`。
  - `tasks`：父任务定义，`key: parent`，`title: Implement {{branch_name}}`，`prompt: |`。
  - 父任务提示词示例：`Coordinate the full pipeline for this feature.`；变量字段 `Feature: {{feature_description}}`、`Branch: {{branch_name}}`。
  - 流程说明文本：`Stages: spec → plan → plan review (parallel reviewers, then revision) → implement → AI review ...`；说明每个 child sequentially 运行，`implement` 会在 `{{branch_name}}` 上打开 draft PR，后续阶段继续在该分支上运行，并有两个 human gates：`revise-plan` 前审批 AI review 后的修订计划，以及部署前审查 PR。
  - `spec` 任务：`key: spec`、`include: write-spec`、`parent: parent`。
  - `plan` 任务：`key: plan`、`include: plan-implementation`、`parent: parent`、`unblocked_by: [spec]`。
  - `plan_review` 任务：`key: plan_review`、`include: plan-review-coordinator`、`parent: parent`、`unblocked_by: [plan]`。
- 页面目录结构：VS Code `AGENTOS` workspace → `.agentos` → `templates` → `full-feature-implementation.yaml` → `variables` / `tasks` → `parent` → `spec` / `plan` / `plan_review`（后续任务在画面下方）。右侧并列 Claude Code `waiting` 面板。
- 旁白要点：展示完整功能实施模板中的变量和分支名，强调可以很容易创建循环任务而不必手动实现；模板把功能描述、分支名传入完整流水线。

### [0:25:30]
- 触发动作：在同一份 `full-feature-implementation.yaml` 中向下滚动，展示 `plan_review` 下的多个并行审查子任务及其后续人工审批任务。
- 左栏状态：VS Code Explorer 仍位于 `AGENTOS/.agentos`；`templates/full-feature-implementation.yaml` 仍为选中项。左侧可见 VS Code 活动栏图标，其中源代码管理图标带徽标 `2`，底部设置图标带徽标 `1`；Explorer 下方有 `OUTLINE`，显示 `No symbols found in document 'full-feature-implementation.yaml'`，更下方为 `TIMELINE`。
- 右栏顶部：编辑器标签 `full-feature-implementation.yaml`；面包屑 `.agentos > templates > full-feature-implementation.yaml`。Claude Code 面板仍显示 `waiting`、`Claude Code v2.1.221`、`Sonnet 5 with high effort · Claude Max`、`~/Development/agentos` 和黄色警告 `1 MCP server needs authentication · run /mcp`。面板中可见 `/model`、`Create cnaary project in AgentOS for me with cli` 等会话内容。
- 右栏主体：
  - 父任务提示词继续显示流程：`Stages: spec → plan → plan review (parallel reviewers, then revision) → implement → AI review ...`，并说明 draft PR、分支和两个 human gates。
  - 基础任务：`spec` → `include: write-spec` → `parent: parent`；`plan` → `include: plan-implementation` → `parent: parent` → `unblocked_by: [spec]`；`plan_review` → `include: plan-review-coordinator` → `parent: parent` → `unblocked_by: [plan]`。
  - 计划审查子任务：`review_plan_feasibility` → `include: review-plan-feasibility` → `parent: plan_review`；`review_plan_scope` → `include: review-plan-scope` → `parent: plan_review`；`review_plan_coherence` → `include: review-plan-coherence` → `parent: plan_review`；`review_plan_security` → `include: review-plan-security` → `parent: plan_review`。这些任务共同体现并行 reviewers。
  - 人工审批说明注释：`Human gate on the plan lives here (not on the initial plan task): I review the AI-reviewed, revised plan. Templates without a plan-review fan should set requires_approval on their plan include instead.`
  - `revise_plan`：`key: revise_plan`、`include: revise-plan-from-review`、`parent: parent`、`unblocked_by: [plan_review]`、`requires_approval: true`。
  - Claude Code 面板主体还显示对 AgentOS CLI/MCP 的检索与确认文本，例如 `Confirmed: the agentos CLI (tools/agentos-cli) can only pick an existing project via agentos init—it has no command to create a new project...`，以及 `User declined to answer questions`；底部状态为 `Worked for 27s`、`Sonnet 5 | Effort: high | Context: 7% used`、`auto mode on`、`1 agent`。
- 页面目录结构：`full-feature-implementation.yaml` → `tasks` → `parent` → `spec` / `plan` / `plan_review` → `review_plan_feasibility`、`review_plan_scope`、`review_plan_coherence`、`review_plan_security` → `revise_plan`（需要审批）。右侧为 Claude Code 会话/状态面板。
- 旁白要点：明确指出 `spec step`、`plan step`、`plan review` 等都是模板任务，并强调每个任务拥有自己的 agent 和 prompt；并行审查和人工 gate 是模板编排的一部分。

### [0:25:40]
- 触发动作：继续切换/查看 `.agentos/template-tasks/implement-feature.yaml`，从总模板进入被引用的具体实现模板任务定义。
- 左栏状态：VS Code Explorer 中展开 `.agentos/template-tasks`，可见 `ai-review-coordinator-loop.yaml`、`ai-review-coordinator.yaml` 等；`.agentos/agents` 展开并列出 `code-agent.yaml`、`code-reviewer.yaml`、`decomposer.yaml`、`default-agent.yaml`、`diagnostic-agent.yaml`、`librarian.yaml`、`pentest-agent.yaml`、`pentest-coordinator.yaml`、`plan-agent.yaml`、`plan-executor.yaml`、`plan-reviewer.yaml`、`research-agent.yaml`、`review-coordinator.yaml`、`senior-dev.yaml`、`spec-agent.yaml`、`test-agent.yaml`、`wiki-linter.yaml`。左栏仍可见 `OUTLINE` 和 `TIMELINE`。
- 右栏顶部：编辑器标签 `implement-feature.yaml — agentos`；面包屑 `.agentos > template-tasks > implement-feature.yaml`。右侧 Claude Code 面板为 `waiting`，显示 `Claude Code v2.1.221`、`Sonnet 5 with high effort · Claude Max`、`~/Development/agentos`、`1 MCP server needs authentication · run /mcp`，以及顶部蓝色 `Update` 按钮。
- 右栏主体：
  - YAML 元数据：`slug: implement-feature`、`scope: project`、`title: Implement`、`agent: Plan Executor`。
  - `consumes`：列表项 `key: branch_name`、`type: text`。
  - `prompt: |`：`Execute the implementation plan from the plan task.`
  - `Git workflow (required)`：
    1. `From an up-to-date main, create branch '{{branch_name}}'.`
    2. `Make the code changes, keep the diff scoped to the plan.`
    3. `Commit incrementally — one commit per logical milestone, each green (lint + tests pass) ...`
    4. `Push the branch and open a **draft** PR against main immediately after the change.`
    5. `In your final message, output: branch name, PR URL, and a one-paragraph summary ...`
  - 末尾约束：`Do not merge. The PR stays in draft until the remaining pipeline stages and my approval pass.`
  - Claude Code 面板主体显示之前的 CLI/MCP 项目创建讨论，底部仍为输入框及 `Sonnet 5 | Effort: high | Context: 7% used`、`auto mode on`、`1 agent`。
- 页面目录结构：VS Code `AGENTOS` workspace → `.agentos` → `template-tasks` → `implement-feature.yaml` → 元数据 → `consumes` → `prompt` → `Git workflow (required)` → draft PR/不合并约束；旁侧为 Claude Code 面板。
- 旁白要点：收束展示并实现步骤，说明这些都是模板任务，每个任务都有自己的代理和提示词；最后以 `AgentOS` 总结这套可复用、可编排的工作流。

## 功能清单

- 从 `Blank task` / `From template` 中选择模板创建任务。
- 使用 `Compound Engineering Workflow (22 tasks)` 模板启动完整功能开发流程。
- 通过 `Feature description` 输入功能说明，例如 `Canary task,`。
- 通过 `Feature branch name (e.g. feat/inbox-search)` 注入分支名变量 `{{branch_name}}`。
- 通过 `Additional details (optional)` 选择附加文件。
- 在 `Will create` 区域预览模板实例化后将创建的任务及依赖关系。
- 使用变量 `{{feature_description}}`、`{{branch_name}}`、`{{additional_details}}` 复用同一套模板。
- 将功能流程拆成 `spec`、`plan`、`plan_review`、`revise_plan`、`implement` 等阶段。
- 通过 `include` 引用可复用的模板任务，例如 `write-spec`、`plan-implementation`、`plan-review-coordinator`、`implement-feature`。
- 通过 `parent`、`unblocked_by` 表达任务层级和解锁依赖。
- 以 `review_plan_feasibility`、`review_plan_scope`、`review_plan_coherence`、`review_plan_security` 组织并行计划审查。
- 为每个模板任务指定独立 agent 和 prompt，例如 `agent: Plan Executor`。
- 通过 `consumes` 声明任务输入变量及类型，例如 `branch_name` / `text`。
- 在 prompt 中内置 Git 工作流：从最新 `main` 创建分支、按逻辑里程碑增量提交、保持 diff 聚焦、推送分支并立即创建 draft PR。
- 支持人工审批 gate：`revise_plan` 设置 `requires_approval: true`，部署/合并前保留人工审查。
- 规定 PR 在剩余流水线阶段和人工批准完成前保持 draft，且任务本身不执行 merge。
- 每个子任务按顺序运行；计划审查阶段可并行运行多个 reviewers，再进入修订。
- 在 AgentOS/VS Code 中直接编辑 YAML 模板，并通过模板目录和 `template-tasks` 目录管理可复用任务。

## 仅旁白提及（画面未见）

- 旁白称该流程是“3小时完全由Blend管理的流程”；截图只能看到模板和任务编排，未显示持续时长或 Blend 的运行计时。
- 旁白说模板可以把“数小时的功能开发流程自动编排起来”；画面展示了编排定义，但未展示完整流程实际执行完毕。
- 旁白提到“我现在就启动”复合工程师工作流；截图展示的是创建表单和 YAML 定义，未看到点击 `Create` 后实际启动的运行状态。
- 旁白提到“而不必手动实现它们”；截图能看到模板化和依赖配置，但未展示手动实现的对照过程。
- 旁白说“我基本上让 Claude Code 为我实现这些步骤”；截图中的 Claude Code 面板处于 `waiting`，可见讨论和状态，但未看到 Claude Code 实际完成这些步骤。
- 旁白概括“这就是 AgentOS”；这是产品理念/总结，截图未出现单独的品牌介绍或功能总结页。
