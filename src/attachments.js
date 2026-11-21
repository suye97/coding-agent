import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { crc32 } from 'node:zlib';

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TASK_ATTACHMENTS = 8;
export const MAX_TASK_ATTACHMENT_BYTES = 24 * 1024 * 1024;

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const jpegFrameMarkers = new Set([0xc0, 0xc1, 0xc2]);
const pngColorDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const imageFormats = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const pendingSaves = new Map();

function invalidImage() {
  return new Error('Invalid or unsupported attachment image');
}

function pngSize(bytes) {
  let hasImageData = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length || crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) break;
    const type = bytes.toString('latin1', offset + 4, start);
    if (offset === 8 ? type !== 'IHDR' || length !== 13 : type === 'IHDR') break;
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') break;
    if (type === 'IDAT' && length) hasImageData = true;
    if (type === 'IEND') {
      if (length !== 0 || end + 4 !== bytes.length || !hasImageData) break;
      const depth = bytes[24];
      const color = bytes[25];
      if (!pngColorDepths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) break;
      return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    }
    offset = end + 4;
  }
  throw invalidImage();
}

function jpegSize(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw invalidImage();
  let dimensions;
  let hasScan = false;
  for (let offset = 2; offset + 1 < bytes.length;) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 && offset === bytes.length && hasScan) return dimensions;
    if (offset + 2 > bytes.length || marker < 0xc0 || marker === 0xd8 || marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length - 2) break;
    if (marker < 0xd0 && ![0xc4, 0xcc].includes(marker)) {
      if (!jpegFrameMarkers.has(marker) || length < 11 || dimensions) break;
      const components = bytes[offset + 7];
      if (length !== 8 + 3 * components || ![1, 3, 4].includes(components) || bytes[offset + 2] !== 8) break;
      dimensions = [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    const scan = marker === 0xda;
    if (scan && (!dimensions || length < 8 || length !== 6 + 2 * bytes[offset + 2])) break;
    offset = end;
    if (scan) {
      // 跳过熵编码扫描中的填充字节和重启标记。
      for (;;) {
        const next = bytes.indexOf(0xff, offset);
        if (next < 0) throw invalidImage();
        offset = next + 1;
        while (bytes[offset] === 0xff) offset++;
        const following = bytes[offset];
        if (following !== 0 && !(following >= 0xd0 && following <= 0xd7)) {
          offset--;
          break;
        }
        offset++;
      }
      if (offset <= end) break;
      hasScan = true;
    }
  }
  throw invalidImage();
}

function webpSize(bytes) {
  if (bytes.readUInt32LE(4) !== bytes.length - 8) throw invalidImage();
  let canvas;
  let dimensions;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('latin1', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end + (length & 1) > bytes.length) throw invalidImage();
    if (type === 'ANIM' || type === 'ANMF') throw invalidImage();
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || bytes[start] & 2) throw invalidImage();
      canvas = [1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3)];
    }
    if (type === 'VP8 ' || type === 'VP8L') {
      if (dimensions) throw invalidImage();
      if (type === 'VP8 ' && length > 10 && !(bytes[start] & 1) && bytes.readUIntBE(start + 3, 3) === 0x9d012a) {
        dimensions = [bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff];
      } else if (type === 'VP8L' && length > 5 && bytes[start] === 0x2f) {
        const packed = bytes.readUInt32LE(start + 1);
        if (packed >>> 29) throw invalidImage();
        dimensions = [1 + (packed & 0x3fff), 1 + ((packed >>> 14) & 0x3fff)];
      } else {
        throw invalidImage();
      }
    }
    offset = end + (length & 1);
  }
  if (!dimensions || offset !== bytes.length || (canvas && (canvas[0] !== dimensions[0] || canvas[1] !== dimensions[1]))) {
    throw invalidImage();
  }
  return dimensions;
}

