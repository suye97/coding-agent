import { createHash } from 'node:crypto';
import { MAX_ATTACHMENT_BYTES, MAX_TASK_ATTACHMENTS, validateAttachmentImage } from './attachments.js';

const tokenUrl = 'https://accounts.feishu.cn/oauth/v3/token';
const messageApi = 'https://open.feishu.cn/open-apis/im/v1/messages';

function isMessageId(value) {
  return typeof value === 'string' && /^om_[A-Za-z0-9_-]{1,200}$/.test(value);
}

function isImageKey(value) {
  return typeof value === 'string' && /^img_[A-Za-z0-9_-]{1,200}$/.test(value);
}

function imageKeys(message) {
  const type = message.rawContentType;
  const raw = message.raw?.message?.content;
  if (!['image', 'post'].includes(type) || typeof raw !== 'string' || raw.length > 128 * 1024) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (type === 'image') return isImageKey(data.image_key) ? [data.image_key] : [];

  // 结构化图片节点属于消息正文；Markdown 文本可能包含任意链接和密钥。
  const post = ('title' in data || 'content' in data || 'content_v2' in data) ? data :
    ['zh_cn', 'en_us', 'ja_jp', ...Object.keys(data)].map(key => data[key]).find(value => value && typeof value === 'object');
  const paragraphs = post?.content_v2?.length ? post.content_v2 : post?.content;
  if (!Array.isArray(paragraphs)) return [];
  const keys = new Set();
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    for (const element of paragraph) {
      if (element?.tag === 'img' && isImageKey(element.image_key)) keys.add(element.image_key);
      if (keys.size > MAX_TASK_ATTACHMENTS) return [...keys];
    }
  }
  return [...keys];
}

export function groupCardSource(message) {
  if (message.chatType !== 'group' || !['app', 'bot'].includes(message.senderType) ||
      message.rawContentType !== 'interactive' || !isMessageId(message.messageId) ||
      !/^oc_[A-Za-z0-9_-]{1,200}$/u.test(message.chatId)) return null;
  const sender = message.raw?.sender?.sender_id;
  const senderIds = [message.senderId, sender?.open_id, sender?.app_id, sender?.user_id]
    .filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(id));
  return senderIds.length ? { chatId: message.chatId, senderIds } : null;
}

function isTapdCardSource(message, source) {
  const observed = groupCardSource(message);
  return observed && observed.chatId === source?.chatId && isOpenId(source.operatorId) &&
    observed.senderIds.includes(source.senderId);
}

// 飞书接收事件可能包含扁平化卡片格式，而非原始卡片描述。
function receivedCardText(raw) {
  if (typeof raw !== 'string' || raw.length > 128 * 1024) return '';
  let card;
  try { card = JSON.parse(raw); } catch { return ''; }
  if (typeof card?.title !== 'string' || !Array.isArray(card.elements)) return '';
  const rows = card.elements.filter(Array.isArray).map(row => row.map(element => {
    if (['text', 'a', 'lark_md', 'plain_text', 'markdown'].includes(element?.tag)) {
      const value = element.text ?? element.content;
      return typeof value === 'string' ? value : '';
    }
    return '';
  }).join(''));
  return [card.title, ...rows].join('\n');
}

export function normalizeTapdCard(message, source) {
  if (!isTapdCardSource(message, source)) return null;
  for (const content of [receivedCardText(message.raw?.message?.content), message.content]) {
    const card = parseTapdCardText(content);
    if (card) return { group: true, tapdCard: true, eventId: message.messageId,
      chatId: message.chatId, userId: source.operatorId, text: `${card.title}\n${card.details}` };
  }
  return null;
}

function parseTapdCardText(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  content = content.trim();
  const header = /^(开发需求|修复缺陷|修复bug)\s*[｜|]\s*([^\r\n]+)$/iu;
  const [heading, ...lines] = content.split(/\r?\n/u);
  const title = heading.trim().replace(/^\*\*(.+)\*\*$/u, '$1');
  if (!header.test(title)) return null;
  const details = lines.join('\n').match(/(?:^|\n)[ \t]*(?:\*\*)?详细描述(?:\*\*)?[：:](?:\*\*)?[ \t]*([\s\S]*?)(?=\n[ \t]*(?:\*\*)?(?:标题(?:\*\*)?[：:]|此消息由TAPD自动化助手触发)|$)/u)?.[1].trim();
  if (!details) return null;
  return { title, details };
}

/** 规范化单聊或群聊中的人工消息，仅保留结构化图片资源。 */
export function normalizeFeishuMessage(message) {
  if (!['p2p', 'group'].includes(message.chatType) || message.senderType !== 'user' ||
      !['text', 'post', 'merge_forward', 'image'].includes(message.rawContentType)) return null;
  const openId = message.raw?.sender?.sender_id?.open_id;
  if (!isOpenId(openId) || openId !== message.senderId ||
      typeof message.chatId !== 'string' || !message.chatId ||
      typeof message.messageId !== 'string' || !message.messageId) return null;

  const keys = isMessageId(message.messageId) ? imageKeys(message) : [];
  if (message.rawContentType === 'image' && !keys.length) return null;
  let text = message.rawContentType === 'image' ? '' : message.content;
  if (keys.length && typeof text === 'string') {
    for (const key of keys) text = text.replaceAll(`![image](${key})`, '');
    text = text.trim();
  }
  const incoming = { eventId: message.messageId, chatId: message.chatId, userId: openId, text, replyTo: message.replyToMessageId };
  if (message.chatType === 'group') incoming.group = true;
  if (isMessageId(message.rootId)) incoming.replyRoot = message.rootId;
  if (keys.length) incoming.attachments = keys.map(key => ({ kind: 'image', messageId: message.messageId, key }));
  return incoming;
}

