import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { safeStorage } from 'electron'
import type { ConfigInput, ProjectConfig, PublicConfig } from './shared.js'

interface StoredConfig {
  enabled: boolean
  appId: string
  userId: string
  dataDirectory: string
  appSecret?: string
  tapdCardSource?: { chatId: string; senderId: string; operatorId: string }
  model: { baseUrl: string; name: string; apiKey?: string }
  projects: ProjectConfig[]
}

const defaults = (directory: string): StoredConfig => ({
  enabled: false, appId: '', userId: '', dataDirectory: join(directory, 'tasks'),
  model: { baseUrl: 'https://api.anthropic.com', name: 'claude-opus-5-5' }, projects: [],
})

function encrypt(value: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('操作系统安全存储当前不可用，无法保存密钥。')
  return safeStorage.encryptString(value).toString('base64')
}

function decrypt(value?: string) {
  if (!value) return ''
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')) } catch { throw new Error('无法解密已保存的密钥，请重新填写。') }
}

function validateProject(project: ProjectConfig) {
  if (!project.name?.trim() || !isAbsolute(project.path ?? '') || !project.baseBranch?.trim() || !project.remote?.trim()) {
    throw new Error('项目名称、仓库绝对路径、基线分支和远程均为必填项。')
  }
  if (!Array.isArray(project.aliases) || !Array.isArray(project.checks)) throw new Error('项目配置格式无效。')
  for (const check of project.checks) {
    if (!check.label?.trim() || !check.command?.trim() || !Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string')) {
      throw new Error('项目检查必须包含名称、可执行文件和参数数组。')
    }
  }
}

export function createConfigStore(file: string) {
  let current: StoredConfig | undefined
  async function load() {
    if (current) return current
    let saved: Partial<StoredConfig> = {}
    try { saved = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('应用配置无法读取，请检查配置文件。')
    }
    current = { ...defaults(dirname(file)), ...saved, model: { ...defaults(dirname(file)).model, ...saved.model }, projects: saved.projects ?? [] }
    return current
  }
  async function save(next: StoredConfig) {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
    current = next
  }
  return {
    async public(): Promise<PublicConfig> {
      const config = await load()
      return {
        enabled: config.enabled, appId: config.appId, userId: config.userId, dataDirectory: config.dataDirectory,
        appSecretConfigured: Boolean(config.appSecret), projects: config.projects, tapdCardSource: config.tapdCardSource,
        model: { baseUrl: config.model.baseUrl, name: config.model.name, apiKeyConfigured: Boolean(config.model.apiKey) },
      }
    },
    async update(input: ConfigInput) {
      const previous = await load()
      if (typeof input.enabled !== 'boolean' || typeof input.appId !== 'string' || typeof input.userId !== 'string' ||
          typeof input.dataDirectory !== 'string' || !input.model || !Array.isArray(input.projects)) throw new Error('配置字段格式无效。')
      const dataDirectory = input.dataDirectory.trim() || join(dirname(file), 'tasks')
      if (!isAbsolute(dataDirectory)) throw new Error('数据目录必须是绝对路径。')
      const baseUrl = input.model.baseUrl.trim().replace(/\/$/, '')
      if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL 必须是有效的 HTTP 或 HTTPS 地址。')
      if (!input.model.name.trim()) throw new Error('请填写模型名称。')
      const operators = input.userId.split(',').map(value => value.trim()).filter(Boolean)
      if (operators.some(value => !/^ou_[A-Za-z0-9_-]+$/u.test(value))) throw new Error('操作人 Open ID 格式无效。')
      input.projects.forEach(validateProject)
      const source = input.tapdCardSource
      if (source && Object.values(source).some(Boolean)) {
        if (!/^oc_[A-Za-z0-9_-]+$/u.test(source.chatId) || !source.senderId.trim() || !/^ou_[A-Za-z0-9_-]+$/u.test(source.operatorId) ||
            (operators.length && !operators.includes(source.operatorId))) throw new Error('TAPD 群卡片来源的群 ID、发送方或操作人无效。')
      }      if (input.enabled && (!input.appId.trim() || !operators.length || !input.projects.length)) throw new Error('启用前请完成飞书应用、操作人和项目配置。')
      const appSecret = input.appSecret?.trim() ? encrypt(input.appSecret.trim()) : previous.appSecret
      const apiKey = input.model.apiKey?.trim() ? encrypt(input.model.apiKey.trim()) : previous.model.apiKey
      if (input.enabled && (!appSecret || !apiKey)) throw new Error('启用前请填写飞书 App Secret 和模型 API Key。')
      await save({ enabled: input.enabled, appId: input.appId.trim(), userId: operators.join(','), dataDirectory, appSecret, tapdCardSource: input.tapdCardSource, model: { baseUrl, name: input.model.name.trim(), apiKey }, projects: input.projects })
      return this.public()
    },
    async secrets() {
      const config = await load()
      return { appSecret: decrypt(config.appSecret), apiKey: decrypt(config.model.apiKey) }
    },
    async runtime() {
      const config = await load()
      const secrets = await this.secrets()
      return { ...config, ...secrets, model: { ...config.model, apiKey: secrets.apiKey } }
    },
  }
}

export type ConfigStore = ReturnType<typeof createConfigStore>
