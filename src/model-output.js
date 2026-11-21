import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { basename, normalize } from 'node:path'

const maxFrame = 1024 * 1024

function readFrames(stdout, receive) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const frame = line => {
    let value
    try { value = JSON.parse(line) } catch { return }
    receive(value)
  }
  const data = chunk => {
    const lines = (typeof chunk === 'string' ? chunk : decoder.write(chunk)).split('\n')
    for (const [index, line] of lines.entries()) {
      const combined = pending !== null && pending.length + line.length <= maxFrame ? pending + line : null
      if (index === lines.length - 1) {
        pending = combined
      } else {
        if (combined) frame(combined)
        pending = ''
      }
    }
  }
  const end = () => {
    if (pending) frame(pending + decoder.end())
  }
  stdout.on('data', data)
  stdout.once('end', end)
  return () => {
    stdout.off('data', data)
    stdout.off('end', end)
  }
}

function claudeText(append) {
  let streamedMessage
  let hasStreamedText = false
  let textBlock
  let needsBreak = false
  const write = text => {
    if (typeof text !== 'string' || !text) return false
    append(needsBreak ? `\n\n${text}` : text)
    needsBreak = false
    return true
  }
  return packet => {
    if (packet?.parent_tool_use_id !== null || packet.error) return
    if (packet.type === 'assistant') {
      // SDK assistant messages repeat each completed streaming block.
      if (streamedMessage && streamedMessage === packet.message?.id && hasStreamedText) return
      const blocks = packet.message?.content
      if (packet.message?.role !== 'assistant' || !Array.isArray(blocks)) return
      for (const block of blocks) {
        if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text) continue
        write(block.text)
        needsBreak = true
      }
      return
    }
    if (packet.type !== 'stream_event') return
    const event = packet.event
    if (event?.type === 'message_start') {
      streamedMessage = event.message?.id
      hasStreamedText = false
      textBlock = undefined
    } else if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
      textBlock = event.index
      if (write(event.content_block.text)) hasStreamedText = true
    } else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      if (write(event.delta.text)) hasStreamedText = true
    } else if (hasStreamedText && (event?.type === 'message_stop' ||
      (event?.type === 'content_block_stop' && textBlock !== undefined && event.index === textBlock))) {
      needsBreak = true
    }
  }
}

function codexText(append) {
  let thread
  let turn
  let itemId
  let hasText = false
  const write = (id, text) => {
    if (typeof id !== 'string' || typeof text !== 'string' || !text) return
    append(hasText && itemId !== id ? `\n\n${text}` : text)
    itemId = id
    hasText = true
  }
  return packet => {
    const params = packet?.params
    if (!params || typeof params.threadId !== 'string') return
    if (packet.method === 'turn/started' && turn === undefined && typeof params.turn?.id === 'string') {
      thread = params.threadId
      turn = params.turn.id
    }
    if (turn === undefined || params.threadId !== thread || params.turnId !== turn) return
    if (packet.method === 'item/agentMessage/delta') write(params.itemId, params.delta)
    if (packet.method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.id !== itemId) {
      write(params.item.id, params.item.text)
    }
  }
}

// Capture assertion records from completed provider tool results, independently of assistant text.
function observeAssertions(kind, record) {
  const pending = new Set()
  let thread, turn
  function consume(id, output) {
    if (typeof id !== 'string' || typeof output !== 'string') return
    const sha256 = createHash('sha256').update(output).digest('hex')
    for (const line of output.split(/\r?\n/u)) {
      if (line.startsWith('FEISHU_AGENT_OBSERVATION ') && line.length <= 1500) {
        record({ id, sha256, line: line.slice('FEISHU_AGENT_OBSERVATION '.length) })
      }
    }
  }
  return packet => {
    if (kind === 'codex') {
      const params = packet?.params
      if (packet?.method === 'turn/started' && turn === undefined) {
        thread = params?.threadId
        turn = params?.turn?.id
      }
      const item = params?.item
      if (turn && params?.threadId === thread && params.turnId === turn && packet.method === 'item/completed' &&
          item?.type === 'commandExecution' && item.status === 'completed' && item.exitCode === 0) consume(item.id, item.aggregatedOutput)
      return
    }
    const blocks = packet?.message?.content
    if (!Array.isArray(blocks) || packet.parent_tool_use_id != null || packet.error) return
    for (const block of blocks) {
      if (packet.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash') pending.add(block.id)
      if (packet.type !== 'user' || block.type !== 'tool_result' || !pending.delete(block.tool_use_id) || block.is_error) continue
      const text = Array.isArray(block.content) ? block.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : block.content
      consume(block.tool_use_id, text)
    }
  }
}

function protocol(argv) {
  const entry = basename(argv[0] ?? '').toLowerCase()
  if (argv[1] === 'app-server' && argv[2] === '--stdio' && /^codex(?:\.exe)?$/.test(entry)) return 'codex'
  if (argv[2] === 'app-server' && argv[3] === '--stdio' && basename(argv[1] ?? '') === 'codex.js') return 'codex'
  const output = argv.indexOf('--output-format')
  if (output < 1 || argv[output + 1] !== 'stream-json' || !argv.includes('--input-format')) return
  if (/^claude(?:\.exe)?$/.test(entry) || basename(argv[1] ?? '') === 'cli.js') return 'claude'
}

// The DSH activation API only exposes the terminal result. Observe the managed
// subprocess returned to the existing Provider through Cordis's service hook.
export function createModelOutputObserver(ctx) {
  const current = new AsyncLocalStorage()
  ctx.on?.('internal/get', (_consumer, name, _error, next) => {
    const service = next()
    const run = name === 'subprocess' && current.getStore()
    if (!run || !run.active) return service
    return new Proxy(service, {
      get(target, key) {
        if (key !== 'spawn') return Reflect.get(target, key, target)
        return spec => {
          const kind = run.active && !run.detach && spec.stdio.stdout === 'pipe' &&
            normalize(spec.cwd) === normalize(run.cwd) && protocol(spec.argv)
          if (!kind) return target.spawn(spec)
          const launch = kind === 'claude' && !spec.argv.includes('--include-partial-messages')
            ? { ...spec, argv: [...spec.argv, '--include-partial-messages'] } : spec
          const child = target.spawn(launch)
          if (child.stdout) {
            const append = text => run.active && run.append(text)
            const text = kind === 'claude' ? claudeText(append) : codexText(append)
            const assertions = run.record && observeAssertions(kind, item => run.active && run.record(item))
            run.detach = readFrames(child.stdout, packet => { text(packet); assertions?.(packet) })
          }
          return child
        }
      },
    })
  })

  return {
    observe(cwd, append, record) {
      const run = { cwd, append, record, active: true }
      return {
        activate: start => current.run(run, start),
        stop() {
          run.active = false
          run.detach?.()
          run.detach = undefined
        },
      }
    },
  }
}