async function boundedBody(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty Feishu response');
  try {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('Feishu response too large');
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) throw new Error('Feishu response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 通过飞书固定的 HTTPS 接口读取已授权资源。 */
export function createFeishuAttachmentDownloader({ appId, appSecret, fetchImpl = globalThis.fetch }) {
  let token;
  let tokenRequest;

  async function requestToken() {
    const response = await fetchImpl(tokenUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: appSecret }),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('Feishu token request failed');
    }
    const data = JSON.parse((await boundedBody(response, 16 * 1024)).toString('utf8'));
    if (data?.code !== 0 || typeof data.access_token !== 'string' ||
        !/^[A-Za-z0-9._~+/=-]{1,8192}$/.test(data.access_token) ||
        !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 7200) {
      throw new Error('Invalid Feishu token response');
    }
    return { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  }

  async function getToken() {
    if (token?.expiresAt > Date.now() + 30_000) return token;
    tokenRequest ??= requestToken().then(result => { token = result; return result; }).finally(() => { tokenRequest = undefined; });
    return tokenRequest;
  }

  async function getResource(ref, credential, signal) {
    return fetchImpl(`${messageApi}/${ref.messageId}/resources/${ref.key}?type=image`, {
      headers: { Authorization: `Bearer ${credential.value}` }, redirect: 'error', signal,
    });
  }

  return async function downloadAttachment(ref) {
    if (ref?.kind !== 'image' || !isMessageId(ref.messageId) || !isImageKey(ref.key)) {
      throw new TypeError('Invalid Feishu attachment reference');
    }
    try {
      const signal = AbortSignal.timeout(20_000);
      const credential = await getToken();
      let response = await getResource(ref, credential, signal);
      if (response.status === 401) {
        await response.body?.cancel();
        if (token === credential) token = undefined;
        response = await getResource(ref, await getToken(), signal);
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error('Feishu resource request failed');
      }
      return validateAttachmentImage(await boundedBody(response, MAX_ATTACHMENT_BYTES), response.headers.get('content-type'));
    } catch {
      // 传输错误和接口响应可能泄露应用凭据。
      throw new Error('Feishu image download or validation failed');
    }
  };
}

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
export async function createFeishuChannel({ appId, appSecret, tapdCardSource, onGroupCard, onMessage, onAction, onError }) {
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
    policy: { requireMention: false },
    httpTimeoutMs: 15000,
    connectTimeoutMs: 30000,
    safety: { chatQueue: { enabled: true, cardActions: 'separate' } },
  });
  let started = null;
  const downloadAttachment = createFeishuAttachmentDownloader({ appId, appSecret });

  /** 将异步事件处理错误送交主程序，避免回调异常丢失。 */
  function reportError(error) {
    try {
      onError(error);
    } catch {
      // 主程序错误回调不应阻断 SDK 的事件分发。
    }
  }

  // 即使 SDK 规范化或策略丢弃事件，也记录平台投递状态。
  channel.onRawEvent('im.message.receive_v1', event => {
    const raw = event.message;
    const observed = groupCardSource({ chatType: raw?.chat_type, rawContentType: raw?.message_type,
      chatId: raw?.chat_id, messageId: raw?.message_id, senderType: event.sender?.sender_type, raw: event });
    if (observed) onGroupCard?.({ chatId: observed.chatId, senderId: observed.senderIds[0], receivedAt: Date.now(),
      messageId: raw.message_id, status: 'received' });
  });

  /** 处理单聊和群聊消息，并统一使用 open_id。 */
  channel.on('message', async (message) => {
    try {
      const observed = groupCardSource(message);
      const recordCard = status => {
        if (observed) onGroupCard?.({ chatId: observed.chatId, senderId: observed.senderIds[0],
          messageId: message.messageId, receivedAt: Date.now(), status });
      };
      if (observed) recordCard(isTapdCardSource(message, tapdCardSource) ? 'content' : 'source');
      let incoming = normalizeFeishuMessage(message) ?? normalizeTapdCard(message, tapdCardSource);
      if (!incoming && isTapdCardSource(message, tapdCardSource)) {
        const fetched = await channel.fetchMessage(message.messageId);
        if (fetched) incoming = normalizeTapdCard({ ...message, content: fetched.content, raw: { ...message.raw, message: fetched.raw?.message } }, tapdCardSource);
        if (!incoming) {
          const [item] = await channel.fetchRawMessage(message.messageId);
          if (item?.message_id === message.messageId) incoming = normalizeTapdCard({ ...message,
            raw: { ...message.raw, message: { content: item.body?.content } } }, tapdCardSource);
        }
      }
      if (!incoming) return;
      const reply = await onMessage(incoming);
      if (incoming.tapdCard) recordCard('parsed');
      else if (reply) await channel.reply(message, { text: reply });
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
    downloadAttachment,

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
      const connecting = started;
      started = null;
      // 连接尚未完成时也不能卡住应用退出；迟到成功后立即补一次断开。
      void connecting.then(() => channel.disconnect()).catch(() => {});
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
