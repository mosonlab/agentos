'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const dotenv = require('dotenv');
const Lark = require('@larksuiteoapi/node-sdk');

const SPIKE_DIR = __dirname;
const ROOT_ENV = path.resolve(SPIKE_DIR, '../../.env');
const EVENTS_DIR = path.join(SPIKE_DIR, 'events');
const DURATION_MS = Number(process.env.TEST_DURATION_MS || 5 * 60 * 1000);

dotenv.config({ path: ROOT_ENV, quiet: true });

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) {
  console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET；应从仓根 .env 读取。');
  process.exit(1);
}

fs.mkdirSync(EVENTS_DIR, { recursive: true });

const startedAt = new Date();
const runId = startedAt.toISOString().replaceAll(':', '-').replaceAll('.', '-');
const run = {
  runId,
  sdkVersion: require('@larksuiteoapi/node-sdk/package.json').version,
  startedAt: startedAt.toISOString(),
  durationMs: DURATION_MS,
  connectionEstablished: false,
  connectionErrors: [],
  textEvents: [],
  cardActionEvents: [],
  echoReplies: [],
  cardsSent: [],
  confirmationMessages: [],
};

let eventSequence = 0;
let shuttingDown = false;
const eventContext = new AsyncLocalStorage();

function printableError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function payloadFromWsData(wsData) {
  const payload = wsData && wsData.data;
  if (payload == null) return null;
  if (typeof payload === 'string') return JSON.parse(payload);
  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    return JSON.parse(Buffer.from(payload).toString('utf8'));
  }
  return payload;
}

function eventTypeOf(payload) {
  return payload?.header?.event_type || payload?.type || payload?.event_type || 'unknown';
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function persistRawWsEvent(wsData) {
  const payload = payloadFromWsData(wsData);
  const eventType = eventTypeOf(payload);
  const eventId = payload?.header?.event_id || wsData?.message_id || `seq-${++eventSequence}`;
  const filename = `${runId}__${safeName(eventType)}__${safeName(eventId)}.json`;
  const relativePath = path.join('events', filename);
  const envelope = {
    captured_at: new Date().toISOString(),
    ws_transport: {
      message_id: wsData?.message_id,
      trace_id: wsData?.trace_id,
      sum: wsData?.sum,
      seq: wsData?.seq,
    },
    payload,
  };
  fs.writeFileSync(path.join(SPIKE_DIR, relativePath), `${JSON.stringify(envelope, null, 2)}\n`);
  console.log(`[EVENT RAW] ${eventType} -> ${relativePath}`);
  return relativePath;
}

function writeRunSummary() {
  run.finishedAt = new Date().toISOString();
  run.finalConnectionStatus = wsClient?.getConnectionStatus?.();
  const summaryPath = path.join(EVENTS_DIR, `${runId}__run-summary.json`);
  fs.writeFileSync(summaryPath, `${JSON.stringify(run, null, 2)}\n`);
  return path.relative(SPIKE_DIR, summaryPath);
}

function assertApiSuccess(label, response) {
  if (response?.code !== undefined && response.code !== 0) {
    throw new Error(`${label}失败：code=${response.code}, msg=${response.msg || 'unknown'}`);
  }
  return response;
}

const client = new Lark.Client({ appId, appSecret, domain: Lark.Domain.Feishu });
const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.info });

// WSClient normally gives handlers only the parsed event body. Wrapping invoke
// preserves the original WebSocket payload and transport identifiers first.
const originalInvoke = dispatcher.invoke.bind(dispatcher);
dispatcher.invoke = async (wsData, params) => {
  let eventFile;
  try {
    eventFile = persistRawWsEvent(wsData);
  } catch (error) {
    console.error('[EVENT RAW] 落盘失败', error);
  }
  return eventContext.run({ eventFile }, () => originalInvoke(wsData, params));
};

async function sendTextToOpenId(openId, text) {
  const response = await client.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
  return assertApiSuccess('发送确认消息', response);
}

async function sendTestCard(chatId) {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'AgentOS 长连接验证' },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: '请点击一个按钮，验证 `card.action.trigger` 是否经 WebSocket 到达。' },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '选项A' },
            value: { choice: 'A', source: 'agentos-feishu-longconn-spike' },
          },
          {
            tag: 'button',
            type: 'default',
            text: { tag: 'plain_text', content: '选项B' },
            value: { choice: 'B', source: 'agentos-feishu-longconn-spike' },
          },
        ],
      },
    ],
  };

  const response = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });
  return assertApiSuccess('发送交互卡片', response);
}

