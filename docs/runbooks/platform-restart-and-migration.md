# 平台重启与生产迁移窗口

**状态：未执行。这是 Leo 的决定点，agent 不得自行执行。**
起草 2026-08-16。批次 4 与批次 2.5 合并后积下的四件事，**必须在同一个窗口里一次做完**，不要分多次。

---

## 为什么必须一次做完

四件事互相咬着：迁移不跑，新 UI 就没数据；API 不重启，新枚举值就不认；
回填跑早了会按错误口径写入。分多次做等于把系统停在几个都不自洽的中间态上。

## 为什么现在还不能做

**前置：必须等 Batch4Fix 合并。**
批次 4 的链外评审报出的 MF-2（用量口径错误）**在在线写入路径上，不只是回填脚本**。
一旦重启，从那一刻起所有新数据都按错误口径累积。先修，再重启。

## 现在就在流血的副作用

跑着的 API 是修复前的构建，**不认识 `BACKLOG` 状态**：

```
PATCH /tasks/:id {"status":"BACKLOG"}
→ 400  expected one of "TODO"|"DOING"|"REVIEW"|"DONE"
```

而 `schema.prisma` 与 `app.ts` 的 `z.nativeEnum(TaskStatus)` 都已经有它。
**后果：看板的 Backlog 列收不了拖放**，Sessions 页同类报错。

---

## 执行清单（按顺序）

### 1. 批次 4 的迁移 —— 必须改造后再跑

迁移文件 `20260816165548_batch4_session_usage`，**未 applied**。
**不要原样执行**，按链外评审的结论拆成两部分：

- **4 个可空列**：走 Prisma，带上有界的 `lock_timeout`
- **两个索引**：**从迁移文件里拿出来**，带外用 `CREATE INDEX CONCURRENTLY` 执行

理由：`SessionEvent` 表 70,672 行 / 122 MB，且有 6 个 runner 正在写入。
`CREATE INDEX`（非 CONCURRENTLY）会持锁阻塞写入。
注意 **`CREATE INDEX CONCURRENTLY` 不能跑在 Prisma 的单文件事务里**——这是物理限制，不是配置问题。

### 2. 批次 2.5 的两支迁移

### 3. 重建 + 重启 API

**风险：reconcile 可能把在跑的链判为孤儿，扫掉它们的工作区（含 `.git`）。**
→ **必须挑链的空档做**，重启前确认没有 RUNNING 的 run。

### 4. 回填 `backfill-session-usage.ts` —— 最后跑

**前置**：必须等 MF-1（并发串行化）与 MF-2（口径修正）都已落地。
MF-1 是 `packages/db/src/usage.ts` 里三个无锁的 await，代码注释声称
*"two concurrent callers would still converge because both compute from the same table"* ——**这句话是错的**。

---

## 收尾验证

- [ ] Backlog 列能接受拖放（`PATCH {"status":"BACKLOG"}` 返回 200）
- [ ] Sessions 页不再报错
- [ ] **批次 4 的 UI 在真实数据下人眼验证一次**——这套界面至今没有被看到工作过
- [ ] 用量数字与源表交叉核对（链外评审当时实测的对照是 545/98 vs 4/77）
- [ ] 回填后抽查若干会话，确认口径与在线写入一致

---

## 回滚

批次 2.5 的回滚步骤见 [`batch-2.5-rollback.md`](batch-2.5-rollback.md)。
批次 4 的四个列是可空新增列，回滚即 drop；索引可独立 drop，不影响正确性。
