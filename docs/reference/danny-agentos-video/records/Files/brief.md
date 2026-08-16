# 模块：Files
## 讲解区间
- 0:06:57–0:07:59: 讲解会话容器没有持久文件系统，因此通过 R2 和 MCP 管理受限文件夹、读写权限及文件预览。

## 本模块字幕（旁白）
- [0:06:54] 然后最后，代理能访问文件系统。
- [0:06:57] 因为每个会话启动自己的容器，你没有持久文件系统。
- [0:07:05] 所以，我连接了Cloudflare R2存储，
- [0:07:09] 在上面放了一个MCP，
- [0:07:11] 因为你不想给代理无限的文件系统访问权限，
- [0:07:16] 因为它会直接清空。
- [0:07:17] 所以，每个代理只能访问那个文件系统上的特定文件夹。
- [0:07:23] 如果你给访问权限，它可以读其他
- [0:07:26] 但比如，你可以说这个代理只能写，不能删除，
- [0:07:29] 因为它必须总是通过MCP来做这些事。
- [0:07:31] 它有服务器端检查来基本上禁止它。
- [0:07:35] 所以，这就是文件系统。这里比如有目标。
- [0:07:41] 我可以看到它们做什么，打开那些文件，编辑那些文件，下载那些文件。
- [0:07:47] 所以，和我的代理互动非常容易。
- [0:07:50] 保存，可以预览，等等。
- [0:07:52] 所以，一个相当高级的文件系统。
- [0:07:55] 然后，显然，代理需要MCP访问。

## 帧清单（按时间排序，逐张查看）
- [0:07:00] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0043.jpg
- [0:07:10] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0044.jpg
- [0:07:20] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0045.jpg
- [0:07:30] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0046.jpg
- [0:07:40] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0047.jpg
- [0:07:46] (scene) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_scene/scene_00466.78.jpg
- [0:07:50] (10s) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_10s/t0048.jpg
- [0:07:52] (scene) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_scene/scene_00472.38.jpg
- [0:07:53] (scene) /private/tmp/claude-501/-Users-leohe-Documents-claude-projects-agentos/c745484d-f59f-4c9a-ac06-db51ef054f52/scratchpad/video/frames_scene/scene_00473.37.jpg