dispatcher.register({
  'im.message.receive_v1': async (data) => {
    const eventFile = eventContext.getStore()?.eventFile;
    const message = data?.message;
    const sender = data?.sender;
    if (message?.message_type !== 'text' || sender?.sender_type !== 'user') {
      console.log(`[消息忽略] type=${message?.message_type || 'unknown'} sender=${sender?.sender_type || 'unknown'}`);
      return;
    }

    let text;
    try {
      text = JSON.parse(message.content).text;
    } catch {
      text = message.content;
    }

    console.log(`\n[已收到文本] ${JSON.stringify(text)} event=${eventFile || '未落盘'}\n`);
    run.textEvents.push({ at: new Date().toISOString(), eventFile, messageId: message.message_id, text });

    try {
      const echo = await client.im.v1.message.reply({
        path: { message_id: message.message_id },
        data: { msg_type: 'text', content: JSON.stringify({ text }) },
      });
      assertApiSuccess('回声回复', echo);
      run.echoReplies.push({ at: new Date().toISOString(), ok: true, messageId: echo?.data?.message_id });
      console.log(`[回声已发送] ${JSON.stringify(text)}`);
    } catch (error) {
      run.echoReplies.push({ at: new Date().toISOString(), ok: false, error: printableError(error) });
      console.error('[回声发送失败]', error);
    }

    try {
      const sent = await sendTestCard(message.chat_id);
      run.cardsSent.push({ at: new Date().toISOString(), ok: true, messageId: sent?.data?.message_id, chatId: message.chat_id });
      console.log('[交互卡片已发出] 请在手机上点击「选项A」或「选项B」');
    } catch (error) {
      run.cardsSent.push({ at: new Date().toISOString(), ok: false, error: printableError(error) });
      console.error('[交互卡片发送失败]', error);
    }
  },

  'card.action.trigger': async (data) => {
    const eventFile = eventContext.getStore()?.eventFile;
    const choice = data?.action?.value?.choice || data?.action?.option || 'unknown';
    console.log(`\n[已收到按钮回调] choice=${choice} event=${eventFile || '未落盘'}\n`);
    run.cardActionEvents.push({ at: new Date().toISOString(), eventFile, choice });

    const openId = data?.operator?.open_id;
    if (openId) {
      try {
        const sent = await sendTextToOpenId(openId, `已收到按钮回调：选项${choice}`);
        run.confirmationMessages.push({ at: new Date().toISOString(), ok: true, messageId: sent?.data?.message_id, choice });
        console.log(`[按钮确认消息已发送] 选项${choice}`);
      } catch (error) {
        run.confirmationMessages.push({ at: new Date().toISOString(), ok: false, error: printableError(error), choice });
        console.error('[按钮确认消息发送失败]', error);
      }
    } else {
      run.confirmationMessages.push({ at: new Date().toISOString(), ok: false, error: { message: '回调缺少 operator.open_id' }, choice });
      console.error('[按钮确认消息未发送] 回调缺少 operator.open_id');
    }

    return { toast: { type: 'success', content: `已收到选项${choice}` } };
  },
});

const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  domain: Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.info,
  onReady: () => {
    run.connectionEstablished = true;
    run.connectedAt = new Date().toISOString();
    console.log('\n[长连接已建立] 现在请在手机飞书中给机器人发送一句文本。收到卡片后请点击一个按钮。\n');
  },
  onError: (error) => {
    run.connectionErrors.push({ at: new Date().toISOString(), error: printableError(error) });
    console.error('[长连接错误]', error);
  },
  onReconnecting: () => console.log('[长连接重连中]'),
  onReconnected: () => console.log('[长连接已重连]'),
});

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  run.exitReason = reason;
  wsClient.close({ force: true });
  const summaryPath = writeRunSummary();
  console.log(`\n[测试结束] reason=${reason}; summary=${summaryPath}`);
  process.exitCode = exitCode;
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('uncaughtException', (error) => {
  run.connectionErrors.push({ at: new Date().toISOString(), error: printableError(error) });
  console.error('[未捕获异常]', error);
  void shutdown('uncaughtException', 1);
});
process.once('unhandledRejection', (error) => {
  run.connectionErrors.push({ at: new Date().toISOString(), error: printableError(error) });
  console.error('[未处理 Promise 拒绝]', error);
  void shutdown('unhandledRejection', 1);
});

console.log(`[测试启动] SDK=${run.sdkVersion}; timeout=${DURATION_MS}ms; 凭证来源=${path.relative(SPIKE_DIR, ROOT_ENV)}`);
setTimeout(() => void shutdown('timeout'), DURATION_MS);
void wsClient.start({ eventDispatcher: dispatcher });
