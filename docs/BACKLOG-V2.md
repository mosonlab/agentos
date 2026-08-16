# BACKLOG V2 — 对标补齐批次（2026-08-15 定案）

来源：Danny Postma AgentOS 视频对标（`docs/reference/danny-agentos-video/comparison.md`）+ grilling 决议（`docs/reference/danny-agentos-video/decisions.md`，唯一决议源）。V1.5 的 pilot 挂账仍在 `docs/BACKLOG.md`，两边独立记完成度。

状态标记：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成

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

## 批次 2 — Tasks 收尾三件套（第 2 项）

- [ ] scheduler 轮询 cron 到期任务入队
- [ ] webhook 加 secret 校验 + payload→变量映射
- [ ] 任务完成/批准自动将 chainIndex+1 置 TODO（链式推进）
- [ ] 闸门消息标注链条上下文（第几步/后续还有什么/是否有并行评审在跑）——来自 2026-08-16 首次真实使用的困惑反馈
- [ ] 顺手删死模型：Trigger / Automation / InboxConnectionWindow（migration）

## 批次 3 — Inbox 结构化问卷重构（第 11 项）

- [ ] schema 重写：`form.questions[]` / `answers` JSON（决议 §7），废 kind/choices/selectedChoiceId，一次性迁移脚本
- [ ] 前端分页渲染 + 进度 + Back/Next + Recommended + Other（接 SurveyJS 渲染层）
- [ ] 飞书卡片适配新结构，硬编码中文文案英文化

## 批次 4 — Sessions 会话查看器（第 1 项）

- [ ] /sessions 列表 + 详情页：轮询 events 渲染消息流、tool call 折叠、Files touched 聚合
- [ ] "向运行中代理发消息"后置（依赖 runner 注入支持）

## 批次 5 — Goals 协调器（第 5 项，决议 §8）

- [ ] 系统 Agent：注册 `orchestrator-router` 与 `dod-generator`（system 标记、不可派发，模型/档位走 Agents 页配置，初始 Luna 级）
- [ ] 路由循环：session 结束 → orchestrator-router 读 DoD+progress log → dispatch/complete/stuck → Task 入队
- [ ] Phase-gating 硬规则（plan → plan review → implementation）
- [ ] 护栏：最大迭代、预算上限、零进展熔断（判定参考 pi-goal：逐条证据、弱证据=继续、3 轮无进展）
- [ ] UI：DoD 清单（生成→确认→自动打勾）+ Orchestrator 事件流 + 迭代/预算显示

## 长尾（依赖松紧穿插）

- [ ] Templates（第 4 项）：{{var}} 展开 + From template 弹窗预览 + 种子模板 = 轻链（5 步）/ 重链（7 步）两条（定义见 decisions.md §12）
- [ ] Skills 页（第 7 项）：列表 + @uiw/react-md-editor + 发布状态；附件后置
- [ ] Files + 路径落地（第 3 项）：`~/.agentos/` + `~/Documents/agentos/` 迁移、删 AGENTOS_FILES_ROOT、存储薄接口（本地盘实现）、SVAR UI、FilesystemGrant+inside() 权限、FileObject 重设计
- [ ] Activity 流（第 6 项）：/activity 聚合时间线（shadcn Timeline，轮询）
- [ ] Env/Repos CRUD（第 9 项）
- [ ] Connections 整页重写（第 10 项）：编辑表单 + 作用域标签；Last verified/Profile 后置
- [ ] 通知渠道适配器：NotificationAdapter 接口 + 飞书实现（只做接口，不做新渠道）
- [ ] YAML Phase 1：DB↔YAML export/import（因开源提前；兼作种子 agent 发行载体）

## 平台修缮（自举过程中发现，小活随批次穿插）

- [ ] WAITING_INBOX 挂起中的 run 工作区不应被 GC：闸门等待期间 /tmp 工作区被清，resume 报 ENOENT 只能重开会话、丢失会话内上下文（2026-08-16 批次 0 修订环节触发）
- [ ] Agent 归档/下线状态（原版有 published/draft）：有任务历史的 agent 删不掉（外键 500），需要软下线——2026-08-16 裁撤 feasibility 时暴露
- [ ] 非模板任务的 approvalGate 到闸不发飞书卡：手动创建的带闸任务 run 成功后静默停 Review 列，人无从得知（2026-08-16 批次 2 PLAN 触发；批次 2 spec §8-1 已把该歧义摆上桌）
- [ ] retry 应按 agent 当前配置重新推导 runner/model，而非复刻失败 run 的定格配置（2026-08-16：评审任务改完 agent 后 retry 仍按旧 CLAUDE runner 跑 sol，二连败，只能删任务重建）

## 开源发布批次

- [ ] 英文 README + quickstart
- [ ] docker-compose（含 Postgres）/ 安装脚本
- [ ] 种子 agent YAML 阵容
- [ ] runner 安全显著警示 + 远程访问文档（反向代理/Tailscale）+ pg_dump 备份文档
- [ ] License：MIT；发布前定内部中文文档去留

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
