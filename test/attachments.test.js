import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { createAttachmentStore, MAX_ATTACHMENT_BYTES, MAX_TASK_ATTACHMENTS, validateAttachmentImage } from '../src/attachments.js';
import { createFeishuAttachmentDownloader, normalizeFeishuMessage, normalizeTapdCard } from '../src/feishu.js';

test('only the configured TAPD robot card supplies a group request', () => {
  const source = { chatId: 'oc_coding', senderId: 'cli_tapd', operatorId: 'ou_owner' };
  const event = { chatType: 'group', senderType: 'app', rawContentType: 'interactive', chatId: source.chatId,
    messageId: 'om_tapd', senderId: source.senderId, content: '开发需求| coding-agent\n详细描述：调整整体 UI\n标题：修改样式\n此消息由TAPD自动化助手触发' };
  assert.deepEqual(normalizeTapdCard(event, source), { group: true, tapdCard: true, eventId: 'om_tapd', chatId: source.chatId, userId: source.operatorId, text: '开发需求| coding-agent\n调整整体 UI' });
  const canonical = { ...event, content: '[interactive card]', raw: { message: { content: JSON.stringify({
    title: '开发需求| coding-agent', elements: [
      [{ tag: 'text', text: '详细描述: ' }, { tag: 'text', text: '调整整体 UI' }],
      [{ tag: 'text', text: '标题: 修改样式 ' }, { tag: 'a', text: '详情' }],
      [{ tag: 'text', text: '此消息由TAPD自动化助手触发' }],
    ],
  }) } } };
  assert.deepEqual(normalizeTapdCard(canonical, source), normalizeTapdCard(event, source));
  assert.equal(normalizeTapdCard(event, undefined), null);
  assert.equal(normalizeTapdCard({ ...event, chatId: 'oc_other' }, source), null);
  assert.equal(normalizeTapdCard({ ...event, senderType: 'user' }, source), null);
  assert.equal(normalizeTapdCard({ ...event, senderId: 'cli_other' }, source), null);
});

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function png(width = 1, height = 1, red = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, red, 0, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const ref = { kind: 'image', messageId: 'om_picture', key: 'img_v3_test' };
const token = (value = 'test-token') => Response.json({ code: 0, access_token: value, expires_in: 7200 });
const image = () => new Response(png(), { headers: { 'content-type': 'image/png' } });

function message(type, data, content = '') {
  return {
    chatType: 'p2p', senderType: 'user', senderId: 'ou_owner', chatId: 'oc_chat', messageId: ref.messageId,
    replyToMessageId: 'om_task_card', rootId: 'om_root', rawContentType: type, content,
    raw: { sender: { sender_id: { open_id: 'ou_owner' } }, message: { content: JSON.stringify(data) } },
  };
}

test('normalizes a direct image reply with its own resource ID and the task reply ID', () => {
  const event = message('image', { image_key: ref.key }, `![image](${ref.key})`);
  assert.deepEqual(normalizeFeishuMessage(event), {
    eventId: ref.messageId, chatId: 'oc_chat', userId: 'ou_owner', text: '',
    replyTo: 'om_task_card', replyRoot: 'om_root', attachments: [ref],
  });
  assert.equal(normalizeFeishuMessage({ ...event, chatType: 'group' }).group, true);
  assert.equal(normalizeFeishuMessage({ ...event, senderType: 'bot' }), null);
  assert.equal(normalizeFeishuMessage({ ...event, senderId: 'ou_other' }), null);
  assert.equal(normalizeFeishuMessage(message('image', { image_key: 'https://example.test/image' })), null);
});

test('reads only structured image nodes in rich text and preserves the human caption', () => {
  const event = message('post', {
    zh_cn: { content: [[{ tag: 'img', image_key: ref.key }, { tag: 'img', image_key: ref.key },
      { tag: 'md', text: '![image](img_unrelated)' }, { tag: 'img', image_key: '../img_x' }]] },
  }, `原型说明\n![image](${ref.key})\n![image](${ref.key})\n![image](img_unrelated)`);
  event.resources = [{ type: 'image', fileKey: 'img_unrelated' }];
  const output = normalizeFeishuMessage(event);
  assert.deepEqual(output.attachments, [ref]);
  assert.match(output.text, /原型说明/);
  assert.doesNotMatch(output.text, /img_v3_test/);
  assert.match(output.text, /img_unrelated/);
  assert.equal(normalizeFeishuMessage({ ...event, rawContentType: 'merge_forward' }).attachments, undefined);
  assert.equal(normalizeFeishuMessage(message('text', { text: '![image](img_unrelated)' })).attachments, undefined);
});

test('uses the fixed authenticated Feishu API, caches the token, and rejects unsafe references before fetching', async () => {
  const calls = [];
  const download = createFeishuAttachmentDownloader({ appId: 'app', appSecret: 'secret', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return options.method === 'POST' ? token() : image();
  } });
  const [first, second] = await Promise.all([download(ref), download(ref)]);
  assert.deepEqual(first, validateAttachmentImage(png()));
  assert.deepEqual(second, first);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://accounts.feishu.cn/oauth/v3/token');
  assert.equal(calls[0].options.body.get('grant_type'), 'client_credentials');
  assert.equal(calls[0].options.body.get('client_secret'), 'secret');
  for (const call of calls.slice(1)) {
    assert.equal(call.url, 'https://open.feishu.cn/open-apis/im/v1/messages/om_picture/resources/img_v3_test?type=image');
    assert.equal(call.options.headers.Authorization, 'Bearer test-token');
  }
  assert(calls.every(({ options }) => options.redirect === 'error' && options.signal instanceof AbortSignal));
  await assert.rejects(download({ ...ref, messageId: '../om_x' }), /Invalid Feishu attachment reference/);
  await assert.rejects(download({ ...ref, key: 'img_a%2Fother' }), /Invalid Feishu attachment reference/);
  assert.equal(calls.length, 3);
});

