## Blocker

### 1. 裸跑 yolo 使 ACL、Secret 隔离和审批门同时失去安全意义

- 严重度：blocker
- 位置：[DECISIONS.md：Runner/文件/Secret 决策](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:11)、[BLUEPRINT.md §5](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:325)、[runner adapter](/Users/leohe/Documents/claude_projects/agentos/packages/runner/src/adapters.ts:35)、[API 鉴权](/Users/leohe/Documents/claude_projects/agentos/packages/api/src/app.ts:97)
- 失败场景：CLI 获得宿主 shell，能直接读取 Mac 上未授权目录、绕过 filesystem MCP、访问任意网络。当前子进程直接继承 `process.env`，其中可能包含 `AGENTOS_API_TOKEN`；API 又使用同一个全局 bearer token 区分不了人、runner 和 agent，因此 gated task 可以绕过“agent token 不得标 done”的设想。统一 Secret 库还把一次泄露的爆炸半径扩至全部项目。
- 最小修正：在 Phase 3 前增加执行边界：每 session 独立容器或至少专用低权限 OS 用户、临时工作区、显式环境白名单、网络限制。子进程只得到 session-scoped token；operator、runner、agent 三种 principal 必须分开。API 层审批仍可保留，但不能把 operator token 注入 agent。

### 2. Lease 过期会产生双执行，当前协议只有“重试”没有 fencing

- 严重度：blocker
- 位置：[README claim/lease](/Users/leohe/Documents/claude_projects/agentos/README.md:3)、[Session lease 字段](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:472)、[过期回收实现](/Users/leohe/Documents/claude_projects/agentos/packages/api/src/app.ts:222)
- 失败场景：runner 因 API/网络短断停止心跳，但 CLI 仍在写代码或 push；另一 runner 将旧 session 标失败、把任务退回 Todo 并重新执行。旧进程并不会被杀死，于是两个进程在同一工作目录修改、commit、发消息。旧 attempt 最终收到 409 也无法撤销外部副作用。
- 最小修正：引入独立 `Job/ExecutionAttempt`、单调递增 `leaseGeneration/fencingToken`；所有状态写和可控副作用携带 fencing token。heartbeat 失败后 runner 必须终止整棵进程组。增加“一任务最多一个 active attempt”的数据库约束，并把 push/通知/后继生成做成幂等操作。

### 3. Task 被同时当作业务卡片和持久队列，Phase 3/4 没有可靠调度内核

- 严重度：blocker
- 位置：[BLUEPRINT durable job runner](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:126)、[Task 模型](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:354)、[Phase 3/4](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:1095)
- 失败场景：九张卡都处于 Todo，但 Todo 本身不能表达“尚未到点”“前置未完成”“等待审批”“等待重试”。服务在“完成 step N”和“创建/唤醒 step N+1”之间崩溃会丢任务；重复处理完成事件又会生成两个后继。Goal 的“session 结束后再 spawn”也有同样的 crash window。
- 最小修正：保留四列 Kanban 作为业务状态，另外增加 durable `WorkItem/Job` 与 `ExecutionAttempt`：`readyAt`、`blockedBy`、`dedupeKey`、attempt、lease、terminal reason。任务状态变更与 enqueue/outbox 必须在同一事务提交。

### 4. 复用现有 `workingDirectory` 违背 clean-session，并且无法可靠交接分支/提交

- 严重度：blocker
- 位置：[README working directory](/Users/leohe/Documents/claude_projects/agentos/README.md:34)、[Task.workingDirectory](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:362)、[BLUEPRINT session cleanup](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:104)
- 失败场景：失败 session 留下脏文件；重试把旧半成品当新输入；两个任务或 lease 双执行修改同一目录。九步链只有 Session 的 `commitShas[]`，没有 repo、branch、base SHA、push 状态，后续 agent 不知道应从哪个确定版本开始。
- 最小修正：每 attempt 创建临时 clone/worktree，记录 repo、branch、base/head SHA、remote push 状态和清理结果；后继通过显式 artifact/ref 交接。结束时删除工作区，不能把用户现有仓库路径作为 runtime 根目录。

### 5. “Inbox 回复恢复同一 session”尚无可执行协议

- 严重度：blocker
- 位置：[BLUEPRINT §6/§12](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:343)、[Session](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:472)、[InboxMessage](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:505)、[当前 stdin 生命周期](/Users/leohe/Documents/claude_projects/agentos/packages/runner/src/adapters.ts:49)
- 失败场景：当前 prompt 写完即关闭 stdin；`runtimeHandle` 是合成字符串，没有捕获 provider conversation ID。若 agent 发问后退出，回复无从恢复；若保持进程等待，lease、2h timeout、Mac 重启又会终止它。Phase 3 的 spec refine 和 Phase 4 的 goal 决策因此不能满足 blueprint 验收。
- 最小修正：先明确统一语义：`WAITING_INBOX` 是“挂起并释放 worker，回复后用 provider session ID 重启恢复”，而不是无限保活进程。增加 `providerConversationId`、`waitingOnMessageId`、`resumableUntil`、resume attempt；每个 CLI adapter 必须通过实测证明 resume、重复回复幂等和进程重启恢复。

