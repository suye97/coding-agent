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
const validation = { kind: 'operation', operation: '更新订单状态', steps: ['打开订单', '点击保存'], expected: '显示已更新' }
const plan = { summary: '修改订单服务', scope: '订单模块', risks: '兼容旧记录', verification: '运行检查', validation }
const alternative = { summary: '只增加只读状态', impact: '保留原更新操作，增加只读查看', validation: {
  kind: 'operation', operation: '查看订单状态', steps: ['打开订单'], expected: '显示原状态',
} }
const report = data => `FEISHU_OPERATION_EVIDENCE ${JSON.stringify(data)}`
const observedReport = scenario => ({ operation: scenario.operation, expected: scenario.expected, passed: true,
  observed: scenario.expected, steps: scenario.steps.map(action => ({ action, observed: `${action}后收到订单页面状态` })),
  ...(scenario.type === 'fix' && { baseline: { reproduced: true, observed: '保存后仍显示旧值' } }) })

async function fixture(t, operators = userId) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-workflow-'))
  const path = join(directory, 'state.sqlite')
  let store = openStore(path)
  let card
  let sequence = 0
  let shouldPass = false
  let pushError = false
  let developmentStatus = 'implemented'
  let makeReports = scenario => scenario ? [report(observedReport(scenario))] : []
  let changeReview
  const attempts = []
  const pushes = []
  const verifications = []
  const project = { name: '订单', checks: [{ label: '单测' }, { label: '操作复现', kind: 'operation' }] }
  const projects = { resolve: name => name === project.name ? name : undefined, get: () => project }
  const runner = {
    async design({ task, recordRun, recordResult }) {
      recordRun('design-child', 'read-only')
      recordResult({ stopReason: 'completed' })
      attempts.push(['design', task.comments])
      return plan
    },
    async develop({ task, recordRun, recordResult }) {
      recordRun('claude-child', 'workspace')
      recordResult({ stopReason: 'completed' })
      attempts.push(['develop', task.work.worktree, task.rework])
      return { status: developmentStatus, summary: developmentStatus === 'needs_clarification' ? '需要扩大实现范围' : '开发完成',
        ...(developmentStatus === 'alternative' && { alternative }) }
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
      const result = { branch: 'feishu/example', commit: changeReview?.commit ?? 'abcdef', changes: 'orders.js', checks: [{ label: '单测', passed: shouldPass }] }
      if (changeReview) result.changeReview = { ...changeReview, approvalRequired: options.task.changeReviewApproval?.commit !== changeReview.commit }
      if (shouldPass && !result.changeReview?.approvalRequired) result.operationReports = makeReports(options.operationValidation)
      return result
    },
    async push({ result }) {
      if (pushError) { pushError = false; throw new Error('Git push 失败：认证失败。') }
      pushes.push(result.commit)
      return { remote: 'origin', commit: result.commit }
    },
  }
  const channel = { async publish(value) { card = value.card; return value.messageId ?? 'om_card' } }
  const build = () => createWorkflow({ store, projects, userId: operators, runner, repository, onError: assert.fail })
  let workflow = build()
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  const send = (text, options = {}) => workflow.onMessage({ text, chatId, userId, eventId: `m-${++sequence}`, ...options })
  const action = (label, options = {}) => workflow.onAction({
    eventId: `a-${++sequence}`, userId, chatId, messageId: 'om_card',
    token: card.actions.find(item => item.label === label)?.token, ...options,
  })
  return {
    action, send, attempts, pushes, verifications, runner, project,
    dispatch: createDispatchHandler({ appId: 'state', dataDirectory: directory }),
    card: () => card,
    work: () => workflow.work(),
    publish: () => workflow.publish(channel),
    store: () => store,
    passChecks: () => { shouldPass = true },
    failPushOnce: () => { pushError = true },
    setDevelopmentStatus: value => { developmentStatus = value },
    setOperationReports: factory => { makeReports = factory },
    setChangeReview: value => { changeReview = value },
    attachImage: options => workflow.attachImage({ chatId, userId, eventId: `i-${++sequence}`, ...options }),
    attachmentTarget: options => workflow.attachmentTarget({ chatId, userId, replyTo: 'om_card', ...options }),
    restart() {
      store.close()
      store = openStore(path)
      workflow = build()
      workflow.recover()
    },
  }
}

