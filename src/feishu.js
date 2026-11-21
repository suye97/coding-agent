import { createHash } from 'node:crypto';

/** 校验飞书 Open ID，避免把其他类型的用户标识交给业务层。 */
function isOpenId(value) {
  return typeof value === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(value);
}

/** 将业务卡片转换为飞书 JSON 2.0 交互卡片。 */
export function encodeCard(card) {
  if (!card || typeof card !== 'object' || typeof card.title !== 'string' ||
      typeof card.text !== 'string' || !Array.isArray(card.actions)) {
    throw new TypeError('Invalid Feishu card');
  }

  const elements = [{ tag: 'div', text: { tag: 'plain_text', content: card.text } }];
  const formButtons = [];

  card.actions.forEach((action, index) => {
    if (!action || typeof action.label !== 'string' || !action.label ||
        typeof action.token !== 'string' || !action.token) {
      throw new TypeError(`Invalid Feishu card action at index ${index}`);
    }

    const button = {
      tag: 'button',
      element_id: `action_${index + 1}`,
      text: { tag: 'plain_text', content: action.label },
      type: 'default',
      behaviors: [{ type: 'callback', value: { token: action.token } }],
    };

    if (action.form === true) {
      button.name = `action_${index + 1}`;
      button.form_action_type = 'submit';
      formButtons.push(button);
    } else {
      elements.push(button);
    }
  });

  if (formButtons.length) {
    elements.push({
      tag: 'form',
      name: 'text_form',
      elements: [
        {
          tag: 'input',
          element_id: 'text_input',
          name: 'text',
          input_type: 'multiline_text',
          label: { tag: 'plain_text', content: '补充说明' },
          placeholder: { tag: 'plain_text', content: '请输入内容' },
        },
        ...formButtons,
      ],
    });
  }

  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: card.title } },
    body: { elements },
  };
}

// Keep only diagnostic identifiers. Raw SDK responses can contain credentials and request bodies.
export async function callCardApi(operation, request) {
  let response;
  let httpStatus = null;
  let requestId = null;
  try {
    response = await request();
  } catch (error) {
    response = error?.response?.data;
    const status = error?.response?.status;
    if (Number.isInteger(status) && status >= 100 && status <= 599) httpStatus = status;
    requestId = error?.response?.headers?.['x-tt-logid'];
  }
  if (response?.code === 0 && (operation === 'patch' || (typeof response.data?.message_id === 'string' && response.data.message_id))) {
    return response;
  }
  const code = response?.code;
  const rawLogId = response?.error?.log_id ?? requestId;
  const logId = typeof rawLogId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(rawLogId) ? rawLogId : null;
  const apiCode = Number.isSafeInteger(code) && code !== 0 ? code : null;
  const kind = apiCode !== null ? 'api' : httpStatus !== null ? 'http' : response?.code === 0 ? 'missing_message_id' : 'transport';
  const error = new Error(`Feishu card ${operation} failed`);
  error.feishuDelivery = { operation, code: apiCode, httpStatus, logId, kind };
  throw error;
}

/** 从原始回调提取可用于去重的标识，不向业务层暴露卡片更新凭证。 */
function actionEventId(event) {
  const raw = event.raw;
  const headerId = raw?.header?.event_id ?? raw?.event_id;
  if (typeof headerId === 'string' && headerId) return headerId;
  if (typeof raw?.token !== 'string' || !raw.token) return null;
  return `card:${createHash('sha256').update(raw.token).digest('hex')}`;
}

