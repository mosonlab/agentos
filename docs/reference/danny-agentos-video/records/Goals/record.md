# Goals

## 时间线记录

说明：以下重复出现的左栏均保持为 MMO Game（徽标 23）、Inbox(es)（徽标 16）、Goals 当前项；底部为绿色 Runner、Running、Settings、Sign out，除特别说明外不再重复展开。

### [0:19:10]
- 触发动作：从 Tasks 悬停/切换到 Goals。
- 左栏状态：MMO Game、徽标 23；Inbox(es) 徽标 16；Goals 当前；Runner Running。
- 右栏顶部：Goals；Archive；黄色 + New Goal。
- 右栏主体：Farming 卡片，状态 running；0 of 10 done；$0.30 / $100.00；Iteration 4；Active: Senior Dev；<1h elapsed；进度条；右侧归档与删除图标。
- 页面目录结构：Goals → Archive/New Goal → Farming → 状态、进度、成本、迭代、agent。
- 旁白要点：对没有结构、偏开放式实现的工作使用目标；目标按完成定义运行。

### [0:19:20]
- 触发动作：打开 Farming 目标。
- 左栏状态：同上。
- 右栏顶部：Farming；running；Runner online；Nudge、Pause、Restart session、Adjust limits、Cancel goal。
- 右栏主体：规格摘要 Farming – spec –，说明 renewable-demand loop、till、sow、rake、harvest、seed-quality lineage、area work；Show more；Started from spec: farming.md。状态横条 Senior Dev working – iteration 4。四张统计卡：DoD progress = 0 done · 0 waived · 10 open；Spend = $0.30 / $100.00；Iteration = 4；Active agent = Senior Dev。标签页 Definition of Done、Progress log、Sessions、Orchestrator、Results。
- 页面目录结构：Farming → 状态/控制 → 规格摘要 → session → 四项统计 → 五个标签页。
- 旁白要点：目标基于完成定义运行；可以自己写，也可以直接放入规格说明书。

### [0:19:30]
- 触发动作：在 Definition of Done 中向下滚动。
- 左栏状态：同上。
- 右栏顶部：统计为 0 done · 0 waived · 10 open、$0.30 / $100.00、4、Senior Dev；Definition of Done 选中。
- 右栏主体：Definition of Done: Farming；Spec: 'goals/farming/spec.md' – the single source of detail. §refs below cite its sections by heading.；Codebase intel for implementers（verified against the repo, 2026-08-14）。可见 paving/tilling flatness、append-only TILE_CODES、floraKind/floraState、stages[]/growthMs[]/locksTerraform、weed state、PROTOCOL_VERSION、SKILLS 等条目。
- 页面目录结构：DoD → 标题 → Spec → Codebase intel → 实现注意事项列表。
- 旁白要点：系统生成完成定义并写出成功标准。

### [0:19:35]
- 触发动作：继续滚动 Codebase intel。
- 左栏状态：同上。
- 右栏顶部：Definition of Done 选中；统计卡不变。
- 右栏主体：New tile type is cheap and append-only；TILE_CODES 示例为 dirt, grass, sand, rock, packed-dirt, gravel, brick-road；field 是 terrain 而非 pavement；flora registry、SPREAD_DENSITY_MAX = 5；weed state 需要 floraState 或 LoadedChunk sparse Map；涉及 CHUNK_FORMAT_VERSION、ChunkBytes/ChunkSnapshot；新增 action 遵循 wiki/flows/adding-an-action.md 的 one-file-per-layer checklist。
- 页面目录结构：DoD → tile/terrain → flora/weed/chunk → action/protocol。
- 旁白要点：循环持续到完成定义中的所有复选框满足。

### [0:19:36]
- 触发动作：再次向下滚动。
- 左栏状态：同上。
- 右栏顶部：Definition of Done；右侧滚动条下移。
- 右栏主体：Skill-gain invariant（gain 只读 ctx.skill，tool QL 压缩 timers）；Rake recipes are rows, not engine work（smithing parts catalog、carpentry-from-planks、IMPROVABLES/TREATMENTS、primaryAction）；Bulk goods exist end-to-end（bulk、StoredStack {kind, count, qlSum}、dropItemsToTile）；Area work is the only genuinely new machinery（footprintQuad、deed ghost preview、hover resolvers）；docs/culture.md、docs/to-dos.md 与 build gotcha。
- 页面目录结构：DoD → skills → recipes/items → bulk goods → area work → docs/build。
- 旁白要点：协调器会检查 progress log、完成定义和已实施内容，再生成下一位 agent。