test('group commands accept open or comma-separated operators and bind tasks to their creator', async t => {
  const listed = await fixture(t, 'ou_owner, ou_second');
  listed.send('开发需求| 订单', { group: true, userId: 'ou_third' });
  listed.send('修复缺陷｜订单：修复保存失败', { group: true, userId: 'ou_second' });
  assert.equal(listed.store().inStage('design_queued')[0].owner, 'ou_second');
  assert.equal(listed.store().inStage('confirm').length, 0);
  const open = await fixture(t, '');
  open.send('开发需求| 订单', { group: true, userId: 'ou_first' });
  await open.publish();
  assert.equal(open.store().inStage('confirm')[0].owner, 'ou_first');
  assert.match(open.action('取消', { userId: 'ou_second' }), /无法识别/);
  assert.equal(open.send('群里的普通讨论', { group: true, userId: 'ou_first' }), '');
  assert.equal(open.store().inStage('confirm').length, 1);
  assert.match(open.send('添加订单查询', { group: true, userId: 'ou_first', replyTo: 'om_card' }), /已保存/);
  assert.equal(open.store().inStage('design_queued').length, 1);
});

test('inline Feishu requests queue immediately for feature and fix commands', async t => {
  const app = await fixture(t)
  app.send('开发需求|订单：增加状态筛选\n保留默认筛选项')
  app.send('修复缺陷｜订单｜修复保存失败')
  app.send('开发需求｜订单 修复链接 https://example.test')
  app.send('修复bug|订单\r\n需求正文：修复列表排序')
  app.send('开发需求｜订单')
  app.send('修复缺陷｜订单：https://example.test')
  const queued = app.store().inStage('design_queued')
  assert.deepEqual(queued.map(({ project, type, requirement }) => [project, type, requirement.body]), [
    ['订单', 'feature', '增加状态筛选\n保留默认筛选项'],
    ['订单', 'fix', '修复保存失败'],
    ['订单', 'feature', '修复链接 https://example.test'],
    ['订单', 'fix', '修复列表排序'],
  ])
  assert.equal(app.store().inStage('confirm').length, 2)
})

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

test('passing compile output and agent assertions cannot satisfy UI operation validation', async t => {
  const app = await fixture(t)
  app.setOperationReports(() => ['Compiled successfully'])
  const develop = app.runner.develop
  app.runner.develop = async input => ({ ...await develop(input), operationReports: [report(observedReport(validation))] })
  app.passChecks()
  app.send('开发需求｜订单\n点击保存按钮后显示已更新')
  await app.work()
  await app.work()
  await app.publish()
  assert.equal(app.card().title, '任务阻塞')
  assert.match(app.card().text, /缺少项目操作检查产生的实测报告/)
  assert.deepEqual(app.pushes, [])
  app.setOperationReports(scenario => [report({ ...observedReport(scenario), steps: [] })])
  assert.equal(app.action('重试'), '已记录。')
  await app.work()
  await app.publish()
  assert.match(app.card().text, /实测结果/)
  assert.deepEqual(app.pushes, [])
  app.setOperationReports(scenario => [report(observedReport(scenario))])
  assert.equal(app.action('重试'), '已记录。')
  await app.work()
  await app.publish()
  assert.match(app.card().text, /实测操作 更新订单状态/)
  assert.match(app.card().text, /点击保存后收到订单页面状态/)
  assert.deepEqual(app.pushes, ['abcdef'])
})