/** 创建飞书长连接适配器；SDK 依赖由集成方安装。 */
export async function createFeishuChannel({ appId, appSecret, onMessage, onAction, onError }) {
  if (typeof appId !== 'string' || !appId || typeof appSecret !== 'string' || !appSecret ||
      typeof onMessage !== 'function' || typeof onAction !== 'function' ||
      typeof onError !== 'function') {
    throw new TypeError('Invalid Feishu channel options');
  }

  const { createLarkChannel } = await import('@larksuite/channel');
  const channel = createLarkChannel({
    appId,
    appSecret,
    transport: 'websocket',
    includeRawEvent: true,
    httpTimeoutMs: 15000,
    connectTimeoutMs: 30000,
    safety: { chatQueue: { enabled: true, cardActions: 'separate' } },
  });
  let started = null;

  /** 将异步事件处理错误送交宿主，避免回调异常丢失。 */
  function reportError(error) {
    try {
      onError(error);
    } catch {
      // 宿主错误回调不应阻断 SDK 的事件分发。
    }
  }

  /** 只接收真人在单聊中发送的内容，并统一使用 open_id。 */
  channel.on('message', async (message) => {
    if (message.chatType !== 'p2p' || message.senderType !== 'user' ||
        !['text', 'post', 'merge_forward'].includes(message.rawContentType)) return;
    const openId = message.raw?.sender?.sender_id?.open_id;
    if (!isOpenId(openId) || openId !== message.senderId ||
        typeof message.chatId !== 'string' || !message.chatId ||
        typeof message.messageId !== 'string' || !message.messageId) return;

    try {
      const reply = await onMessage({
        eventId: message.messageId,
        chatId: message.chatId,
        userId: openId,
        text: message.content,
        replyTo: message.replyToMessageId,
      });
      if (reply) await channel.reply(message, { text: reply });
    } catch (error) {
      reportError(error);
    }
  });

  /** 校验点击来源与表单值，向飞书同步返回操作提示。 */
  channel.on('cardAction', async (event) => {
    const openId = event.operator?.openId;
    const eventId = actionEventId(event);
    const token = event.action?.value?.token;
    if (!isOpenId(openId) || !eventId || typeof token !== 'string' || !token ||
        typeof event.chatId !== 'string' || !event.chatId ||
        typeof event.messageId !== 'string' || !event.messageId) {
      return { toast: { type: 'warning', content: '无法验证此操作' } };
    }

    try {
      // The workflow checks the task against the recorded direct chat and message.
      const formText = event.action?.formValue?.text;
      if (formText !== undefined && typeof formText !== 'string') {
        return { toast: { type: 'warning', content: '表单内容无效' } };
      }
      const toast = await onAction({
        eventId,
        chatId: event.chatId,
        userId: openId,
        messageId: event.messageId,
        token,
        text: formText ?? '',
      });
      return { toast: { type: 'success', content: typeof toast === 'string' && toast ? toast : '已处理' } };
    } catch (error) {
      reportError(error);
      return { toast: { type: 'error', content: '操作失败，请稍后重试' } };
    }
  });

  channel.on('error', reportError);

  return {
    /** 建立长连接；重复调用复用同一次连接。 */
    async start() {
      if (!started) {
        started = channel.connect().catch((error) => {
          started = null;
          throw error;
        });
      }
      return started;
    },

    /** 关闭长连接。 */
    async stop() {
      if (!started) return;
      try {
        await started;
      } catch {
        return;
      } finally {
        started = null;
      }
      await channel.disconnect();
    },

    /** 按消息 ID 原位更新，或用飞书消息 API 的 uuid 在重试时去重。 */
    async publish({ chatId, messageId, card, idempotencyKey }) {
      if (typeof chatId !== 'string' || !chatId ||
          (messageId !== undefined && (typeof messageId !== 'string' || !messageId)) ||
          (idempotencyKey !== undefined &&
            (typeof idempotencyKey !== 'string' || !idempotencyKey))) {
        throw new TypeError('Invalid Feishu publish options');
      }
      const encoded = encodeCard(card);
      if (!started) throw new Error('Feishu channel is not started');
      await started;

      if (messageId) {
        await callCardApi('patch', () => channel.rawClient.im.v1.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(encoded) },
        }));
        return messageId;
      }

      const result = await callCardApi('create', () => channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(encoded), uuid: idempotencyKey },
      }));
      return result.data.message_id;
    },
  };
}
