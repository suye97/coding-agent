const kinds = new Set(['read', 'search', 'edit', 'command', 'plan', 'other'])
const statuses = new Set(['running', 'completed', 'error'])

// Fixed categories only: tool names, arguments, paths and output never cross into the UI.
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
  return { id: item.id, kind: item.kind, status: item.status }
}
