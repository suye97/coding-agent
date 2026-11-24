import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const prefix = 'FEISHU_AGENT_OBSERVATION '

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (typeof block === 'string') return block
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) return String(block.text)
    return ''
  }).join('\n')
}

function assertions(id, text, lines) {
  const sha256 = createHash('sha256').update(text).digest('hex')
  return lines.filter(line => line.startsWith(prefix) && line.length <= 10_000)
    .map(line => ({ id, line: line.slice(prefix.length), sha256 }))
}

export function observationsFromText(id, text) {
  if (typeof id !== 'string' || typeof text !== 'string') return []
  return assertions(id, text, text.split(/\r?\n/u))
}

// The structured SDK result contains the complete command stdout; message.content
// can instead be a truncation notice or a background-task placeholder.
export async function commandToolObservations({ id, kind, content, result }) {
  if (kind !== 'command' || typeof id !== 'string') return []
  if (result && typeof result === 'object' && !Array.isArray(result) &&
      'persistedOutputPath' in result && typeof result.persistedOutputPath === 'string') {
    try { return await observationsFromFile(id, result.persistedOutputPath) } catch { return [] }
  }
  const stdout = result && typeof result === 'object' && !Array.isArray(result) && 'stdout' in result
    ? result.stdout : undefined
  return observationsFromText(id, typeof stdout === 'string' ? stdout : textFromContent(content))
}

// Background Bash output is read from the path supplied by the SDK task event,
// never from an arbitrary file path chosen by the model.
export async function observationsFromFile(id, path) {
  const hash = createHash('sha256')
  const input = createReadStream(path)
  input.on('data', chunk => hash.update(chunk))
  const lines = []
  const reader = createInterface({ input, crlfDelay: Infinity })
  for await (const line of reader) {
    if (line.startsWith(prefix) && line.length <= 10_000) lines.push(line)
  }
  const sha256 = hash.digest('hex')
  return lines.map(line => ({ id, line: line.slice(prefix.length), sha256 }))
}
