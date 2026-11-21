export const isOperatorId = id => typeof id === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(id)

export function operatorIds(value = '') {
  if (!value.trim()) return []
  const ids = value.split(',').map(id => id.trim())
  return ids.every(isOperatorId) ? [...new Set(ids)] : null
}