test('refreshes stale authorization once and sanitizes errors', async () => {
  let issued = 0;
  const download = createFeishuAttachmentDownloader({ appId: 'app', appSecret: 'secret', fetchImpl: async (url, options) => {
    if (options.method === 'POST') return token(`token-${++issued}`);
    if (options.headers.Authorization === 'Bearer token-1') return new Response(null, { status: 401 });
    throw new Error('internal credential=secret');
  } });
  await assert.rejects(download(ref), { message: 'Feishu image download or validation failed' });
  assert.equal(issued, 2);
});

test('bounds the actual response body and validates its content before returning bytes', async () => {
  const cases = [
    () => new Response(png(), { headers: { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) } }),
    () => new Response(png(), { headers: { 'content-type': 'image/jpeg' } }),
    () => Response.json({ code: 234003 }),
    () => new Response(null, { status: 206 }),
  ];
  for (const response of cases) {
    const download = createFeishuAttachmentDownloader({ appId: 'app', appSecret: 'secret',
      fetchImpl: async (url, options) => options.method === 'POST' ? token() : response() });
    await assert.rejects(download(ref), /download or validation failed/);
  }
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(MAX_ATTACHMENT_BYTES / 2)); },
    cancel() { cancelled = true; },
  });
  const download = createFeishuAttachmentDownloader({ appId: 'app', appSecret: 'secret',
    fetchImpl: async (url, options) => options.method === 'POST' ? token() : new Response(body) });
  await assert.rejects(download(ref), /download or validation failed/);
  assert.equal(cancelled, true);
});

test('validates image structure and dimensions independently of the MIME header', () => {
  assert.deepEqual(validateAttachmentImage(png(), 'application/octet-stream'), {
    bytes: png(), mimeType: 'image/png', extension: 'png', width: 1, height: 1,
  });
  for (const bytes of [png(8193, 1), png(5000, 5000), png().subarray(0, -1), Buffer.from('<svg/>')]) {
    assert.throws(() => validateAttachmentImage(bytes), /Invalid or unsupported/);
  }
  const corrupt = png();
  corrupt[45] ^= 1;
  assert.throws(() => validateAttachmentImage(corrupt), /Invalid or unsupported/);
  const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=', 'base64');
  assert.equal(validateAttachmentImage(webp).mimeType, 'image/webp');
  const jpeg = Buffer.from([
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL',
    'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/',
    'wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAA',
    'AAAAAAAAAAAAAAD/2gAIAQEAAD8AP7//2Q==',
  ].join(''), 'base64');
  assert.equal(validateAttachmentImage(jpeg).mimeType, 'image/jpeg');
  assert.throws(() => validateAttachmentImage(jpeg.subarray(0, -2)), /Invalid or unsupported/);
});

