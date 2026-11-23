import Schema from '@deepseek-ai/schemastery'
import { mkdir } from 'node:fs/promises'
import { dispatchDatabase, registerDispatch } from './src/dispatch.js'
import { registerChannelSettings } from './src/channel-settings.js'
import { registerClaudeSettings } from './src/claude-settings.js'
import { registerProjectSettings } from './src/project-settings.js'
import { dirname, isAbsolute, join } from 'node:path'
import { createFeishuChannel } from './src/feishu.js'
import { createAttachmentStore } from './src/attachments.js'
import { receiveTaskMessage } from './src/attachment-intake.js'
import { createHarness } from './src/harness.js'
import { createDesktopEnvironment } from './src/desktop-environment.js'
import { createProjects, createRepository } from './src/repository.js'
import { openStore } from './src/store.js'
import { createWorkflow } from './src/workflow.js'
import { operatorIds } from './src/operators.js'

export const inject = ['agents', 'subagents', 'credentials']
export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('启动飞书长连接和任务处理'),
  appId: Schema.string().default('').description('飞书自建应用 App ID'),
  secretKey: Schema.string().default('FEISHU_DEV_APP_SECRET').description('DSH 凭据引用名称'),
  userId: Schema.string().default('').description('操作人 open_id，用英文逗号分隔；留空允许任何用户发起关键词任务'),
  tapdCardSource: Schema.object({
    chatId: Schema.string().default('').description('接收 TAPD 卡片的飞书群 chat_id'),
    senderId: Schema.string().default('').description('发送 TAPD 卡片的机器人事件发送方 ID'),
    operatorId: Schema.string().default('').description('该来源创建任务的操作人 open_id'),
  }).description('指定 TAPD 群卡片来源'),
  dataDirectory: Schema.string().default('').description('SQLite 和任务工作树的绝对存放路径'),
  designProvider: Schema.string().default('').description('限制为只读的 Claude Code provider'),
  developmentProvider: Schema.string().default('').description('写入范围限制在任务工作树的 Claude Code provider'),
  providerPoliciesVerified: Schema.boolean().default(false).description('只有完成 provider 的工作目录和权限联调后才开启'),
  claudeConfigDirectory: Schema.string().default('').description('包含 settings.json 的 Claude Code 配置目录绝对路径'),
  desktopTemplateDirectory: Schema.string().default('').description('专用 Desktop 验证模板绝对路径；留空使用数据目录下的 desktop-validation/template'),
  desktopExecutable: Schema.string().default('').description('DSH Desktop 可执行文件绝对路径；留空使用当前 Host 程序'),
  desktopReadinessCommand: Schema.string().default('').description('检查隔离 Desktop Provider、样例库和测试仓库的固定可执行文件'),
  desktopReadinessArgs: Schema.array(Schema.string()).default([]).description('Desktop 健康检查固定参数；路径通过环境变量传入'),
  desktopStartupTimeoutMs: Schema.natural().min(1000).max(120000).default(60000).description('Desktop 启动与健康检查总时限'),
  projects: Schema.array(Schema.object({
    name: Schema.string().required(),
    aliases: Schema.array(Schema.string()).default([]),
    path: Schema.string().required(),
    baseBranch: Schema.string().default('main'),
    remote: Schema.string().default('origin'),
    checks: Schema.array(Schema.object({
      label: Schema.string().required(),
      kind: Schema.union(['command', 'operation']).default('command'),
      command: Schema.string().required(),
      args: Schema.array(Schema.string()).default([]),
      timeoutMs: Schema.natural().min(1).max(600000).default(120000),
    })).default([]),
  })).default([]),
})

export function apply(ctx, config) {
  let lastGroupCard
  ctx.inject(['connection'], connectionCtx => registerDispatch(connectionCtx, config))
  ctx.inject(['connection', 'configEditor'], settingsCtx => registerChannelSettings(settingsCtx, config, ctx.fiber.entry, () => lastGroupCard))
  ctx.inject(['connection', 'configEditor'], settingsCtx => registerClaudeSettings(settingsCtx, config, ctx.fiber.entry))
  ctx.inject(['connection', 'configEditor'], settingsCtx => registerProjectSettings(settingsCtx, config, ctx.fiber.entry))
  if (!config.enabled) return
  if (!config.appId || !operatorIds(config.userId) || !/^[A-Z_][A-Z0-9_]*$/i.test(config.secretKey) || !isAbsolute(config.dataDirectory) || !config.projects.length) {
    throw new Error('请核对飞书 App ID、操作人 open_id 格式、凭据引用、数据目录和项目。')
  }
  const projects = createProjects(config.projects)
  const attachmentStore = createAttachmentStore({ directory: config.dataDirectory, appId: config.appId })
  const desktopRoot = join(config.dataDirectory, 'desktop-validation')
  const desktopEnvironment = createDesktopEnvironment({
    root: desktopRoot,
    templateDirectory: config.desktopTemplateDirectory || join(desktopRoot, 'template'),
    executable: config.desktopExecutable || process.execPath,
    readinessCommand: config.desktopReadinessCommand,
    readinessArgs: config.desktopReadinessArgs,
    provider: config.developmentProvider,
    startupTimeoutMs: config.desktopStartupTimeoutMs,
  })
  const runner = createHarness(ctx, config, { loadAttachment: attachmentStore.load, desktopEnvironment })
  const repository = createRepository(join(config.dataDirectory, 'worktrees'))
  const report = () => console.warn('[feishu-development-agent] 飞书连接或任务处理失败，待发送卡片将重试。')

  ctx.effect(() => {
    let stopping = false
    let store
    let channel
    let workflow
    let timer
    let worker
    let publisher
    function tick() {
      if (stopping) return
      worker ??= workflow.work().catch(report).finally(() => { worker = undefined })
      publisher ??= workflow.publish(channel).catch(report).finally(() => { publisher = undefined })
    }
    const start = (async () => {
      const secret = await ctx.credentials.resolve(config.secretKey)
      if (stopping) return
      if (!secret?.value) throw new Error('缺少飞书凭据引用。')
      const database = dispatchDatabase(config)
      await mkdir(dirname(database), { recursive: true })
      if (stopping) return
      store = openStore(database)
      workflow = createWorkflow({ store, projects, userId: config.userId, runner, repository, onError: report })
      channel = await createFeishuChannel({
        appId: config.appId, appSecret: secret.value, tapdCardSource: config.tapdCardSource, onError: report,
        onGroupCard: ({ messageId, ...source }) => {
          if (messageId === lastGroupCard?.messageId && source.status === 'received') return
          lastGroupCard = { messageId, ...source }
        },
        onMessage: message => stopping ? '' : receiveTaskMessage(workflow, channel, attachmentStore, message),
        onAction: action => stopping ? '插件正在停止。' : workflow.onAction(action),
      })
      if (stopping) return
      workflow.recover()
      await channel.start()
      if (stopping) return
      timer = setInterval(tick, 1000)
      tick()
    })().catch(() => console.warn('[feishu-development-agent] 启动失败，请核对应用配置、凭据和数据目录。'))

    return async () => {
      stopping = true
      clearInterval(timer)
      workflow?.stop()
      try {
        try {
          await channel?.stop()
        } finally {
          await start
          await channel?.stop()
        }
      } finally {
        await Promise.allSettled([worker, publisher])
        await runner.close()
        store?.close()
      }
    }
  })
}
