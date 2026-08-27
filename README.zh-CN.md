<div align="center">

# AgentOS

**面向 coding agent 的本地控制平面。**

你只写规格，剩下的交给一条 agent 链——计划、评审、实现、验证、合入，
每一次 run 都可观察、可评审。

[![status](https://img.shields.io/badge/status-developer%20preview-orange)](docs/status.zh-CN.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-lightgrey)](docs/status.zh-CN.md)
[![node](https://img.shields.io/badge/node-22.17.0-brightgreen)](.nvmrc)

[安装](#快速开始) · [文档](#文档) · [支持状态](docs/status.zh-CN.md) · [English](README.md)

<img src="docs/media/tasks.png" alt="任务看板：十二步模板链运行中，每张卡片展示逐 run 状态与成本" width="880">

</div>

## 这是什么

AgentOS 把任务、agent、仓库与文件授权、独立的运行记录、provider 事件流、人工
提问、评审关卡和 git 交付串成一个工作流，全部跑在你自己的机器上。

它编排的是你已经安装并完成认证的官方 Codex CLI、Claude Code 与 Pi——这些 CLI
手里已有的订阅登录，就是它运行所依赖的全部认证。AgentOS 自己不提供任何凭据，
也不转售任何订阅，详见[认证与订阅](#认证与订阅)。

## 它改变了什么

一条任务链承载完整的交付路径：写规格、计划、计划评审、实现、两轮独立代码评审、
应用修复、回归验证、合并就绪判定，直到合并本身。每一步都带着自己的角色、提示词、
模型与推理档位，上一步的产出就是下一步的输入。

链一旦启动就自行推进。需要你出面的只有三种时刻：agent 通过 Inbox 向你提问、你
显式设为 gated 的步骤需要人工裁决、或者某次 run 升级(escalate)。其余时间它无人
值守地跑，交付也在其中——推分支、可选地开 PR、并在 merge gate 之后合入。

杠杆就在这里。稀缺资源不再是你的工时，而是你注册了多少 runner：不同任务、不同
仓库的链同时在飞，而你在读评审产出，不在敲实现。

一处诚实的边界：长时程自治还没接线。Goal 能存能编辑，但没有任何东西从 Goal 调度
工作，所以链仍然由你或 webhook 触发启动，而不是由一个常驻目标驱动。见
[支持状态](docs/status.zh-CN.md)。

<div align="center">

<img src="docs/media/chain.png" alt="链视图：十二步保障工作流，每一步标注其指派的 agent 角色" width="880">

<sub>任务链：每一步都带着自己的角色、提示词与评审关卡。</sub>

<img src="docs/media/agents.png" alt="Agents 视图：每个 agent 的角色、模型、推理档位与 runner" width="880">

<sub>Agents：一个角色、一段提示词、一个模型与档位，以及它派往的 runner。</sub>

</div>

> **Developer Preview 3（v0.3.0）。** 接口、配置与已存数据的形状都可能在预览版
> 之间变动，预览版之间除全新安装外没有升级路径。
>
> **裸机执行警告。** AgentOS 会用非交互式 permission bypass 启动 coding CLI。
> 默认安装下它们以你的 macOS 用户身份、在 sandbox 之外运行，拥有该用户的文件
> 系统与网络权限。AgentOS grant 约束的是 AgentOS API，不构成 host containment。
> 只用可丢弃仓库，以及你愿意让 agent 修改的机器。

## 快速开始

面向 Apple Silicon Mac，需要 `.nvmrc` 记录的 Node.js `22.17.0`（安装强制要求
Node.js 满足 `^20.19.0 || ^22.13.0 || >=24`，其余版本会被拒绝）、npm 10.9.2+、Docker Compose、
Git，以及在同一 macOS 账号下**已安装且已登录**的官方 Codex CLI。Claude Code 与
Pi 都是可选的。

```sh
git clone https://github.com/mosonlab/agentos.git
cd agentos
git checkout v0.3.0
npm ci
npm run setup:local
npm run build
docker compose up -d --wait --wait-timeout 60 postgres
npm run db:migrate:release -- --fresh
```

随后在三个终端里依次启动 `npm run dev:api`、`npm run dev:runner`、
`npm run dev:web`，并打开 `http://127.0.0.1:5173`。

以上是简写形式。包含文件系统、端口、runner identity 与仓库 preflight 的逐字序列
在 [`docs/release/developer-preview.md`](docs/release/developer-preview.md)，
其余安装细节在 [`docs/install.zh-CN.md`](docs/install.zh-CN.md)。

## 支持状态

| 面 | 状态 |
| --- | --- |
| Codex CLI | 已验证 |
| Claude Code | 已验证 / 认证为维护者验证 |
| Pi | 已验证 |
| macOS on Apple Silicon | 目标平台 |
| Linux | 未验证 |
| Windows | 不支持 |

上面的每个标签指的都是本仓库内记录的证据，而不是 CLI provider 的兼容性承诺。
证据边界见 [`docs/status.zh-CN.md`](docs/status.zh-CN.md)，权威支持矩阵见
[`docs/release/support-matrix.md`](docs/release/support-matrix.md)。

## 认证与订阅

AgentOS 不持有任何 provider 凭据。它启动的是你本机已经安装并登录的官方 CLI——
Codex CLI、Claude Code 与 Pi——认证状态留在各个 CLI 自己的配置里，AgentOS 既不
读取也不转发。这里没有 AgentOS 账号，没有 API 反代，也没有要你粘贴的 key。

因此这些 CLI 支持哪种认证，AgentOS 就跑在哪种之上：ChatGPT 订阅登录、Claude
Pro/Max 登录，或各 CLI 自己的 API key 模式，完全按你已经配好的样子。Pi 复用的
也正是 Codex 与 Claude 这两份登录，不需要第四个账号。

这一点你可以自己核实，不必只听我们说。runner 是为 provider 子进程构造环境，而不
是整份复制宿主环境（[`docs/architecture.zh-CN.md`](docs/architecture.zh-CN.md)、
`packages/runner/src/adapters/`）；发布检查会扫描这份 checkout 里的 token 变量、
bearer header 与 `Authorization`（[`docs/release/security.md`](docs/release/security.md)）。

它不能替你裁定 provider 的条款。套餐额度、速率限制、用量配额，以及你的套餐是否
允许这种编排方式，都在你和 provider 之间。AgentOS 不授予任何权益，也不替 CLI
provider 作出兼容性承诺。

## 文档

- [架构与安全模型](docs/architecture.zh-CN.md)——控制台、API、runner 与 provider
  CLI 如何拼在一起，以及 grant 约束了什么、没约束什么。
- [安装细节与验证](docs/install.zh-CN.md)——环境文件、迁移、merge executor 与检查序列。
- [安全](docs/release/security.md)——在把它指向任何你在乎的东西之前先读。
- [迁移与恢复](docs/release/migration-and-recovery.md)——在往里放数据之前先读。
- [发布说明](docs/release/v0.3.0-release-notes.md) · [支持](SUPPORT.md) ·
  [贡献](CONTRIBUTING.md)

## 致谢与许可证

本项目是受 Danny Postma 的视频 *How I Built My Own AgentOS on Claude's Agent
SDK (So You Can Too)*（2026）启发的独立实现，从视频中的想法出发从零构建。

本快照以 [MIT License](LICENSE) 授权；快照边界由
[`public-snapshot.json`](public-snapshot.json) 定义。
