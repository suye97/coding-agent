import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { toolActivityKind } from '../src/agent-activity.js'
import { commandToolObservations, observationsFromFile } from '../src/agent-evidence.js'

interface StartMessage {
  type: 'start'
  id: string
  input: {
    prompt: string
    cwd: string
    stage: 'design' | 'develop' | 'verify'
    electronDist?: string
    resumeSessionId?: string
    model: string
    baseUrl: string
    apiKey: string
  }
}

const active = new Map<string, { abort: AbortController; close: () => void }>()
const port = process.parentPort
if (!port) throw new Error('Agent runner must run as an Electron utility process')

function packagedWindowsExecutable(): string | undefined {
  if (process.platform !== 'win32' || !process.resourcesPath) return undefined
  const archive = join(process.resourcesPath, 'app.asar')
  const insideArchive = (path: string) => {
    const entry = relative(archive, path)
    return entry && entry !== '..' && !entry.startsWith(`..${sep}`) && !isAbsolute(entry) ? entry : undefined
  }
  if (!insideArchive(fileURLToPath(import.meta.url))) return undefined
  try {
    // Resolve relative to the SDK, including when npm nests its native dependency.
    const resolve = createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk')).resolve
    const binary = resolve(`@anthropic-ai/claude-agent-sdk-win32-${process.arch}/claude.exe`)
    // The SDK discovers an ASAR virtual path, but Windows CreateProcess needs a real file.
    const entry = insideArchive(binary)
    const executable = entry ? join(`${archive}.unpacked`, entry) : binary
    if (statSync(executable, { throwIfNoEntry: false })?.isFile()) return executable
  } catch {
    // Do not fall back to PATH or the archive when the packaged executable is missing.
  }
  throw new Error(`安装包缺少 Windows ${process.arch} 的 Claude Agent 执行文件，请重新安装完整的需求交付台。`)
}

function send(message: Record<string, unknown>) { port.postMessage(message) }

async function run(message: StartMessage) {
  const { id, input } = message
  const abort = new AbortController()
  let stream: ReturnType<typeof query> | undefined
  active.set(id, { abort, close: () => stream?.close() })
  try {
    const design = input.stage === 'design'
    const options: Options = {
      abortController: abort,
      cwd: input.cwd,
      pathToClaudeCodeExecutable: packagedWindowsExecutable(),
      model: input.model,
      resume: input.resumeSessionId,
      permissionMode: design ? 'plan' : 'bypassPermissions',
      tools: design ? ['Read', 'Grep', 'Glob'] : { type: 'preset', preset: 'claude_code' },
      disallowedTools: design ? ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent'] : ['WebFetch', 'WebSearch'],
      includePartialMessages: true,
      settingSources: ['project'],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: input.baseUrl,
        ANTHROPIC_API_KEY: input.apiKey,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'feishu-delivery-desktop/0.2.0',
        ELECTRON_RUN_AS_NODE: undefined,
        FEISHU_VERIFY_ELECTRON_DIST: input.stage === 'verify' ? input.electronDist : undefined,
        ...(input.stage === 'verify' && input.electronDist && { ELECTRON_OVERRIDE_DIST_PATH: undefined }),
      },
    }
    stream = query({ prompt: input.prompt, options })
    let finalText = ''
    let sessionId = input.resumeSessionId
    let initialized = false
    const activities = new Map<string, { kind: string; status: string }>()
    const backgroundOutputs = new Set<string>()
    const startActivity = (toolId: unknown, name: unknown) => {
      if (typeof toolId !== 'string' || activities.has(toolId)) return
      const item = { kind: toolActivityKind(name), status: 'running' }
      activities.set(toolId, item)
      send({ type: 'activity', id, item: { id: toolId, ...item } })
    }
    const finishActivity = (toolId: string, failed: boolean) => {
      const current = activities.get(toolId)
      if (!current || current.status !== 'running') return
      current.status = failed ? 'error' : 'completed'
      send({ type: 'activity', id, item: { id: toolId, ...current } })
    }
    for await (const event of stream as AsyncIterable<SDKMessage>) {
      if (abort.signal.aborted) break
      // Every SDK event, including a resumed init, marks this invocation as started.
      if (!initialized) {
        initialized = true
        send({ type: 'session', id, sessionId: event.session_id ?? sessionId })
      }
      if ('session_id' in event && event.session_id) sessionId = event.session_id
      if (event.type === 'stream_event' && !event.parent_tool_use_id && event.event.type === 'content_block_start' && event.event.content_block.type === 'tool_use') {
        startActivity(event.event.content_block.id, event.event.content_block.name)
      }
      if (event.type === 'assistant' && !event.parent_tool_use_id && Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') startActivity(block.id, block.name)
        }
      }
      if (event.type === 'stream_event' && !event.parent_tool_use_id && event.event.type === 'content_block_delta' && event.event.delta.type === 'text_delta') {
        send({ type: 'output', id, text: event.event.delta.text })
      }
      if (event.type === 'user' && !event.parent_tool_use_id) {
        const content = event.message.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          finishActivity(block.tool_use_id, Boolean(block.is_error))
          if (block.is_error) continue
          const items = await commandToolObservations({
            id: block.tool_use_id,
            kind: activities.get(block.tool_use_id)?.kind ?? 'other',
            content: block.content,
            result: event.tool_use_result,
          })
          for (const item of items) send({ type: 'assertion', id, item })
        }
      }
      if (event.type === 'system' && event.subtype === 'task_notification' && event.status === 'completed' &&
          typeof event.tool_use_id === 'string' && activities.get(event.tool_use_id)?.kind === 'command' &&
          !backgroundOutputs.has(event.tool_use_id)) {
        backgroundOutputs.add(event.tool_use_id)
        try {
          const items = await observationsFromFile(event.tool_use_id, event.output_file)
          for (const item of items) send({ type: 'assertion', id, item })
        } catch {
          // A missing task output cannot be replaced by model text or an arbitrary Read result.
        }
      }
      if (event.type === 'result') {
        if (event.subtype !== 'success' || event.is_error) {
          const diagnostic = 'errors' in event ? event.errors.join('; ') : 'result' in event ? event.result : '模型调用失败'
          throw new Error(`Agent 调用未完成：${String(diagnostic).slice(0, 500)}`)
        }
        finalText = event.result
      }
    }
    if (!finalText) throw new Error(abort.signal.aborted ? 'Agent 调用已取消。' : 'Agent 未返回最终结果。')
    send({ type: 'result', id, result: { text: finalText, sessionId, stopReason: 'completed' } })
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message.split(input.apiKey).join('[已隐藏]').slice(0, 800) : 'Agent 调用失败。'
    send({ type: 'error', id, error: diagnostic })
  } finally {
    active.delete(id)
  }
}

port.on('message', event => {
  const message = event.data
  if (message?.type === 'start' && typeof message.id === 'string') void run(message as StartMessage)
  if (message?.type === 'cancel' && typeof message.id === 'string') {
    const running = active.get(message.id)
    if (running) { running.abort.abort(); running.close(); active.delete(message.id) }
  }
})
