# Files：运行期路径、授权边界与已知缺口

这页描述 Files 批次当前运行时的行为，面向部署/运维人员和以后修改文件访问代码的人。
部署步骤见 [`docs/runbooks/files-deployment.md`](../runbooks/files-deployment.md)；评审修复记录见
[`docs/reviews/batch-files-fixes.md`](../reviews/batch-files-fixes.md)。那两份文档承载迁移操作和威胁模型细节，
本页只保留读代码、定位故障和判断边界所需的运行期知识。

## 先看这里：FilesystemGrant 不是本机默认配置下的安全边界

本机 `RUNNER_RUN_AS_PREFIX` 为空，agent 与平台进程使用同一个 uid。
在没有 run-as 低权限账号或等价 sandbox 的前提下，`FilesystemGrant` 只是防误操作的护栏：

- 它挡住 agent 通过 `files_*` MCP 工具越界；
- 它挡不住 agent 直接开 shell，读取或写入同 uid 有权限访问的任意文件，包括 `FILES_ROOT` 之外的文件。

真正把 grant 变成安全边界的部署前提是：模型 CLI 运行在不同的低权限 principal 下，且该 principal 对
`FILES_ROOT` 及其父路径没有 traverse/write 权限。API 启动时会拒绝 `FILES_ROOT` 与
`RUNNER_WORKSPACE_ROOT` 重叠，并在 `RUNNER_RUN_AS_PREFIX` 为空时打印警告；这两项是靠山检查，
不是把本机同 uid 配置变成隔离环境。

## `files_read` 的完整路径

`files_read` 只有一个真实终点：受 grant 检查的磁盘读取。当前代码不会把内容写进 `FileObject`。
`FileObject` 和 `TaskAttachment` 已由迁移 `20260816060946_files_drop_dead_models` 删除，数据库只保留
`FilesystemGrant` 权限行；文件内容和目录状态以 `FILES_ROOT` 下的磁盘为准。

```text
agent CLI
  │ stdio JSON-RPC
  ▼
runner/mcp-server.ts
  tools/list  ────────────────► 无条件返回 TOOLS（4 个控制工具 + 4 个 files_*）
  tools/call(files_read)
       │ 校验 path；fetch /session/runs/:runId/files/content
       │ Authorization: Bearer agos_session_...
       ▼
API app.ts 全局 middleware
  authenticate() + principalMayAccess()
  session token / runId 不匹配 ──► 401/403（fail-closed）
       ▼
sessionFileAccess()
  查 Run → agentId → 查 FilesystemGrant
  getFileStore() → grantAdmits()
       │ normalizeRelPath + store.grantKey(filesystemKey)
       │ contains(grantKey, requestKey) + required canRead
       └─ 无可用 grant / 脏 grant / key=null ─► 403（fail-closed）
       ▼
LocalFileStore.stat(path)
  resolveContained(existing) → lexical root assertion
  component-wise lstat（不跟随中间 symlink）
  final lstat；不存在 → 404；超过 5 MiB → 413
       ▼
LocalFileStore.read(path)
  resolveContained(existing)
  open(O_RDONLY | O_NOFOLLOW)
  handle.fstat()；普通文件 nlink > 1 → HardLinkError
  handle.readFile()
       │ Symlink/路径/硬链接错误 → 400（fail-closed）
       ▼
API 返回 {content, encoding, stat}
  UTF-8 → encoding=utf8；否则 → encoding=base64

旧的 FileObject 落库终点：不存在。没有 db.fileObject.create/update；磁盘是 source of truth。
```

代码所在层：

- MCP 协议面在 [`packages/runner/src/mcp-server.ts`](../../packages/runner/src/mcp-server.ts)：
  `tools/list` 直接返回 `TOOLS`，`tools/call` 进入 `invokeTool`；`files_read` 转成 session API 的 GET。
- principal 鉴权和 URL 作用域在 [`packages/api/src/auth.ts`](../../packages/api/src/auth.ts) 与
  [`packages/api/src/app.ts`](../../packages/api/src/app.ts) 的全局 middleware。session token 失效、过期、
  被撤销或不属于 URL 中的 run 时，不能进入文件路由。
