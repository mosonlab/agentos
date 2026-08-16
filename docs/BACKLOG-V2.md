# BACKLOG V2 — 对标补齐批次（2026-08-15 定案）

来源：Danny Postma AgentOS 视频对标（`docs/reference/danny-agentos-video/comparison.md`）+ grilling 决议（`docs/reference/danny-agentos-video/decisions.md`，唯一决议源）。V1.5 的 pilot 挂账仍在 `docs/BACKLOG.md`，两边独立记完成度。

状态标记：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成

细节层差距全量清单（179 条判定：✅61/🟡70/❌41/🚫7）：`docs/reference/danny-agentos-video/detail-gaps.md`（2026-08-16 扫描）——本文件只吸收其前 10 条高价值项，其余以该文件为准逐批次消化。

## 批次 0 — 前端底座迁移

- [ ] 引入 Tailwind v4 + shadcn/ui，现有 ~45 个 CSS 变量色值映射为自定义主题（明暗双主题令牌）
- [ ] 存量 8 页迁移（Connections/Inbox/Projects 只做最小迁移，后续批次整页重写）
- [ ] 亮色模式随主题令牌落地（默认跟系统，可手动切，localStorage）

## 批次 1 — Settings + i18n + 侧栏全局区（第 8 项）

- [ ] 统一升级 Batch 0 留下的 Tailwind v3 版 shadcn 生成组件到 v4 版次；届时统一决定采用 `tw-animate-css` 或保持无动画，避免两代模板混用（Batch 0 已移除当前无效的 `animate-*` / v3 `origin-[--radix-…]` 类）
- [ ] 新建真正的 Settings 页（语言/主题切换 + runner 信息；修复导航错链 /secrets）
- [ ] i18n：zh/en 字典 + context hook，~548 处字符串抽取（派机械代理），UI 默认英文
- [ ] 侧栏底部 Runner 在线状态（heartbeat 已有）+ Inbox 未读徽标
- [ ] Agents 页：claude/codex 模型下拉 + 推理等级下拉（字段已有，纯 UI）；完成后 Leo 复核各 agent 模型
- [ ] 模型选择联动 runnerPreference（选 gpt 系自动落 CODEX、claude 系落 CLAUDE），消灭 model/runner 错配——来自 2026-08-16 评审 run model_not_found 事故
- [ ] Runner 状态浮层补字段：名称/Busy/heartbeat/daemon 版本/CLI 版本/磁盘剩余（detail-gaps #6）
- [ ] Agents 页逐项工具开关（Bash/Read/Write/Edit/…）→ 落到 CLI 原生 --allowedTools：真执行、低成本，不属 §13 裁掉的沙箱范畴（detail-gaps 建议重审项，本窗裁：做）

## 批次 2 — Tasks 收尾三件套（第 2 项）

- [ ] scheduler 轮询 cron 到期任务入队
- [ ] webhook 加 secret 校验 + payload→变量映射
- [ ] 任务完成/批准自动将 chainIndex+1 置 TODO（链式推进）
- [ ] 闸门消息标注链条上下文（第几步/后续还有什么/是否有并行评审在跑）——来自 2026-08-16 首次真实使用的困惑反馈
- [ ] 顺手删死模型：Trigger / Automation / InboxConnectionWindow（migration）

## 批次 2.5 — Tasks 可见性（2026-08-16 立批：批次 2 已在飞不打断，本批承接其 UI 面；批次 0/2 合并后与批次 1/4 并行）

- [ ] 链条可见性：任务详情显示整条链各步状态（第几步/各步 agent/闸门位置），看板卡片标 `n/m 步`+当前活跃步名；Approval 徽标 tooltip；待跑步"立刻开跑"按钮（detail-gaps #4）
- [ ] 触发器管理 UI：Tasks 页五标签（My Tasks/Tasks/Automations/Triggers/Archived）、Automations 表（Schedule 人类可读+可暂停+Recent sessions）、Triggers 表+详情（Fire now/required 变量标注/replay window 防重放/Recent fires）（detail-gaps #3）
- [ ] 看板补齐：Backlog 列、Done 列 Archive All、Archived 视图、任务来源徽标（cron/webhook/手动）（detail-gaps #8）

## 批次 3 — Inbox 结构化问卷重构（第 11 项）