## Major

### 6. Session 状态把执行结果和清理结果混成一个维度

- 严重度：major
- 位置：[SessionStatus](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:89)
- 失败场景：`DESTROYED` 同时被当作成功终态，但“工作成功、清理失败”和“工作失败、清理成功”无法表达；也没有 queued、provisioning、timed-out、cancelled、lost。
- 最小修正：拆成 `executionStatus` 与 `cleanupStatus`，增加 `exitCode/signal/terminationReason` 和状态时间戳；`destroyed` 只描述资源清理。

### 7. stdout/stderr 不能支撑 tool-call viewer 或 10 分钟停滞检测

- 严重度：major
- 位置：[DECISIONS 护栏](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:19)、[Session.toolCallLog](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:483)、[runner 默认命令](/Users/leohe/Documents/claude_projects/agentos/packages/runner/src/config.ts:20)
- 失败场景：当前 Claude、Codex、Pi 都用文本输出，chunk 不等于 tool event；长测试可能十多分钟无输出，被误杀，stdout 缓冲又可能把活跃任务判停滞。`Json[]` 持续追加还会反复重写同一 Session 行。
- 最小修正：各 adapter 启用结构化模式并归一化成 append-only `SessionEvent(seq,type,payload,at)`；分开记录 process heartbeat、model event、tool start/end、stdout。停滞判定使用进程活性和未完成 tool，而非“十分钟无新文本”。

### 8. 九步模板缺少 fan-out/join 和精确 artifact binding

- 严重度：major
- 位置：[模板第 3/4 步](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:583)、[TaskTemplateStep](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:336)、[Task self-chain](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:354)
- 失败场景：review coordinator 要并发派四个 reviewer 再汇总，但 Task 没有 parent/root/join 关系；`followUpTaskId` 与 `chainId/index` 是两套可能互相矛盾的拓扑。`attachmentsFromPrevious` 只表达“上一节点”，却无法表示 step 4 同时读取 step 2 的计划和 step 3 的评审。
- 最小修正：增加 `WorkflowRun/StepRun/Dependency`，支持 fan-out/join；输入用 `inputBindings` 指向具体 step 的具名输出。实例化时快照模板版本和变量，不再依赖可变模板。

### 9. 审批只保存一个布尔门，没有保存“批准了什么”

- 严重度：major
- 位置：[approvalGate](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:366)、[BLUEPRINT gates](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:556)
- 失败场景：人把 spec task 标 Done 后，附件或正文仍可修改；后继实际消费的内容可能不是人审过的版本。也无法审计批准人、时间、artifact hash 或撤销。
- 最小修正：增加 `ApprovalDecision`，绑定 task、artifact revision/hash、actor、时间和 decision；审批后修改输入必须自动失效并重新审批。所有 API/MCP/runner 更新走同一个策略函数。

### 10. Goal 模型不足以实现 DoD 审批、证据和 stuck-at-N

- 严重度：major
- 位置：[Goal](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:417)、[GoalDefinitionItem](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:445)、[Goal loop](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:599)
- 失败场景：`done` 只有布尔值，没有 evidence、判定 session、判定人/模型；DoD 在 `dodApproved=true` 后仍可编辑而不失效。stuck 判定要求比较“同 specialist + 同 unresolved DoD + 无进展”，当前没有 iteration/decision/fingerprint，无法可靠计数。
- 最小修正：增加 DoD revision + approval record，以及 `GoalIteration/OrchestratorDecision`：chosenAgent、unresolvedDoDHash、progressHash、evidence、stopReason。`maxSessionsPerTask` 在 Goal 上应改为明确的 `maxIterations/maxSessions`。

### 11. Inbox 缺少 thread、reply 和外部投递幂等模型

- 严重度：major
- 位置：[InboxMessage](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:505)
- 失败场景：一个 session 同时有两个 open question 时，人类消息没有 `replyToId`，无法确定回答哪个；飞书重推事件会重复 resume。也没有 external message/card/action ID、delivery 状态、失败重试和 dedupe key。
- 最小修正：增加 `InboxThread`、`replyToMessageId`、channel、external IDs、delivery status、dedupe key；回答某个 question 与创建 resume job 放在同一事务。

