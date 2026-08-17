# 链条运维规程

九步链（①spec ②plan ③plan review ④plan revision ⑤implement ⑥code review ⑦review fixes ⑧wiki ⑨human PR review）
的日常操作规程。**只收长期有效的东西**——"哪条链跑到哪"这类会话态不进本文件，留在当次的交接文档里。

来源：2026-08-16 通宵值守，四个批次合并、五次故障救火的实战沉淀。

---

## 合并流程

1. `gh pr list` 找**领先 master 提交数最多**的分支 —— **不是最后一步的分支**。
   链的分支是从 spec 提交长出来的兄弟分支，不是栈；每步一个 PR，所以"最后一步"往往只含它自己那点改动。
2. 确认 wiki 那步的分支是否已含前一步的实现（⑦⑧ 的分支自愈机制已三次验证有效）。
3. 四道闸，顺序不能换：
   `npm install` → **`npm run build -w @agentos/web`** → `npm test` → `npm run typecheck`
   build 必须在 test 之前：`styles.test.tsx` 读 `dist/assets/*.css`，裸跑 `npm test` 会对陈旧产物断言。
4. **逐条 `git show` 核对 must-fix 是真代码**，不采信任务输出里"已应用"的声明。
5. `gh pr merge <N> --merge` → 关掉同链其余 PR → ⑨ 标 DONE。
6. **收尾必做**：`POST /inbox/messages/:id/decision {"decision":"approve","requestId":"..."}` 关掉 ⑨ 的闸门消息。
   PATCH 标 DONE **不会**关它（平台缺陷，已挂账）。**URL 结尾是 `/decision`，漏了返回 `{"error":"Not found"}`。**

### 合并前置条件（不满足就停手，留记录给人）

1. ⑥ 或链外评审的 must-fix，⑦ 没有全部解决
2. ⑦ 或 ⑧ 失败 / 超时
3. PR 的 `mergeable != MERGEABLE`
4. 本地四道闸不绿

---

## 建链

```sh
python3 scratchpad/mkbatch.py docs/briefs/<brief>.md <slug> "<title>" "<Prefix>"
```

已烧进任务书模板的东西：

- ⑥ 用专职 `code-reviewer`；模型与 runner 只放在 agent 配置，不写进任务提示词
- ⑥ 的统一独立性规则：**REVIEW INDEPENDENCE** —— 模型或厂商标签不构成独立性或质量证据；
  所有结论从 diff、文件与实测重新推导，plan、commit message、前序产出和 activity 都只当待核声明；
  报告必须独立成立，不假设另一位评审会兜底
- **⑥⑦⑧ 的分支自愈段**：找不到含实现的树就明说并停止——
  *"a review of the wrong tree is worse than no review, because it reads as a clean verdict."*
- ⑤⑥⑦ 带 ego-browser 段
- ⑤ 的 build-before-test
- **⑦ 的证据标准**：逐条给 commit SHA + 文件/符号 + 一个"回退修复就会红"的测试；
  被否决的条目也要有一行给出机制；两份评审打架时写冲突台账；**不许有任何条目被静默处理**
- 禁止对活库副本起第二个 control plane

①② 建成 `gate=False`。**视觉方向类的 ① 必须 `gate=True`**（定整个 app 的观感，要人拍板）。

### 关于"修复验证步"——决定不加

三次抽查全是真代码，改为要求 ⑦ 逐条给可核对证据（已进模板）。
**触发条件**：出现一次"声称已修但 diff 里没有"，立刻加，不再讨论。

---

## 链外并行评审（只对含后端/迁移的批次）

⑤ 一完成就另建链外评审任务，targetBranch 指实现分支，与 ⑥ 并行；
⑦ 的 description 写上该任务 id 让它主动拉取，并要求写冲突台账。**纯前端批次不配。**

两次实战结果：

| 批次 | 主评审（Opus ⑥） | 链外评审 | 净贡献 |
|---|---|---|---|
| 2.5 | PASS，1 必修 | **FAIL，6 必修** | 6/6 逐条 `git show` 核实为真代码，零虚构 |
| 4 | 原 PASS，1 必修 | **FAIL，3 必修 1 应修** | **拦下了一次即将执行的生产迁移** |

更高价值的产出其实是 ⑦ 的**冲突台账**：两份评审都可能开错药方。
实测中出现过"必要但不充分"（药方治不了它自己的回归测试）、"药方本身是错的"（改动打破既有测试）、
"物理上不可能"（`CREATE INDEX CONCURRENTLY` 不能跑在 Prisma 的事务里）三种。

---

## ⚠️ 交付期网络瞬断——最高频的人工消耗

