import { isAbsolute } from 'node:path'
import { createProjects } from './repository.js'
import { isOperatorId, operatorIds } from './operators.js'

const prefix = 'feishuChannel/'
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })

/** 返回可展示的配置状态，绝不包含凭据值。 */
function publicSettings(config, secretConfigured, lastGroupCard) {
  return {
    appId: config.appId ?? '',
    userId: config.userId ?? '',
    enabled: config.enabled === true,
    dataDirectory: config.dataDirectory ?? '',
    secretConfigured,
    ...(config.tapdCardSource && { tapdCardSource: config.tapdCardSource }),
    ...(lastGroupCard && { lastGroupCard }),
  }
}

/** 检查表单字段，同时允许在停用状态下逐步填写配置。 */
function validateInput(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof payload.appId !== 'string' || typeof payload.userId !== 'string' ||
      typeof payload.enabled !== 'boolean' ||
      (payload.dataDirectory !== undefined && typeof payload.dataDirectory !== 'string') ||
      (payload.appSecret !== undefined && (typeof payload.appSecret !== 'string' || !payload.appSecret.trim()))) {
    return failure('feishu-channel/invalid-input', '配置字段格式无效。')
  }
  if (payload.appId !== payload.appId.trim() ||
      (payload.dataDirectory !== undefined && payload.dataDirectory !== payload.dataDirectory.trim())) {
    return failure('feishu-channel/invalid-input', '配置字段前后不能包含空格。')
  }
  if (!operatorIds(payload.userId)) {
    return failure('feishu-channel/invalid-user-id', '操作人必须是飞书 open_id（ou_ 开头），多个 ID 用英文逗号分隔。')
  }
  return null
}

/** 为一个插件实例创建配置请求处理器。 */
export function createChannelSettingsHandler(ctx, config, entry = ctx.fiber.entry, getLastGroupCard) {
  return async (endpoint, payload, signal, peer) => {
    if (peer?.principal?.kind !== 'owner' || peer.signal?.aborted) return failure('feishu-channel/denied', '仅所有者可访问飞书配置。')
    if (signal?.aborted) return failure('feishu-channel/cancelled', '请求已取消。')
    if (endpoint !== `${prefix}read` && endpoint !== `${prefix}save`) return failure('feishu-channel/not-found', '未知配置接口。')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.secretKey ?? '')) {
      return failure('feishu-channel/invalid-secret-key', '凭据引用名称无效。')
    }
    let secretConfigured
    try {
      secretConfigured = Boolean((await ctx.credentials.resolve(config.secretKey))?.value)
    } catch {
      return failure('feishu-channel/credential-read-failed', '读取飞书凭据状态失败。')
    }
    if (endpoint === `${prefix}read`) return { ok: true, value: publicSettings(config, secretConfigured, getLastGroupCard?.()) }

    const invalid = validateInput(payload)
    if (invalid) return invalid
    const source = payload.tapdCardSource
    if (source !== undefined && (!source || typeof source !== 'object' || Array.isArray(source) ||
        !['chatId', 'senderId', 'operatorId'].every(key => typeof source[key] === 'string'))) {
      return failure('feishu-channel/invalid-source', 'TAPD 卡片来源格式无效。')
    }
    const tapdCardSource = source === undefined ? config.tapdCardSource : {
      chatId: source.chatId.trim(), senderId: source.senderId.trim(), operatorId: source.operatorId.trim(),
    }
    const operators = operatorIds(payload.userId)
    if (tapdCardSource && Object.values(tapdCardSource).some(Boolean) &&
        (!/^oc_[A-Za-z0-9_-]{1,200}$/u.test(tapdCardSource.chatId) ||
          !/^[A-Za-z0-9_-]{1,200}$/u.test(tapdCardSource.senderId) || !isOperatorId(tapdCardSource.operatorId) ||
          (operators.length && !operators.includes(tapdCardSource.operatorId)))) {
      return failure('feishu-channel/invalid-source', '请填写有效的群 ID、机器人发送方 ID 和任务操作人 Open ID。操作人名单已填写时，此人须在名单内。')
    }
    const dataDirectory = payload.dataDirectory ?? config.dataDirectory ?? ''
    if (payload.enabled) {
      if (!payload.appId) return failure('feishu-channel/app-id-required', '启用前请填写飞书 App ID。')
      if (!isAbsolute(dataDirectory)) return failure('feishu-channel/data-directory-required', '启用前请填写绝对路径的数据目录。')
      if (!Array.isArray(config.projects) || !config.projects.length) {
        return failure('feishu-channel/projects-required', '启用前请在插件配置中添加项目。')
      }
      try { createProjects(config.projects) } catch {
        return failure('feishu-channel/invalid-projects', '项目配置无效，请检查项目路径、名称和基线分支。')
      }
      if (!secretConfigured && payload.appSecret === undefined) {
        return failure('feishu-channel/app-secret-required', '启用前请填写飞书 App Secret。')
      }
    }
    if (!entry || !ctx.configEditor) return failure('feishu-channel/config-unavailable', '当前插件配置不可编辑。')
    if (signal?.aborted) return failure('feishu-channel/cancelled', '请求已取消。')

    let secretSaved = false
    if (payload.appSecret !== undefined) {
      try {
        await ctx.credentials.set(config.secretKey, payload.appSecret)
        secretSaved = true
      } catch {
        return failure('feishu-channel/credential-save-failed', '飞书凭据保存失败，配置未修改。')
      }
    }
    try {
      await ctx.configEditor.edit(entry, current => ({
        ...current,
        appId: payload.appId,
        userId: operators.join(','),
        ...(tapdCardSource && { tapdCardSource }),
        enabled: payload.enabled,
        dataDirectory,
      }))
    } catch {
      return secretSaved
        ? failure('feishu-channel/partial-save', '飞书凭据已保存，但插件配置保存失败。请重新读取配置。')
        : failure('feishu-channel/config-save-failed', '插件配置保存失败。')
    }
    return { ok: true, value: publicSettings({ ...config, ...payload, userId: operators.join(','), tapdCardSource, dataDirectory }, secretConfigured || secretSaved, getLastGroupCard?.()) }
  }
}

/** 注册仅供已认证所有者调用的 Connection 精确路由。 */
export function registerChannelSettings(ctx, config, entry = ctx.fiber.entry, getLastGroupCard) {
  const handle = createChannelSettingsHandler(ctx, config, entry, getLastGroupCard)
  for (const method of ['read', 'save']) {
    const endpoint = `${prefix}${method}`
    ctx.connection.fetch.register({
      path: `/api/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const envelope = await request.json().catch(() => null)
        if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.method !== endpoint) {
          return new Response('Invalid request', { status: 400 })
        }
        const result = await handle(endpoint, envelope.payload, request.signal, { principal: { kind: 'owner' } })
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
      },
    })
  }
}
