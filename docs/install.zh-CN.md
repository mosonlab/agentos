# 安装细节与验证

本文承接 README 中被精简掉的安装细节。权威安装序列见
[`docs/release/v0.1.0-developer-preview.md`](release/v0.1.0-developer-preview.md)。

## 本地启动

Developer Preview 只面向一个平台：Apple Silicon Mac。本版本应使用 `.nvmrc`
记录的 Node.js `22.17.0`。安装会强制要求 Node.js 满足 `^20.19.0 || ^22.13.0 || >=24`，
即锁定工具链共同支持的范围；Node 22.12.x 与 23 会被拒绝。此外还需要

- npm 10.9.2 或更高；
- Docker 与 Docker Compose，用于仓库内定义的 PostgreSQL 服务；
- Git；
- **已安装且已登录**的官方 Codex CLI，位于将要运行 AgentOS runner 的同一个 macOS
  账号下；
- 如果希望 AgentOS 自动创建 pull request，还需在同一账号下安装并认证 GitHub CLI
  (`gh`)；只交付 branch 时不需要它。

本预览只要求 Codex 这一个 provider CLI：它安装的 starter agent 跑在 Codex 上；
Claude Code 与实验性的 Pi adapter 都是可选的，没装它们的机器同样是一份完整安装。
AgentOS 从不替你登录 provider，也从不读取任何凭据存储。

```sh
git clone https://github.com/mosonlab/agentos.git
cd agentos
git checkout v0.2.0
npm ci
npm run setup:local
npm run build
docker compose up -d --wait --wait-timeout 60 postgres
export GOAL5A0_MASTER_SHA=8d69ee8544196a3310b3d63caf8ce5ec9a0e023b
export GOAL5A0_CONTROL_PLANE_A_SHA=29f8dd354cb99d671c2e2e4e9e23716fd8004f3d
npm run db:migrate:release -- --fresh
```

这是发布安装路径，不是 contributor bootstrap。请逐字执行已更正的
[`docs/release/v0.1.0-developer-preview.md`](release/v0.1.0-developer-preview.md)，
包括文件系统、端口、runner identity 与仓库 preflight。然后在三个终端里依次启动
`npm run dev:api`、`npm run dev:runner`、`npm run dev:web`，并打开
`http://127.0.0.1:5173`。

`npm ci` 必须被允许运行 lockfile 声明的生命周期脚本——本仓库的 `postinstall` 生成
Prisma client——因此**不支持 `--ignore-scripts`**。Inbox 服务可选。前台的开发者预览
流程不交付任何 launchd 定义；远程访问和本仓库内部 task-chain 模板同样不属于该流程。
独立自托管的 merge executor 则另有已记录但未经验证的 macOS LaunchDaemon 与 Linux
systemd profile，见公开的
[`docs/runbooks/merge-executor.md`](runbooks/merge-executor.md) runbook。这些流程
不改变上面的平台分级，也不改变权威支持矩阵。

在把它指向任何东西之前先读
[`docs/release/v0.1.0-security.md`](release/v0.1.0-security.md)，在往里放数据
之前先读
[`docs/release/v0.1.0-migration-and-recovery.md`](release/v0.1.0-migration-and-recovery.md)。

`npm run db:migrate` 就是 `prisma migrate dev`，**只用于开发**；它只在
`CONTRIBUTING.md` 中作为开发命令说明，不是安装命令。上面的有闸发布路径运行
`npm run db:migrate:release -- --fresh`。该命令在读取 schema 状态前取得排他维护锁，
并在有闸迁移全程持有它。没有有效 `release-authority.json` attestation 的导出会停下，
不会默认为可信。`--existing` 已实现 verified-bundle consumer，但本仓库不交付用于生成
合规 bundle 的 backup producer。因此受支持的发布流程仍只有 fresh；`--existing` 不会
发出虚构的 “interface unavailable” refusal，也不能被视为受支持的端到端迁移路径。实际
实现的完整流程与拒绝条件见发布 quickstart 和迁移指南。打包、公证与自动更新同样不属于
本发布候选范围。

`npm run setup:local` 会一次性生成权限 0600 的 `.env`：互不相同的 operator 与 runner
token、session cookie secret、base64 编码的 32 字节加密密钥，以及同时写入
`POSTGRES_PASSWORD` 与 `DATABASE_URL` 的同一个数据库口令。它只输出状态类别，从不
输出任何值。`--upgrade` 会保留所有已有 assignment，只补可在本机安全生成的缺键，且
不会自动轮换弱凭据；它没有 overwrite 或 rotation 开关。`.env.example` 只是键位说明
文档，不是用来复制的文件。

要部署 fail-closed 的 merge executor，先读它的
[操作 runbook](runbooks/merge-executor.md)，然后在仓库根目录运行可重复执行、
由人把关的采集向导：