- [ ] schema 重写：`form.questions[]` / `answers` JSON（决议 §7），废 kind/choices/selectedChoiceId，一次性迁移脚本
- [ ] 前端分页渲染 + 进度 + Back/Next + Recommended + Other（接 SurveyJS 渲染层）
- [ ] 飞书卡片适配新结构，硬编码中文文案英文化
- [ ] Inbox 正文 Markdown 渲染（含表格）+ Archive all + "阻塞中"提示条（detail-gaps #5）

## 批次 4 — Sessions 会话查看器（第 1 项；2026-08-16 Leo 裁：**提前**，批次 0 合并后与批次 1 并行首发——dogfood 最大痛点是"看不懂 agent 在干嘛"）

- [ ] /sessions 列表 + 详情页：轮询 events 渲染消息流（agent 文本 / 代码片段带路径 / tool call 折叠展开含参数与返回）、顶部统计条（N messages · N tool calls · N files）、Files touched 聚合折叠区——对齐原版 [0:16:30] 画面
- [ ] 原始事件表（现 TaskDetail 的 JSON 截断流）收进默认折叠的 Debug events 视图，排障用
- [ ] 任务产出（outputs）在任务详情渲染为 Markdown + 分支名/PR 可点链接——spec/plan 正文当前只能去 GitHub 读（2026-08-16 Leo 反馈）
- [ ] run 表加 Cost/Tokens 两列（原版每 run 显示 $ 与 token 数；runner 事件是否已带用量数据实现时验证）——总账最便宜实现，可能免掉整个 Costs 页
- [ ] "向运行中代理发消息"后置（依赖 runner 注入支持）

## 批次 5 — Goals 协调器（第 5 项，决议 §8）

- [ ] 系统 Agent：注册 `orchestrator-router` 与 `dod-generator`（system 标记、不可派发，模型/档位走 Agents 页配置，初始 Luna 级）
- [ ] 路由循环：session 结束 → orchestrator-router 读 DoD+progress log → dispatch/complete/stuck → Task 入队
- [ ] Phase-gating 硬规则（plan → plan review → implementation）
- [ ] 护栏：最大迭代、预算上限、零进展熔断（判定参考 pi-goal：逐条证据、弱证据=继续、3 轮无进展）
- [ ] Session 软收尾：Session budget（分钟）+ Grace period——超预算先向运行中会话注入 Nudge 消息催收尾（提交/push/摘要），宽限期后才强停（detail-gaps §8；**依赖 runner 会话注入能力**，与批次 4 后置的"向运行中代理发消息"同一底座，批次 5 时一并做）（2026-08-16 Leo 裁）
- [ ] UI：DoD 清单（生成→确认→自动打勾）+ Orchestrator 事件流 + 迭代/预算显示
- [ ] Goal 生命周期通知：ready-for-approval / complete 两条 Inbox 系统消息，含 DoD 计数与总花费（detail-gaps #1）
- [ ] Goal 运行控制面：Nudge / Pause（后端已有）/ Restart session / Adjust limits / Cancel（detail-gaps #2）
- [ ] DoD 产出结构规范 + waived 三态语义（护栏"弱证据=继续"的出口）（detail-gaps #7）
- [ ] Agents 页 System Agents 分区 + draft/published/archived 三态（与修缮清单 agent 软下线合并实现）（detail-gaps #10）

## 长尾（依赖松紧穿插）

- [ ] Templates（第 4 项）：{{var}} 展开 + From template 弹窗预览 + 种子模板 = 单链九步一条，小任务靠模板跳步（decisions §12 终版；2026-08-16 细节扫描纠正旧的轻/重链残留）
- [ ] Skills 页（第 7 项）：列表 + @uiw/react-md-editor + 发布状态；附件后置
- [ ] Files + 路径落地（第 3 项）：`~/.agentos/` + `~/Documents/agentos/` 迁移、删 AGENTOS_FILES_ROOT、存储薄接口（本地盘实现）、SVAR UI、FilesystemGrant+inside() 权限、FileObject 重设计、根目录约定（specs/plans/reviews/goals/）+ 文件创建者 agent 溯源 + 未保存离开确认（detail-gaps #9）
- [ ] Activity 流（第 6 项）：/activity 聚合时间线（shadcn Timeline，轮询）
- [ ] Env/Repos CRUD（第 9 项）
- [ ] Connections 整页重写（第 10 项）：编辑表单 + 作用域标签；Last verified/Profile 后置
- [ ] MCP 连接真注入：AgentMCPConnection 授权随 claim 载荷下发，runner 生成 CLI 的 MCP 配置真正启动外部连接（现为纯 DB 元数据，agent 配了 GitHub MCP 等也用不了——2026-08-16 执行面审计发现；定性为功能补缺，非权限工程）
- [ ] 通知渠道适配器：NotificationAdapter 接口 + 飞书实现（只做接口，不做新渠道）
- [ ] YAML Phase 1：DB↔YAML export/import（因开源提前；兼作种子 agent 发行载体）

