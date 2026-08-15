# agentos 设计审讯（grilling）状态文件

> 用途：本窗上下文超水位，写盘防压缩丢失。压缩后回读此文件重建状态继续。
> 更新时刻：2026-08-15，Round 1 已发出、等 Leo 作答。

## 项目定调（Leo 已拍板）

- 目标：照 Danny Postma 的 AgentOS blueprint（Claude Agent SDK 之上的无人值守开发流水线）**从头自建**，「按照他的来」，不迁就 Leo 现有 word-factory/herdr 现状（Leo 原话：现状是噪音，不必考虑）。
- 信源：`~/Documents/claude_projects/notes/yt-hub-learn/01-学习笔记/ai/dannypostmaa/2026-08-14-在Claude Agent SDK上自建AgentOS：无人值守的开发流水线.md`（学习笔记）+ gist 全文已拉存为本仓 `BLUEPRINT.md`（约1200行：域模型、13 内置 agent、会话状态机、YAML schema、CLI、Phase 0-7 实施计划）。
- 工作区：`~/Documents/claude_projects/agentos/`，已 git init。名字/位置 Round 1 可改（未单列问题，默认定了）。
- 需支持模型：Claude（Max 订阅）、Codex（订阅）、DeepSeek（Leo 说「跑在 PI 上」，含义待 Q2 澄清）。

## 已核实的事实（答过 Leo 的疑问，勿重查）

- Managed Agents（云托管）**不免费**：token 按 API 价（Opus 5 $5/$25 每 M），容器 $0.08/h，web search $10/千次；**Max 订阅额度不能覆盖**（订阅只盖 Claude Code/claude.ai）。Danny 的 ~$500/天、一晚 $1000 就烧在这。平台现原生支持 session budget（美元硬上限）。
- 订阅额度唯一吃法：本地/自管 runner 跑 Claude Code CLI（OAuth 订阅登录）。Danny 自己就为此加了 ~$10/月 Hetzner VM 本地 runner（Claude yolo + Grok），按 goal 路由贵活/便宜活。
- Codex/DeepSeek 不能进 Anthropic 托管容器，必然走自管 runner 侧；runner 抽象里挂 `runner: local-codex` 等即可，不改 Danny 架构。

## Round 1 已定案（Leo 2026-08-15）

- 只做自管 runner，云托管**整个不建**（连开关都不要，Leo 明确不考虑云端）。
- 「PI」= 本地已装的 pi CLI agent（默认 DeepSeek 模型），用得少，作**可选档**。Codex CLI 同意支持。
- Runner 隔离：**裸跑 yolo**（Mac 本地，Leo 拍板，风险已告知备忘）。
- 控制面：Leo 有一台国内腾讯云服务器（还剩1年），问能否用。已答：可以，条件=通知通道/对象存储换国内可达（Telegram/R2/Anthropic API 均被墙）；runner 协议做 pull 模式（Mac 轮询领任务）。
- 持久层简化（sops/age 替 GSM）；v1 = Phase 0-4；通知 bot 先行、PWA+WebPush 排 v2（已告知 Web Push 国内 FCM 收不到、仅 iOS APNs 可用）。

## Round 2 已定案（Leo 2026-08-15）

- 通知通道：**飞书自建应用 bot**（长连接模式收事件，免公网回调）。Web Push 排 v2 且已告知国内仅 iOS APNs 可用。
- 技术栈：照抄 TS+Hono+Prisma+Postgres+React/Vite。
- v1 agent 名册：10 个流水线必需（default/plan/spec/senior-dev/review-coordinator/feasibility/scope-guardian/coherence/implementation-plan-executioner/librarian）。已向 Leo 讲清 agent（角色+模型+权限边界）vs skill（挂在 agent 上的方法论文件）两层概念。
- 护栏：会话最长 2h / 停滞 10min 判死 / 同任务最多 3 会话；spend cap 字段留 schema 不生效。
- 路由：规划/评审=claude、实现=codex、librarian 杂活=pi/DeepSeek，YAML 逐 agent 覆盖。
- Leo 质疑成立并已修正口径：runner 在 Mac ⇒ Mac 必须常开 ⇒ 控制面上云的可用性收益不成立；对象存储不需要（Danny 用 R2 是因一次性云容器无持久盘），文件 MCP 的 ACL 逻辑照建、后端换本地目录。

## Round 3 已发问题（等答案）

- Q1 控制面落点修正定案：A 全落 Mac（推荐，腾讯云 v1 不用、v2 触发器时再搬）/ B 仍上腾讯云。
- Q2 secret 管理：A .env + agent environment 白名单注入（推荐）/ B sops/age。
- Q3 试点场景：A 玩具仓 / B 真实小需求仓（推荐，人工审 PR）/ C 主力仓。
- 挂账人工活：Leo 亲手在飞书开放平台建自建应用拿 app_id/app_secret（届时给逐步指引）。

## 收口计划

Round 3 答完若无新分叉 → 前沿空 → 汇总全部定案成决策记录（落 agentos 仓）请 Leo 确认共识 → 确认后才动手建 Phase 0。

## 纪律

- grilling 技能进行中：每轮问整个前沿、每问带推荐、等 Leo 答完再推进；前沿空 + Leo 确认共识后才动手建。
- 事实自己查（子代理/联网），决策问 Leo。