- grant 查询和能力判断在 `app.ts:1707-1715` 的 `sessionFileAccess`、
  [`packages/api/src/files/grants.ts`](../../packages/api/src/files/grants.ts)。`list/stat/read` 需要
  `canRead`，`write/mkdir` 需要 `canWrite`，`delete` 需要 `canDelete`。没有 grant 不会把请求交给磁盘。
- 路径规范化和纯词法规则在 [`packages/api/src/files/paths.ts`](../../packages/api/src/files/paths.ts)。
  HTTP 边界只解码一次；store 和 paths 层不再次 percent-decode。
- 真实 root、grant key、启动期检查在
  [`packages/api/src/files/config.ts`](../../packages/api/src/files/config.ts) 与
  [`packages/api/src/files/alias.ts`](../../packages/api/src/files/alias.ts)。`realpath.native` 提供
  文件系统实际拼写；key 总是重建为 root-relative，解析到 root 外返回 `null`。
- containment、`lstat`、`O_NOFOLLOW`、`fstat` 和文件操作在
  [`packages/api/src/files/local.ts`](../../packages/api/src/files/local.ts)。这里的拒绝路径都是错误返回，
  不会降级为“读一下看看”。
- operator 的 `/files/*` 路由也使用同一个 `LocalFileStore`，但 operator principal 不走
  `FilesystemGrant`；session 路由才逐请求执行 grant admission。

## Containment：检查做什么，哪些测试钉住它

### 检查顺序

1. `normalizeRelPath` 先拒绝 NUL、绝对路径、Windows drive prefix 和归一化后逃出 root 的 `..`；
   `""` 是 Files Root 本身。反斜杠是合法 POSIX 文件名字符，不再被拒绝；Windows drive 形态仍由
   drive-prefix 检查覆盖。percent-decoding 只发生在 Hono HTTP boundary。
2. `createLocalFileStore` 保留逻辑 root 供日志使用，同时用 `realpath.native` 得到 canonical root。
   因此 `/tmp` 或 iCloud 重定位的合法 root 不会因为逻辑路径与真实路径不同而被假拒。
3. `resolveContained` 在 `packages/api/src/files/local.ts` 调用 `assertContainedTarget`：目标必须等于
   canonical root，或以 `canonicalRoot + sep` 开头。这里的分隔符断言防住了
   `root-evil` 这类 bare `startsWith(root)` 误判。
4. root 下的每一个中间 segment 都用 `lstat` 检查：symlink 拒绝，非目录拒绝；创建父目录时是逐段
   `mkdir` 后重新 `lstat`，不是一次递归调用把并发 symlink 当成目录。
5. 最终组件按操作分别再检查：`list/stat` 不跟随 symlink；read 用 `O_NOFOLLOW` 打开后 `fstat`；
   write 对旧目标做 `lstat`，写私有新 inode 后 `rename` 原子替换；delete 用 `lstat` 后 unlink 文件或
   空目录；recursive delete 用 `entries()` 看见 `list()` 隐藏的 symlink，并只 unlink link 本身。

这些检查层次互相补位，但都不是对可直接写 root 的同 uid agent 的绝对保证；中间目录被检查后、随后
`open`/`unlink`/`rmdir`/`rename` 之前仍有 TOCTOU 窗口，见下文。

### 最核心的回归保险

评审时曾把 `packages/api/src/files/local.ts` 旧版的 root-prefix containment block（当时为
`local.ts:57-59`）整段删掉：原有 43 个 files 测试和 66 个 API 测试全部通过。这说明核心安全逻辑
当时没有任何能让它转红的测试。

现在断言被提成 `assertContainedTarget`，并由两个直接探针钉住：

- `packages/api/src/files/local.test.ts` 的 **probe 20** 直接调用 predicate；删掉断言或把它弱化成
  bare `startsWith(canonicalRoot)` 时，`../outside`、`/etc/passwd`、`${root}-evil/x` 等输入转红。
- 同文件 **probe 21** 钉住 `resolveContained` 必须调用断言；只保留 predicate 而删除调用点时，该探针转红。

实际变异结果：

