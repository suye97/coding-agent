import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

interface RunInput {
  prompt: string
  cwd: string
  stage: 'design' | 'develop' | 'verify'
  electronDist?: string
  resumeSessionId?: string
  model: { name: string; baseUrl: string; apiKey: string }
  signal: AbortSignal
  onOutput(text: string): void
  onAssertion(item: { id: string; line: string; sha256: string }): boolean | void
  onSession(sessionId: string): void
}

interface Pending {
  input: RunInput
  resolve(value: { text: string; sessionId: string; stopReason: string }): void
  reject(error: Error): void
  abort(): void
}

export class AgentProcess {
  private child: UtilityProcess | undefined
  private pending = new Map<string, Pending>()
  private closing = false

  private ensureProcess() {
    if (this.child) return this.child
    const file = new URL('./agent-runner.js', import.meta.url)
    this.child = utilityProcess.fork(fileURLToPath(new URL('./agent-runner.js', import.meta.url)), [], { serviceName: 'Claude Agent Runner', stdio: 'pipe' })
    this.child.on('message', (message: { id?: string; type?: string; [key: string]: unknown }) => {
      const pending = message.id ? this.pending.get(message.id) : undefined
      if (!pending || !message.id) return
      if (message.type === 'output' && typeof message.text === 'string') pending.input.onOutput(message.text)
      if (message.type === 'assertion') pending.input.onAssertion(message.item as { id: string; line: string; sha256: string })
      if (message.type === 'session' && typeof message.sessionId === 'string') pending.input.onSession(message.sessionId)
      if (message.type === 'result') {
        this.pending.delete(message.id)
        pending.input.signal.removeEventListener('abort', pending.abort)
        pending.resolve(message.result as { text: string; sessionId: string; stopReason: string })
      }
      if (message.type === 'error') {
        this.pending.delete(message.id)
        pending.input.signal.removeEventListener('abort', pending.abort)
        pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Agent 调用失败。'))
      }
    })
    this.child.once('exit', code => {
      for (const [id, pending] of this.pending) {
        this.pending.delete(id)
        pending.input.signal.removeEventListener('abort', pending.abort)
        pending.reject(new Error(`Agent 运行进程已退出 (${code ?? '未知'})。`))
      }
      this.child = undefined
      if (!this.closing && this.pending.size) this.ensureProcess()
    })
    this.child.stdout?.on('data', () => {})
    this.child.stderr?.on('data', () => {})
    return this.child
  }

  run(input: RunInput) {
    if (this.closing) return Promise.reject(new Error('应用正在退出。'))
    if (input.signal.aborted) return Promise.reject(input.signal.reason)
    const id = randomUUID()
    const child = this.ensureProcess()
    return new Promise<{ text: string; sessionId: string; stopReason: string }>((resolve, reject) => {
      const abort = () => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        input.signal.removeEventListener('abort', abort)
        child.postMessage({ type: 'cancel', id })
        reject(input.signal.reason instanceof Error ? input.signal.reason : new Error('Agent 调用已取消。'))
      }
      this.pending.set(id, { input, resolve, reject, abort })
      input.signal.addEventListener('abort', abort, { once: true })
      child.postMessage({ type: 'start', id, input: {
        prompt: input.prompt, cwd: input.cwd, stage: input.stage, resumeSessionId: input.resumeSessionId,
        electronDist: input.electronDist, model: input.model.name, baseUrl: input.model.baseUrl, apiKey: input.model.apiKey,
      } })
    })
  }

  async close() {
    this.closing = true
    for (const pending of this.pending.values()) pending.abort()
    this.pending.clear()
    if (!this.child) return
    const child = this.child
    this.child = undefined
    await Promise.race([new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() }), new Promise<void>(resolve => setTimeout(resolve, 3000).unref())])
  }
}
