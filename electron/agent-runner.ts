import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

interface StartMessage {
  type: 'start'
  id: string
  input: {
    prompt: string
    cwd: string
    stage: 'design' | 'develop' | 'verify'
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
function textFromToolResult(content: unknown) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (typeof block === 'string') return block
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) return String(block.text)
    return ''
  }).join('\n')
}

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
        ELECTRON_RUN_AS_NODE: '1',
      },
    }
    stream = query({ prompt: input.prompt, options })
    let finalText = ''
    let sessionId = input.resumeSessionId
    for await (const event of stream as AsyncIterable<SDKMessage>) {
      if (abort.signal.aborted) break
      if ('session_id' in event && event.session_id && event.session_id !== sessionId) {
        sessionId = event.session_id
        send({ type: 'session', id, sessionId })
      }
      if (event.type === 'stream_event' && !event.parent_tool_use_id && event.event.type === 'content_block_delta' && event.event.delta.type === 'text_delta') {
        send({ type: 'output', id, text: event.event.delta.text })
      }
      if (event.type === 'user' && !event.parent_tool_use_id) {
        const content = event.message.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block.type !== 'tool_result' || block.is_error) continue
          const text = textFromToolResult(block.content)
          for (const line of text.split(/\r?\n/u)) {
            if (!line.startsWith('FEISHU_AGENT_OBSERVATION ') || line.length > 10_000) continue
            send({ type: 'assertion', id, item: { id: block.tool_use_id, line: line.slice('FEISHU_AGENT_OBSERVATION '.length), sha256: createHash('sha256').update(text).digest('hex') } })
          }
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
