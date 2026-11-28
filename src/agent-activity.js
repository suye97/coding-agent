const kinds = new Set(['read', 'search', 'edit', 'command', 'plan', 'other'])
const statuses = new Set(['running', 'completed', 'error'])

// Fixed categories only: arbitrary tool payloads never cross into the UI.
export function toolActivityKind(name) {
  return {
    Read: 'read',
    Grep: 'search', Glob: 'search',
    Edit: 'edit', Write: 'edit', NotebookEdit: 'edit',
    Bash: 'command',
    TodoWrite: 'plan',
  }[name] ?? 'other'
}

export function normalizeActivity(item) {
  if (typeof item?.id !== 'string' || !item.id || item.id.length > 128 ||
      !kinds.has(item.kind) || !statuses.has(item.status)) return undefined
  return {
    id: item.id, kind: item.kind, status: item.status,
    ...(typeof item.name === 'string' && /^[\w.:+-]{1,80}$/u.test(item.name) && { name: item.name }),
    ...(typeof item.diagnostic === 'string' && item.diagnostic.trim() && {
      diagnostic: item.diagnostic.slice(0, 3000),
    }),
  }
}

const inputFields = {
  Bash: ['command'], Read: ['file_path', 'offset', 'limit'],
  Edit: ['file_path', 'old_string', 'new_string'], Write: ['file_path', 'content'], NotebookEdit: ['notebook_path'],
  Grep: ['pattern', 'path', 'glob'], Glob: ['pattern', 'path'], TodoWrite: ['todos'],
  Agent: ['description', 'prompt'],
}
const inputLabels = { command: '命令', file_path: '文件', notebook_path: '文件', path: '目录', pattern: '匹配', glob: '范围', offset: '起始行', limit: '行数',
  old_string: '原内容', new_string: '新内容', content: '内容', todos: '公开计划', description: '任务', prompt: '执行说明' }

function sanitize(value, secrets = [], limit = 1800) {
  let text = String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\0/gu, '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[已隐藏]')
  }
  return text
    .replace(/\/\/[^\s/:@]+:[^\s/@]+@/gu, '//[已隐藏]@')
    .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/giu, '$1 [已隐藏]')
    .replace(/([?&](?:api[_-]?key|access_token|token|secret|password)=)[^&\s]+/giu, '$1[已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu, '$1[已隐藏]')
    .replace(/((?:--?(?:api[-_]?key|token|secret|password|credential)(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s]+))/giu, match => {
      const separator = match.includes('=') ? '=' : ' '
      return `${match.split(separator)[0]}${separator}[已隐藏]`
    })
    .replace(/\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/giu, '[已隐藏]')
    .trim().slice(-limit)
}

function resultText(content, result) {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const text = ['stderr', 'stdout', 'message'].filter(key => typeof result[key] === 'string' && result[key])
      .map(key => result[key]).join('\n')
    if (text) return text
  }
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => typeof block === 'string' ? block
    : block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block ? String(block.text) : '').join('\n')
}

export function toolActivityParameters(name, input, secrets = []) {
  return (inputFields[name] ?? []).flatMap(key => {
    const value = input && typeof input === 'object' ? input[key] : undefined
    const text = value && typeof value === 'object' ? JSON.stringify(value) : value
    if (!['string', 'number'].includes(typeof text)) return []
    return [`${inputLabels[key] ?? key}：${sanitize(text, secrets, 900)}`]
  }).join('\n')
}

export function toolActivityDetail(name, input, content, result, secrets = [], failed = false) {
  const parameters = toolActivityParameters(name, input, secrets)
  const output = sanitize(resultText(content, result), secrets)
  return [parameters && `参数\n${parameters}`, output && `${failed ? '错误' : '结果'}摘要\n${output}`].filter(Boolean).join('\n') ||
    (failed ? '工具返回失败，但未提供错误正文。' : '工具已完成，无文本输出。')
}

export function toolFailureDiagnostic(name, input, content, result, secrets = []) {
  return toolActivityDetail(name, input, content, result, secrets, true)
}

export function summarizeActivities(items) {
  const counts = Object.fromEntries([...kinds].map(kind => [kind, 0]))
  const active = []
  const failures = []
  const details = []
  let total = 0
  let errors = 0
  for (const item of Array.isArray(items) ? items.slice(-40) : []) {
    const activity = normalizeActivity(item)
    if (!activity) continue
    total++
    counts[activity.kind]++
    details.push(activity)
    if (activity.status === 'running') active.push(activity)
    if (activity.status === 'error') { errors++; failures.push(activity) }
  }
  return { total, counts, active, failures, details, errors }
}