### [0:19:36]
- 触发动作：滚动到 Success Criteria。
- 左栏状态：同上。
- 右栏顶部：Definition of Done 选中；右侧滚动条继续下移。
- 右栏主体：Success Criteria 标题；未勾选 checkbox。Phase 1 – Field & rake：field tile、till 1×1、farming skill、wooden/iron rake、tiled-field rendering；Phase 2 – Crops in the ground：五种 crop/seed、sow、growth clock、offline catch-up；Phase 3 – Harvest & lineage：harvest、clear、seed drops、QL lineage。
- 页面目录结构：DoD → Success Criteria → Phase 1 → Phase 2 → Phase 3。
- 旁白要点：系统运行直到所有成功标准满足。

### [0:19:40]
- 触发动作：继续滚动 Success Criteria。
- 左栏状态：同上。
- 右栏顶部：DoD 标签和统计卡不变。
- 右栏主体：Phase 1–3 仍可见；新增 Phase 4 – Weeds & tending（two weed waves、tend、yield multiplier、withering/fallow）；底部开始出现 Phase 5 – Area work。
- 页面目录结构：Success Criteria → Phase 1–5 顺序清单，每项为 checkbox 与长文本。
- 旁白要点：目标按 success criteria 逐项闭环。

### [0:19:50]
- 触发动作：继续向下滚动。
- 左栏状态：同上。
- 右栏顶部：Definition of Done 选中。
- 右栏主体：Phase 4、Phase 5、Phase 6 – Wild bootstrap；End-to-end acceptance（find wild seeds → craft rake → till → sow → tend → harvest → replant best seed → measurable QL climb → area work）；Per-phase process followed（Plan agent 与 Plan Review Coordinator）；Implementation Review agent；Review fixes landed。
- 页面目录结构：Success Criteria → Phase 4/5/6 → 端到端验收 → phase plan/review → implementation review → fixes。
- 旁白要点：最后步骤必须经过 review 并落地。

### [0:19:53]
- 触发动作：继续滚动成功标准。
- 左栏状态：同上。
- 右栏顶部：DoD 选中；0 done · 0 waived · 10 open。
- 右栏主体：Phase 1–5 长文本和未勾选 checkbox；每项含 Demo、Build and tests green。
- 页面目录结构：Success Criteria → 多阶段验收 → Demo/Build/tests。
- 旁白要点：协调器根据已完成事情判断下一步。

### [0:19:54]
- 触发动作：短距离继续滚动。
- 左栏状态：同上。
- 右栏顶部：Definition of Done 与四项统计不变。
- 右栏主体：Phase 3 harvest/lineage、Phase 4 weeds/tending、Phase 5 area work 同时可见，均未勾选。
- 页面目录结构：Success Criteria → harvest/lineage → weeds/tending → area work。
- 旁白要点：协调器会重新检查进度并决定生成下一个 agent。

### [0:20:00]
- 触发动作：继续滚动到收尾区。
- 左栏状态：同上。
- 右栏顶部：Definition of Done 选中，滚动条靠下。
- 右栏主体：Phase 3–6、End-to-end acceptance、Per-phase process followed、Implementation Review agent；文本说明计划和 review 保存于 goals/farming/。
- 页面目录结构：DoD → 成功标准 → 功能阶段 → 端到端验收 → 计划/审查流程。
- 旁白要点：每个 session 结束后协调器会重新检查状态。

### [0:20:10]
- 触发动作：滚回摘要并点击 Orchestrator。
- 左栏状态：同上。
- 右栏顶部：Farming、running、Runner online；Nudge、Pause、Restart session、Adjust limits、Cancel goal；Senior Dev working – iteration 4；统计 0 done · 0 waived · 10 open、$0.30 / $100.00、4、Senior Dev。
- 右栏主体：Orchestrator 选中。事件：Dispatched iteration 4 – session task created for Senior Dev（12m ago）；Routed iteration 4 → Senior Dev（phases 1–2 plans authored/review-cleared，Senior Dev 为 mandated implementer）；Session completed – router re-evaluating（13m ago）；下方有 iteration 3 Review Coordinator。
- 页面目录结构：Farming → 运行状态 → 统计 → Orchestrator → dispatch/routing/completion 事件流。
- 旁白要点：协调器检查“这个完成了吗”，未完成就生成 Senior Developer 或计划代理。