### 12. 飞书“长连接 + 卡片按钮免公网”仍是未证实假设

- 严重度：major（疑问）
- 位置：[DECISIONS 收件箱](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:20)
- 失败场景：飞书官方 SDK 的长连接章节明确写“仅支持事件订阅，不支持回调订阅”，但较新的 Channel 文档又声称默认 WebSocket 支持 `cardAction`，两份官方材料存在矛盾。[官方 SDK README](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)、[Channel 文档](https://github.com/larksuite/node-sdk/blob/main/docs/channel.zh.md)。如果按钮仍属于 callback subscription，v1 多选按钮需要公网 callback，当前“免公网”定案失效。
- 最小修正：Phase 1 做真实自建应用 spike：文本消息、按钮点击、断线重连、重复推送、3 秒 ack 全跑通。失败时最小降级为“长连接收文本编号回复”；或提前启用 Cloudflare Tunnel 接卡片 callback。

### 13. 三 CLI 被抽象成同一种 runner，但能力和失败语义没有建模

- 严重度：major
- 位置：[RunnerKind/Preference](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:32)、[BLUEPRINT Runner interface](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:692)
- 失败场景：本机当前 Claude、Codex、Pi 均支持某种非交互和恢复，但 JSON 事件、MCP 注入、session ID、预算、取消、退出码含义不同。Agent 配置更新或 CLI 自动升级后，历史 Session 无法回答“当时到底用了哪个版本、manifest、模型、权限”。
- 最小修正：建立 adapter capability matrix；Session 快照 `adapterVersion/cliVersion/model/authMode/manifest/promptHash`。路由只能选择满足 `structuredEvents/resume/MCP` 等能力的 backend。

### 14. 订阅版 CLI 无人值守长跑的稳定性没有 SLO

- 严重度：major（疑问）
- 位置：[DECISIONS runner 名册](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:12)
- 失败场景：登录过期、订阅额度限流、CLI 更新、交互式提示或 provider outage 都可能被统称为普通 exit failure，然后盲目重试三次。现有资料不能证明订阅登录态对数小时无人值守构成稳定接口。
- 最小修正：不要先假设稳定；加入启动 preflight、auth/limit/update 错误分类、指数退避、熔断、人工通知和 adapter smoke test。对每个 CLI 连续跑一个 2h 玩具任务再决定是否满足 v1。

### 15. 单 Mac + 本机 Postgres 缺少无人值守运行的运维闭环

- 严重度：major
- 位置：[DECISIONS 单机](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:9)、[README 启动方式](/Users/leohe/Documents/claude_projects/agentos/README.md:14)
- 失败场景：Mac 睡眠、重启、Docker Desktop 更新或磁盘满后，API、DB、runner、飞书长连接以不同顺序恢复；旧 lease、半写日志、未清理工作区无人 reconcile。
- 最小修正：使用 launchd/等价 supervisor、自启动顺序、健康检查、磁盘阈值、每日加密备份，并在 control plane 启动时执行 orphan attempt/workspace reconciliation。个人系统不需要 HA，但必须可恢复。

### 16. 本地文件系统 MCP 的 ACL 会遭遇 symlink、大小写和路径别名绕过

- 严重度：major
- 位置：[DECISIONS 文件存储](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:15)、[FilesystemGrant](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:259)、[FileObject](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:572)
- 失败场景：字符串前缀检查通过 `/allowed/link/secret`，但 symlink 指向授权根外；macOS 默认大小写不敏感又会产生路径别名。裸 shell 还可以完全绕过 MCP。
- 最小修正：ACL 保存 root ID + 规范化相对路径；访问时 realpath/openat 校验并拒绝 symlink escape。文件根目录不得直接暴露给 agent 宿主进程。

### 17. Secret 模型缺少轮换元数据，环境变量映射还会发生覆盖冲突

- 严重度：major
- 位置：[Secret/AgentSecretGrant/EnvironmentSecret](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:282)
- 失败场景：两个 grant 可把不同 secret 映射到同一 `envVar`，最终值取决于装配顺序；`encryptedValue` 没有 key ID、算法/版本、轮换和禁用状态，主密钥轮换或回滚困难。
- 最小修正：对作用域内 `envVar` 加唯一约束；记录 ciphertext version、key ID、rotatedAt、disabledAt。主加密密钥必须位于 DB 外。统一库可以保留，但默认 grant 仍应 deny。

### 18. 多个外键允许跨 Project 关系，项目边界只靠应用代码约定

- 严重度：major
- 位置：[Agent 及各 join table](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:138)、[Task/Session](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:354)
- 失败场景：Project A 的 Task 可以引用 Project B 的 Agent；Agent 可引用其他项目的 Environment、Skill、Repo、MCP。YAML 导入或 API bug 会生成跨项目 session，读取错误 repo/secret。
- 最小修正：为关系补 composite `(id, projectId)` 外键，或在单一事务内集中验证并加数据库测试。单用户不消除项目级最小权限需求。

### 19. v1 禁用 spend cap 与 blueprint 的 Goal 验收直接冲突

- 严重度：major
- 位置：[DECISIONS 护栏](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:19)、[BLUEPRINT Goal rails](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:622)
- 失败场景：Phase 4 验收要求 `spendCap=0` 不 spawn；定案却只留字段不执行。即使订阅没有逐 token 现金账单，无限循环仍会消耗订阅额度、机器时间并阻塞其他任务。
- 最小修正：把护栏抽象成通用 budget：美元、session/iteration 数、wall time、provider quota 至少一种必须生效。订阅 runner 可将美元 cap 标为“不适用”，但不能让 budget engine 空转。

## Minor

### 20. Schedule 字段没有交叉约束和 occurrence 记录

- 严重度：minor
- 位置：[Task schedule](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:369)
- 失败场景：可保存 `CRON` 但 cron/timezone 为空，或 `NOW` 同时带 runAt；重复 scheduler tick 无法识别同一 occurrence。
- 最小修正：增加校验约束和 `ScheduleOccurrence(dedupeKey, scheduledFor, status)`，并索引 `readyAt/nextRunAt`。

### 21. 文档的优先级口径自相矛盾

- 严重度：minor
- 位置：[DECISIONS 开头](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:3)、[README precedence](/Users/leohe/Documents/claude_projects/agentos/README.md:8)
- 失败场景：一边称 BLUEPRINT 是“设计唯一信源”，另一边又规定 DECISIONS 优先，且已有多项实质偏离；后续实现者无法判断 acceptance test 是否仍有效。
- 最小修正：明确“BLUEPRINT 为上游需求，DECISIONS 为本项目覆盖层”，每条偏离列出被替代的 blueprint 条款和新的验收标准。

### 22. 关系字段缺少一致性约束

- 严重度：minor
- 位置：[TaskTemplateStep](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:336)、[InboxMessage](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:505)、[Session](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:472)
- 失败场景：`assigneeType=AGENT` 但 agent 为空；Session 可同时关联 Task 和 Goal，或两者皆空；Inbox 可成为完全无上下文的 orphan。
- 最小修正：增加数据库 CHECK 或统一创建服务，强制 XOR 和 assignee 一致性。

## 建议的最小重排

不要现在直接进入模板：

1. 先做三 CLI adapter spike：结构化事件、resume、MCP、kill、auth failure。
2. 再完成执行内核：Job/Attempt、fencing、临时工作区、环境净化、session token。
3. 跑通 Inbox 文本/卡片和 crash-resume。
4. 然后做 Phase 3 workflow/fan-out/join。
5. 最后做 Phase 4 Goal iteration 与护栏。

## 哪些常见质疑其实不成立

- “单机就必须用 R2”不成立。本地文件系统对个人系统完全可行，前提是 agent 只能经 MCP 访问，并补好路径安全、备份和临时工作区。
- “claim/lease pull 本身不可靠”不成立。它是成熟模式；问题是当前缺 fencing、幂等和独立 attempt。
- “审批放 API 层一定不安全”不成立。所有写入口统一、principal 真正分离、agent 只持 session token 时，API 层正是合适的策略边界，不必强上数据库 trigger。
- “不保留云 runner 就必然设计错”不成立。Leo 已明确只用本地订阅；需要保留的是 adapter/capability seam，不是无用的云实现。
- “Postgres 和服务同机必然不可用”不成立。单用户系统不需要 HA；监督启动、备份、磁盘监控和启动 reconciliation 足够。
- “Task 必须增加十几个状态”不成立。Kanban 四态可以保持简洁；排队、等待、重试、lease 应放在 Job/Attempt，而不是污染业务卡片状态。
- “三套 CLI 无法自动化”不成立。本机版本都已提供非交互和某种 session 恢复能力；真正风险是协议不统一、版本漂移和订阅登录态没有无人值守 SLO。
- “飞书长连接不能做双向文本”不成立。收消息事件和调用发送 API 没问题；当前待证伪的只是卡片按钮 callback 能否完全免公网。
hook: Stop
hook: Stop
hook: Stop Completed
hook: Stop Completed
tokens used
160,915
结论：当前架构足以做出“单任务跑一次”的 demo，但还不具备 blueprint 所要求的“走开后可靠地产出 PR”。如果按现有顺序直接进入 Phase 3/4，最可能被迫返工的是 runner/lease、临时工作区、Inbox 恢复和 workflow/goal 状态模型，而不是 UI。

我以四份指定文件为主；为验证 README 的 claim/lease 描述，额外只读抽查了当前 API/runner 关键路径。未修改任何文件。

## Blocker

### 1. 裸跑 yolo 使 ACL、Secret 隔离和审批门同时失去安全意义

- 严重度：blocker
- 位置：[DECISIONS.md：Runner/文件/Secret 决策](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:11)、[BLUEPRINT.md §5](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:325)、[runner adapter](/Users/leohe/Documents/claude_projects/agentos/packages/runner/src/adapters.ts:35)、[API 鉴权](/Users/leohe/Documents/claude_projects/agentos/packages/api/src/app.ts:97)
- 失败场景：CLI 获得宿主 shell，能直接读取 Mac 上未授权目录、绕过 filesystem MCP、访问任意网络。当前子进程直接继承 `process.env`，其中可能包含 `AGENTOS_API_TOKEN`；API 又使用同一个全局 bearer token 区分不了人、runner 和 agent，因此 gated task 可以绕过“agent token 不得标 done”的设想。统一 Secret 库还把一次泄露的爆炸半径扩至全部项目。
- 最小修正：在 Phase 3 前增加执行边界：每 session 独立容器或至少专用低权限 OS 用户、临时工作区、显式环境白名单、网络限制。子进程只得到 session-scoped token；operator、runner、agent 三种 principal 必须分开。API 层审批仍可保留，但不能把 operator token 注入 agent。

### 2. Lease 过期会产生双执行，当前协议只有“重试”没有 fencing

- 严重度：blocker
- 位置：[README claim/lease](/Users/leohe/Documents/claude_projects/agentos/README.md:3)、[Session lease 字段](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:472)、[过期回收实现](/Users/leohe/Documents/claude_projects/agentos/packages/api/src/app.ts:222)
- 失败场景：runner 因 API/网络短断停止心跳，但 CLI 仍在写代码或 push；另一 runner 将旧 session 标失败、把任务退回 Todo 并重新执行。旧进程并不会被杀死，于是两个进程在同一工作目录修改、commit、发消息。旧 attempt 最终收到 409 也无法撤销外部副作用。
- 最小修正：引入独立 `Job/ExecutionAttempt`、单调递增 `leaseGeneration/fencingToken`；所有状态写和可控副作用携带 fencing token。heartbeat 失败后 runner 必须终止整棵进程组。增加“一任务最多一个 active attempt”的数据库约束，并把 push/通知/后继生成做成幂等操作。

### 3. Task 被同时当作业务卡片和持久队列，Phase 3/4 没有可靠调度内核

- 严重度：blocker
- 位置：[BLUEPRINT durable job runner](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:126)、[Task 模型](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:354)、[Phase 3/4](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:1095)
- 失败场景：九张卡都处于 Todo，但 Todo 本身不能表达“尚未到点”“前置未完成”“等待审批”“等待重试”。服务在“完成 step N”和“创建/唤醒 step N+1”之间崩溃会丢任务；重复处理完成事件又会生成两个后继。Goal 的“session 结束后再 spawn”也有同样的 crash window。
- 最小修正：保留四列 Kanban 作为业务状态，另外增加 durable `WorkItem/Job` 与 `ExecutionAttempt`：`readyAt`、`blockedBy`、`dedupeKey`、attempt、lease、terminal reason。任务状态变更与 enqueue/outbox 必须在同一事务提交。

### 4. 复用现有 `workingDirectory` 违背 clean-session，并且无法可靠交接分支/提交

- 严重度：blocker
- 位置：[README working directory](/Users/leohe/Documents/claude_projects/agentos/README.md:34)、[Task.workingDirectory](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:362)、[BLUEPRINT session cleanup](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:104)
- 失败场景：失败 session 留下脏文件；重试把旧半成品当新输入；两个任务或 lease 双执行修改同一目录。九步链只有 Session 的 `commitShas[]`，没有 repo、branch、base SHA、push 状态，后续 agent 不知道应从哪个确定版本开始。
- 最小修正：每 attempt 创建临时 clone/worktree，记录 repo、branch、base/head SHA、remote push 状态和清理结果；后继通过显式 artifact/ref 交接。结束时删除工作区，不能把用户现有仓库路径作为 runtime 根目录。

### 5. “Inbox 回复恢复同一 session”尚无可执行协议

- 严重度：blocker
- 位置：[BLUEPRINT §6/§12](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:343)、[Session](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:472)、[InboxMessage](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:505)、[当前 stdin 生命周期](/Users/leohe/Documents/claude_projects/agentos/packages/runner/src/adapters.ts:49)
- 失败场景：当前 prompt 写完即关闭 stdin；`runtimeHandle` 是合成字符串，没有捕获 provider conversation ID。若 agent 发问后退出，回复无从恢复；若保持进程等待，lease、2h timeout、Mac 重启又会终止它。Phase 3 的 spec refine 和 Phase 4 的 goal 决策因此不能满足 blueprint 验收。
- 最小修正：先明确统一语义：`WAITING_INBOX` 是“挂起并释放 worker，回复后用 provider session ID 重启恢复”，而不是无限保活进程。增加 `providerConversationId`、`waitingOnMessageId`、`resumableUntil`、resume attempt；每个 CLI adapter 必须通过实测证明 resume、重复回复幂等和进程重启恢复。

## Major

### 6. Session 状态把执行结果和清理结果混成一个维度

- 严重度：major
- 位置：[SessionStatus](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:89)
- 失败场景：`DESTROYED` 同时被当作成功终态，但“工作成功、清理失败”和“工作失败、清理成功”无法表达；也没有 queued、provisioning、timed-out、cancelled、lost。
- 最小修正：拆成 `executionStatus` 与 `cleanupStatus`，增加 `exitCode/signal/terminationReason` 和状态时间戳；`destroyed` 只描述资源清理。

### 7. stdout/stderr 不能支撑 tool-call viewer 或 10 分钟停滞检测

- 严重度：major
- 位置：[DECISIONS 护栏](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:19)、[Session.toolCallLog](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:483)、[runner 默认命令](/Users/leohe/Documents/claude_projects/agentos/packages/runner/src/config.ts:20)
- 失败场景：当前 Claude、Codex、Pi 都用文本输出，chunk 不等于 tool event；长测试可能十多分钟无输出，被误杀，stdout 缓冲又可能把活跃任务判停滞。`Json[]` 持续追加还会反复重写同一 Session 行。
- 最小修正：各 adapter 启用结构化模式并归一化成 append-only `SessionEvent(seq,type,payload,at)`；分开记录 process heartbeat、model event、tool start/end、stdout。停滞判定使用进程活性和未完成 tool，而非“十分钟无新文本”。

### 8. 九步模板缺少 fan-out/join 和精确 artifact binding

- 严重度：major
- 位置：[模板第 3/4 步](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:583)、[TaskTemplateStep](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:336)、[Task self-chain](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:354)
- 失败场景：review coordinator 要并发派四个 reviewer 再汇总，但 Task 没有 parent/root/join 关系；`followUpTaskId` 与 `chainId/index` 是两套可能互相矛盾的拓扑。`attachmentsFromPrevious` 只表达“上一节点”，却无法表示 step 4 同时读取 step 2 的计划和 step 3 的评审。
- 最小修正：增加 `WorkflowRun/StepRun/Dependency`，支持 fan-out/join；输入用 `inputBindings` 指向具体 step 的具名输出。实例化时快照模板版本和变量，不再依赖可变模板。

### 9. 审批只保存一个布尔门，没有保存“批准了什么”

- 严重度：major
- 位置：[approvalGate](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:366)、[BLUEPRINT gates](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:556)
- 失败场景：人把 spec task 标 Done 后，附件或正文仍可修改；后继实际消费的内容可能不是人审过的版本。也无法审计批准人、时间、artifact hash 或撤销。
- 最小修正：增加 `ApprovalDecision`，绑定 task、artifact revision/hash、actor、时间和 decision；审批后修改输入必须自动失效并重新审批。所有 API/MCP/runner 更新走同一个策略函数。

### 10. Goal 模型不足以实现 DoD 审批、证据和 stuck-at-N

- 严重度：major
- 位置：[Goal](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:417)、[GoalDefinitionItem](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:445)、[Goal loop](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:599)
- 失败场景：`done` 只有布尔值，没有 evidence、判定 session、判定人/模型；DoD 在 `dodApproved=true` 后仍可编辑而不失效。stuck 判定要求比较“同 specialist + 同 unresolved DoD + 无进展”，当前没有 iteration/decision/fingerprint，无法可靠计数。
- 最小修正：增加 DoD revision + approval record，以及 `GoalIteration/OrchestratorDecision`：chosenAgent、unresolvedDoDHash、progressHash、evidence、stopReason。`maxSessionsPerTask` 在 Goal 上应改为明确的 `maxIterations/maxSessions`。

### 11. Inbox 缺少 thread、reply 和外部投递幂等模型

- 严重度：major
- 位置：[InboxMessage](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:505)
- 失败场景：一个 session 同时有两个 open question 时，人类消息没有 `replyToId`，无法确定回答哪个；飞书重推事件会重复 resume。也没有 external message/card/action ID、delivery 状态、失败重试和 dedupe key。
- 最小修正：增加 `InboxThread`、`replyToMessageId`、channel、external IDs、delivery status、dedupe key；回答某个 question 与创建 resume job 放在同一事务。

### 12. 飞书“长连接 + 卡片按钮免公网”仍是未证实假设

- 严重度：major（疑问）
- 位置：[DECISIONS 收件箱](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:20)
- 失败场景：飞书官方 SDK 的长连接章节明确写“仅支持事件订阅，不支持回调订阅”，但较新的 Channel 文档又声称默认 WebSocket 支持 `cardAction`，两份官方材料存在矛盾。[官方 SDK README](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)、[Channel 文档](https://github.com/larksuite/node-sdk/blob/main/docs/channel.zh.md)。如果按钮仍属于 callback subscription，v1 多选按钮需要公网 callback，当前“免公网”定案失效。
- 最小修正：Phase 1 做真实自建应用 spike：文本消息、按钮点击、断线重连、重复推送、3 秒 ack 全跑通。失败时最小降级为“长连接收文本编号回复”；或提前启用 Cloudflare Tunnel 接卡片 callback。

### 13. 三 CLI 被抽象成同一种 runner，但能力和失败语义没有建模

- 严重度：major
- 位置：[RunnerKind/Preference](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:32)、[BLUEPRINT Runner interface](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:692)
- 失败场景：本机当前 Claude、Codex、Pi 均支持某种非交互和恢复，但 JSON 事件、MCP 注入、session ID、预算、取消、退出码含义不同。Agent 配置更新或 CLI 自动升级后，历史 Session 无法回答“当时到底用了哪个版本、manifest、模型、权限”。
- 最小修正：建立 adapter capability matrix；Session 快照 `adapterVersion/cliVersion/model/authMode/manifest/promptHash`。路由只能选择满足 `structuredEvents/resume/MCP` 等能力的 backend。

### 14. 订阅版 CLI 无人值守长跑的稳定性没有 SLO

- 严重度：major（疑问）
- 位置：[DECISIONS runner 名册](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:12)
- 失败场景：登录过期、订阅额度限流、CLI 更新、交互式提示或 provider outage 都可能被统称为普通 exit failure，然后盲目重试三次。现有资料不能证明订阅登录态对数小时无人值守构成稳定接口。
- 最小修正：不要先假设稳定；加入启动 preflight、auth/limit/update 错误分类、指数退避、熔断、人工通知和 adapter smoke test。对每个 CLI 连续跑一个 2h 玩具任务再决定是否满足 v1。

### 15. 单 Mac + 本机 Postgres 缺少无人值守运行的运维闭环

- 严重度：major
- 位置：[DECISIONS 单机](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:9)、[README 启动方式](/Users/leohe/Documents/claude_projects/agentos/README.md:14)
- 失败场景：Mac 睡眠、重启、Docker Desktop 更新或磁盘满后，API、DB、runner、飞书长连接以不同顺序恢复；旧 lease、半写日志、未清理工作区无人 reconcile。
- 最小修正：使用 launchd/等价 supervisor、自启动顺序、健康检查、磁盘阈值、每日加密备份，并在 control plane 启动时执行 orphan attempt/workspace reconciliation。个人系统不需要 HA，但必须可恢复。

### 16. 本地文件系统 MCP 的 ACL 会遭遇 symlink、大小写和路径别名绕过

- 严重度：major
- 位置：[DECISIONS 文件存储](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:15)、[FilesystemGrant](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:259)、[FileObject](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:572)
- 失败场景：字符串前缀检查通过 `/allowed/link/secret`，但 symlink 指向授权根外；macOS 默认大小写不敏感又会产生路径别名。裸 shell 还可以完全绕过 MCP。
- 最小修正：ACL 保存 root ID + 规范化相对路径；访问时 realpath/openat 校验并拒绝 symlink escape。文件根目录不得直接暴露给 agent 宿主进程。

### 17. Secret 模型缺少轮换元数据，环境变量映射还会发生覆盖冲突

- 严重度：major
- 位置：[Secret/AgentSecretGrant/EnvironmentSecret](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:282)
- 失败场景：两个 grant 可把不同 secret 映射到同一 `envVar`，最终值取决于装配顺序；`encryptedValue` 没有 key ID、算法/版本、轮换和禁用状态，主密钥轮换或回滚困难。
- 最小修正：对作用域内 `envVar` 加唯一约束；记录 ciphertext version、key ID、rotatedAt、disabledAt。主加密密钥必须位于 DB 外。统一库可以保留，但默认 grant 仍应 deny。

### 18. 多个外键允许跨 Project 关系，项目边界只靠应用代码约定

- 严重度：major
- 位置：[Agent 及各 join table](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:138)、[Task/Session](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:354)
- 失败场景：Project A 的 Task 可以引用 Project B 的 Agent；Agent 可引用其他项目的 Environment、Skill、Repo、MCP。YAML 导入或 API bug 会生成跨项目 session，读取错误 repo/secret。
- 最小修正：为关系补 composite `(id, projectId)` 外键，或在单一事务内集中验证并加数据库测试。单用户不消除项目级最小权限需求。

### 19. v1 禁用 spend cap 与 blueprint 的 Goal 验收直接冲突

- 严重度：major
- 位置：[DECISIONS 护栏](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:19)、[BLUEPRINT Goal rails](/Users/leohe/Documents/claude_projects/agentos/BLUEPRINT.md:622)
- 失败场景：Phase 4 验收要求 `spendCap=0` 不 spawn；定案却只留字段不执行。即使订阅没有逐 token 现金账单，无限循环仍会消耗订阅额度、机器时间并阻塞其他任务。
- 最小修正：把护栏抽象成通用 budget：美元、session/iteration 数、wall time、provider quota 至少一种必须生效。订阅 runner 可将美元 cap 标为“不适用”，但不能让 budget engine 空转。

## Minor

### 20. Schedule 字段没有交叉约束和 occurrence 记录

- 严重度：minor
- 位置：[Task schedule](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:369)
- 失败场景：可保存 `CRON` 但 cron/timezone 为空，或 `NOW` 同时带 runAt；重复 scheduler tick 无法识别同一 occurrence。
- 最小修正：增加校验约束和 `ScheduleOccurrence(dedupeKey, scheduledFor, status)`，并索引 `readyAt/nextRunAt`。

### 21. 文档的优先级口径自相矛盾

- 严重度：minor
- 位置：[DECISIONS 开头](/Users/leohe/Documents/claude_projects/agentos/DECISIONS.md:3)、[README precedence](/Users/leohe/Documents/claude_projects/agentos/README.md:8)
- 失败场景：一边称 BLUEPRINT 是“设计唯一信源”，另一边又规定 DECISIONS 优先，且已有多项实质偏离；后续实现者无法判断 acceptance test 是否仍有效。
- 最小修正：明确“BLUEPRINT 为上游需求，DECISIONS 为本项目覆盖层”，每条偏离列出被替代的 blueprint 条款和新的验收标准。

### 22. 关系字段缺少一致性约束

- 严重度：minor
- 位置：[TaskTemplateStep](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:336)、[InboxMessage](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:505)、[Session](/Users/leohe/Documents/claude_projects/agentos/packages/db/prisma/schema.prisma:472)
- 失败场景：`assigneeType=AGENT` 但 agent 为空；Session 可同时关联 Task 和 Goal，或两者皆空；Inbox 可成为完全无上下文的 orphan。
- 最小修正：增加数据库 CHECK 或统一创建服务，强制 XOR 和 assignee 一致性。

## 建议的最小重排

不要现在直接进入模板：

1. 先做三 CLI adapter spike：结构化事件、resume、MCP、kill、auth failure。
2. 再完成执行内核：Job/Attempt、fencing、临时工作区、环境净化、session token。
3. 跑通 Inbox 文本/卡片和 crash-resume。
4. 然后做 Phase 3 workflow/fan-out/join。
5. 最后做 Phase 4 Goal iteration 与护栏。

## 哪些常见质疑其实不成立

- “单机就必须用 R2”不成立。本地文件系统对个人系统完全可行，前提是 agent 只能经 MCP 访问，并补好路径安全、备份和临时工作区。
- “claim/lease pull 本身不可靠”不成立。它是成熟模式；问题是当前缺 fencing、幂等和独立 attempt。
- “审批放 API 层一定不安全”不成立。所有写入口统一、principal 真正分离、agent 只持 session token 时，API 层正是合适的策略边界，不必强上数据库 trigger。
- “不保留云 runner 就必然设计错”不成立。Leo 已明确只用本地订阅；需要保留的是 adapter/capability seam，不是无用的云实现。
- “Postgres 和服务同机必然不可用”不成立。单用户系统不需要 HA；监督启动、备份、磁盘监控和启动 reconciliation 足够。
- “Task 必须增加十几个状态”不成立。Kanban 四态可以保持简洁；排队、等待、重试、lease 应放在 Job/Attempt，而不是污染业务卡片状态。
- “三套 CLI 无法自动化”不成立。本机版本都已提供非交互和某种 session 恢复能力；真正风险是协议不统一、版本漂移和订阅登录态没有无人值守 SLO。
- “飞书长连接不能做双向文本”不成立。收消息事件和调用发送 API 没问题；当前待证伪的只是卡片按钮 callback 能否完全免公网。