## 平台修缮（自举过程中发现，小活随批次穿插）

- [x] WAITING_INBOX 挂起中的 run 工作区不应被 GC：闸门等待期间 /tmp 工作区被清，resume 报 ENOENT 只能重开会话、丢失会话内上下文（2026-08-16 批次 0 修订环节触发）— **修缮批次已合并上线，`WAITING_INBOX` 已进 `reconcile.ts` 的 `workspaceKeepStatuses`**
- [ ] Agent 归档/下线状态（原版有 published/draft）：有任务历史的 agent 删不掉（外键 500），需要软下线——2026-08-16 裁撤 feasibility 时暴露
- [ ] runner 并发度参数：单进程 worker 池跑 N 个 run（现=1 run/进程，扩并发只能多开进程；多进程认领 CAS 安全已验证，但产品级并发应是一个配置项）。上限设计：run 是 I/O 等待型（等模型回包），瓶颈是内存/磁盘（npm ci、build 爆发）而非 CPU——默认自适应 `min(核数-1, 内存GB/4)`（下限 2，可配置覆盖；该数=同时跑的 run 数），不用裸核数——run 稳态是等模型回包，但 npm ci/build 爆发吃核吃内存（2026-08-16 四链排队暴露 + Leo 裁：默认要随机器规格走，不固定低值）
- [ ] 非模板任务的 approvalGate 到闸不发飞书卡：手动创建的带闸任务 run 成功后静默停 Review 列，人无从得知（2026-08-16 批次 2 PLAN 触发；批次 2 spec §8-1 已把该歧义摆上桌）— **部分修复**：批次 2 已合并，带 `chainId`/`followUpTaskId` 的任务到闸会发卡（带 PR url + 产物预览）；**纯手工独立任务仍静默**，本条留着
- [x] retry 应按 agent 当前配置重新推导 runner/model，而非复刻失败 run 的定格配置（2026-08-16：评审任务改完 agent 后 retry 仍按旧 CLAUDE runner 跑 sol，二连败，只能删任务重建）— **修缮批次已合并上线**，retry 现调 `deriveRunConfig(task.assigneeAgent, …)` 重推导 runner/model/promptHash，改模型后直接 retry 即可
- [ ] 迁移的破坏性守卫不对称：Files 的 `20260816060946` 有 `FileObject` 行数守卫 + `db:files-precheck` 预检脚本，批次 2 的 `20260816000000` 却是裸 `DROP TABLE Trigger/Automation/InboxConnectionWindow`（上线时库里 InboxConnectionWindow 有 4 行遥测被无声销毁）。删表/删列的迁移应统一要求预检 + 行数守卫（2026-08-16 上线迁移时发现）
- [ ] `db:files-precheck` 未在根 `package.json` 暴露，只能 `npm run db:files-precheck -w @agentos/db`；破坏性迁移的预检应和 `db:migrate` 一样是根级命令，最好由 `db:migrate` 自己前置调用（2026-08-16 上线迁移时发现）
- [ ] **Agents「Capabilities」面板整体下移 3.00 CSS px**（前端收敛批次 `3c1f186` 合并后实测，未记入偏差台账）。用批次自带的截图夹具重拍 20 帧与基线逐像素比对：8 个整页最大偏差 0.232%、Connections 明暗两态**恰好为 0**、20 帧尺寸全等（无重排）；唯独 3× 开关特写帧差 5.0–5.4%，做垂直互相关后**最佳位移恰为 9px@3× = 3.00 CSS px**，对齐后残差从 306,302 掉到 52,008。开关本体（旋钮尺寸、行程、配色）与基线一致，**G2 无回归**；整页帧最佳位移均为 0，说明漂移只在 Capabilities 面板内部。3px 这个整数值指向某处 padding/border 的令牌换算，非随机渲染差。属小活，随批次 1 顺手查（那批要动 Agents 页的每工具开关）
- [ ] `apps/web/src/tests/styles.test.tsx` 读 `dist/assets/*.css`，裸 `npm test` 会对着陈旧产物断言（改了 CSS 不 build 就跑测试 = 假绿/假红）。测试应自己触发构建或读源文件，不该隐式依赖执行顺序（2026-08-16 合并 PR #1 时发现）