### [0:20:20]
- 触发动作：在 Orchestrator 事件流中向下滚动。
- 左栏状态：同上。
- 右栏顶部：Orchestrator 选中；状态、控制按钮、统计卡不变。
- 右栏主体：iteration 4 dispatch/routing/completed；Dispatched iteration 3 – session task created for Review Coordinator；Routed iteration 3 → Review Coordinator（每个 Plan agent 后必须 review，禁止实现未审查计划）；Dispatched iteration 2 – session task created for Plan Agent；Routed iteration 2 → Plan Agent（DoD 已写入，下一步 planning，Phase 1/2 可在 120-min budget 内批处理）。
- 页面目录结构：Orchestrator → iteration 4 → iteration 3 review → iteration 2 planning → dispatch/routing/completed。
- 旁白要点：协调器会问“需要做什么”，然后生成计划代理。

### [0:20:30]
- 触发动作：继续滚动事件流。
- 左栏状态：同上。
- 右栏顶部：Farming running、Runner online、Orchestrator 选中。
- 右栏主体：事件行由三角展开图标、路由图标、绿色完成图标构成；可展开查看事件类型、iteration、目标 agent、相对时间及说明。
- 页面目录结构：事件流 → Dispatch → Route → Session completed → router re-evaluate。
- 旁白要点：协调器会根据完成状态继续派发。

### [0:20:40]
- 触发动作：保持 Orchestrator，继续查看日志。
- 左栏状态：同上。
- 右栏顶部：同上。
- 右栏主体：按时间倒序显示 iteration 4 Senior Dev、iteration 3 Review Coordinator、iteration 2 Plan Agent 的 dispatch/routing/session completion。
- 页面目录结构：Farming → Orchestrator → 迭代历史时间线。
- 旁白要点：下一步显然是写计划，系统生成计划代理。

### [0:20:50]
- 触发动作：向下滚动 Orchestrator。
- 左栏状态：同上，Runner Running。
- 右栏顶部：Orchestrator 选中，目标仍 running。
- 右栏主体：继续显示 dispatch/routing/session completion 记录，没有新的表单。
- 页面目录结构：Orchestrator → iteration 事件记录。
- 旁白要点：高级开发人员正在工作；共享收件箱和文件系统让用户看到他们写了什么。

### [0:20:55]
- 触发动作：滚动到结果文件视图。
- 左栏状态：同上。
- 右栏顶部：Farming 目标状态栏和 Results 区域在上方。
- 右栏主体：表格列 File、Size、Updated；plan-phase-1.md（32.7 KB，14/08/2026, 09:23:25）、plan-phase-2.md（37.7 KB，14/08/2026, 09:23:37）、plan-review-phases-1-2.md（24.0 KB，14/08/2026, 09:23:13）。
- 页面目录结构：Farming → Results → File/Size/Updated → 计划与审查文档。
- 旁白要点：可以确切看到 agent 在共享文件系统里写了什么，以及进度日志。

### [0:22:30]
- 触发动作：回到 Goals 列表并滚动到已完成目标。
- 左栏状态：Goals 选中；MMO Game 徽标 23；Inbox 16；Runner Running。
- 右栏顶部：Goals 列表，目标卡均已完成。
- 右栏主体：Butchering：done，10 of 10 done，$59.17 / $125.00，Iteration 9，2h elapsed；Fighting v1：22 of 22 done，$212.42 / $200.00，Iteration 30，18h elapsed；Mining：11 of 11 done，$158.51 / $250.00，Iteration 15，15h elapsed；Fences：10 of 10 done，$128.81 / $100.00，Iteration 15，14h elapsed；下方可见 Climbing、Natural regrowth、Toolbelt 的 done 卡。
- 页面目录结构：Goals → 目标卡 → done → 完成数/进度条 → 花费 → iteration/elapsed。
- 旁白要点：早上写规格并扔进目标系统，系统生成完成定义。

### [0:22:40]
- 触发动作：切换到编辑器中的规格示意图。
- 左栏状态：AgentOS 左栏不可见；为深色编辑器窗口。
- 右栏顶部：标签 agentos-overview.png；顶部 code-agent.yaml — agentos；Update。
- 右栏主体：流程图 YOU → set a goal → GOAL（"Ship the new landing page"）→ broken down into → TASKS（todo → doing → review → done）→ 三个 AGENT（Claude agents running in the cloud）→ SKILLS（how to do things）、KNOWLEDGE（what it knows）、FILES（what it works on）→ INBOX（status updates & questions）→ you reply → agent resumes → ✓ DONE。
- 页面目录结构：YOU → GOAL → TASKS → AGENT → Skills/Knowledge/Files → Inbox → Done。
- 旁白要点：规格就是需要发生的事情的清单。