```text
=== MUTATION 1: check deleted -> whole API suite ===
ℹ tests 68   ℹ pass 66   ℹ fail 2        （探针 20、21）
=== MUTATION 2: bare startsWith(canonicalRoot) ===
ℹ tests 45   ℹ pass 43   ℹ fail 2
=== RESTORED ===
ℹ tests 68   ℹ pass 68   ℹ fail 0
```

`paths.test.ts` 负责钉住 `..` 和绝对路径的词法拒绝；symlink、final-component swap、hardlink、
recursive delete、grant alias 和 session route 测试负责各自的层。不要因为某个更早的层已经拒绝输入，
就删除后面的 assertion：变异结果证明“看起来重复”的 root-prefix 检查曾经是唯一没有覆盖的防线。

C-3 的一个有意决定也属于 containment 合同：没有补回反斜杠拒绝。反斜杠是合法 POSIX 文件名字符，
包容依靠分段遍历和 root-prefix assertion，不依靠这个过滤器；探针 12 现在让
`report\\draft.txt` 完整走过 write/list/read/stat/delete。下一个修改者不要把 Windows 形状的假设
顺手补回来；drive-prefix 守卫已经负责真正的 Windows 路径形状。

## 五个高频坑：症状 → 根因 → 现在靠什么守着

### 1. Hardlink 穿透 containment

**症状**：root 内的 `innocent.txt` 是 root 外 `secret.txt` 的硬链接时，旧行为可以读到
`TOP-SECRET`，写入还能改掉 root 外文件；当前正确错误文本是
`Hard link refused: innocent.txt`（session 路由响应 400）。写路径成功后，root 内会换成新内容，
外部 sentinel 应仍为 `SAFE`。

**根因**：硬链接不是 symlink；路径、`lstat` 和 `O_NOFOLLOW` 都会把它看成普通文件。它没有需要赢的
竞态，同一个 inode 可以稳定地从 root 外被访问。

**现在靠什么守着**：read 打开后 `fstat`，普通文件 `nlink > 1` 抛 `HardLinkError`；write 不 truncate
旧 inode，而是写私有新 inode 后 `rename` 替换目录项。启动期还拒绝 `FILES_ROOT` 与
`RUNNER_WORKSPACE_ROOT` 重叠。这个重叠前提一旦成立，问题从次要升级为严重：agent 对 workspace 有
完全写权限，就能在 Files Root 内植入硬链接或交换目录。

### 2. 大小写 / Unicode 别名绕过 grant

**症状**：在默认大小写、规范化不敏感的 macOS 卷上，已有 `Protected/value.txt` 时，
`protected` 的 canWrite grant 请求能返回 **200** 并改掉 `Protected/value.txt`；NFD 拼写的 grant
也能返回 **200** 并改掉 NFC 拼写的 `café/value.txt`。这不是“已核实 fail-closed”的结论。

这里有两个必须分开的测试格子：Opus 测的是 **containment 层 + 别名不匹配** 的方向；Sol 测的是
**grant 强制层 + 别名匹配** 的方向。前者通过不代表后者不存在；两者不矛盾，Sol 找到的是前者没有
覆盖的格子。

**根因**：grant 行原来按 `folderPath` 字节串比对，而 APFS 会把不同大小写、NFC/NFD 拼写解析到同一
物理目录。于是同一目录可以藏着权限不同的两行 grant，控制台又可能把它们显示成同一目录。

**现在靠什么守着**：grant 创建和请求 admission 都调用同一个 `filesystemKey`。它用
`realpath.native` 获取落盘拼写，把 key 重建为 Files-Root-relative 路径；无法从文件系统获知的
不存在组件保留字面拼写，解析到 root 外则返回 `null`。已有物理目录发生别名时，第二条冲突 grant 返回
409。单条 grant 的可达面因此有意变宽一格：同一物理目录的单条读 grant 可以匹配另一种拼写，模型与
文件系统一致；能力拆分被 409 堵住。已有的 `protected`/`Protected` 冲突行本批次不清理，仍会叠加，
见迁移后的运维检查。

### 3. 纯空白 `folderPath` 静默变成整根授权