## 失败恢复与交付流（2026-08-16 挂账；原 failure-recovery-and-pr-flow 链已撤）

**背景**：2026-08-16 曾为这批开过一条九步链（`chainId 38948720-…`），因与另一窗直接在 master 上修 Sol 崩溃的工作撞车而当场撤销（① 已 DONE 并留说明，②–⑨ 已删）。那一窗已落地的部分**不在本节范围内**：codex `0.144.1 → 0.147.0`、结构化 provider 错误优先写 `failureReason`（不再被 models-cache 告警刷掉）、`ENOENT|No such file` 不再被误判成 `BINARY_NOT_FOUND`（只认 exit 127）。以下是**没人做**的剩余部分。

**共同前置**：四条里三条动 `packages/runner/src/*` 与 `packages/api/src/app.ts`，与上述改动同文件。**必须等那一窗的改动提交并合入 master 之后才能派**，否则链上 ⑤ 从 GitHub master 克隆，看不到未提交的改动，必然冲突。

- [ ] **失败 run 的 stdout 落盘（取证）** — 中价值。runner 已经在发（`runner.ts` completeRun body 的 `output`，尾部 50 万字符），API 只在成功时写进 `TaskStepOutput`（`app.ts` 约 2076-2095），失败直接丢；`Run` 表无 output 列。约束：`TaskStepOutput.taskId` 是 `@unique`，一个任务一行，而一个任务可以死 5 次（Files ⑥ 实测），所以按 run 存需要新地方。**验收**：下次猝死能从库里归因；做不到就升级为把全量 stdout 落进工作区文件再随 WIP 一起抢救。注：codex 升级 0.147 后急性痛点可能已消失，本条现在的价值是"下一次再猝死时不再瞎"的保险
- [x] **WIP 抢救先 commit 再推** — **已完成**：`deliverFailedWorkspace` 先暂存并提交可追踪改动，再以普通 push 推送 run 分支；保持绝不 force-push、绝不开 PR、抢救失败不得盖住真实失败原因，并将抢救提交的新 `headSha` 上报平台
- [ ] **一链一 PR** — 中价值，且**现在仍在发生**：2026-08-16 前端链的 ① 是纯文档步，照样开了 PR #33。按 head 分支复用 open PR 的逻辑**早已实现**（`delivery.ts` 用 `gh pr list --head <branch> --state open`），缺的是两件：①`enqueueTaskRun`（`packages/db/src/workflow.ts`）里算 `chainBranch` 的条件写死了 `task.templateId`，**API 建的 `chainId` 链拿不到共享分支**，于是每步落回 `agentos/<taskId>/run-<n>` 各自一个 head、各自一个 PR（四条链刷 32 个 PR 的成因）；②"哪些步开 PR"要放进建链数据（如 `opensPullRequest` 布尔），纯文档步只推分支不开 PR，**不许在 runner 里 grep 步骤名**
- [ ] **工作区依赖注入（APFS clonefile）** — 低价值，纯效率。`provisionWorkspace`（`packages/runner/src/workspace.ts`）clone 后按 `package-lock.json` hash 分桶，命中用 `cp -Rc` 克隆 node_modules，未命中跑一次 `npm ci` 存新桶。注意 runner 里**现在根本没有 `npm ci` 调用**，依赖是 agent 自己在会话里装的。边界：clonefile 仅同 APFS 卷有效，跨卷静默退化成普通复制（慢但正确），Linux 等价物 `--reflink=auto`；损坏的桶绝不能交给 agent；缓存需要容量上限。**已实测推翻的理由不要再写进 spec**：npm 输出撑爆上下文导致猝死（热缓存 21.2 秒/37 行）
- [x] ~~新增 `USAGE_LIMIT`/`PROVIDER_ERROR` 可重试分类~~ — **已由上述分类器修复顺带解决**：`BINARY_NOT_FOUND` 不再抢在前面吃掉文本，用量超限现在正常命中既有的 `RATE_LIMITED` 分支（`/429|rate.?limit|usage.?limit|quota/`，`retryable: true`），自动重试生效。无需新分类

## 开源发布批次