### [0:22:50]
- 触发动作：切换到 Archived Goals。
- 左栏状态：MMO Game 徽标 23；Inbox 16；Goals 当前；Runner Running。
- 右栏顶部：Archived Goals；Back to goals。
- 右栏主体：Player death（done，8 of 8 done，$5.94 / $100.00，Iteration 15，10h elapsed）；Aggressive spider（8 of 8 done，$7.19 / $100.00，Iteration 29，4h elapsed）；Local chat（8 of 8 done，$1.02 / $50.00，Iteration 8，1h elapsed）；Event console（6 of 6 done，$0.83 / $50.00，Iteration 7，1h elapsed）；Wildlife v1（24 of 24 done，Iteration 14，4h elapsed）；Static waterline（7 of 7 done，Iteration 9，2h elapsed）。每卡有 done、归档/恢复和删除图标。
- 页面目录结构：Archived Goals → Back to goals → 已完成目标卡 → 状态/完成数/进度/花费/迭代/操作。
- 旁白要点：批准完成定义后运行 5–6 小时，用户可以做任何事。

### [0:23:00]
- 触发动作：Archived Goals 页面保持不变。
- 左栏状态：同上。
- 右栏顶部：Archived Goals、Back to goals。
- 右栏主体：同一组已完成卡片与 100% 黄色进度条。
- 页面目录结构：Archived Goals → 已完成目标列表。
- 旁白要点：一天结束收到 PR，人工审查并合并。

### [0:23:10]
- 触发动作：无明显 UI 变化，停留在 Archived Goals。
- 左栏状态：同上。
- 右栏顶部：Archived Goals、Back to goals。
- 右栏主体：归档清单保持可见，支持回到 Goals、恢复/归档和删除。
- 页面目录结构：Archived Goals → 已完成目标卡 → 操作。
- 旁白要点：合并后第二天重新开始；让 agents 做所有事情，用户几乎不需要手动操作。

### [0:23:15]
- 触发动作：无明显 UI 变化。
- 左栏状态：同上。
- 右栏顶部：Archived Goals、Back to goals。
- 右栏主体：已完成目标卡与满进度条保持不变。
- 页面目录结构：Archived Goals → 完成目标 → done/进度/成本/迭代时间。
- 旁白要点：总结这种开放式目标循环很有用，但也可能让人觉得有很多手动工作。

## 功能清单

- Goals 列表、目标卡、状态 running/done、完成数、进度条、成本、iteration、elapsed。
- + New Goal、Archive、Back to goals，以及归档/恢复和删除。
- 从 farming.md 或 goals/farming/spec.md 启动目标。
- 自动生成 Definition of Done 与 Success Criteria。
- DoD 的 done、waived、open 统计与 checkbox。
- 持续运行直到所有完成定义满足。
- Runner online、Nudge、Pause、Restart session、Adjust limits、Cancel goal。
- Progress log、Sessions、Orchestrator、Results 标签页。
- 协调器在 session 完成后重新评估并派发下一轮。
- Plan Agent、Review Coordinator、Senior Dev、Implementation Review agent 的角色调度。
- phase-gating：Plan → Plan Review → implementation。
- Orchestrator 事件流：Dispatched、Routed、Session completed – router re-evaluating。
- 共享 inbox/文件系统、计划文件、进度日志。
- Results 表格 File、Size、Updated。
- 多阶段验收、端到端验收、实施审查与 review fixes。
- 左栏模块：Inbox(es)、Activity、Tasks、Goals、Sessions、Costs、Skills、Environments、Agents、Templates、Files、Knowledge、Repos、Connections、Admin。
- 底部全局区：Runner、Settings、Sign out。
- 工作流：YOU → GOAL → TASKS（todo/doing/review/done）→ AGENT → SKILLS/KNOWLEDGE/FILES → INBOX → DONE。
- 日常流程：早上规格，系统生成 DoD 并运行数小时，晚上 PR 审查合并，第二天继续。

## 仅旁白提及（画面未见）

- 用户可直接编写 Definition of Done，或把规格说明书放入目标系统；截图只显示生成后的 DoD。
- 系统会一直运行到所有 checkbox 都打勾；截图中的 Farming 仍为 0 done · 0 waived · 10 open。
- 协调器会依据 progress log、DoD 和实现内容自动决定下一位 agent；截图显示了日志，但没有显示决策过程本身。
- 用户批准后系统运行 5–6 小时，结束时交付 PR、人工审查并合并；未见 PR 页面或合并操作。
- 用户在 agent 工作期间可以做任何事，甚至几乎什么都不用做。
- 整个 video game 都由该系统开发；截图没有展示游戏本体。
- cooking & food buffs 是 separate、later spec；截图只在规格摘要中间接提及。
- “让 agents 做所有事情真的很有趣”“非常非常好”以及“可能觉得很多手动工作”是体验评价，不是画面功能。