**症状**：API 直接提交 `folderPath: " "` 后，
`GET /session/runs/:runId/files/content?path=secret/keys.txt` 返回 **200**，即使操作者原本只想
授权一个空白目录名。

**根因**：`""` 是 whole-Files-Root 哨兵；如果 Zod 先 `.trim()` 再 `.refine()`，`" "` 会先变成
`""`，校验看见的是合法整根，而不是非法空白。这是校验顺序错误，不是缺少校验。

**现在靠什么守着**：`filesystemGrantFields` 先在 pre-trim 值上判断：只有原始值正好是 `""` 才允许
whole root；非空字符串要先按 canonical path refine，再 transform trim。`" "`、`"   "`、`"\\t\\n "`
现在均为 400。whole-root sentinel 本身仍是“一处笔误 = 全部权限”的形状，已列入 backlog；Web 表单
虽会禁用纯空白输入，API 直打仍是触发面。

### 4. 递归删除先毁内容再失败

**症状**：递归删除含 symlink 的目录时，可见文件已经被删，最后出现真实错误文本
`Directory is not empty: <path>`（旧路径把 `ENOTEMPTY` 错分成 400），目录本身留下，之后仍删不掉。
对“路径是目录”的读写，当前真实错误文本是 `Path is a directory: <path>`，响应为 409。

**根因**：旧的 recursive walk 使用 `list()`；`list()` 为避免跟随 link 而隐藏 symlink。walk 删除完它
看见的 children 后调用 `rmdir`，隐藏 link 还在，于是 `ENOTEMPTY`。同时错误映射把 filesystem state
conflict 当成 malformed path 400。

**现在靠什么守着**：`FileStore.entries()` 明确列出 `file/dir/symlink`，recursive delete 对目录递归、
对 symlink 直接 unlink，绝不跟随 link。`ENOTEMPTY` 映射为 `DirectoryNotEmptyError`，`EISDIR` 映射为
`IsADirectoryError`；两类都是 409。operator route 的递归删除测试覆盖含 file link 和 dir link 的 tree。

### 5. `getFileStore()` 永久缓存已拒绝的 promise

**症状**：首次初始化 root 失败时拿到 `EACCES`（或 `realpath` 的同类错误）；修好权限、重新挂载
目录后，每次请求仍重复同一个 rejected promise，直到 API 重启。

**根因**：按 root 缓存的是 `Promise<FileStore>`。如果 rejected promise 也留在 `stores` map，后续调用
只会复用同一个失败结果，不会重新尝试 mkdir/realpath。

**现在靠什么守着**：`getFileStore()` 的 catch 只在 map 仍指向该 promise 时驱逐它，再把原错误抛给当前
请求。修好权限后下一次请求会重新创建 store，不需要重启；测试先制造失败，再恢复权限并断言第二次
调用成功。

## TOCTOU：已知、未关闭的窗口

当前算法仍是“检查后使用”：`resolveContained` 的 canonical/root-prefix 检查和中间目录 `lstat`
完成后，随后才执行 `open`、`unlink`、`rmdir` 或 `rename`。如果具有 root 内写权限的对手在这段时间
替换已检查的中间目录，后续系统调用可以落到 root 外。

这不是只在理论上存在的极小概率：

- Opus 的竞态打法在 **6223** 次尝试中赢了 **118** 次，**第 4 次尝试**就出现第一次穿透；
- Sol 用另一种打法跑了 **30,000** 次没有赢。

两个数字说明命中率取决于攻击者的调度/替换打法，不说明窗口稀有或已经关闭。仓库中的 opt-in
`probe 24` 也把这件事保留下来：`AGENTOS_RACE_PROBE=1` 时会主动交换中间目录，并把“第一次
outside read”作为测试失败/威胁模型更新的信号。

⑦ 只做了四件可观测性与隔离工作：

- 把原来的竞态探针改名为 **KNOWN OPEN GAP**，不再把它报告成通过；
- 把 hardlink 纳入威胁模型，并留下可执行证据；
- 启动期拒绝 root overlap，并在 `RUNNER_RUN_AS_PREFIX` 为空时警告缺少 OS 隔离靠山；
- 把竞态探针收进仓库，但默认 opt-in，避免 CI 因 race flake。