test('a UI request cannot be classified as static checks, while a structural change can', async t => {
  const app = await fixture(t)
  app.runner.design = async () => ({ ...plan, validation: { kind: 'checks', reason: '仅重排内部模块' } })
  app.passChecks()
  app.send('开发需求｜订单\n点击按钮时显示状态')
  await app.work()
  assert.equal(app.store().inStage('blocked').length, 1)
  assert.deepEqual(app.pushes, [])
  app.project.checks = []
  app.send('开发需求｜订单\n重排内部模块')
  await app.work()
  await app.work()
  assert.equal(app.verifications.at(-1).operationValidation, undefined)
  assert.deepEqual(app.pushes, ['abcdef'])
})

test('a fix requires an actual baseline reproduction and a post-change observation', async t => {
  const app = await fixture(t)
  app.setOperationReports(scenario => [report({ ...observedReport(scenario), baseline: undefined })])
  app.passChecks()
  app.send('修复缺陷｜订单\n保存后仍显示旧值')
  await app.work()
  await app.work()
  await app.publish()
  assert.equal(app.card().title, '任务阻塞')
  assert.deepEqual(app.pushes, [])
  app.setOperationReports(scenario => [report(observedReport(scenario))])
  assert.equal(app.action('重试'), '已记录。')
  await app.work()
  await app.publish()
  assert.equal(app.verifications.at(-1).operationValidation.baseCommit, 'base')
  assert.match(app.card().text, /基线复现 保存后仍显示旧值/)
  assert.deepEqual(app.pushes, ['abcdef'])
})

for (const source of ['design', 'development']) {
  test(`${source} alternatives await owner approval and verify the approved operation`, async t => {
    const app = await fixture(t)
    app.passChecks()
    if (source === 'design') app.runner.design = async () => ({ ...plan, alternative })
    else app.setDevelopmentStatus('alternative')
    app.send('开发需求｜订单\n点击保存按钮后显示已更新')
    await app.work()
    if (source === 'development') await app.work()
    await app.publish()
    assert.equal(app.card().title, '待所有者审批')
    assert.match(app.card().text, /与原需求的差异\n保留原更新操作，增加只读查看/)
    const token = app.card().actions.find(item => item.label === '批准').token
    app.restart()
    await app.work()
    assert.deepEqual(app.pushes, [])
    assert.equal(app.verifications.length, 0)
    assert.match(app.action('批准', { userId: 'ou_other' }), /无法操作/)
    assert.match(app.action('批准', { chatId: 'oc_other' }), /无法识别/)
    assert.match(app.action('批准', { messageId: 'om_other' }), /无法识别/)
    assert.equal(app.action('批准'), '已记录。')
    assert.match(app.action('批准', { token }), /已更新/)
    app.setDevelopmentStatus('implemented')
    await app.work()
    assert.equal(app.verifications.at(-1).operationValidation.operation, alternative.validation.operation)
    assert.deepEqual(app.pushes, ['abcdef'])
  })
}

test('declining an alternative keeps the original requirement and prevents delivery', async t => {
  const app = await fixture(t)
  app.runner.design = async () => ({ ...plan, alternative })
  app.send('开发需求｜订单\n点击保存按钮后显示已更新')
  await app.work()
  await app.publish()
  assert.equal(app.action('拒绝'), '已记录。')
  await app.work()
  const [task] = app.store().inStage('blocked')
  assert.match(task.requirement.body, /点击保存按钮/)
  assert.equal(task.alternativeApproval, undefined)
  assert.deepEqual(app.pushes, [])
})

