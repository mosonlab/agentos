<div align="center">

# AgentOS

**面向 coding agent 的本地控制平面。**

你只写规格，剩下的交给一条 agent 链：计划、评审、实现、验证、合入。
每一次 run 都可观察、可评审。

[![status](https://img.shields.io/badge/status-developer%20preview-orange)](#支持状态)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-lightgrey)](#支持状态)
[![node](https://img.shields.io/badge/node-22.17.0-brightgreen)](.nvmrc)

[安装](#快速开始) · [文档](#文档) · [支持状态](#支持状态) · [English](README.md)

<img src="docs/media/tasks.png" alt="任务看板：模板链运行中，每张卡片展示所处步骤、run 状态、模型与成本" width="880">

</div>

## 这是什么

AgentOS 把任务、agent、仓库与文件授权、独立的运行记录、provider 事件流、人工
提问、评审关卡和 git 交付串成一个工作流，全部跑在你自己的机器上。

它编排的是你已经安装并完成认证的官方 Codex CLI、Claude Code 与 Pi：这些 CLI
手里已有的订阅登录，就是它运行所依赖的全部认证。AgentOS 自己不提供任何凭据，
也不转售任何订阅，详见[认证与订阅](#认证与订阅)。

## 它改变了什么

一条任务链覆盖完整的交付路径：写规格、计划、计划评审、实现、两轮独立代码评审、
应用修复、回归验证、合并就绪判定，直到合并本身。每一步都带着自己的角色、提示词、
模型与推理档位，上一步的产出就是下一步的输入。

链一旦启动就自行推进。需要你出面的只有三种时刻：agent 通过 Inbox 向你提问、你
显式设为 gated 的步骤需要人工裁决、或者某次 run 升级（escalate）。其余时间它无人
值守地跑，交付也在其中：推分支、可选地开 PR、并在 merge gate 之后合入。

这改变的是你的瓶颈在哪里。吞吐取决于你注册了多少 runner，而不是你的工时：不同
任务、不同仓库的链同时在飞，你在读评审产出，不在敲实现。

长时程自治还没接线。Goal 能存能编辑，但没有任何东西从 Goal 调度工作，所以链仍然
由你或 webhook 触发启动，而不是由一个常驻目标驱动。见
[支持状态](#支持状态)。

<div align="center">

<img src="docs/media/agents.png" alt="Agents 视图：每个 agent 的角色、模型、推理档位与 runner" width="880">

<sub>Agents：一个角色、一段提示词、一个模型与档位，以及它派往的 runner。</sub>

</div>

## 十二步任务链

AgentOS 自带的 Full Assurance 模板。每一步绑定一个角色，每个角色自带 runner、
模型与推理档位。

| # | 步骤 | Agent 角色 | 做什么 | Runner | 模型 · 档位 |
| --- | --- | --- | --- | --- | --- |
| 1 | 写规格 | `spec` | 把任务转成作准的规格说明 | Claude | Claude Opus 5 · high |
| 2 | 规划 | `plan` | 把规格切成可并行的垂直曳光弹切片 | Claude | Claude Fable 5 · medium |
| 3 | 规划评审 | `review-coordinator` | 对着规格与冻结基线逐片评审 | Pi | GPT-5.6 Sol · xhigh |
| 4 | 修订规划 | `plan-reviser` | 在全新会话里按评审结论就地改切片 | Claude | Claude Opus 5 · medium |
| 5 | 实现 | `implementation-plan-executioner` | 从活的依赖前沿执行切片集，并开出 PR | Codex | GPT-5.6 Sol · high，子代理为 GPT-5.6 Luna · max |
| 6 | 代码评审 | `review-coordinator-sol` | 在钉死的 base 与 head 上评审集成后的 diff | Pi | GPT-5.6 Sol · xhigh |
| 7 | 盲评 | `review-coordinator-opus` | 对同一份 diff 再评一次，看不到第 6 步的结论 | Claude | Claude Opus 5 · high |
| 8 | 应用评审修复 | `senior-dev` | 对两份评审的每条结论逐条裁决，并落实采纳项 | Codex | GPT-5.6 Sol · high |
| 9 | 文档 | `librarian` | 把内部文档更新到与交付代码一致 | Pi | GPT-5.6 Luna · xhigh |
| 10 | 回归验证 | `regression-verifier` | 刷新到目标分支并重跑回归 | Claude | Claude Opus 5 · medium |
| 11 | 合并就绪 | — | 重算 head，要求每份未结评审清空，签发精确 head 的合并授权 | — | 机械步，不跑模型 |
| 12 | 执行合并 | `merge-integrator` | 对着线上 PR 重新校验每一项前置条件，然后合并 | — | 机械步，不跑模型 |

<div align="center">

<img src="docs/media/chain.png" alt="任务详情：十二步链的每一步及其角色与状态，上方是已完成的 run，下方是任务提示词" width="880">

<sub>运行中的一条链：第 4 步执行中，第 6、7 步作为并行同层等待。</sub>

</div>

第 6、7 步是并行同层：盲评看不到对方的输出，由第 8 步一并裁决。第 5 步的根会话
派发原生子代理，档位钉死在 Luna max，最多八个并发。

角色绑定在
[`agents/templates/compound-engineer-workflow/`](agents/templates/compound-engineer-workflow)，
模型在 [`agents/roles/`](agents/roles)。在控制台改过的模型或档位是持久化的运行时
覆盖，后续 seed 不会替换它。

> **Developer Preview 3（v0.3.0）。** 接口、配置与已存数据的形状都可能在预览版
> 之间变动，预览版之间除全新安装外没有升级路径。
>
> **裸机执行警告。** AgentOS 会用非交互式 permission bypass 启动 coding CLI。
> 默认安装下它们以你的 macOS 用户身份、在 sandbox 之外运行，拥有该用户的文件
> 系统与网络权限。AgentOS grant 约束的是 AgentOS API，不构成 host containment。
> 只用可丢弃仓库，以及你愿意让 agent 修改的机器。

## 快速开始

你需要一台 Apple Silicon Mac，以及 `.nvmrc` 记录的 Node.js `22.17.0`（安装强制要求
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
其余安装细节在英文页面 [`docs/install.md`](docs/install.md)。除本页外，内部文档仅
提供英文版。

## 支持状态

Developer Preview。支持范围以及每一条主张背后的证据，记录在
[`docs/release/support-matrix.md`](docs/release/support-matrix.md)，那是权威支持
声明（仅英文）。它描述的是本仓库内记录的证据，不是 CLI provider 作出的兼容性
承诺。

AgentOS 的目标平台是 Apple Silicon 上的 macOS。Linux 未验证；Windows 按设计不
支持：runner 依赖 POSIX 进程组、路径和命令行为。

Provider CLI、账号、认证、订阅、用量、速率限制、模型和 provider 侧可用性均由你
自己负责。AgentOS 不提供 provider 凭据，也不提供使用资格。

## 认证与订阅

AgentOS 不持有任何 provider 凭据。它启动的是你本机已经安装并登录的官方 CLI
（Codex CLI、Claude Code 与 Pi），认证状态留在各个 CLI 自己的配置里，AgentOS
既不读取也不转发。这里没有 AgentOS 账号，没有 API 反代，也没有要你粘贴的 key。

因此这些 CLI 支持哪种认证，AgentOS 就跑在哪种之上：ChatGPT 订阅登录、Claude
Pro/Max 登录，或各 CLI 自己的 API key 模式，完全按你已经配好的样子。Pi 同样没有
自己的账号，它走的是 Codex 那份登录。

这一点你可以自己核实。runner 是为 provider 子进程构造环境，而不是整份复制
宿主环境（[`docs/architecture.md`](docs/architecture.md)、
`packages/runner/src/adapters/`）；发布检查会扫描这份 checkout 里的 token 变量、
bearer header 与 `Authorization`（[`docs/release/security.md`](docs/release/security.md)）。

这些都不能替你裁定 provider 的条款。套餐额度、速率限制、用量配额，以及你的套餐是否
允许这种编排方式，都在你和 provider 之间。AgentOS 不授予任何权益，也不替 CLI
provider 作出兼容性承诺。

## 文档

除本页外，内部文档仅提供英文版。

- [架构与安全模型](docs/architecture.md)：控制台、API、runner 与 provider
  CLI 如何拼在一起，以及 grant 约束了什么、没约束什么。
- [安装细节与验证](docs/install.md)：环境文件、迁移、merge executor 与检查序列。
- [安全](docs/release/security.md)：在把它指向任何你在乎的东西之前先读。
- [迁移与恢复](docs/release/migration-and-recovery.md)：在往里放数据之前先读。
- [发布说明](docs/release/v0.3.0-release-notes.md) · [贡献](CONTRIBUTING.md)

## 支持

AgentOS 是个人项目，不承诺提供支持或响应时间。安全报告请通过
[`SECURITY.md`](SECURITY.md) 中的私密渠道提交；权威支持声明见
[`docs/release/support-matrix.md`](docs/release/support-matrix.md)。

## 致谢与许可证

本项目是受 Danny Postma 的视频 *How I Built My Own AgentOS on Claude's Agent
SDK (So You Can Too)*（2026）启发的独立实现，从视频中的想法出发从零构建。

任务链的角色与步骤提示词欠的不止是启发：其行文主体来自
[mattpocock/skills](https://github.com/mattpocock/skills) 的五个技能，逐字沿用，
外面包着为本平台契约另写的段落。上游以 MIT 授权，`Copyright (c) 2026 Matt
Pocock`，声明在 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

本快照以 [MIT License](LICENSE) 授权；快照边界由
[`public-snapshot.json`](public-snapshot.json) 定义。
