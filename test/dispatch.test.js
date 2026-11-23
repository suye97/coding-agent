import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDispatchHandler, dispatchDatabase, registerDispatch } from '../src/dispatch.js'
import { openStore } from '../src/store.js'
import { encodeCard, callCardApi } from '../src/feishu.js'

const owner = { principal: { kind: 'owner' } }

test('dispatch reads persisted requirement revisions and results only for the owner', t => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'feishu-dispatch-'))
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }))
  const config = { appId: 'cli_fixture', dataDirectory, enabled: false }
  const dispatch = createDispatchHandler(config)
  const call = (method, body, peer = owner) => dispatch(`feishuDispatch/${method}`, body, undefined, peer)
  assert.deepEqual(call('list').value.items, [])
  const store = openStore(dispatchDatabase(config))
  const task = { id: 'ABCDEF12', chatId: 'private-chat', owner: 'private-owner', stage: 'confirm', project: '订单', requirementVersion: 1, requirement: { body: '原始需求' } }
  store.save(task)
  task.attempt = { id: 'attempt', kind: 'developing', provider: 'workspace', startedAt: 100, heartbeatAt: 200, status: 'running' }
  store.progress(task)
  assert.equal(task.revision, 1)
  task.attempt.status = 'completed'
  task.attempt.finishedAt = 300
  task.attempt.development = { status: 'implemented', summary: '已修改订单服务' }
  task.attempt.usage = { input: 100, output: 20 } // An older stored attempt.
  store.save({ ...task, stage: 'review', requirementVersion: 2, requirement: { body: '修改后的需求' }, result: { branch: 'feishu/test', checks: [{ label: '单测', passed: true }] } })
  store.close()
  assert.equal(call('list', {}, { principal: { kind: 'other' } }).ok, false)
  assert.equal(call('detail', { taskId: '../test' }).ok, false)
  assert.equal(call('list').value.items[0].summary, '修改后的需求')
  const [summary] = call('list').value.items
  assert.equal(summary.attempt.provider, 'workspace')
  assert.equal('usage' in summary.attempt, false)
  assert.equal('development' in summary.attempt, false)
  const { history } = call('detail', { taskId: task.id }).value
  assert.deepEqual(history[1].development, { status: 'implemented', summary: '已修改订单服务' })
  assert.equal('usage' in history[1].attempt, false)
  assert.deepEqual(history.map(entry => entry.requirement.body), ['原始需求', '修改后的需求'])
  assert.equal(history[1].result.checks[0].passed, true)
  assert.equal(history[0].chatId, undefined)
  assert.ok(history.every(entry => Number.isFinite(entry.recordedAt)))
})

test('dispatch exposes safe UI verification progress without tool records', t => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'feishu-dispatch-progress-'))
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }))
  const config = { appId: 'cli_fixture', dataDirectory }
  const store = openStore(dispatchDatabase(config))
  store.save({ id: 'ABCDEF12', chatId: 'chat', stage: 'verifying', requirement: { body: '需求' },
    operationCheckpoint: { preflight: 'ready', phase: 'step', steps: ['打开页面'], completedSteps: [], baselineReproduced: false,
      startedAt: 100, stepStartedAt: 150, lastRecordedAt: null, finishedAt: 1500, stepElapsedMs: 1350,
      assertions: [{ line: 'private tool output' }] } })
  store.close()
  const dispatch = createDispatchHandler(config)
  const { history } = dispatch('feishuDispatch/detail', { taskId: 'ABCDEF12' }, undefined, owner).value
  assert.deepEqual(history[0].operationCheckpoint, { preflight: 'ready', phase: 'step', steps: ['打开页面'], completedSteps: [],
    baselineReproduced: false, startedAt: 100, stepStartedAt: 150, lastRecordedAt: null, finishedAt: 1500, stepElapsedMs: 1350 })
})

test('Feishu card delivery uses the JSON 2.0 submit field and persists safe response diagnostics', async t => {
  const card = encodeCard({ title: '需求确认', text: '正文', actions: [{ label: '补充信息', token: 'token', form: true }] })
  const submit = card.body.elements.find(element => element.tag === 'form').elements.at(-1)
  assert.equal(submit.form_action_type, 'submit')
  assert.equal(submit.action_type, undefined)
  const dataDirectory = mkdtempSync(join(tmpdir(), 'feishu-delivery-'))
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }))
  const config = { appId: 'test', dataDirectory }
  const store = openStore(dispatchDatabase(config))
  const taskId = 'ABCDEF12'
  try {
    store.save({ id: taskId, chatId: 'test', stage: 'confirm', requirement: { body: '' } })
    const notice = store.nextNotice()
    await assert.rejects(callCardApi('create', async () => ({ code: 230099, msg: 'private body' })), error => {
      assert.equal(error.feishuDelivery.code, 230099)
      return true
    })
    await assert.rejects(callCardApi('create', async () => {
      throw { response: { status: 400, data: { code: 230099, msg: 'private body', error: { log_id: 'test-log-123' } } } }
    }), error => {
      store.retryNotice(notice, error.feishuDelivery)
      return true
    })
    const dispatch = createDispatchHandler(config)
    const detail = () => dispatch('feishuDispatch/detail', { taskId }, undefined, owner).value
    assert.equal(detail().delivery.failures, 1)
    assert.deepEqual({ ...detail().delivery.lastError }, { operation: 'create', kind: 'api', code: 230099, httpStatus: 400, logId: 'test-log-123', recordedAt: detail().delivery.lastError.recordedAt })
    assert.ok(!JSON.stringify(detail()).includes('private body'))
    store.delivered(notice, 1, 'test-message')
    assert.equal(detail().delivery.failures, 0)
    assert.equal(detail().delivery.lastError.code, 230099)
  } finally {
    store.close()
  }
})

test('dashboard registers exact owner-only Connection routes with matching RPC envelopes', async () => {
  const routes = new Map()
  registerDispatch({ connection: { fetch: { register(route) { routes.set(route.path, route) } } } }, { appId: '', dataDirectory: '' })
  assert.deepEqual([...routes.keys()], ['/api/feishuDispatch/list', '/api/feishuDispatch/detail'])
  const route = routes.get('/api/feishuDispatch/list')
  const request = method => new Request(`http://localhost${route.path}`, {
    method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'sample', method, payload: {} }),
  })
  assert.equal((await route.fetch(request('feishuDispatch/detail'))).status, 400)
  assert.deepEqual(await (await route.fetch(request('feishuDispatch/list'))).json(), {
    type: 'server-response', rpcId: 'sample', result: { ok: true, value: { status: 'unconfigured', items: [] } },
  })
})