test('source-change approval applies only to the reviewed commit and precedes operation verification', async t => {
  const app = await fixture(t)
  app.passChecks()
  const changeReview = { commit: 'abcdef', deletions: ['orders/old.js'], warnings: [{ path: 'script.js', reason: '提示' }] }
  app.setChangeReview(changeReview)
  app.send('开发需求｜订单\n点击保存按钮后显示已更新')
  await app.work()
  await app.work()
  await app.publish()
  assert.match(app.card().text, /orders\/old.js/)
  assert.match(app.card().text, /script.js 提示/)
  assert.equal(app.action('批准'), '已记录。')
  app.setChangeReview({ ...changeReview, commit: 'changed' })
  await app.work()
  await app.publish()
  assert.equal(app.card().title, '待所有者审批')
  assert.deepEqual(app.pushes, [])
  assert.equal(app.action('批准'), '已记录。')
  app.setOperationReports(() => [])
  await app.work()
  assert.equal(app.store().inStage('blocked').length, 1)
  assert.deepEqual(app.pushes, [])
})

test('image replies resolve only eligible owner cards and observe the per-task cap', async t => {
  const app = await fixture(t)
  app.send('开发需求｜订单\nhttps://example.test/source')
  await app.publish()
  const taskId = app.attachmentTarget({})
  assert.ok(taskId)
  assert.match(app.card().text, /发送原型图或截图/)
  assert.equal(app.attachmentTarget({ chatId: 'other' }), undefined)
  assert.equal(app.attachmentTarget({ replyTo: 'unknown', replyRoot: 'om_card' }), taskId)
  const attachment = { id: 'image1', byteLength: 20 * 1024 * 1024 }
  assert.match(app.attachImage({ taskId, attachment, chatId: 'other' }), /请回复/)
  assert.match(app.attachImage({ taskId, attachment }), /已保存任务图片/)
  assert.match(app.attachImage({ taskId, attachment }), /该图片已保存/)
  assert.match(app.attachImage({ taskId, attachment: { ...attachment, id: 'image2', byteLength: 5 * 1024 * 1024 } }), /上限/)
  app.send('点击保存按钮后显示已更新', { replyTo: 'om_card' })
  assert.equal(app.store().get(taskId).attachments.length, 1)
  await app.work()
  assert.equal(app.attachmentTarget({}), undefined)
})

test('image replies during design restart the same task with the attachment', async t => {
  const app = await fixture(t)
  const started = Promise.withResolvers()
  app.send('开发需求｜订单\n点击保存按钮后显示已更新')
  await app.publish()
  const taskId = app.attachmentTarget({})
  app.runner.design = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    started.resolve()
  })
  const previous = app.work()
  await started.promise
  assert.equal(app.attachmentTarget({}), taskId)
  assert.match(app.attachImage({ taskId, attachment: { id: 'prototype', byteLength: 100 } }), /重新设计/)
  await previous
  assert.equal(app.store().get(taskId).stage, 'design_queued')
  app.runner.design = async ({ task }) => {
    assert.equal(task.id, taskId)
    assert.equal(task.attachments[0].id, 'prototype')
    return plan
  }
  await app.work()
  assert.equal(app.store().get(taskId).stage, 'queued')
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
    return { summary: '最终方案', validation }
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
  assert.deepEqual(completed.history.at(-1).plan, { summary: '最终方案', validation })
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

test('an interrupted legacy verification cannot bypass the new evidence plan or loop', async t => {
  const app = await fixture(t)
  app.send('开发需求｜订单\n点击保存按钮后显示已更新')
  app.store().transaction(() => {
    const [task] = app.store().inStage('design_queued')
    task.stage = 'verifying'
    task.plan = { summary: '旧方案', verification: '编译' }
    app.store().save(task)
  })
  app.restart()
  await app.publish()
  assert.equal(app.action('重试'), '已记录。')
  await app.work()
  assert.equal(app.store().inStage('design_queued').length, 1)
  assert.equal(app.verifications.length, 0)
  app.runner.design = async () => ({ summary: '无验证的新方案' })
  await app.work()
  await app.work()
  assert.equal(app.store().inStage('blocked').length, 1)
  assert.deepEqual(app.pushes, [])
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
