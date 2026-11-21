import { isAbsolute, join } from 'node:path'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const prefix = 'feishuDispatch/'
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })

export function dispatchDatabase(config) {
  return config.appId && isAbsolute(config.dataDirectory)
    ? join(config.dataDirectory, `${encodeURIComponent(config.appId)}.sqlite`)
    : null
}

function publicAttempt(attempt) {
  return attempt && {
    id: attempt.id, childId: attempt.childId, kind: attempt.kind, provider: attempt.provider,
    startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, heartbeatAt: attempt.heartbeatAt,
    status: attempt.status, stopReason: attempt.stopReason,
  }
}

function summary(task) {
  return {
    id: task.id, project: task.project ?? null, stage: task.stage, revision: task.revision,
    summary: (task.requirement?.body ?? '').replace(/\s+/gu, ' ').trim().slice(0, 220),
    recordedAt: task.recordedAt ?? null, attempt: publicAttempt(task.attempt),
  }
}

// 旧记录保留在数据库中，对调度详情只返回需求正文。
function historyItem(task) {
  return {
    revision: task.revision, stage: task.stage, recordedAt: task.recordedAt ?? null,
    requirementVersion: task.requirementVersion, requirement: { body: task.requirement?.body ?? '' },
    comments: task.comments, planVersion: task.planVersion, plan: task.plan,
    approval: task.approval && { planVersion: task.approval.planVersion, requirementVersion: task.approval.requirementVersion, at: task.approval.at },
    attempt: publicAttempt(task.attempt),
    development: task.attempt?.development && {
      status: task.attempt.development.status, summary: task.attempt.development.summary,
    },
    rework: task.rework, error: task.error,
    work: task.work && { branch: task.work.branch },
    result: task.result && { branch: task.result.branch, commit: task.result.commit, changes: task.result.changes, checks: task.result.checks, remote: task.result.remote },
  }
}

export function createDispatchHandler(config) {
  const path = dispatchDatabase(config)
  return (endpoint, payload, signal, peer) => {
    if (peer?.principal?.kind !== 'owner' || peer.signal?.aborted) return failure('feishu-dispatch/denied', 'Owner access required')
    if (signal?.aborted) return failure('feishu-dispatch/cancelled', 'Request cancelled')
    const list = endpoint === `${prefix}list`
    const detail = endpoint === `${prefix}detail`
    if (!list && !detail) return failure('feishu-dispatch/not-found', 'Unknown endpoint')
    const taskId = payload?.taskId
    if (detail && (typeof taskId !== 'string' || !/^[A-F0-9]{8}$/.test(taskId))) return failure('feishu-dispatch/invalid-id', 'Invalid task ID')
    if (!path || !existsSync(path)) return list
      ? { ok: true, value: { status: path ? 'ready' : 'unconfigured', items: [] } }
      : failure('feishu-dispatch/not-found', 'Task not found')
    try {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        if (list) {
          const items = db.prepare(`SELECT tasks.body, outbox.failures FROM tasks
            LEFT JOIN outbox ON outbox.task = tasks.id ORDER BY tasks.rowid DESC`).all().map(row => ({
            ...summary(JSON.parse(row.body)), deliveryFailures: row.failures ?? 0,
          }))
          return { ok: true, value: { status: 'ready', items } }
        }
        const history = db.prepare('SELECT body FROM history WHERE task = ? ORDER BY revision').all(taskId)
          .map(entry => historyItem(JSON.parse(entry.body)))
        if (!history.length) return failure('feishu-dispatch/not-found', 'Task not found')
        const currentRow = db.prepare('SELECT body FROM tasks WHERE id = ?').get(taskId)
        if (currentRow) {
          const current = historyItem(JSON.parse(currentRow.body))
          if (current.revision === history.at(-1).revision) history[history.length - 1] = current
        }
        const pending = db.prepare('SELECT failures, due FROM outbox WHERE task = ?').get(taskId)
        const hasErrors = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'feishu_delivery_errors'").get()
        const lastError = hasErrors ? db.prepare(`SELECT operation, kind, code, http_status AS httpStatus,
          log_id AS logId, recorded_at AS recordedAt FROM feishu_delivery_errors WHERE task = ?`).get(taskId) : null
        const hasModelOutputs = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'model_outputs'").get()
        const outputs = hasModelOutputs ? db.prepare('SELECT attempt, text, truncated FROM model_outputs WHERE task = ?').all(taskId) : []
        const modelOutputs = Object.fromEntries(outputs.map(({ attempt, text, truncated }) => [attempt, { text, truncated: Boolean(truncated) }]))
        return { ok: true, value: { requirement: history.at(-1).requirement, history, modelOutputs, delivery: {
          failures: pending?.failures ?? 0, retryAt: pending?.due ?? null, lastError: lastError ?? null,
        } } }
      } finally {
        db.close()
      }
    } catch {
      return failure('feishu-dispatch/read-failed', 'Could not read task records')
    }
  }
}

export function registerDispatch(ctx, config) {
  const handle = createDispatchHandler(config)
  for (const method of ['list', 'detail']) {
    const endpoint = `${prefix}${method}`
    // Shared exact routes are admitted by Connection for authenticated owner Peers only.
    ctx.connection.fetch.register({
      path: `/api/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const envelope = await request.json().catch(() => null)
        if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.method !== endpoint) {
          return new Response('Invalid request', { status: 400 })
        }
        const result = handle(endpoint, envelope.payload, request.signal, { principal: { kind: 'owner' } })
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
      },
    })
  }
}