一晚复发 5 次，是无人值守不可行的**首要根因**。每次处置相同：

1. `git ls-remote --heads origin 'agentos/<taskId>/*'` 看分支在不在
2. `git fetch` + `git log --oneline origin/master..FETCH_HEAD` 核对内容
3. 查 `/tasks/<id>/output` 确认产出已持久化
4. 产出还在 → `PATCH {"status":"DONE"}`（后继自动激活）；**clone 阶段就断的 → `PATCH {"status":"TODO"}` 纯白重试**
5. 写一条 activity 说明原因

**五次实例**：被毁工作区跑 git、交付期 SSL ×2、clone 阶段 SSL ×2、`gh` 建 PR `graphql: EOF`。

**两个该修的地方**：
- clone/push 的网络错误应进 retry 白名单（现在 `TOOL_FAILED`/`TASK_FAILED` 不可重试）
- **push 之后的交付失败根本不该把 run 标失败**——代码早推上去了，只因建 PR 时 EOF 就整个判死

**手工操作时的自救**：push/fetch 套重试循环
`for i in 1 2 3 4 5; do … && break; sleep 6; done` —— 实测每次都是第 1–2 次就通。

---

## 环境与端点

- 前端 **:5174**，launchd 托管 `~/Library/LaunchAgents/com.agentos.web.plist`（KeepAlive + RunAtLoad）。
  **不要用后台 shell 起 vite**——那种进程随后台 shell 一起被杀，这是它反复打不开的真正原因。
  重载：`launchctl kickstart -k gui/501/com.agentos.web`
- **5173 是 agent 做浏览器验证时自己占的**（任务书里写死的），别动、别把常驻服务挪过去
- API **:3000**。鉴权 `Bearer $(grep '^OPERATOR_TOKEN=' .env | cut -d= -f2)`。**token 不进任何提交物或任务 description。**
- 端点：任务列表 `/tasks`（不是 `/projects/:id/tasks`）· 产出 `/tasks/:id/output` ·
  活动 `/tasks/:id/activity` · 闸门 `/inbox/messages` + `POST /inbox/messages/:id/decision`
- runner 重载要 `bootout` → **等 10 秒以上** → `bootstrap`
- **`Page.captureScreenshot` 在本环境必超时**（多个 agent 都撞到），几何与样式改用 `js()` 实测，不是环境故障
- **有 run 记录的任务 DELETE 返回 500**（外键），只能标 DONE 存档 + 写 activity 说明

---

## 硬性禁区

- **绝不对活库或其任何副本起第二个 control plane。**
  副本仍把在跑的 run 列为 RUNNING，而第二个 API 不持有那些 runtimeHandle，
  它的 reconciler 会把它们判为孤儿并删掉工作区——**包括 `.git`**。
  绝不 dump 或复制活库，绝不让第二个 API 进程指向它。
- agent 不得重启 launchd 服务、不得重启 runner 或 API、不得自行合并。
- 任务书一律写明「不要调用 `inbox_ask`」。

---

## 平台机制备忘（踩过的坑）

- **`approvalGate` 不能当汇合点。** 它拦的是"跑完之后往下走"，不拦"开跑"。
  想要真汇合只能串行建步。
- `activateChainSuccessor`（`packages/db/src/workflow.ts`）：非 AGENT 后继一律进 REVIEW + `gateQuestion`，
  与 `approvalGate` 无关；agent 步骤才看 `approvalGate`。
- 开闸看步骤类型（`workflow.ts:254`），关闸看 `approvalGate`（`app.ts:1335`）——**两套判据，所以闸门消息关不掉**。
- 链的分支拓扑：兄弟分支挂在 spec 提交上，不是栈；每步一个 PR。

---

## 什么时候投链、什么时候直接做

**投链**：动生产数据/迁移/链条机器本身 · 量大到 spec/plan 真能降风险 · 需要可追溯的决策记录 ·
机械体力活会淹掉监工窗上下文。

**直接做（或开子代理）**：改动局部且能机械验证 · 诊断与测量 · 运维动作（合并/放闸/救任务/端口进程） ·
它挡着别的事、链的延迟本身就是主要成本。

**子代理模式（已验证）**：给它同样的实测基线与验收标准、同样的禁区，省掉九步链的仪式，只剩「做 + 我验」。
**必须用自己的脚本复现它的数字**，不采信它的报告。

**门槛是浮动的**：链的人工消耗越高（targetBranch 手改、多个 PR 手关、闸门手关），门槛越要往"直接做"挪。
这些手工负担被平台修复消化掉之后，门槛可以挪回来。
