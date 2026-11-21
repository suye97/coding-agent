import { AsyncLocalStorage } from 'node:async_hooks'
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
            run.detach = readFrames(child.stdout, kind === 'claude' ? claudeText(append) : codexText(append))
          }
          return child
        }
      },
    })
  })

  return {
    observe(cwd, append) {
      const run = { cwd, append, active: true }
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
