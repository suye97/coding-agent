import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createAgent } from '../src/agent.js'
import { createAttachmentStore } from '../src/attachments.js'
import { receiveTaskMessage } from '../src/attachment-intake.js'
import { dispatchDatabase } from '../src/dispatch.js'
import { createFeishuChannel } from '../src/feishu.js'
import { createProjects, createRepository } from '../src/repository.js'
import { openStore } from '../src/store.js'
import { createWorkflow } from '../src/workflow.js'
import type { AgentProcess } from './agent-client.js'
import type { ConfigStore } from './config.js'

type Store = ReturnType<typeof openStore>
type Workflow = ReturnType<typeof createWorkflow>
type Channel = Awaited<ReturnType<typeof createFeishuChannel>>

export class Runtime {
  private store: Store | undefined
  private workflow: Workflow | undefined
  private channel: Channel | undefined
  private timer: NodeJS.Timeout | undefined
  private worker: Promise<void> | undefined
  private publisher: Promise<void> | undefined
  private generation = 0
  private lastGroupCard: { messageId: string; chatId: string; senderId: string; status: string } | undefined

  constructor(private config: ConfigStore, private agents: AgentProcess, private notify: () => void) {}

  async publicConfig() {
    return { ...await this.config.public(), ...(this.lastGroupCard && { lastGroupCard: this.lastGroupCard }) }
  }

  async start() {
    const generation = ++this.generation
    const config = await this.config.runtime()
    await mkdir(config.dataDirectory, { recursive: true })
    const database = dispatchDatabase(config)
    if (!database) throw new Error('数据目录无效。')
    this.store = openStore(database)
    const projects = createProjects(config.projects)
    const attachments = createAttachmentStore({ directory: config.dataDirectory, appId: config.appId || 'local' })
    const repository = createRepository(join(config.dataDirectory, 'worktrees'))
    const runner = createAgent({
      execute: input => this.agents.run(input),
      getModel: async () => (await this.config.runtime()).model,
      loadAttachment: attachments.load,
    })
    const report = () => { this.notify() }
    this.workflow = createWorkflow({ store: this.store, projects, userId: config.userId, runner, repository, onError: report })
    this.workflow.recover()
    if (config.enabled) {
      this.channel = await createFeishuChannel({
        appId: config.appId, appSecret: config.appSecret, tapdCardSource: config.tapdCardSource, onError: report,
        onGroupCard: (card: { messageId: string; chatId: string; senderId: string; status: string }) => { this.lastGroupCard = card; this.notify() },
        onMessage: (message: any) => this.workflow ? receiveTaskMessage(this.workflow, this.channel!, attachments, message) : '',
        onAction: (action: any) => this.workflow?.onAction(action) ?? '应用正在重启。',
      })
      await this.channel.start()
    }
    if (generation !== this.generation) return
    this.timer = setInterval(() => {
      this.notify()
      if (!config.enabled || !this.workflow) return
      this.worker ??= this.workflow.work().catch(report).finally(() => { this.worker = undefined })
      if (this.channel) this.publisher ??= this.workflow!.publish(this.channel).catch(report).finally(() => { this.publisher = undefined })
    }, 1000)
  }

  async stop() {
    ++this.generation
    clearInterval(this.timer)
    this.workflow?.stop()
    await this.channel?.stop().catch(() => {})
    await Promise.allSettled([this.worker, this.publisher])
    this.store?.close()
    this.store = undefined
    this.workflow = undefined
    this.channel = undefined
  }

  async restart() {
    await this.stop()
    await this.start()
    this.notify()
  }

  async close() {
    await this.stop()
    await this.agents.close()
  }
}