```sh
bash scripts/setup-merge-executor.sh
```

该向导自己不注册任何 App，也不执行任何管理员操作。它采集安装本地的私有 GitHub App
配置，在不读取密钥字节的前提下校验专用 OS 用户与密钥的边界，并把明确的 root 所有
服务接管留给对应的 runbook profile。

## 模板发布演示

`npm run demo:templates -- preflight|setup|instantiate|capture|verify|reset` 驱动
的是保留下来的 v0.2 十二节点发布演示流程；它不是当前分层版 canonical 模板的证据。
该演示的边界和确切命令见
[`docs/demos/templates-release-demo.md`](demos/templates-release-demo.md)。当前
的 Direct 与 Full Assurance 图记录在
[`agents/README.md`](../agents/README.md)。一次彩排或一个 provider 的运行，既不能证明
所有 provider 都兼容，也不能证明全新安装可用。

## 验证

仓库定义了以下检查，按此顺序执行：

```sh
npm run db:validate
npm run typecheck
npm run lint
npm run build
npm test
docker compose config --quiet
npm run test:dependency-gate
npm run test:snapshot-scan
npm run snapshot:scan
```

`npm test` 跑所有 workspace 的单元测试，不需要数据库，也不需要任何服务在跑。但它
需要先跑过 `npm run build`：web 的 CSS 回归测试读取 `apps/web/dist/` 里构建出的
样式表，没有它这一个文件会以 `Build apps/web before running CSS regression
tests` 失败。

`npm run test:db` 是刻意分开的，**不**并入 `npm test`。它把 API 的数据库测试跑在
调用方自己提供的活 PostgreSQL 上，经由 `TEST_DATABASE_URL` 和
`TEST_DATABASE_MAINTENANCE_URL` 指向一个 scratch 数据库——绝不能指向任何你还想保留
的数据库。把它并进 `npm test`，只会让全新 clone 的默认检查因为缺一个服务而失败，
而不是因为存在缺陷而失败。

这些测试会同时跑多个文件，每个文件用自己的数据库：runner 迁移出一个模板，再给每
个文件一份 `CREATE DATABASE ... TEMPLATE` 拷贝，以及各自的 `RUNNER_WORKSPACE_ROOT`、
`CONTROL_PLANE_STATE_DIR` 和 `FILES_ROOT` 子目录。过去逼这些文件排队的正是那一个
共享 schema，而分开的数据库还隔开了 schema 永远隔不开的东西——advisory lock 是按
数据库计的。分发数据库需要 `AGENTOS_ALLOW_SCRATCH_DATABASES=1`，也就是 scratch 数
据库管理器本来就要求的那个开关；没有它，整轮测试就退回到单一共享 schema 上串行执
行，和以前完全一样。`AGENTOS_DBTEST_CONCURRENCY` 决定同时跑几个文件（默认为核数
减一，最多四个——一个测试文件不止一个进程，超过四个笔记本是被压垮而不是变忙），
`AGENTOS_DBTEST_PROVISION=0` 则关掉按文件分发数据库。每一次退出都会清掉自己创建的
东西：失败、Ctrl-C、以及数据库还在分发过程中的失败。清不掉的那一轮会明说并判定失
败，而不是只报告它同时拿到的那些绿色测试。只有被直接杀死的运行才可能留下
`agentos_cp_a_*` 数据库，而下一轮会在开始前回收它们——按名字回收，且只回收创建它
的进程已经消失、也没有任何连接的那些。

`npm run test:dependency-gate` 之所以在这份清单里，是因为根 `npm test` 是
`npm run test --workspaces --if-present`，它永远走不到 `scripts/`。没有这一行，已发布
的 `scripts/goal-5a0-*` 就会在零执行证明的情况下发出去——快照扫描证明的是它们被
*列出*，不是它们仍然会拒绝文件系统根目录、checkout 目录、非空目录、符号链接目录和
不在允许清单里的证据落地位置。它不需要 `node_modules`，也不需要数据库。

`npm run snapshot:scan` 读取被 git 跟踪的工作区，并要求它与 `HEAD` 一致；工作区不
干净时它 fail closed，而不是把改动算到所报告的 commit 头上。

快照命令记录在 [`docs/public-snapshot.md`](public-snapshot.md)。扫描通过是一个
有明确范围的发布关卡，不代表 pattern matching 能发现所有可能的 secret。

`npm run lint` 是一道刻意做小的关卡，`scripts/merge-gate.sh` 会跑它：Biome 检查一份
逐条列出、每条都写明理由的安全规则清单（`biome.jsonc`），typescript-eslint 只检查
唯一一条类型感知规则 `no-floating-promises`，外加一条补上该规则在 `node:test` 上
无法回避的盲点的语法选择器（`eslint.config.mjs`）。它不检查格式化，跑它也永远不会
改写文件。

