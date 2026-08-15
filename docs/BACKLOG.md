# Backlog

试点（vibeville lines 子命令，2026-08-15）暴露的 V1.5 补漏与已裁定的 V2 项。V2 大项见 DECISIONS.md（#3/#4/#10/#13/#16/#18/#20），Leo 已明确暂不启动 V2。

## V1.5 补漏（试点实测暴露，优先于 V2）

- [ ] **Web 重试按钮**：`POST /tasks/:taskId/retry` 已落地（api），前端 Tasks 页还没有入口；失败任务目前只能 curl。
- [ ] **入站自由文本的兜底 UX**：用户主动发给 bot 的消息若匹配不到等待中的提问会被丢弃（现已落库 InboxExternalEvent 可审计，但 Inbox 页不可见）。考虑落成 from=HUMAN 的未挂靠消息展示。
- [ ] **api 重启对在跑 run 的折损**：启动对账会把租约过期的 run 判 lost 并消耗 run 预算。孤儿抢端口是本次根因（已清），但「api 短暂重启不应折损预算」值得加缓冲（如启动后宽限一个心跳周期再对账）。
- [ ] **闸门消息的产物预览**：闸门卡片只有一句话+PR 链接，产物正文要去 Tasks 页翻；可在卡片/Inbox 详情内嵌 TaskStepOutput 摘要。

## 已修（本轮，无需再做）

- run 执行环境缺 USER/LOGNAME（env 构造器已统一，commit 7374530）。
- 产物存原始 stream-json 转录（三家 CLI 终态事件提取 finalOutput）。
- 未匹配飞书事件随事务回滚丢失（事务外补记落库）。
- 电路告警无 thread 永远 pending（挂 FEISHU_DEFAULT_CHAT_ID 线程）。
- FEISHU_DEFAULT_CHAT_ID 已配置（.env + api plist），出站通道实测通。
