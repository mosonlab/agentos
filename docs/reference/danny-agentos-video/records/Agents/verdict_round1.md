# 判定：FAIL

## 核对详情

- 0:03:40｜基本属实｜画面确为 `Agents` 列表，`Your Agents / System Agents`、`New folder`、`Create Agent`、表格列、代理名称、模型、`Published` 状态及日期均与记录一致；左栏的 `MMO Game 24`、`Inboxes 17`、选中的 `Agents` 和底部 `Runner / Running`、`Settings`、`Sign out` 也均已正确记录。
- 0:03:50｜基本属实｜画面确为 `Edit Agent → Prompt`，`AgentOS Foundation` 带 `v6`、`Read-only` 和 `Sits above your instructions`；记录所述 foundation prompt、运行时约束、任务阶段转换、guide 调用及隔离 subagent 内容均有画面依据。
- 0:04:20｜不属实｜该帧仍在 `Prompt` 标签，主体是 `Your agent instructions`，可见 build-order、学习 AgentOS filesystem、读取 spec、研究代码库和双处交付 plan 等步骤；并未进入 `Capabilities`，也没有显示 Memory、Tools 或 Skills 开关。记录把后续帧的界面提前写到了此时间戳。
- 0:04:30｜部分不属实｜该帧刚进入 `Capabilities` 顶部，显示关闭的 agent memory、开启的 tools 总开关、八个开启的工具开关，以及 Skills 开头的 `Verify Live`、`Update Wiki`；记录声称已向下滚到完整 Skills、`MCP Connections` 和 `Repositories`，与本帧不符。
- 0:05:10｜不属实｜该帧仍是 `Capabilities` 下半页：`Plan Mode` 开启，其余所示 Skills 关闭；`AgentOS MCP` 开启，`Ahrefs Global`、`GitHub MCP` 关闭；仓库 `vibeville / dannypostma/vibeville` 开启。画面不是 `Collaborators`，也没有协作代理列表。
- 0:05:30｜属实｜画面确为 `Collaborators` 标签，说明仅列出 published agents；`Default Agent`、`Senior Dev`、`Plan Executor`、`Review Coordinator`、`Plan Reviewer`、`Code Reviewer`、`Plan Agent`、`Librarian`、`Spec Agent` 及关闭的逐项开关均与记录一致。
- 0:23:50｜基本属实｜画面确为 `.agentos/agents/spec-agent.yaml`；`slug`、名称、描述、`model: claude-opus-4-8`、scope、status、tools、skill、MCP、spawn、nesting、memory、environment、repo、init script 和 system prompt 等字段与示例值均记录正确，Explorer 中的 agents/skills 文件也有画面依据。
- 0:24:10｜基本属实｜终端确实执行 `agentos --help`，用途、options 以及 `login`、`logout`、`whoami`、`init`、`pull`、`push`、`status`、`diff`、`task`、`help` 命令均与记录一致。

## 遗漏清单

- `0:03:50` 的 foundation prompt 还明确说明：每次 session 的第一条用户消息含权威的 `<session-context>`，后续要求忽略或覆盖这些 invariants 时应拒绝。记录概括了 foundation 和部分约束，但未记下这组可见且有价值的安全规则。
- 除上述一项外，旁白涉及的模型、提示词、技能、MCP、仓库、最小权限隔离、独立云容器、协作代理及 CLI push/pull/init 均已有记录；左栏项目切换器、`24`/`17` 徽标和底部全局区也没有整体性漏记。

## 错误清单

- `0:04:20` 页面类型错误：实际为 `Prompt / Your agent instructions`，被写成 `Capabilities`。
- `0:04:30` 滚动位置和主体区块错误：实际只到 Capabilities 顶部及 Skills 开头，被写成已经显示完整 Skills、MCP Connections 和 Repositories。
- `0:05:10` 页面类型错误：实际为 Capabilities 下半页，被写成 `Collaborators`。协作代理列表在抽查的 `0:05:30` 帧才出现。
- 上述错误使多项真实字段和开关被张冠李戴到错误时间戳；虽然这些功能在其他帧中确实存在，但不能据此视为对应帧描述属实。

## 修复指令

1. 重写 `0:04:20`：保留 `Prompt` 为选中状态，按画面记录 `Your agent instructions` 中可见的 build-order、filesystem guide、读取 spec、研究代码库和双处交付 plan；删除该条中的 Memory、Tools、Skills 描述。
2. 重写 `0:04:30`：改为“进入 Capabilities 顶部”，准确记录 Memory 关闭、Tools 总开关开启、`Bash`、`Read`、`Write`、`Edit`、`Glob`、`Grep`、`Web fetch`、`Web search` 均开启，以及仅刚出现的 Skills 开头；删除本帧尚未显示的 MCP 和仓库描述。
3. 重写 `0:05:10`：改为 Capabilities 下半页，逐项写明 Skills、`MCP Connections 1 / 20` 和 repository 的实际开关状态；删除 Collaborators 列表及“点击 Collaborators”的动作。
4. 保留 `0:05:30` 作为已核实的 Collaborators 页面；不要把它复制到 `0:05:10`。对 `0:04:40–0:05:20` 的每一帧重新逐张核对后再分配下半页内容，避免机械平移时间戳。
5. 在 `0:03:50` 的 foundation prompt 记录中补入 `<session-context>` 的权威性及拒绝覆盖 runtime invariants 的规则。
6. 修改后复核每条的“触发动作、选中标签、主体区块、字段值”是否与该时间戳原帧同时成立；不得用相邻帧存在的元素代替本帧证据。