这些不是 fd-relative 修复。根治需要 native helper 做 fd-relative / `openat` 式遍历，这是独立工程，
已进 `docs/BACKLOG-V2.md`。在那之前，文档必须把这条写成“已知的、未关闭的窗口”，不能写成
“containment 已绝对保证”。

## 能力面与工具清单会漂移

`packages/runner/src/mcp-server.ts` 的 `TOOLS` 在每个 agent session 的 `tools/list` 中无条件包含
`files_list`、`files_read`、`files_write`、`files_delete`；它不读取 grant，也不读取 claim。调用时
才由 API 的 session route 查 grant，因此无 grant 仍是 403。这是服务端 fail-closed 的授权设计，
不是鉴权洞。

曾经的漂移是：MCP 实际暴露 8 个工具，而 `packages/runner/src/adapters.ts` 的 `toolManifest` 只
告诉 agent 4 个控制工具，清单不实。当前 manifest 已列出 8 个，并明确 files 工具“按请求在服务端
鉴权，无 grant 返回 403”。这修正了清单部分，但没有改变 `tools/list` 的全局发现行为。

这与 `inboxAccess` 是同一个模式：平台从来没有按能力过滤客户端工具面；客户端先看到工具，服务端
再按 request/principal 拦截。全局“按能力裁剪 tools/list”是平台级 backlog，不应在 Files route 中
假装已经存在。

## 破坏性迁移：运维要记住的路径

这次迁移会删除数据模型并清空旧 grant，不能按普通可逆 schema 发布处理。

### precheck 的真实语义

运行：

```sh
npm run db:files-precheck -w @agentos/db
```

当前脚本查询部署目标数据库的 `FileObject`、`TaskAttachment`、`FilesystemGrant` 三个 count；任意
一个非零都 exit 1。⑦ 之前只有 `FileObject` 非零才会非零退出，导致有待删 `TaskAttachment` 或旧
grant 时仍像绿色 pre-flight；修复后已经强制化。脚本定义在
`packages/db/package.json`，计划中有调用要求；`deploy/` 和 CI 没有自动调用它，所以“强制化”是
脚本拒绝危险状态，不是部署系统替运维执行了这一步。必须针对迁移实际使用的 `DATABASE_URL` 运行，
不能拿一套新容器的 0 行结果代替生产库检查。

precheck 非零时先导出/确认要保留的数据并停下，不要直接 deploy。尤其旧 `FilesystemGrant` 行是
迁移前未定义语义的历史行，迁移会清掉它们；重新授权要使用 Files-Root-relative canonical POSIX
路径，`""` 表示 whole root。

### 没有 rollback，只有前向恢复

Prisma **6.19 没有 down 命令**，本仓库也没有 restoration migration。因此不存在“回滚迁移”这一
运维操作：不要编造 `migrate down`，不要手工改已经应用的 migration。

正式发布的恢复路径是：

1. 发布前对实际 Postgres 做备份/导出，并保留旧 `FilesystemGrant` 的 `agentId`、`folderPath` 和
   三个 capability 列。
2. 若需要恢复数据库状态，从发布前备份恢复到替换库/恢复目标，再按当前 migration 顺序执行
   `prisma migrate deploy`，最后重放需要的 FilesystemGrant 行（转换为 root-relative canonical
   POSIX 路径）。这是前向恢复 + 重放，不是 down。
3. 若只是 grant 被清空，从备份/发布前导出重建 grant 即可；应用前运行 alias 检查。`FileObject` 和
   `TaskAttachment` 按 precheck 合同本应为空，因此没有文件内容可恢复；若未来需要它们，写新的
   forward migration 并重新生成 client。
4. migration 不触碰 `FILES_ROOT` 磁盘文件；数据库恢复也不会自动恢复/删除磁盘文件，磁盘和数据库
   分别按各自备份处理。

迁移后的行数核对要靠运维手工执行，不能依赖 Prisma 是否转发 PostgreSQL `RAISE NOTICE`：

```sql
SELECT COUNT(*) AS filesystem_grants FROM "FilesystemGrant";
```

