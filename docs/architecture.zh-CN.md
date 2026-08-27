# 架构与安全模型

## 运行形态

```text
Web 控制台
          |
          v
控制平面 API  <---->  PostgreSQL
          ^                 任务、运行、租约、
          |                 事件、授权、输出
          |
本地 runner -----> 临时 git 工作区
          |
          +----> Codex CLI / Claude Code / Pi
                         |
                         +----> AgentOS session 工具（MCP 或 Pi extension）
```

- React/Vite Web 控制台和 Hono API 提供 project、agent、capability、task、chain、
  approval、run、session 和 Inbox 工作流。
- PostgreSQL 通过 Prisma 访问；task 状态与持久化的 Run、SessionEvent 记录分开
  保存。
- 本地 runner 用带 fencing 的 lease 领取工作，在受控的单次运行工作区中 clone
  指定仓库，创建或恢复运行分支，对选中的 CLI 执行 preflight，并记录结构化
  provider 事件。
- Codex 和 Claude 通过每次运行专属的 stdio MCP server 获得 AgentOS session
  工具；Pi 通过 extension 获得对应的任务工具。
- AgentOS 不再提供仓库命令行界面。操作者通过 Web 控制台以及文档中说明的 service、
  database 和 runner 脚本操作。

## 一个真实任务的工作流

1. 操作者创建 project、登记 repository、定义 agent，并授予当前 runtime 所需的
   repository access、Files Root access 和 secret。skill、custom MCP 和 collaborator
   binding 也可以保存为控制平面配置，但目前不会作为 runtime grant 发送给 runner。
2. 操作者直接创建任务，或从任务链模板创建任务，并选择 Codex、Claude 或实验性
   Pi 路径。
3. runner 使用 lease 和 fencing generation 领取排队中的 Run，然后创建临时 clone
   与本次运行专属的 git 分支。
4. agent 启动前，provider preflight 会检查配置的 binary、version 命令和登录状态。
5. agent 在 clone 中工作，持续写入 provider 与 tool 事件，记录关键进展，可通过
   Inbox 提交阻塞性人工问题，并持久化 task output。
6. AgentOS 记录 git 结果并 push 本次运行的 branch。创建与领取任务时必须存在
   repository-access row，但其中的 read/write 级别目前不会约束这次 push。Run 的
   `opensPullRequest` 设置控制交付时是否还尝试创建 pull request。有审批关卡的任务
   进入 review 等待人工决定；无关卡且成功的任务可以结束。

> **待完成（OSS-C）：公开 demo 证据。** 上文截图仅用于展示界面。OSS-C 证据
> 关卡完成前，本 README 不包含任何视频、耗时、benchmark 或端到端 demo 声明。

## 安全默认与限制

- operator、runner 和每次运行的 session 是不同 principal。runner route 与 session
  route 分别限定范围，session token 随 Run 到期或被撤销。
- runner 认证的 Run 状态写入，以及 session event、activity、output、Inbox 和
  completion 路径，会依据 Run 的 fencing generation 进行检查；过期 generation
  会被拒绝，runner 随即终止 provider 进程组。Files Root 的修改则要求绑定 lease
  的单次运行 session token 和匹配的 Filesystem Grant；其请求不携带客户端 fencing
  字段。
- 子进程只接收显式构建的环境：配置的 `PATH`/`HOME`、Run 身份、session 凭据和已
  授权 secret；runner 不会整体复制 host 环境。
- Runner 的代理是显式开启的，经由 `RUNNER_HTTP_PROXY`、`RUNNER_HTTPS_PROXY` 和
  `RUNNER_NO_PROXY` 配置。一旦配置，它作用于整条由 runner 控制的网络路径：Claude、
  Codex、Pi，以及 Git 和工作区的准备与交付命令。常规的 host 代理
  环境变量会被忽略。`RUNNER_RUN_AS_PREFIX` 启动器必须保留这份显式环境；代理 URL
  不会被序列化进 provider 的 argv。
- 持久化 secret 使用 AES-256-GCM；公开 API 的 secret 表示不包含明文或密文。
- 控制平面要求存在 repository-access row，并检查 Files Root grant；该 access row
  的 read/write 级别目前不会约束交付 push。每次运行的凭据以 `0600` 模式写在临时
  工作区内，并在本地 git exclude 中排除。
- 成功运行的工作区会删除；失败工作区可按 runner 配置保留有限数量用于恢复。
- 一个规范工作区根同一时刻只能由一个 API 控制平面拥有。所有权从受保护的、仅 API
  可访问的 `CONTROL_PLANE_STATE_DIR` 获取，且在导入 Prisma 或开始 reconciliation
  之前完成。runner 守护进程仍是普通客户端，任意数量的 runner 都可以轮询这同一个
  API。
- 公开快照默认关闭，并扫描未分类路径、凭据、PII、私有绝对路径和仅内部材料。

重要限制：当前 provider adapter 使用非交互 permission-bypass 参数。AgentOS grant
限制的是它自己的控制平面 API，但它们本身不是 OS sandbox。在默认的同一用户配置
下，Filesystem Grant 是授权与审计边界，而不是主机文件系统 containment 边界。本
发布候选不声称强制执行网络隔离。如果需要更强的主机隔离，请使用专用、最小权限的
runner 账号，并在启用 `RUNNER_RUN_AS_PREFIX` 前阅读 `.env.example` 中的警告注释——
该前缀隔离的是 runner 之间：单个 runner 的账号仍然拥有它自己创建过的全部
workspace，因此仍可删除自己此前的 workspace。此外，面对已经能在 Files Root 内写入
的攻击者，Files 路径遍历还留有一个已知缺口。

[`docs/release/security.md`](release/security.md) 逐条写明了这些
限制，以及哪些被检查、哪些没有；在把它指向任何你在意的东西之前先读它。

