# 求助：飞书自建应用长连接收不到任何事件（im.message.receive_v1）

请你扮演飞书开放平台专家，帮我诊断下面这个问题。我会给出完整配置状态、代码要点和已排除项，请给出还有哪些可能原因、以及逐条验证方法。

## 现象

- 自建应用（正式应用，企业租户，非个人版），机器人能力已开启。
- 用官方 Node SDK `@larksuiteoapi/node-sdk` v1.73.0 的 `WSClient` 建立长连接，`onReady` 正常触发，日志出现 `ws client ready`，连接稳定不重连。
- 开发者后台「事件与回调 → 订阅方式」选的是「使用长连接接收事件」，页面上点「重新验证」显示**连接成功**。
- 但从手机飞书给机器人发单聊文本消息后，**长连接端一个事件都收不到**（handler 完全不触发，连原始 WS 帧落盘钩子都没有任何输出）。
- 开发者后台「运营监控 → 日志检索 → 事件日志检索」查询全天：**暂无查询结果**——即平台侧根本没有生成/推送过任何事件记录。
- 「服务端 API 日志」正常记录了我们主动调用的 API（tenant_access_token 获取成功，im/v1/messages 主动发消息给用户也成功过），说明凭证和网络都通。

## 当前配置状态（截图核实过）

- 应用状态：已启用，顶部横幅显示「当前修改均已发布」（无未发布改动）。
- 事件订阅：已添加 `im.message.receive_v1`（接收消息 v2.0），订阅类型=应用身份。
- 权限管理中「已开通」的权限（应用身份）：
  - `im:message`（获取与发送单聊、群组消息）
  - `im:message.group_at_msg.include_bot:readonly`（获取群组中其他机器人和用户@当前机器人的消息）
  - `im:message.group_msg.include_bot:read`（获取群组中用户和机器人发送的消息）
  - `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息）—— 最后补开的，开通后**已重新发布版本**，再测仍收不到
  - `im:message:send_as_bot`（以应用的身份发消息）
- 加密策略：Encrypt Key 未开启（长连接模式官方说明无需配置）。
- 回调订阅（卡片回传 card.action.trigger）也配置为长连接。

## 已排除项

1. 未保存/未发布：横幅显示「当前修改均已发布」，且权限变更后重新发过版。
2. Encrypt Key 干扰：未开启。
3. 另一个同租户旧应用抢连接：另一应用 app_id 不同，且本机确认只有一个监听进程在跑。
4. 连接本身：平台「重新验证」显示连接成功；SDK onReady 触发；多轮 5–9 分钟监听窗口都在线。
5. 凭证错误：同一对 app_id/app_secret 主动调 API 全部成功。
6. 单聊权限缺失：`im:message.p2p_msg:readonly` 已补开并发版（注：补开后的复测有一次可能撞上本地监听下线的空窗，正在重测）。

## 代码要点（Node）

```js
const client = new Lark.Client({ appId, appSecret, domain: Lark.Domain.Feishu });
const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.info });
dispatcher.register({
  'im.message.receive_v1': async (data) => { /* ... */ },
  'card.action.trigger': async (data) => { /* ... */ },
});
const wsClient = new Lark.WSClient({ appId, appSecret, domain: Lark.Domain.Feishu, loggerLevel: Lark.LoggerLevel.info, onReady, onError });
wsClient.start({ eventDispatcher: dispatcher });
```

- 凭证从 .env 读取，确认非空、与后台一致。
- 我们还包装了 `dispatcher.invoke` 把原始 WS 帧直接落盘——所以「handler 没匹配上事件名」这种情况也能看见原始帧；实际是连原始帧都没有。

## 测试方式

- 用手机飞书，在与机器人的单聊会话里发送纯文本。发送方是企业租户内的正常用户账号（也是应用创建者/管理员）。
- 机器人可以主动给这个用户发消息成功（im/v1/messages, receive_id_type=open_id），说明可用范围覆盖该用户。

## 问题

1. 在「事件日志检索」完全无记录的前提下，还有哪些原因会导致平台根本不生成 `im.message.receive_v1` 事件？请按可能性排序。
2. 「订阅方式=长连接」与「事件订阅列表」是否存在需要分别发版/分别生效的坑？
3. 应用身份（tenant）订阅类型下，还有什么开关（如可用范围、员工字段、会话存档、企业管理后台侧设置）会拦截消息事件的生成？
4. 有没有官方工具/接口能直接验证「事件订阅当前实际生效的配置」（而不是后台页面显示的配置）？
5. 如果你怀疑是企业管理后台（admin.feishu.cn）侧的设置问题，请具体指出路径。
