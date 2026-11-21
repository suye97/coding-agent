import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openStore } from '../src/store.js'
import { createWorkflow } from '../src/workflow.js'
import { createDispatchHandler } from '../src/dispatch.js'

const userId = 'ou_operator'
const chatId = 'oc_direct'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-workflow-'))
  const path = join(directory, 'state.sqlite')
  let store = openStore(path)
  let card
  let sequence = 0
  let shouldPass = false
  let pushError = false
  let developmentStatus = 'implemented'
  const attempts = []
  const pushes = []
  const verifications = []
  const project = { name: '订单' }
  const projects = { resolve: name => name === project.name ? name : undefined, get: () => project }
  const runner = {
    async design({ task, recordRun, recordResult }) {
      recordRun('design-child', 'read-only')
      recordResult({ stopReason: 'completed' })
      attempts.push(['design', task.comments])
      return { summary: '修改订单服务', scope: '订单模块', risks: '兼容旧记录', verification: '运行检查' }
    },
    async develop({ task, recordRun, recordResult }) {
      recordRun('claude-child', 'workspace')
      recordResult({ stopReason: 'completed' })
      attempts.push(['develop', task.work.worktree, task.rework])
      return { status: developmentStatus, summary: developmentStatus === 'needs_clarification' ? '需要扩大实现范围' : '开发完成' }
    },
  }
  const repository = {
    async intent({ task }) {
      return task.work ?? { worktree: 'task-worktree', branch: 'feishu/example', base: 'base', prepared: false }
    },
    async prepare({ task }) {
      if (task.work.prepared === false) assert.equal(store.get(task.id).work.prepared, false)
      return { ...task.work, prepared: true }
    },
    async verify(options) {
      verifications.push(options)
      return { branch: 'feishu/example', commit: 'abcdef', changes: 'orders.js', checks: [{ label: '单测', passed: shouldPass }] }
    },
    async push({ result }) {
      if (pushError) { pushError = false; throw new Error('Git push 失败：认证失败。') }
      pushes.push(result.commit)
      return { remote: 'origin', commit: result.commit }
    },
  }
  const channel = { async publish(value) { card = value.card; return value.messageId ?? 'om_card' } }
  const build = () => createWorkflow({ store, projects, userId, runner, repository, onError: assert.fail })
  let workflow = build()
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  const send = (text, options = {}) => workflow.onMessage({ text, chatId, userId, eventId: `m-${++sequence}`, ...options })
  const action = (label, options = {}) => workflow.onAction({
    eventId: `a-${++sequence}`, userId, chatId, messageId: 'om_card',
    token: card.actions.find(item => item.label === label)?.token, ...options,
  })
  return {
    action, send, attempts, pushes, verifications, runner,
    dispatch: createDispatchHandler({ appId: 'state', dataDirectory: directory }),
    card: () => card,
    work: () => workflow.work(),
    publish: () => workflow.publish(channel),
    store: () => store,
    passChecks: () => { shouldPass = true },
    failPushOnce: () => { pushError = true },
    setDevelopmentStatus: value => { developmentStatus = value },
    restart() {
      store.close()
      store = openStore(path)
      workflow = build()
      workflow.recover()
    },
  }
}

test('complete requests run automatically through verification and rework', async t => {
  const app = await fixture(t)
  app.send('开发需求｜订单\n需求正文：增加订单状态\n验收条件：旧订单可读取')
  assert.equal(app.store().inStage('design_queued').length, 1)
  await app.publish()
  assert.equal(app.card().title, '等待设计')
  assert.equal(app.card().actions.some(action => ['开始设计', '批准开发'].includes(action.label)), false)
  await app.work()
  assert.equal(app.store().inStage('queued').length, 1)
  await app.publish()
  assert.match(app.card().text, /方案\n修改订单服务/)
  assert.match(app.card().text, /调用记录 read-only · 已完成/)
  assert.doesNotMatch(app.card().text, /Token|当前 Provider 未提供/)
  await app.work()
  await app.publish()
  assert.match(app.card().text, /失败 单测/)
  assert.equal(app.attempts.filter(([kind]) => kind === 'develop').length, 1)
  app.passChecks()
  app.failPushOnce()
  assert.equal(app.action('重试'), '已记录。')
  await app.work()
  await app.publish()
  assert.equal(app.card().title, '任务阻塞')
  assert.match(app.card().text, /认证失败/)
  assert.deepEqual(app.pushes, [])
  assert.equal(app.action('重试'), '已记录。')
  await app.work()
  await app.publish()
  assert.equal(app.card().title, '开发交付')
  assert.match(app.card().text, /已推送 origin\/feishu\/example/)
  assert.match(app.card().text, /调用记录 workspace · 已完成/)
  assert.doesNotMatch(app.card().text, /Token/)
  assert.deepEqual(app.pushes, ['abcdef'])
  assert.equal(app.attempts.filter(([kind]) => kind === 'develop').length, 1)
  assert.equal(app.action('要求返工', { text: '补充错误提示' }), '已记录。')
  await app.work()
  await app.publish()
  assert.deepEqual(app.attempts.at(-1), ['develop', 'task-worktree', '补充错误提示'])
  assert.equal(app.verifications.at(-1).requireNewCommit, true)
  assert.equal(app.verifications.at(-1).previousCommit, 'abcdef')
  assert.deepEqual(app.pushes, ['abcdef', 'abcdef'])
  assert.equal(app.action('确认验收'), '已记录。')
  await app.publish()
  assert.equal(app.card().title, '已验收')
})

