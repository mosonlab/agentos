# BACKLOG V2 — 对标补齐批次（2026-08-15 定案）

来源：Danny Postma AgentOS 视频对标（`docs/reference/danny-agentos-video/comparison.md`）+ grilling 决议（`docs/reference/danny-agentos-video/decisions.md`，唯一决议源）。V1.5 的 pilot 挂账仍在 `docs/BACKLOG.md`，两边独立记完成度。

状态标记：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成

细节层差距全量清单（179 条判定：✅61/🟡70/❌41/🚫7）：`docs/reference/danny-agentos-video/detail-gaps.md`（2026-08-16 扫描）——本文件只吸收其前 10 条高价值项，其余以该文件为准逐批次消化。

## 批次 0 — 前端底座迁移

- [ ] 引入 Tailwind v4 + shadcn/ui，现有 ~45 个 CSS 变量色值映射为自定义主题（明暗双主题令牌）
- [ ] 存量 8 页迁移（Connections/Inbox/Projects 只做最小迁移，后续批次整页重写）
- [ ] 亮色模式随主题令牌落地（默认跟系统，可手动切，localStorage）

## 批次 1 — Settings + i18n + 侧栏全局区（第 8 项）

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
- [ ] 链条可见性：任务详情显示整条链各步状态；看板卡片标 `n/m 步`+当前活跃步名（detail-gaps #4——现在链条跑到哪一步页面上完全不可见）
- [ ] 触发器管理 UI：cron/webhook 列表、Fire now、Recent fires、webhook replay window 防重放（detail-gaps #3；依赖本批后端，UI 可顺延到批次 4 窗口）
- [ ] 看板补齐：Backlog 列、Archive All、Archived 视图、任务来源徽标（cron/webhook/手动）（detail-gaps #8）

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

- [ ] WAITING_INBOX 挂起中的 run 工作区不应被 GC：闸门等待期间 /tmp 工作区被清，resume 报 ENOENT 只能重开会话、丢失会话内上下文（2026-08-16 批次 0 修订环节触发）
- [ ] Agent 归档/下线状态（原版有 published/draft）：有任务历史的 agent 删不掉（外键 500），需要软下线——2026-08-16 裁撤 feasibility 时暴露
- [ ] runner 并发度参数：单进程 worker 池跑 N 个 run（现=1 run/进程，扩并发只能多开进程；多进程认领 CAS 安全已验证，但产品级并发应是一个配置项）。上限设计：run 是 I/O 等待型（等模型回包），瓶颈是内存/磁盘（npm ci、build 爆发）而非 CPU——默认自适应 `min(核数-1, 内存GB/4)`（下限 2，可配置覆盖；该数=同时跑的 run 数），不用裸核数——run 稳态是等模型回包，但 npm ci/build 爆发吃核吃内存（2026-08-16 四链排队暴露 + Leo 裁：默认要随机器规格走，不固定低值）
- [ ] 非模板任务的 approvalGate 到闸不发飞书卡：手动创建的带闸任务 run 成功后静默停 Review 列，人无从得知（2026-08-16 批次 2 PLAN 触发；批次 2 spec §8-1 已把该歧义摆上桌）
- [ ] retry 应按 agent 当前配置重新推导 runner/model，而非复刻失败 run 的定格配置（2026-08-16：评审任务改完 agent 后 retry 仍按旧 CLAUDE runner 跑 sol，二连败，只能删任务重建）

## 开源发布批次

- [ ] 英文 README + quickstart
- [ ] docker-compose（含 Postgres）/ 安装脚本
- [ ] 种子 agent YAML 阵容
- [ ] runner 安全显著警示 + 远程访问文档（反向代理/Tailscale）+ pg_dump 备份文档
- [ ] 权限诚实化（2026-08-16 Leo 裁，替代做强制）：filesystem grants / Environment networking 等未执行项在 UI 标注 "not enforced"；文档给出两个真隔离方案——受限 macOS 用户运行 runner（推荐）与 `RUNNER_RUN_AS_PREFIX` 套 Docker；不做应用层沙箱
- [ ] License：MIT；发布前定内部中文文档去留

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
