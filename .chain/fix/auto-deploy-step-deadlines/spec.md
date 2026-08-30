2026-08-30 部署 61a4c4e9 时一次约 44 分钟的 API 停摆。**同日已取得对照数据，原因方向已被对照推翻一次**，见下。修复形状不受影响，仍然成立。

## 对照实测（两轮真实部署）

| | 第一轮 `61a4c4e9`（**空**迁移） | 第二轮 `98dbbabb`（C3 **真**迁移 + 一次性 backfill） |
|---|---|---|
| preflight 子步 | **9m46s** (03:58:47→04:08:33) | **4.4s** (05:02:31→05:02:35) |
| migrate 子步 | **33m28s** (04:08:33→04:42:01) | **1m15s** (05:02:35→05:03:50) |
| API 停摆 | 约 44 分钟 | 约 3.5 分钟 |

第一轮的 release 不含任何新增 migration（`_prisma_migrations` 无未完成行，已应用尾部与该 release 完全一致），迁移步是**空操作**却跑了 33 分半；第二轮带真迁移和 backfill，只用 75 秒。

**因此可以排除：** 不是与迁移内容相关，也不是固定开销。**第一轮是异常**，并且它的 preflight 与 migrate **两步一起慢**——这指向两步共有的环境因素，而不是迁移逻辑本身。

## 现场取证（第一轮）

卡住时 `prisma migrate deploy`（deploy job 的直接子进程）0% CPU、`pg_stat_activity` 里**无任何连接**、**无 migration engine 子进程**。最终它自己走完了——是极慢，不是死锁。

期间 `com.agentos.api` 与全部 10 个 runner 标签 last exit = 75 (EX_TEMPFAIL)，即 wrapper 在报 deploy barrier 仍被持有。web (4173) 与 inbox 不受影响。

## 已证伪 / 已排除（勿重复走）

- **不是连接耗尽**：当时 39/100 connections。
- **不是在等数据库锁**：该进程根本没有数据库连接。
- **与那 11 个 advisory lock 无关**：其 classid 为 `1095192403`（"AGDS"），barrier 是 `1095189584`（"AGDP"），不是同一类锁。本卡初版曾假设 KeepAlive 反复重启服务抢锁饿死迁移，**已证伪**。
- **不是迁移内容或固定开销**：见上方对照表。

## 当前最可能的方向（未证实）

机器级资源争用。第一轮（03:58–04:42）正好与多轮 merge-train 门控并发，且机器上另有一组 `packages/db` 的 `node --test` 进程在跑；第二轮（05:02）跑在空闲机器上。这与「两步一起慢」和「0% CPU 却不动」（在等 I/O 或进程启动，而非在算）都吻合。

**下次复现时先做的事**：对该 pid 跑 `sample <pid>` 拿栈，同时记录当时的机器负载与并发任务。不要从数据库查起。

## 根因（这一条与上面无关，独立成立）

**恢复机制对失败穷尽，对存活性全盲。** 本次事故全程没有 `escalated.json`：

1. `command()`（`scripts/deploy/quiet-window-deploy.mjs:88`）用 `spawn()` 起每步，Promise **只在子进程 close/error 时 settle**。没有 timeout、没有 AbortSignal、没有 kill 期限。全文件唯一超时是 `/health` 与 `/version` 探针的两个 2 秒 `AbortSignal.timeout`。
2. escalation 是**失败驱动**：步骤抛 `DeployFailure` → `persistAndNotifyFailure` → `writeEscalation`。
3. deploy barrier 是**会话级 Postgres advisory lock**（classid `0x41474450` "AGDP"，key 1），由部署进程持有，会话结束时自动释放。所以任何一次*失败*，进程退出，锁自动掉，服务恢复。

挂起或极慢同时打穿三条：不抛异常所以不写 escalation，不退出所以 barrier 不释放，无看门狗所以无人知情。runbook 里「读 escalated.json → 修根因 → --clear-escalation」这条唯一恢复路径在这种形态下够不着，操作员没有任何文档化手段。

## 修复形状（不依赖上面的成因结论）

即便成因只是偶发争用，一个无上界的步骤能把 API 和全部 runner 拖停 44 分钟且不告警，本身就是缺陷。核心一条：**给 `command()` 加每步期限**，到期 SIGTERM→SIGKILL 并抛 `DeployFailure`。把「挂起/超时」翻译成「失败」后，**现有恢复链条原封不动生效**：写 escalated.json、发 inbox、进程退出、barrier 自动释放、服务回到 current、操作员照 runbook 跑 `--clear-escalation`。不需要发明新恢复路径——runbook 明令禁止发明恢复路径，这个形状正好绕开该约束。

三个不能省的细节：

- **预算分步给，不设全局值**。构建约 8–10 分钟属正常，空迁移应是秒级。单一数字要么松到抓不住本次，要么紧到误杀构建。对照表可直接用作定预算的基线。
- **迁移步超时不能照抄其他步骤**。空迁移杀掉安全，真迁移写到一半被杀不安全——那时释放 barrier 会让服务重启到半应用的 schema 上。迁移步超时应 **escalate 但继续压住 barrier**（把服务留在停摆这个安全态）。这是要人拍的取舍，不是一行配置。
- **再加一层 barrier 时长看门狗**。barrier 才是造成对外停摆的东西，应有独立于任何步骤的上界，超时即告警，这样 `command()` 之外的挂起也能被抓到。

日志在 `~/Library/Logs/Anneal/auto-deploy.log`。相邻但不同的既有卡：「Auto-deploy escalation: self-clear」。

## Ruling (Moson, 2026-08-30)

When the migrate step exceeds its budget: escalate (write escalated.json, notify inbox, exit non-zero) but do NOT release the deploy barrier. The services stay stopped on the safe side until an operator clears the escalation; a restart onto a half-applied schema is the worse outcome. Every other step's timeout follows the plain path: kill, DeployFailure, barrier released with the process, services return to current.

Route: implementation=senior-dev
