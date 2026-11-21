import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const prefix = 'feishuClaude/'
const methods = ['read', 'save']
const providerPackage = '@deepseek-ai/dsh-subagent-claude-code'
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })
const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
const modelKeys = [
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
]

// 优先使用 Provider 已配置的 profile，否则按 Provider 名称自动定位。
export function resolveClaudeDirectory(config, home = homedir(), providerConfig) {
  const providerDirectory = providerConfig?.env?.CLAUDE_CONFIG_DIR
  if (providerDirectory !== undefined) {
    if (typeof providerDirectory !== 'string' || !isAbsolute(providerDirectory)) throw new Error('invalid-directory')
    return providerDirectory
  }
  if (config.claudeConfigDirectory) {
    if (!isAbsolute(config.claudeConfigDirectory)) throw new Error('invalid-directory')
    return config.claudeConfigDirectory
  }
  const provider = config.designProvider
  if (typeof provider !== 'string' || !/^[A-Za-z0-9._-]+$/.test(provider)) throw new Error('provider-required')
  const profile = provider.startsWith('claude-code-') ? `claude-${provider.slice('claude-code-'.length)}` : provider
  if (!profile) throw new Error('provider-required')
  return join(home, '.dsh', 'profiles', 'desktop', profile)
}

function findProvider(ctx, config) {
  if (!ctx.configEditor) throw new Error('config-unavailable')
  const matches = ctx.configEditor.entries().filter(entry =>
    entry.options?.name === providerPackage && entry.options?.config?.providerName === config.designProvider)
  if (matches.length !== 1) throw new Error('provider-required')
  return matches[0]
}

async function readSettings(directory) {
  let source
  try {
    source = await readFile(join(directory, 'settings.json'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  const settings = JSON.parse(source)
  if (!isObject(settings) || (settings.env !== undefined && !isObject(settings.env))) throw new Error('invalid-settings')
  return settings
}

function publicSettings(providerConfig, settings) {
  const env = settings.env ?? {}
  return {
    baseUrl: typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '',
    model: typeof providerConfig.model === 'string' ? providerConfig.model :
      typeof env.ANTHROPIC_MODEL === 'string' ? env.ANTHROPIC_MODEL : '',
    apiKeyConfigured: typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && Boolean(env.ANTHROPIC_AUTH_TOKEN),
  }
}

function validate(payload) {
  if (!isObject(payload) || typeof payload.baseUrl !== 'string' || typeof payload.model !== 'string' ||
      !payload.baseUrl.trim() || !payload.model.trim() || payload.baseUrl !== payload.baseUrl.trim() ||
      payload.model !== payload.model.trim() || payload.baseUrl.length > 2000 || payload.model.length > 500 ||
      (payload.apiKey !== undefined && (typeof payload.apiKey !== 'string' || !payload.apiKey.trim() ||
        payload.apiKey !== payload.apiKey.trim() || payload.apiKey.length > 2000))) {
    return failure('feishu-claude/invalid-input', '请填写有效的 API 地址和模型名称。')
  }
  let url
  try { url = new URL(payload.baseUrl) } catch { return failure('feishu-claude/invalid-url', 'API 地址格式无效。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return failure('feishu-claude/invalid-url', 'API 地址只支持不含凭据的 HTTP(S) 地址。')
  }
  return null
}

async function writeSettings(directory, settings) {
  await mkdir(directory, { recursive: true })
  const target = join(directory, 'settings.json')
  const temporary = join(directory, `.settings.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export function createClaudeSettingsHandler(ctx, config, entry = ctx.fiber.entry) {
  return async (endpoint, payload, signal, peer) => {
    if (peer?.principal?.kind !== 'owner' || peer.signal?.aborted) return failure('feishu-claude/denied', '仅所有者可访问模型配置。')
    if (signal?.aborted) return failure('feishu-claude/cancelled', '请求已取消。')
    if (!methods.some(method => endpoint === `${prefix}${method}`)) return failure('feishu-claude/not-found', '未知配置接口。')
    const current = entry?.options?.config ?? config
    let provider
    let directory
    try {
      provider = findProvider(ctx, current)
      directory = resolveClaudeDirectory(current, homedir(), provider.options.config)
    } catch (error) {
      if (error.message === 'config-unavailable') return failure('feishu-claude/config-unavailable', '当前 profile 不支持保存 Provider 配置。')
      return failure('feishu-claude/provider-required', '请先在当前 profile 注册并启用匹配 designProvider 的 Claude Code Provider。')
    }
    if (endpoint === `${prefix}read`) {
      try {
        return { ok: true, value: publicSettings(provider.options.config, await readSettings(directory)) }
      } catch {
        return failure('feishu-claude/read-failed', '无法读取模型配置，请检查 Provider profile 和 settings.json。')
      }
    }

    const invalid = validate(payload)
    if (invalid) return invalid
    let settings
    try {
      settings = await readSettings(directory)
    } catch {
      return failure('feishu-claude/read-failed', '无法读取现有模型配置，未保存任何修改。')
    }
    const nextSettings = { ...settings, env: { ...settings.env, ANTHROPIC_BASE_URL: payload.baseUrl } }
    for (const key of modelKeys) nextSettings.env[key] = payload.model
    if (payload.apiKey !== undefined) nextSettings.env.ANTHROPIC_AUTH_TOKEN = payload.apiKey
    if (signal?.aborted) return failure('feishu-claude/cancelled', '请求已取消。')
    try {
      await writeSettings(directory, nextSettings)
    } catch {
      return failure('feishu-claude/file-save-failed', '模型配置保存失败，请检查 Provider profile 目录权限。')
    }

    let nextProvider
    try {
      await ctx.configEditor.edit(provider, latest => {
        nextProvider = { ...latest, model: payload.model }
        return nextProvider
      })
    } catch {
      return failure('feishu-claude/partial-save', '模型连接配置已保存，但 Provider 模型名称保存失败，请重新读取后重试。')
    }
    return { ok: true, value: publicSettings(nextProvider, nextSettings) }
  }
}

export function registerClaudeSettings(ctx, config, entry = ctx.fiber.entry) {
  const handle = createClaudeSettingsHandler(ctx, config, entry)
  for (const method of methods) {
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
