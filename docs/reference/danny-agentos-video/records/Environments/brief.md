# 模块：Environments
## 讲解区间
- 0:05:36–0:06:10: 说明环境如何限制网络访问和可用域名，从底层阻止代理访问不应接触的资源。
- 0:08:25–0:09:06: 演示环境变量和密钥注入，说明凭证加密存储以及如何授予代理只读数据库等访问权限。

## 本模块字幕（旁白）
- [0:05:35] 并在彼此之间沟通。
- [0:05:36] 所以，这些就是代理。代理有一个环境。什么是环境？
- [0:05:42] 我们可以说，“好的，
- [0:05:44] 它有网络访问权限还是有限访问权限？如果有限，
- [0:05:48] 我只希望它比如能访问api.front.com。
- [0:05:54] 如果这个引擎在这个环境里只能访问那个，
- [0:05:56] 它永远不能上我的GitHub。
- [0:05:58] 即使它有访问权限，它在基础层面就被阻止了。
- [0:06:01] 所以，这就是你怎么把它全部构建进去。
- [0:06:05] 顺便说一下，这一切都构建在Claude托管代理之上。
- [0:08:22] 它有一个个人访问令牌。然后，环境。
- [0:08:25] 我还可以在这里添加任何文件。
- [0:08:28] 环境变量，因为它们需要被注入到会话中，嗯，比如，安全地。
- [0:08:34] 所以，这存储在Google的……我记不清名字了，
- [0:08:40] 但基本上加密存储在Google的令牌加密系统上。我忘了名字。
- [0:08:46] 总之，所有东西都存储着。
- [0:08:48] 即使我被黑客攻击了，它也安全存储。
- [0:08:51] 所以，这就是我怎么添加环境变量来给它访问权限，比如，
- [0:08:56] 我的只读MongoDB数据库。
- [0:08:59] 我可以给它任何访问权限。
- [0:09:02] 嗯，这就是系统的基础。

## 帧清单（按时间排序，逐张查看）
- [0:05:40] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0035.jpg
- [0:05:50] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0036.jpg
- [0:06:00] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0037.jpg
- [0:06:10] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0038.jpg
- [0:08:30] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0052.jpg
- [0:08:40] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0053.jpg
- [0:08:50] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0054.jpg
- [0:09:00] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0055.jpg