/** 存储或加载前检查图片容器、声明的媒体类型和尺寸。 */
export function validateAttachmentImage(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) throw invalidImage();
  let extension;
  let dimensions;
  if (bytes.subarray(0, 8).equals(pngSignature)) {
    extension = 'png';
    dimensions = pngSize(bytes);
  } else if (bytes.length >= 2 && bytes.readUInt16BE(0) === 0xffd8) {
    extension = 'jpg';
    dimensions = jpegSize(bytes);
  } else if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    extension = 'webp';
    dimensions = webpSize(bytes);
  } else {
    throw invalidImage();
  }
  const mimeType = imageFormats[extension];
  if (contentType != null && typeof contentType !== 'string') throw invalidImage();
  const declared = contentType?.split(';', 1)[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== mimeType) throw invalidImage();
  const [width, height] = dimensions;
  if (!width || !height || width > 8192 || height > 8192 || width * height > 24_000_000) throw invalidImage();
  return { bytes, mimeType, extension, width, height };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function checkedDirectory(parent, name, create) {
  const path = join(parent, name);
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
    throw new Error('Invalid attachment directory');
  }
  return path;
}

async function assertTaskCapacity(folder, incomingBytes) {
  const names = (await readdir(folder)).filter(name => /^[0-9a-f]{64}\.(png|jpg|webp)$/.test(name));
  const sizes = await Promise.all(names.map(async name => (await lstat(join(folder, name))).size));
  if (sizes.length >= MAX_TASK_ATTACHMENTS || sizes.reduce((sum, size) => sum + size, incomingBytes) > MAX_TASK_ATTACHMENT_BYTES) {
    throw Object.assign(new Error('Task attachment limit exceeded'), { code: 'ATTACHMENT_LIMIT' });
  }
}

async function readAttachment(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.size > MAX_ATTACHMENT_BYTES) throw invalidImage();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.size > MAX_ATTACHMENT_BYTES) throw invalidImage();
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw invalidImage();
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

/** 按任务和应用存储图片，并以摘要作为稳定标识。 */
export function createAttachmentStore({ directory, appId }) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || typeof appId !== 'string' || !appId) {
    throw new TypeError('Invalid attachment store options');
  }
  const namespace = sha256(appId);

  async function taskDirectory(taskId, create) {
    if (typeof taskId !== 'string' || !/^[0-9a-f]{8}$/i.test(taskId)) throw new TypeError('Invalid attachment task ID');
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await checkedDirectory(await realpath(directory), 'attachments', create);
    const app = await checkedDirectory(root, namespace, create);
    return checkedDirectory(app, taskId.toUpperCase(), create);
  }

  async function load(taskId, ref) {
    if (typeof ref?.id !== 'string' || !/^[0-9a-f]{64}$/.test(ref.id) || !Object.hasOwn(imageFormats, ref.extension)) {
      throw new TypeError('Invalid attachment reference');
    }
    const folder = await taskDirectory(taskId, false);
    const path = join(folder, `${ref.id}.${ref.extension}`);
    const bytes = await readAttachment(path);
    const image = validateAttachmentImage(bytes, imageFormats[ref.extension]);
    if (sha256(bytes) !== ref.id || bytes.length !== ref.byteLength || image.mimeType !== ref.mimeType ||
        image.width !== ref.width || image.height !== ref.height) throw invalidImage();
    return { ...image, path };
  }

  async function saveImage(taskId, folder, ref, bytes) {
    const path = join(folder, `${ref.id}.${ref.extension}`);
    try {
      await load(taskId, ref);
      return ref;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await assertTaskCapacity(folder, bytes.length);
    const temporary = join(folder, `.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await load(taskId, ref);
      }
    } finally {
      await unlink(temporary);
    }
    return ref;
  }

  return {
    async save(taskId, image) {
      const { bytes: source, ...metadata } = validateAttachmentImage(image?.bytes, image?.mimeType);
      const bytes = Buffer.from(source);
      const ref = { id: sha256(bytes), ...metadata, byteLength: bytes.length };
      const folder = await taskDirectory(taskId, true);
      const previous = pendingSaves.get(folder) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(() => saveImage(taskId, folder, ref, bytes));
      pendingSaves.set(folder, pending);
      try {
        return await pending;
      } finally {
        if (pendingSaves.get(folder) === pending) pendingSaves.delete(folder);
      }
    },
    load,
  };
}
