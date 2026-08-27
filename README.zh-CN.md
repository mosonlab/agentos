<div align="center">

# AgentOS

**面向 coding agent 的本地控制平面。**

把有明确权限范围的任务交给 Codex CLI 与 Claude Code，
并让每一次 run 都可观察、可评审、可持久化。

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

它编排的是你已经安装并完成认证的官方 Codex CLI 与 Claude Code；AgentOS 不捆绑
也不转售任何订阅，provider 条款与套餐限制仍然适用。

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
实验性的 Pi adapter 都是可选的。

```sh
git clone https://github.com/mosonlab/agentos.git
cd agentos
git checkout v0.3.0
npm ci
npm run setup:local
npm run build
docker compose up -d --wait --wait-timeout 60 postgres
export GOAL5A0_MASTER_SHA=8d69ee8544196a3310b3d63caf8ce5ec9a0e023b
export GOAL5A0_CONTROL_PLANE_A_SHA=29f8dd354cb99d671c2e2e4e9e23716fd8004f3d
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
| Pi | 实验性 |
| macOS on Apple Silicon | 目标平台 |
| Linux | 未验证 |
| Windows | 不支持 |

上面的每个标签指的都是本仓库内记录的证据，而不是 CLI provider 的兼容性承诺。
证据边界见 [`docs/status.zh-CN.md`](docs/status.zh-CN.md)，权威支持矩阵见
[`docs/release/support-matrix.md`](docs/release/support-matrix.md)。

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