test('dispatch exposes bounded model text before the result without changing revisions or cards', async t => {
  const app = await fixture(t)
  const started = Promise.withResolvers()
  const terminal = Promise.withResolvers()
  app.runner.design = async ({ recordRun, recordResult, recordOutput }) => {
    recordRun('stream-child', 'read-only')
    started.resolve(recordOutput)
    await terminal.promise
    recordResult({ stopReason: 'completed' })
    return { summary: '最终方案' }
  }
  app.send('开发需求｜订单\n需求正文：增加订单状态\n验收条件：旧订单可读取')
  const work = app.work()
  const recordOutput = await started.promise
  const [task] = app.store().inStage('designing')
  const read = (peer = { principal: { kind: 'owner' } }) => app.dispatch('feishuDispatch/detail', { taskId: task.id }, undefined, peer)
  try {
    await app.publish()
    assert.equal(app.store().nextNotice(), undefined)
    recordOutput('正在读取订单模块。')
    const deadline = Date.now() + 2000
    while (!read().value.modelOutputs[task.attempt.id] && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const detail = read().value
    assert.deepEqual(detail.modelOutputs[task.attempt.id], { text: '正在读取订单模块。', truncated: false })
    assert.equal(detail.history.at(-1).attempt.status, 'running')
    assert.equal(detail.history.at(-1).revision, task.revision)
    assert.equal(app.store().nextNotice(), undefined)
    assert.doesNotMatch(app.card().text, /正在读取订单模块/)
    assert.equal(read({ principal: { kind: 'other' } }).ok, false)
    recordOutput('大'.repeat(24_001) + '尾')
  } finally {
    terminal.resolve()
    await work
  }
  recordOutput('调用结束后的内容')
  app.restart()
  const completed = read().value
  assert.deepEqual(completed.history.at(-1).plan, { summary: '最终方案' })
  assert.deepEqual(completed.modelOutputs[task.attempt.id], { text: '大'.repeat(23_999) + '尾', truncated: true })
})

test('incomplete requests only wait for information and then run automatically', async t => {
  const app = await fixture(t)
  app.send('开发需求｜订单\nhttps://example.test/tapd/42')
  assert.equal(app.store().inStage('confirm').length, 1)
  await app.publish()
  assert.equal(app.card().title, '待补充需求')
  assert.equal(app.card().actions.some(action => action.label === '开始设计'), false)
  assert.match(app.send('需求正文：增加订单状态\n验收条件：旧订单可读取', { replyTo: 'om_card' }), /保存/)
  assert.equal(app.store().inStage('design_queued').length, 1)
  await app.work()
  assert.equal(app.store().inStage('queued').length, 1)
})

test('development clarification blocks instead of looping through automatic design', async t => {
  const app = await fixture(t)
  app.send('开发需求｜订单\n需求正文：增加订单状态\n验收条件：旧订单可读取')
  await app.work()
  app.setDevelopmentStatus('needs_clarification')
  await app.work()
  const [task] = app.store().inStage('blocked')
  assert.equal(task.failedStage, 'developing')
  assert.match(task.error, /需要扩大实现范围/)
  assert.equal(app.pushes.length, 0)
  assert.equal(app.verifications.length, 0)
  await app.publish()
  assert.match(app.action('提交补充', { text: '需求正文：限定只读接口' }), /保存/)
  assert.equal(app.store().inStage('design_queued').length, 1)
})

test('card actions remain owner-bound, chat-bound and idempotent', async t => {
  const app = await fixture(t)
  app.send('开发需求｜订单\n需求正文：增加订单状态\n验收条件：旧订单可读取')
  await app.publish()
  assert.match(app.action('取消', { userId: 'ou_other' }), /无法操作/)
  assert.match(app.action('取消', { chatId: 'oc_other' }), /无法识别/)
  assert.equal(app.action('取消', { eventId: 'click' }), '已记录。')
  assert.equal(app.action('取消', { eventId: 'click' }), '已记录。')
  assert.match(app.action('取消'), /已更新/)
  assert.equal(app.store().inStage('cancelled').length, 1)
})

test('legacy approval and confirmation tasks migrate to automatic queues', async t => {
  const app = await fixture(t)
  app.send('开发需求｜订单\n需求正文：增加订单状态\n验收条件：旧订单可读取')
  app.store().transaction(() => {
    const [task] = app.store().inStage('design_queued')
    task.stage = 'approval'
    task.plan = { summary: '旧方案', scope: '订单', risks: '无', verification: '测试' }
    app.store().save(task)
  })
  app.restart()
  assert.equal(app.store().inStage('queued').length, 1)
})

test('first card send preserves its idempotency key and payload across restart', async t => {
  const app = await fixture(t)
  app.send('修复bug｜订单\nhttps://example.test/tapd/42')
  assert.equal(app.store().inStage('confirm')[0].type, 'fix')
  const first = app.store().nextNotice()
  app.store().firstSend(first, 1, { title: '首次发送', text: '原需求', actions: [] })
  app.send('补充一条需求')
  app.restart()
  assert.equal(app.store().nextNotice().id, first.id)
  await app.publish()
  assert.equal(app.card().title, '首次发送')
  await app.publish()
  assert.match(app.card().text, /补充一条需求/)
  assert.equal(app.store().nextNotice(), undefined)
})

test('interrupted development is blocked after reopening SQLite', async t => {
  const app = await fixture(t)
  app.send('修复缺陷｜订单\n需求正文：更新状态\n验收条件：旧数据兼容')
  app.store().transaction(() => {
    const [task] = app.store().inStage('design_queued')
    task.stage = 'developing'
    app.store().save(task)
  })
  app.restart()
  await app.publish()
  assert.match(app.card().text, /上次运行中断/)
  assert.equal(app.attempts.length, 0)
})
