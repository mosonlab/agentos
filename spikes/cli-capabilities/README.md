# 三 CLI adapter 能力 spike

实验日期：2026-08-15。对应 `DECISIONS.md` #10 重排后的第①步，并针对架构评审 findings #7、#13、#14 取证。

## 实验口径

- CLI 版本：Claude Code `2.1.227`、Codex CLI `0.147.0`、Pi `0.84.2`。
- 样本保留 CLI 原始输出；唯一例外是 `claude-auth-status.stdout` 中的 email/org 标识已脱敏，认证类型与订阅类型原样保留。
- 模型任务全部在本目录下新建的临时工作目录中执行，stdin 连接 `/dev/null`，单次硬超时不超过 120 秒；取证器见 [`run_capture.py`](run_capture.py)。每个证据前缀有 `.stdout`、`.stderr`、`.meta.json`（命令、cwd、耗时、超时、退出码）。
- Claude 成功调用使用本机 Claude Max 登录态，并带 `--dangerously-skip-permissions`；Codex 使用本机 ChatGPT 登录态；Pi 使用已有 `openai-codex` OAuth 与 `gpt-5.6-luna`。Pi 的本机默认 DeepSeek 配置实际指向 `api.deepseek.com/v1` 且带按 token 单价，因此按实验禁令没有调用该模型；相关 preflight 只检查凭据，失败的 Pi 启动发生在发模型请求前。
- 为允许 Codex/Pi 在本次受限执行环境中写 session，凭据只被临时复制到 `/private/tmp` 的 `0700` 目录，未写入仓库，实验后删除。Claude OAuth 登录态不能迁移到临时 `CLAUDE_CONFIG_DIR`；原 `~/.claude` 在本次执行环境中只读，因此 Claude 的 session persistence/resume 结果带环境限制，不能据此判定产品不支持 resume。
- “实测”只代表上述版本与 2026-08-15 的本机登录态；CLI 升级后必须重跑 smoke test。

## 能力矩阵

