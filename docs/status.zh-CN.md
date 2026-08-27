# 发布候选证据状态

以下标签描述本仓库内记录的证据，不是 CLI provider 作出的兼容性承诺。

- **已验证（Verified）**：所述路径已有实际运行或仓库证据。
- **维护者已验证（Maintainer-verified）**：维护者已在指定平台实际运行，但全新
  机器复现关卡仍未完成。
- **实验性（Experimental）**：实现程度足够用于开发评估，但不构成 v0.1 支持
  承诺。
- **待完成（Pending）**：所需证据尚未完成，不应据此推断已支持。
- **未验证（Unverified）**：尚无符合要求的证据记录。
- **不支持（Unsupported）**：不在支持目标内。

### Provider 支持

| Provider 运行时 | 状态 | 证据边界 |
| --- | --- | --- |
| Codex CLI | **已验证** | adapter/runtime 和订阅认证路径已验证；全新安装证据为 **待完成（OSS-B）**。 |
| Claude Code | **已验证** / **维护者已验证** | adapter/runtime 已验证；Claude Pro/Max 认证已由维护者在 macOS Apple Silicon 上验证；v0.1 全新安装关卡为 **待完成（OSS-B）**。 |
| Pi | **实验性** | adapter 代码已存在，但 Pi 不属于已承诺的 v0.1 支持范围。 |

Provider CLI、账号、认证、订阅、用量、速率限制、模型和 provider 侧可用性均由
用户负责。AgentOS 不提供 provider 凭据或使用资格。

### 平台支持

| 平台 | 状态 | 证据边界 |
| --- | --- | --- |
| Apple Silicon 上的 macOS | **目标平台** | 当前维护者证据包括 Claude Pro/Max 认证；完整的全新安装关卡仍为 **待完成（OSS-B）**。 |
| Linux | **未验证** | 不应因为项目使用 Node.js 就推断已支持。 |
| Windows | **不支持** | 当前 runner 依赖 POSIX 进程组、路径和命令行为。 |

### 能力支持

| 能力 | 状态 | 证据边界 |
| --- | --- | --- |
| Goals | **待完成** | 控制平面存储 Goal 及其 Definition of Done、进展日志和各项上限，控制台可以编辑它们。执行模型未接线：没有任何东西从 Goal 派发工作，没有任何东西统计它的花费，也没有任何东西按花费、时间或停滞把它停下。因此控制台不渲染花费数字，也不渲染已停止状态——服务端对这两者都没有写入方。 |