若发布前记录为 `n`，正常迁移后应为 0，再由运维按 runbook 重建需要的行。`RAISE NOTICE` 可见时是
额外帮助；不可见不影响迁移正确性。

迁移里的三个“为什么没有额外守卫”也不要改错：

- `FilesystemGrant` 的 `DELETE` 是故意无守卫。旧行的 `folderPath` 是迁移前未定义的路径语义，
  不能可靠转换；新代码会对非 canonical/绝对旧行 fail-closed。迁移清掉它们，靠导出和部署后重建
  恢复意图，而不是留下看似存在但不授予能力的行。
- `TaskAttachment` 的 `DROP` 也故意无独立守卫。它有外键指向 `FileObject`；非空 `TaskAttachment`
  必然使 `FileObject` 非空，因此前置的 `FileObject` guard 已经会先中止。再加一条重复 guard 不会
  增加安全性。
- `FileObject` 的 guard 必须保留；只要它非空，migration 应异常退出，避免删除仍有数据的表。

Opus 用一次性 **Postgres 16** 容器实际跑过两种数据库形态验证 migration 行为，不是纸面推演；
但本 run 不触碰 Leo 的真实数据库。迁移后的 NOTICE 转发仍不作为正确性前提。

### 部署后 alias 自查

本批次不做既有冲突 grant 清理脚本；409 只阻止新建/改路径。部署后至少运行一次下面的检查，
发现同一折叠 key 的多行时，删除多余行并保留权限最小的一条，再重新确认业务需要：

```sql
SELECT LOWER("folderPath") AS folded_folder_path,
       COUNT(*) AS grant_rows,
       ARRAY_AGG("id" ORDER BY "id") AS ids
FROM "FilesystemGrant"
GROUP BY LOWER("folderPath")
HAVING COUNT(*) > 1;
```

`LOWER` 覆盖数据库可表达的大小写别名；NFC/NFD 还要结合目标卷和导出文本做规范化检查，不能把
PostgreSQL 的 `LOWER` 当作 Unicode normalization。查到冲突时保留权限最小的一行，删除其他行，
并把一次性清理脚本列为后续 backlog，而不是在本批次偷偷扩大迁移范围。

## 合并与后续批次

本分支相对当前 master 的已核对冲突面是以下六个文件：

- `packages/api/package.json`：API package scripts/test glob 与其他批次的 package 变更的文本合并面。
- `packages/api/src/app.ts`：Files routes/grant validation 与其他 API route 变更的合并面。
- `packages/api/src/index.ts`：启动期 Files root isolation/warning 与启动编排变更的合并面。
- `packages/api/src/reconcile.ts`：**纯文本冲突**；Files 只加入 `homedir`/`join` import 和
  `defaultWorkspaceRoot` 导出，`reconcileDatabaseRuns` / `reconcileWorkspaces` 一行未动；保留两边
  的 import 和两边语义即可。
- `packages/db/package.json`：`db:files-precheck` script 与其他 db scripts 的文本合并面。
- `packages/db/prisma/schema.prisma`：Files 删除死模型/反向 relation 与其他批次 schema 变更的
  非文本三方合并面。

四条链的最终合并顺序：**#6 修缮 → #2 批次 2 → #9 Files → #1 批次 0**；迁移文件名字典序、
`schema.prisma` 三方重新生成等合并操作详见
[`docs/merge-notes/batch-repairs-and-batch-2.md`](../merge-notes/batch-repairs-and-batch-2.md)
和 [`docs/merge-notes/batch-files.md`](../merge-notes/batch-files.md)，本页不复制合并全文。

合并后仍需保持以下运行时事实：

- `reconcile.ts` 的 root helper 与 runner 的默认 root 继续一致；runner 不能直接 import API，现有
  源码级测试是临时钉子，不要因“看起来重复”而删除；
- migration 必须按字典序落地，schema 变更要在最终合并后的 schema 上重新生成；
- 如果未来关闭 TOCTOU，先让 probe 24 在 opt-in 下失败，再更新本页和 `local.ts` threat model，
  把“known open gap”改成已验证的新边界，而不是只删除探针。