| 能力项 | Claude | Codex | Pi |
|---|---|---|---|
| 命令与版本 | `claude --version` → `2.1.227 (Claude Code)`，退出 0。[stdout](samples/claude-version.stdout) / [meta](samples/claude-version.meta.json) | `codex --version` → `codex-cli 0.147.0`，退出 0（另有不可写 PATH alias warning）。[stdout](samples/codex-version.stdout) / [stderr](samples/codex-version.stderr) / [meta](samples/codex-version.meta.json) | `pi --version` → `0.84.2`，退出 0。[stdout](samples/pi-version.stdout) / [meta](samples/pi-version.meta.json) |
| 登录身份 / preflight | `claude auth status` 输出 JSON：`loggedIn=true`、`authMethod=claude.ai`、`subscriptionType=max`，并含 email/org；持久化时应散列或脱敏账号。[stdout](samples/claude-auth-status.stdout) / [meta](samples/claude-auth-status.meta.json) | `codex login status`，stderr 为 `Logged in using ChatGPT`，退出 0；不提供账号 ID。[stderr](samples/codex-login-status-isolated.stderr) / [meta](samples/codex-login-status-isolated.meta.json) | 无通用 `auth status`；用 `pi auth check --provider openai-codex`，stdout `ready`、退出 0，不提供账号 ID。[stdout](samples/pi-auth-check-openai-codex.stdout) / [meta](samples/pi-auth-check-openai-codex.meta.json) |
| 最小非交互形态 | `claude -p --dangerously-skip-permissions "prompt"`；结构化实测另加 `--safe-mode --output-format stream-json --verbose --tools=""`，结果 `2`、退出 0。[stdout](samples/claude-start-safe-mode.stdout) / [meta](samples/claude-start-safe-mode.meta.json) | `codex exec "prompt"`；临时非 Git 目录需 `--skip-git-repo-check`。实测加 `--sandbox read-only --json`，结果 `2`、退出 0。[stdout](samples/codex-start-isolated.stdout) / [meta](samples/codex-start-isolated.meta.json) | `pi -p "prompt"`；订阅路由必须显式 `--model openai-codex/gpt-5.6-luna`，实测加 `--mode json --no-tools` 等隔离 flags，结果 `2`、退出 0。[stdout](samples/pi-start-openai-codex.stdout) / [meta](samples/pi-start-openai-codex.meta.json) |
| JSON 事件流 | `--output-format stream-json --verbose`，JSONL。首尾核心事件：`system/init`、`assistant`、`user(tool_result)`、`result`；可选 `--include-partial-messages`、`--include-hook-events`（本次未开）。[help](samples/claude-help.stdout) / [样本](samples/claude-tool-event.stdout) | `--json`，JSONL。核心事件：`thread.started`、`turn.started`、`item.started/completed`、`turn.completed`、`error`。[help](samples/codex-exec-help.stdout) / [样本](samples/codex-tool-event-bypass.stdout) | `--mode json`，JSONL（另有更适合双向控制的 `--mode rpc`，本次未测）。核心事件最细：`session`、agent/turn/message 生命周期、`message_update`、tool execution 生命周期、`agent_settled`。[help](samples/pi-help.stdout) / [样本](samples/pi-tool-event.stdout) |
| session ID 来源 | 首个 `system`/`init.session_id`；终态 `result.session_id` 也重复提供。[样本](samples/claude-start-safe-mode.stdout) | 首个 `thread.started.thread_id`。[样本](samples/codex-start-isolated.stdout) | 首个 `session.id`；同时写入 session JSONL 文件名。[输出](samples/pi-start-openai-codex.stdout) / [官方 session 格式](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md) |
| 恢复命令 | `claude -p ... -r <session_id> "new input"`；帮助还支持 `--fork-session`。本环境普通完成、SIGTERM、SIGKILL 三次恢复均因只读 `~/.claude` 未落盘而报 `No conversation found`，故标 **产品支持、当前沙箱未证实**。[help](samples/claude-help.stdout) / [普通恢复失败](samples/claude-resume.stdout) / [TERM 后](samples/claude-resume-after-sigterm.stdout) / [KILL 后](samples/claude-resume-after-sigkill.stdout) / [官方 CLI reference](https://code.claude.com/docs/en/cli-usage) | `codex exec resume <thread_id> "new input"`（或 `--last`）。普通恢复把上轮 `2` 加为 `3`；TERM/KILL 后均成功输出 `resumed`，thread ID 不变。[help](samples/codex-resume-help.stdout) / [普通](samples/codex-resume.stdout) / [TERM 后](samples/codex-resume-after-sigterm.stdout) / [KILL 后](samples/codex-resume-after-sigkill.stdout) | `pi -p --session <id|path> "new input"`，配合同一个 `--session-dir`。普通恢复把 `2` 加为 `3`；TERM/KILL 后均成功输出 `resumed`，session ID 不变。[help](samples/pi-help.stdout) / [普通](samples/pi-resume.stdout) / [TERM 后](samples/pi-resume-after-sigterm.stdout) / [KILL 后](samples/pi-resume-after-sigkill.stdout) |
| viewer：tool start | `assistant.message.content[].type=tool_use`，含 tool id/name/input。[样本](samples/claude-tool-event.stdout) | `item.started` 且 `item.type=command_execution`，含 item id/command/status。[样本](samples/codex-tool-event-bypass.stdout) | 先有 `message_update.assistantMessageEvent.type=toolcall_end`（完整参数），随后明确 `tool_execution_start`，含 toolCallId/name/args。[样本](samples/pi-tool-event.stdout) |
| viewer：tool output/end | `user.message.content[].type=tool_result`，并有 `tool_use_result.stdout/stderr/interrupted`。[样本](samples/claude-tool-event.stdout) | `item.completed` + `command_execution`，含聚合输出、exit_code、status。[样本](samples/codex-tool-event-bypass.stdout) | `tool_execution_update` 可带 partialResult；`tool_execution_end` 含 result/isError；另有 toolResult message。[样本](samples/pi-tool-event.stdout) |
| 可用于停滞检测的事件 | tool start/end、assistant/result、`rate_limit_event` 都算“有进展”；没有独立周期心跳。工具处于 in-flight 时不能按“无文本”判死，需进程活性 + tool deadline。[tool 样本](samples/claude-tool-event.stdout) | `item.started/completed`、`turn.*` 算“有进展”；没有独立周期心跳。命令长时间无输出时 JSON 可沉默，需进程活性 + tool deadline。[tool 样本](samples/codex-tool-event-bypass.stdout) | `message_update`、`tool_execution_start/update/end`、turn/agent 生命周期均可推进 event heartbeat；静默工具仍可能只有 start/end，需进程活性 + tool deadline。[tool 样本](samples/pi-tool-event.stdout) |
| 成功判定 | 必须同时满足：进程退出 0、末条 `type=result`、`is_error=false`、`terminal_reason=completed`。不能信 `subtype=success`，认证失败样本也出现该 subtype。[成功](samples/claude-start-safe-mode.stdout) / [认证失败](samples/claude-start-isolated.stdout) | 必须收到 `turn.completed` 且无顶层/item `error`；再结合退出码。只看退出 0 会误判 SIGTERM 或 401。[成功](samples/codex-start-isolated.stdout) / [SIGTERM](samples/codex-sigterm.stdout) / [401](samples/codex-auth-failure.stdout) | 必须收到成功 assistant `message_end/turn_end` 与 `agent_end.willRetry=false`，最好再等 `agent_settled`，且退出 0；首条 `session` 不是成功信号。[成功](samples/pi-start-openai-codex.stdout) / [认证失败](samples/pi-auth-failure.stdout) |
| SIGTERM | 在 Bash `sleep 60` 期间杀整组：CLI 发出 interrupted/error result，进程退出 **143**。[stdout](samples/claude-sigterm.stdout) / [meta](samples/claude-sigterm.meta.json) | 在 `command_execution in_progress` 时杀整组：JSON 无 terminal event，但进程退出竟为 **0**；必须由 runner 自己记录 terminationReason，绝不能按退出码报成功。[stdout](samples/codex-sigterm.stdout) / [meta](samples/codex-sigterm.meta.json) | 在 `tool_execution_start` 后杀整组：进程退出 **143**，无正常 terminal event。[stdout](samples/pi-sigterm.stdout) / [meta](samples/pi-sigterm.meta.json) |
| SIGKILL | 立即停止，无 terminal event，Python `returncode=-9`。[stdout](samples/claude-sigkill.stdout) / [meta](samples/claude-sigkill.meta.json) | 立即停止，停在 command in-progress，无 terminal event，`returncode=-9`。[stdout](samples/codex-sigkill.stdout) / [meta](samples/codex-sigkill.meta.json) | 立即停止，停在 tool in-progress，无 terminal event，`returncode=-9`。[stdout](samples/pi-sigkill.stdout) / [meta](samples/pi-sigkill.meta.json) |
| 认证失效分类 | **实测**：隔离 config 无登录态时退出 1；JSON assistant 含 `error=authentication_failed`，result `is_error=true`、`terminal_reason=api_error`；stderr 可为空。`claude auth status` 也应先拦截。[stdout](samples/claude-start-isolated.stdout) / [meta](samples/claude-start-isolated.meta.json) | **实测**：空 CODEX_HOME 得到 JSON `type=error` / HTTP 401，自动多次重连和 transport fallback；30 秒超时 SIGTERM 后退出却为 0。看到 401/Missing authentication 必须立即归 `AUTH_REQUIRED`、熔断且不重试。[stdout](samples/codex-auth-failure.stdout) / [stderr](samples/codex-auth-failure.stderr) / [meta](samples/codex-auth-failure.meta.json) | **实测**：空 agent dir 时 stderr `No API key found for openai-codex`，退出 1；stdout 仍先发 `session`。[stderr](samples/pi-auth-failure.stderr) / [meta](samples/pi-auth-failure.meta.json) |
| 额度 / 限流分类 | **未实测耗尽**。成功流会发 `rate_limit_event`（本次为 `status=allowed`，含 resetsAt/type）；若 status 非 allowed 或 API error 为 429，应归 `RATE_LIMITED` 并使用 reset/retry-after。[样本](samples/claude-start-safe-mode.stdout) | **未实测耗尽**。官方只确认订阅存在 plan usage limit，未承诺稳定 CLI exit code；adapter 应解析结构化 `error` 中的 429/usage-limit 文本并保留原事件，不能只看退出码。[官方说明](https://help.openai.com/en/articles/11369540-codex-and-chatgpt-plan-usage-limits) | **未实测耗尽**，本版 `--help` 无稳定限流错误契约。adapter 应从 message/agent error、HTTP 429、retry-after 与 stderr 归类，未知格式先 `TRANSIENT_PROVIDER` 并熔断，不能盲重试。[help](samples/pi-help.stdout) |
| 命令不存在 | OS 层 stderr `env: claude: No such file or directory`、退出 **127**。[stderr](samples/claude-command-not-found.stderr) / [meta](samples/claude-command-not-found.meta.json) | 同上，退出 **127**。[stderr](samples/codex-command-not-found.stderr) / [meta](samples/codex-command-not-found.meta.json) | 同上，退出 **127**。[stderr](samples/pi-command-not-found.stderr) / [meta](samples/pi-command-not-found.meta.json) |
| session 目录可写性 | 必须能写 `~/.claude`（或同一已登录且可写的配置根）。本环境只读时能完成模型调用但不能 resume；自定义空 config 则失去 OAuth。最初 hooks 还直接报 session-env `EPERM`。[初始失败](samples/claude-start.stdout) | `CODEX_HOME` 必须可写；原 home 只读时 app-server 初始化 `EPERM`，复制 auth/config 到可写临时 home 后成功。[初始失败](samples/codex-start.stderr) / [成功](samples/codex-start-isolated.meta.json) | agent dir 的 settings/package cache 与 session dir都需可写；`--no-extensions` 仍可能先解析/安装 settings 中 packages，因此 runner 应使用净化 settings；显式 `--session-dir` 可把会话放入 attempt 目录。[初始失败](samples/pi-start-isolated.stderr) / [成功](samples/pi-start-openai-codex.meta.json) |

## 统一 SessionEvent 建议

不要把原始 JSON 塞回同一 Session 行。逐行解析后 append-only 写入 `SessionEvent(seq, attemptId, at, source, type, providerEventId, toolCallId, payload)`，并至少归一化为：

- `PROCESS_STARTED | PROCESS_ALIVE | PROCESS_EXITED`
- `MODEL_STARTED | MODEL_DELTA | MODEL_COMPLETED | PROVIDER_STATUS`
- `TOOL_STARTED | TOOL_PROGRESS | TOOL_COMPLETED`
- `FINAL_OUTPUT | ADAPTER_ERROR`

`heartbeat` 返回两个时间：`lastProcessAliveAt`（runner 通过 PID/process group 探测产生）与 `lastProgressEventAt`（模型/tool 结构化事件产生），外加当前 `inFlightTool {id,name,startedAt,lastProgressAt}`。停滞规则应为：进程不活跃立即失败；进程活跃且无 in-flight tool 时按模型 idle deadline；有 in-flight tool 时按 per-tool deadline，而不是统一“10 分钟无 stdout”。

## 执行内核 adapter 接口建议

题目列出的名称实际是五个；为覆盖 finding #14 的无人值守启动风险，协议应明确为以下六个方法：

```ts
interface CliAdapter {
  preflight(spec: RunSpec): Promise<PreflightResult>;
  start(spec: RunSpec, sink: SessionEventSink): Promise<RuntimeHandle>;
  resume(spec: ResumeSpec, sink: SessionEventSink): Promise<RuntimeHandle>;
  kill(handle: RuntimeHandle, reason: TerminationReason): Promise<KillResult>;
  heartbeat(handle: RuntimeHandle): Promise<HeartbeatSnapshot>;
  classifyError(evidence: ExitEvidence): ClassifiedFailure;
}
```

### `preflight`

- 共通：解析绝对 binary path，执行 `--version`，验证工作目录/session 目录可写，关闭 stdin，快照 `adapterVersion/cliVersion/model/authMode/manifest/promptHash`；版本或 capability 不满足即不路由。
- Claude：`claude auth status` 必须 `loggedIn=true` 且期望 `subscriptionType=max`；检查 config/session 根可写。账号只存哈希。
- Codex：`codex login status` 必须退出 0 且显示 ChatGPT；`CODEX_HOME` 可写。不能把 `login status` 缺少账号 ID 当成匿名 API key。
- Pi：对**显式 provider/model**执行 `pi auth check --provider ...`，并拒绝自定义 `models.json` 中带按 token API endpoint 的 provider，除非未来策略明确允许。禁止依赖可漂移的 defaultProvider；净化 `packages/skills/extensions`。

### `start`

- Claude：`claude -p --dangerously-skip-permissions --output-format stream-json --verbose ... <prompt>`；首个 `system.init.session_id` 写入 `providerConversationId`。
- Codex：`codex exec --json ... <prompt>`；首个 `thread.started.thread_id` 写入 `providerConversationId`。外层已有 OS 隔离时可按策略使用 `--dangerously-bypass-approvals-and-sandbox`，否则保留 Codex sandbox；两种 manifest 必须快照。
- Pi：`pi -p --mode json --session-dir <attempt-session-dir> --model <explicit-provider/model> ... <prompt>`；首个 `session.id` 写入 `providerConversationId`，同时记录 session file 路径。

所有 adapter 必须逐行即时落原始事件，再产出归一化事件；只有收到各自 terminal-success event 且退出证据一致时才完成 attempt。

### `resume`

- Claude：`claude -p ... --resume <session_id> <new-input>`；session 存储必须与原登录 config 同根且可写。当前需在真正的 `agentrunner` 用户环境再补验 SIGTERM/SIGKILL resume，作为 v1 blocker。
- Codex：`codex exec resume --json <thread_id> <new-input>`；已实测普通、TERM 后、KILL 后恢复。
- Pi：`pi -p --mode json --session-dir <same-dir> --session <id> <new-input>`；必须绑定原 attempt 的 session 文件，不能用模糊 `--continue`；已实测普通、TERM 后、KILL 后恢复。

Inbox 回复创建新的 resume attempt，复用 provider conversation ID，但获得新的 fencing token/runtime handle；重复回复由 Inbox dedupe 保证只生成一个 attempt。

### `kill`

统一对 attempt 的独立 process group：先记录 `terminationReason` 和 fencing 失效，再 SIGTERM，最多等 5 秒，仍活则 SIGKILL；最后确认整组不存在。退出码只作证据，不作业务成功判定。特别是 Codex SIGTERM 可能返回 0。

### `heartbeat`

adapter 解析上述结构化映射；runner 另行每数秒检测 PID/process group，并 append `PROCESS_ALIVE`（可降采样）。任何 tool start 都开启 tool-specific deadline，tool end 才关闭。Pi 的 `tool_execution_update` 可刷新 tool progress；Claude/Codex 对静默工具通常只有 start/end。

### `classifyError`

按优先级组合 `runnerTerminationReason > terminal event > structured error/status > signal > exit code > stderr regex`，返回稳定枚举与 `retryable/retryAt/operatorAction`：

| 统一分类 | 识别要点 | 默认策略 |
|---|---|---|
| `BINARY_NOT_FOUND` | spawn/`env` 127、ENOENT | 不重试；通知安装/修 PATH |
| `AUTH_REQUIRED` | Claude `authentication_failed`；Codex 401/Missing authentication；Pi `No API key found` | 熔断该 backend，不消耗三次 task retry；通知登录 |
| `RATE_LIMITED` | provider 429、明确 usage/rate-limit event，保存 retry-after/reset | 到点后退避重试；backend 级熔断 |
| `CANCELLED_OR_TIMED_OUT` | runner 已记录 TERM/KILL；Claude/Pi 143；任一 -9；Codex 即使 0 也以 runner 原因为准 | 仅按调度策略 resume/retry |
| `TOOL_FAILED` | 结构化 tool end `isError` / nonzero tool exit | 交给模型处理时不结束 attempt；若终态则按任务策略 |
| `TRANSIENT_PROVIDER` | 5xx、网络断开、provider outage | 指数退避；计入 backend 健康度 |
| `PROTOCOL_ERROR` | EOF 前无 terminal event、坏 JSON、退出 0 但状态不完整 | 不报成功；短退避并报警版本漂移 |
| `COMPLETED` | terminal-success event + 无错误 + runner 未杀 + 合法退出 | 完成 attempt |

## 尚未关闭的风险

1. Claude resume 必须在真实 `agentrunner` 可写 home 中重跑“普通 / TERM / KILL 后恢复”；本 spike 只证实命令语法和 session ID 来源，未证实持久化链路。
2. 三者的订阅额度耗尽错误都未安全实测。上线前应在自然触发时捕获并固化 golden sample；此前按 429/结构化 status/文本多信号分类。
3. 这只是短任务能力 spike，不是 finding #14 所要求的 2h SLO。下一步执行内核仍需连续 2h smoke、登录过期演练、CLI 自动升级漂移检测和 backend 熔断。
