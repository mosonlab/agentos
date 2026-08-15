# Backlog

试点（vibeville lines 子命令，2026-08-15）暴露的 V1.5 补漏与已裁定的 V2 项。V2 大项见 DECISIONS.md（#3/#4/#10/#13/#16/#18/#20），Leo 已明确暂不启动 V2。

## V1.5 补漏（试点实测暴露，优先于 V2）

- [x] **Web 重试按钮**：Tasks 看板行菜单与任务详情页对末次 run 已终止的任务给「Retry」，调 `POST /tasks/:taskId/retry`。
- [x] **入站自由文本的兜底 UX**：匹配不到等待中提问的入站文本落一条 from=HUMAN 的 InboxMessage（挂该 chat 的 thread），Inbox 页可见，不参与决策流；卡片点击仍按原样报错。
- [x] **api 重启对在跑 run 的折损**：启动/领取对账对心跳仍新鲜（距今 < stallTimeout）的活跃 run 跳过判定；外因失败（信号终止、预检失败、runner 异常、租约丢失）不再消耗预算，而是把 run 预算上限 +1。任务默认预算 3 → 5。
- [x] **闸门消息的产物预览**：闸门 Inbox 消息在 PR 链接后内嵌该步 TaskStepOutput 正文摘要（截断 1000 字符），飞书卡片正文另有 3000 字符兜底截断。
- [x] **agent 会话内 AgentOS MCP 未接上**：新增 AgentOS MCP server（stdio，`packages/runner/src/mcp-server.ts`），暴露 task_activity_log / task_output / task_status / inbox_ask；claude 走 `--mcp-config --strict-mcp-config`，codex 走 `-c mcp_servers.agentos.*`（其 MCP 子进程环境被清洗，凭据改走工作区 0600 文件），pi 无 MCP 客户端故以扩展形式注入同一批工具。三家 CLI 均已实测能列出并调用，且实测写入线上库。

### 本批未做（继续挂账）

- **一链一 PR 的历史链**：修复只对新建链生效（后续步骤的 run 继承链共享分支）；试点那条已开 7 个 PR 的链不会被回收合并。
- **闸门产物预览的富渲染**：目前是纯文本截断塞进卡片正文，没有折叠/展开或独立 Markdown 块。
- **失败 run 的 WIP 分支回收**：保底推送只写 `agentos/<taskId>/run-N`，没有清理策略，远端会逐渐积累 WIP 分支。

## 已修（本轮，无需再做）

- run 执行环境缺 USER/LOGNAME（env 构造器已统一，commit 7374530）。
- 产物存原始 stream-json 转录（三家 CLI 终态事件提取 finalOutput）。
- 未匹配飞书事件随事务回滚丢失（事务外补记落库）。
- 电路告警无 thread 永远 pending（挂 FEISHU_DEFAULT_CHAT_ID 线程）。
- FEISHU_DEFAULT_CHAT_ID 已配置（.env + api plist），出站通道实测通。
- 一链一 PR：模板链后续步骤的 run 继承链共享特性分支，交付时复用该 head 上的 open PR（`gh pr list --state open`），新开 PR 标题用链名而非步骤名。
- 失败 run 成果保底：工作区有新 commit 的失败 run 在清理前把 `agentos/<taskId>/run-N` 推到 remote（不开 PR），保底推送失败不会盖住真实失败原因。