- [ ] 英文 README + quickstart
- [ ] docker-compose（含 Postgres）/ 安装脚本
- [ ] 种子 agent YAML 阵容
- [ ] runner 安全显著警示 + 远程访问文档（反向代理/Tailscale）+ pg_dump 备份文档
- [ ] 权限诚实化（2026-08-16 Leo 裁，替代做强制）：filesystem grants / Environment networking 等未执行项在 UI 标注 "not enforced"；文档给出两个真隔离方案——受限 macOS 用户运行 runner（推荐）与 `RUNNER_RUN_AS_PREFIX` 套 Docker；不做应用层沙箱
- [ ] License：MIT；发布前定内部中文文档去留
- [ ] **示例 plist 不设 `RUNNER_PATH`，全新安装大概率开局就 `BINARY_NOT_FOUND`**（`deploy/com.agentos.runner.plist:12` 只给了 `PATH`，没有 `RUNNER_PATH`）。runner 传给 CLI 子进程的是 `RUNNER_PATH`（`packages/runner/src/config.ts:33`），缺省值 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` 不含 `~/.npm-global/bin` 与 `~/.local/bin`——而 `claude` 通常就装在 npm 全局前缀下。后果：装完即用会直接撞 `BINARY_NOT_FOUND`，且该分类 `retryable: false`，新用户第一条任务就死且无从下手。修：示例 plist 补 `RUNNER_PATH` 并在 quickstart 里写明"用 `which claude` 的结果所在目录填进去"；另可在 runner 启动预检里对 `binaries` 做一次 `which`，缺失时明确报「CLI 不在 RUNNER_PATH 上」而不是等第一个 run 失败。**2026-08-16 实测**：本机 6 个 plist 的 `RUNNER_PATH` 同样缺 `~/.local/bin`，导致 agent 读得到 `~/.claude/skills/ego-browser` 技能却跑不了它的二进制，只能自己用 CDP 驱动 headless Chrome 顶上（已现场补齐并重载 runner）。

## Files / 平台缺陷（Files 批次评审产出，2026-08-16）

- [ ] **`classifyError` 把任何含 ENOENT 的输出判成 `BINARY_NOT_FOUND`**（`packages/runner/src/adapters.ts:494-499`）。
      它 grep 的是整个 stdout/stderr，所以任何正常做文件系统操作的 agent 都可能被误判为「CLI 没装」，
      且 `retryable: false`、`operatorAction` 把人引向「装 CLI / 修 RUNNER_PATH」，真实故障被完全掩盖。
      实战代价：Files 批次的第 ⑥ 步评审因此连挂五次，报告全丢。
      修法：限制到 spawn 失败 / exit 127 / 结构化 preflight 证据。
      **本批次刻意未改**——属于平台全局行为、与 Files 无关，改它会影响另外三条在飞的链。
- [ ] **`LocalFileStore` 的 post-walk 目录替换（TOCTOU）需要 fd-relative 遍历才能真正关闭。**
      纯 Node 没有 `openat`；关闭它需要一个 native helper（或 `node:fs` 提供 fd-relative 原语）。
      缺口是真的、可复现的：`AGENTOS_RACE_PROBE=1 node --import tsx --test src/files/local.test.ts`
      （探针 24，毫秒级命中）。当前的替代品是启动期检查靠山是否存在
      （`assertFilesRootIsolated` / `warnIfRunnerSharesPrincipal`），不是修复。
- [ ] **`FilesystemGrant` 的 whole-root 哨兵值 `""` 应改成显式的 `wholeRoot: boolean`。**
      本次退档为 pre-trim 校验（空白输入不再静默变成整根授权），因为改 schema 需要同步动 `apps/web`
      并加大与批次 2 的三方 schema 合并难度。哨兵值本身仍然是「一个笔误 = 全部权限」的形状。

## 远期

- [ ] YAML Phase 2（diff/pull/push）、Phase 3（task/goal 创建）
- [ ] Costs：先评估 cc-switch 够不够，需归因再自研（Prisma groupBy + Recharts，约 2-3 天）
- [ ] Inbox 移动端 PWA + 推送
- [ ] Knowledge（等对标物/自身需求明确）
- [ ] Agent 长期记忆（原版 memoryEnabled 对应能力）
- [ ] 官方 /goal 作 session 内防泄气优化（可选）

## 不做（已关闭）

- Admin 管理台（单用户场景）
- 本地/云 Runner 混合路由（无原版的省费痛点）