test('stores concurrently, reloads by task and application, and rejects corruption', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-attachments-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const taskId = '123ABCDE';
  const store = createAttachmentStore({ directory, appId: 'app' });
  const bytes = png();
  const [saved, duplicate] = await Promise.all([store.save(taskId, { bytes }), store.save(taskId, { bytes })]);
  assert.deepEqual(duplicate, saved);
  assert.equal(saved.id, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(saved.byteLength, bytes.length);
  const reopened = createAttachmentStore({ directory, appId: 'app' });
  const loaded = await reopened.load(taskId, saved);
  assert.deepEqual(loaded.bytes, bytes);
  assert.equal(loaded.path, join(directory, 'attachments', createHash('sha256').update('app').digest('hex'), taskId, `${saved.id}.png`));
  await assert.rejects(reopened.load('87654321', saved), { code: 'ENOENT' });
  await assert.rejects(createAttachmentStore({ directory, appId: 'other' }).load(taskId, saved), { code: 'ENOENT' });
  await assert.rejects(reopened.load('../../task', saved), /Invalid attachment task ID/);
  await assert.rejects(reopened.load(taskId, { ...saved, extension: '../../png' }), /Invalid attachment reference/);
  await assert.rejects(reopened.load(taskId, { ...saved, width: 2 }), /Invalid or unsupported/);
  const namespace = (await readdir(join(directory, 'attachments')))[0];
  const folder = join(directory, 'attachments', namespace, taskId);
  const name = `${saved.id}.png`;
  assert.deepEqual(await readdir(folder), [name]);
  await writeFile(join(folder, name), png(1, 1, 1));
  await assert.rejects(reopened.load(taskId, saved), /Invalid or unsupported/);
  await assert.rejects(reopened.save(taskId, { bytes }), /Invalid or unsupported/);
});

test('enforces persistent per-task count and byte limits while allowing duplicates', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-attachment-limit-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const store = createAttachmentStore({ directory, appId: 'app' });
  const taskId = '123ABCDE';
  const first = await store.save(taskId, { bytes: png() });
  const results = await Promise.allSettled(Array.from({ length: MAX_TASK_ATTACHMENTS }, (_, index) =>
    store.save(taskId, { bytes: png(1, 1, index + 1) })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, MAX_TASK_ATTACHMENTS - 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ATTACHMENT_LIMIT');
  const reopened = createAttachmentStore({ directory, appId: 'app' });
  assert.deepEqual(await reopened.save(taskId, { bytes: png() }), first);
  await assert.rejects(reopened.save(taskId, { bytes: png(1, 1, 99) }), { code: 'ATTACHMENT_LIMIT' });

  const byteLimitedTask = '9876FEDC';
  for (let index = 0; index < 4; index++) {
    const small = png(1, 1, index);
    const comment = pngChunk('tEXt', Buffer.alloc(7 * 1024 * 1024));
    const large = Buffer.concat([small.subarray(0, -12), comment, small.subarray(-12)]);
    const save = reopened.save(byteLimitedTask, { bytes: large });
    if (index === 3) await assert.rejects(save, { code: 'ATTACHMENT_LIMIT' });
    else assert.equal((await save).byteLength, large.length);
  }
});

test('does not follow a task directory link', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-attachment-link-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const store = createAttachmentStore({ directory, appId: 'app' });
  const taskId = '123ABCDE';
  const saved = await store.save(taskId, { bytes: png() });
  const namespace = (await readdir(join(directory, 'attachments')))[0];
  const folder = join(directory, 'attachments', namespace, taskId);
  const target = join(directory, 'other-task');
  await rename(folder, target);
  await symlink(target, folder, 'junction');
  await assert.rejects(store.load(taskId, saved), /Invalid attachment directory/);
  await assert.rejects(store.save(taskId, { bytes: png() }), /Invalid attachment directory/);
});
