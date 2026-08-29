<div align="center">

# Anneal

**你只写 spec，它清空看板。**

Anneal 在你自己的 Mac 上驱动一条条 coding agent 任务链。把任务挂进
看板，每个任务都会被无人值守地计划、评审、实现、验证、合并，全程跑在
你已经登录的 Codex 与 Claude 订阅上。

[![status](https://img.shields.io/badge/status-developer%20preview-orange)](#当前状态)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-lightgrey)](#当前状态)
[![node](https://img.shields.io/badge/node-22.17.0-brightgreen)](.nvmrc)

[安装](#快速开始) · [工作原理](#工作原理) · [当前状态](#当前状态) · [English](README.md)

<img src="docs/media/parallel-tasks.gif" alt="看板上多个任务并行推进" width="880">

</div>

## 它服务的工作流

你只做一件事：写 spec。把它们挂进看板，然后走开。任务链接过每个任务
并走完全程：计划、计划评审、实现、两次相互独立的代码评审、修复落地、
回归验证，直至合并。等你回来，只读真正重要的 pull request，对在意的
那几个开一个 agent 窗口，和 AI 迭代到满意为止。

中间它不需要你。链只在三种情况下停下来等你：agent 通过 Inbox 向你
提问、你标记为 gated 的步骤需要人来决策、或某次运行升级（escalate）。

## 你得到什么

- **Spec 进，merge 出。** 一张任务卡最终成为一个分支、一个 pull
  request 和一次通过 merge gate 的合并。中间的每个产物（计划、评审
  发现、修复裁决、回归结果）都记录在你的机器上，事后可以逐步回溯
  整条链。
- **不靠信任合并。** 两次盲评、一次独立回归验证和一道 merge gate，
  隔在 agent 的 diff 和你的主分支之间。
- **默认并行。** 不同任务、不同仓库的链同时在飞；吞吐量取决于你注册了
  多少 runner，而不是你的工时。
- **用你的订阅，不用 API key。** Anneal 启动的是你已经安装并登录的官方
  Codex CLI、Claude Code 和 Pi。它自己不持有任何凭据，不做代理，也没有
  任何要粘贴的 key。

## Anneal 由 Anneal 构建

这个仓库里的 pull request 由 Anneal 自己的任务链完成规格、计划、评审、
实现与合并，全部跑在一台 Mac 上。链交付的提交带有
`Co-Authored-By: Anneal Chain` 以及 `X-Anneal-Run` / `X-Anneal-Step`
trailer，你可以直接在 git log 里核对哪些提交出自链。

## 工作原理

链由模板实例化而来。每一步绑定一个 agent 角色：提示词、模型、推理档位
以及执行它的 runner CLI。旗舰的 Full Assurance 模板用十二步覆盖整条
交付路径。

模板是数据，不是代码。角色、提示词、模型和 gate 都可以编辑，你可以把
这条链改造成自己的流程。

<details>
<summary><b>完整十二步</b>——每一步的角色、runner、模型与档位</summary>

表中的 `Sol` 和 `Luna` 是 Codex CLI 暴露的 GPT-5.6 变体。

| # | 步骤 | Agent 角色 | 做什么 | Runner | 模型 · 档位 |
| --- | --- | --- | --- | --- | --- |
| 1 | 写 spec | `spec` | 把任务转为正式规格 | Claude | Claude Opus 5 · high |
| 2 | 计划 | `plan` | 把规格切成可并行的垂直切片 | Claude | Claude Fable 5 · medium |
| 3 | 计划评审 | `review-coordinator` | 对照规格与冻结基线评审每个切片 | Pi | GPT-5.6 Sol · xhigh |
| 4 | 修订计划 | `plan-reviser` | 在全新会话中按评审发现修订切片集 | Codex | GPT-5.6 Sol · high |
| 5 | 实现 | `implementation-plan-executioner` | 按依赖前沿执行切片集并开出 pull request | Codex | GPT-5.6 Sol · high，子代理 GPT-5.6 Luna · max |
| 6 | 代码评审 | `review-coordinator-sol` | 在钉住的 base 与 head 上评审集成后的 diff | Pi | GPT-5.6 Sol · xhigh |
| 7 | 盲评 | `review-coordinator-opus` | 对同一 diff 再评一次，看不到第 6 步的发现 | Claude | Claude Opus 5 · high |
| 8 | 落地评审修复 | `senior-dev` | 裁决两轮评审的全部发现并落地采纳项 | Codex | GPT-5.6 Sol · high |
| 9 | 文档 | `librarian` | 让内部文档与交付代码保持一致 | Pi | GPT-5.6 Luna · xhigh |
| 10 | 回归验证 | `regression-verifier` | 刷新到目标分支并重跑回归 | Codex | GPT-5.6 Luna · max |
| 11 | 合并就绪 | — | 重算 head，要求所有评审清零，签发精确到 head 的授权 | — | 机械步骤，无模型运行 |
| 12 | 合并执行 | `merge-integrator` | 对照线上 pull request 复核全部前置条件后合并 | — | 机械步骤，无模型运行 |

</details>

<div align="center">

<img src="docs/media/chain.png" alt="任务详情：十二步链及各步角色与状态" width="880">

<sub>一条在飞的链：第 4 步运行中，第 6、7 步作为并行兄弟等待。</sub>

</div>

这些步骤背后的设计规则是：写代码的一方永远不裁决自己的代码。创作、
评审与验证在相互独立的会话里进行，两路代码评审看不到彼此的发现，由
第 8 步统一裁决。每个会话都是干净起步：提示词为该角色专门构造，运行
环境由 runner 自行构造，你的全局 agent 配置和技能不会作为噪音漏入。角色绑定在
[`agents/templates/compound-engineer-workflow/`](agents/templates/compound-engineer-workflow)；
看板各列的语义见
[task-routing 契约](docs/governance/task-routing-v1.md)。

## 快速开始

你需要：

- Apple Silicon 的 Mac
- Node.js `22.17.0`（见 `.nvmrc`）与 npm 10.9.2+
- Docker Compose 与 Git
- 在同一 macOS 账户下已登录的官方 Codex CLI（Claude Code 与 Pi 可选）

```sh
git clone https://github.com/mosonlab/anneal.git
cd anneal
git checkout v0.4.0
npm ci
npm run setup:local
npm run build
docker compose up -d --wait --wait-timeout 60 postgres
npm run db:migrate:release -- --fresh
```

然后依次在三个终端启动 `npm run dev:api`、`npm run dev:runner`、
`npm run dev:web`，打开 `http://127.0.0.1:5173`。完整流程与各项预检见
[`docs/release/developer-preview.md`](docs/release/developer-preview.md)。

## 当前状态

Developer Preview 4（v0.4.0）：接口与存储数据形态在 preview 之间可能
变化，唯一升级路径是全新安装。仅支持 Apple Silicon 上的 macOS。

**把它指向任何你在乎的东西之前先读这段：** Anneal 以非交互的权限旁路
方式启动 coding CLI，以你的 macOS 用户身份运行，不在沙箱内。请使用可
丢弃的仓库和一台你愿意让 agent 修改的机器。详见
[`docs/release/security.md`](docs/release/security.md)。

Provider CLI、它们的认证与套餐条款始终在你和 provider 之间；权威支持
声明见
[`docs/release/support-matrix.md`](docs/release/support-matrix.md)。

## 文档

[架构](docs/architecture.md) ·
[安装](docs/install.md) ·
[安全](docs/release/security.md) ·
[迁移与恢复](docs/release/migration-and-recovery.md) ·
[发布说明](docs/release/v0.4.0-release-notes.md) ·
[贡献指南](CONTRIBUTING.md) ·
[支持](SECURITY.md)

## 致谢与许可

链提示词的工作文本采用了
[mattpocock/skills](https://github.com/mattpocock/skills)（MIT，
Copyright (c) 2026 Matt Pocock）中的五个技能，见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。本快照以
[MIT License](LICENSE) 许可，快照边界由
[`public-snapshot.json`](public-snapshot.json) 定义。
