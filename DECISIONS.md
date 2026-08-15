# AgentOS 决策记录

> 经三轮设计审讯（grilling）与 Leo 逐项拍板形成，2026-08-15。审讯过程见 `GRILLING-STATE.md`，设计唯一信源 = `BLUEPRINT.md`（Danny Postma AgentOS gist 全文）。
> 状态：待 Leo 确认共识后开建 Phase 0。

| # | 决策点 | 定案 | 关键理由 |
|---|---|---|---|
| 1 | 蓝本 | 照 Danny blueprint 建，不迁就 Leo 现有工程（herdr/word-factory 视为噪音） | Leo 定调「按照他的来」 |
| 2 | 执行场地 | 只做自管 runner，Anthropic 云托管整个不建（连开关都不留）；全系统落 Mac 单机 | 云托管走 API 计费无免费额度、Max 订阅不覆盖；Leo 不考虑云端 |
| 3 | 公网入口 | 腾讯云彻底不用（v1/v2 都不用）；v2 需要 inbound webhook 时用 Cloudflare Tunnel（Leo 已有域名，免费版够用）给 Mac 挂公网 HTTPS | runner 在 Mac ⇒ Mac 必须常开 ⇒ 上云无可用性收益；CF Tunnel 免费且免端口暴露 |
| 4 | Runner 形态 | agent 会话以专用低权限 macOS 用户（agentrunner）跑，`--dangerously-skip-permissions`；既有危险命令钩子保留为第一层，OS 权限为兜底层；Docker 化仍排 v2（Leo 2026-08-15 采纳 Sol 评审 blocker#1 后改裁） | 钩子是可绕过的枚举过滤，OS 用户是内核强制；挡误删主账户文件+挡凭证读取 |
| 5 | Runner 名册 | claude CLI（Max 订阅登录态）+ codex CLI（Codex 订阅）+ pi CLI（DeepSeek，可选档、少用） | 全吃已有订阅，日常零 API 成本 |
| 6 | 路由默认 | 规划/spec/评审类 agent = claude；实现类（senior-dev、implementation-plan-executioner）= codex；librarian 杂活 = pi/DeepSeek；YAML 逐 agent `model`+`runner` 覆盖 | 与 Leo 双订阅现行用法同构 |
| 7 | 技术栈 | TypeScript + Hono + Prisma + Postgres（本机 Docker）+ React/Vite | 照 blueprint 参考栈，无修改理由 |
| 8 | 文件存储 | 本地目录 + 文件系统 MCP（服务端 ACL：read/write/delete 分权、per-agent 文件夹授权，照 blueprint 全建）；不用 R2/COS | Danny 需要对象存储是因一次性云容器无持久盘；单机自带持久盘 |
| 9 | Secret | AgentOS 建**统一 secret 库**（Postgres 表 + 后台管理页），所有项目共用、按名称引用；runner 起会话时把该 agent 引用的 secret 注入子进程环境（Leo 2026-08-15 指定统一管理） | 单一管理地址；裸跑下注入是便利机制不是安全墙（agent 本就继承用户环境），安全边界留待 Docker 化 |
| 10 | v1 范围 | Phase 0/1 已交付；余下按 Sol 评审重排（Leo 2026-08-15 采纳）：① 三 CLI 能力 spike → ② 执行内核（Runs/Attempt 分离、lease fencing、临时工作区、低权限用户、环境净化、session token）→ ③ Inbox 双向+恢复 → ④ 9 步模板+审批门 → ⑤ goals+护栏。触发器/CLI/YAML 同步/PWA = v2 | 模板与 goals 压在执行内核可靠性上，先地基后盖楼；评审 22 条 findings 见 docs/reviews/ |
| 11 | Agent 名册 | 10 个流水线必需：default / plan / spec / senior-dev / review-coordinator / feasibility / scope-guardian / coherence / implementation-plan-executioner / librarian。砍 customer-support / diagnostic / linkedin-content | 后三个是 Danny 的业务不是系统；YAML 随时可加 |
| 12 | 护栏默认值 | 会话最长 2h（杀会话、任务转 review 进收件箱）；停滞 10min 无新工具调用判死；同任务最多 3 会话超限等人；spend cap 字段留 schema、v1 不生效（订阅额度无钱消费方） | 上线再调 |
| 13 | 收件箱 | Inbox MCP 为协议层；投递通道 v1 = 飞书自建应用 bot（长连接模式收事件，免公网回调），支持双向问答+卡片按钮多选题；PWA + Web Push 排 v2（国内 Web Push 仅 iOS APNs 可达） | Telegram 国内被墙；通道换皮不动 agent 侧 |
| 14 | 试点验收 | 新建一个玩具仓，跑通「设目标 → 走开 → 收 PR」+ 完整 9 步模板 + 审批门 | Leo 选定 |
| 15 | 人工挂账 | Leo 亲手在飞书开放平台建自建应用、开机器人能力、拿 app_id/app_secret（开工后给逐步指引） | 涉及账号，agent 不碰 |

## 概念口径（已向 Leo 讲清）

- **Agent vs Skill**：agent = 角色（模型 + prompt + 权限边界 + 协作名单），权限挂 agent；skill = 挂在 agent 上的方法论/能力文件，一个 agent 可挂多个。类比：agent≈派出去的窗口+定档，skill≈`.claude/skills/` 技能文件。
- **计费事实**：Anthropic Managed Agents 按 API token 计费 + $0.08/h 容器 + $10/千次搜索，Max 订阅不覆盖；订阅额度唯一吃法 = 本地跑 Claude Code CLI。
