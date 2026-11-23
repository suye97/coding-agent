import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgent } from '../src/agent.js'

const model = { name: 'test-model', baseUrl: 'https://example.invalid', apiKey: 'unit-test-only' }
const validation = { kind: 'operation', operation: '筛选订单', steps: ['点击筛选'], expected: '只显示已完成订单' }
const plan = { summary: '实现状态筛选', scope: '订单', risks: '旧数据', verification: '运行检查', validation }
const task = { id: 'ABCDEF12', type: 'feature', requirement: { body: '增加状态筛选' }, requirementVersion: 1, planVersion: 1, work: { worktree: 'D:/isolated', base: 'base', branch: 'feature/ABCDEF12' }, plan }
const project = { path: 'D:/repo', checks: [] }

function input(overrides = {}) {
  return {
    task: structuredClone(task), project, signal: new AbortController().signal,
    recordRun() {}, recordSession() {}, recordResult() {}, recordOutput() {}, ...overrides,
  }
}

function fixture(outputs, options = {}) {
  const calls = []
  const remaining = Array.isArray(outputs) ? [...outputs] : [outputs]
  const execute = async request => {
    calls.push(request)
    request.onSession('session-1')
    request.onOutput('正在检查项目')
    if (options.assertion) request.onAssertion(options.assertion)
    const output = remaining.length > 1 ? remaining.shift() : remaining[0]
    return { text: typeof output === 'string' ? output : JSON.stringify(output), sessionId: 'session-1', stopReason: 'completed' }
  }
  const runner = createAgent({ execute, getModel: async () => model, gitCommit: async () => 'commit-a', prepareOperation: async () => {}, ...options })
  return { runner, calls }
}

test('independent agent streams text, persists its SDK session and resumes development', async () => {
  const { runner, calls } = fixture([plan, { status: 'implemented', summary: '已完成开发' }])
  const output = []
  const sessions = []
  const first = input({ recordOutput: value => output.push(value), recordSession: value => sessions.push(value) })
  assert.deepEqual(await runner.design(first), plan)
  assert.deepEqual(output, ['正在检查项目'])
  assert.deepEqual(sessions, ['session-1'])
  assert.equal(first.task.agentSessionId, 'session-1')
  assert.equal(calls[0].cwd, project.path)
  assert.equal(calls[0].stage, 'design')
  assert.equal(calls[0].resumeSessionId, undefined)
  await runner.develop(input({ task: first.task }))
  assert.equal(calls[1].cwd, task.work.worktree)
  assert.equal(calls[1].resumeSessionId, 'session-1')
})

test('agent rejects invalid structured plans and undeclared alternative results', async () => {
  const invalidPlan = fixture({ ...plan, validation: undefined })
  await assert.rejects(invalidPlan.runner.design(input()), /缺少有效的操作验证计划/)
  const alternative = { summary: '只读列表', impact: '取消筛选', validation }
  const invalidDevelopment = fixture({ status: 'implemented', summary: '完成', alternative })
  await assert.rejects(invalidDevelopment.runner.develop(input()), /必须单独提交审批/)
})

test('agent requires model configuration before starting a paid run', async () => {
  let called = false
  const runner = createAgent({ execute: async () => { called = true }, getModel: async () => ({ ...model, apiKey: '' }) })
  await assert.rejects(runner.design(input()), /先.*模型/)
  assert.equal(called, false)
})

test('verification returns only observation assertions emitted by real tool results', async () => {
  const assertion = { id: 'tool-1', line: JSON.stringify({ commit: 'commit-a', step: 1, observed: '列表仅显示已完成订单' }), sha256: 'a'.repeat(64) }
  const accepted = []
  const { runner, calls } = fixture({ status: 'passed', observed: '筛选结果正确' }, { assertion })
  const result = await runner.verifyOperation(input({
    commit: 'commit-a', validation, recordCheckpoint: item => { accepted.push(item); return true },
  }))
  assert.deepEqual(result, { observed: '筛选结果正确', assertions: [assertion] })
  assert.deepEqual(accepted, [assertion])
  assert.match(calls[0].prompt, /只执行 validation\.steps/)
  assert.match(calls[0].prompt, /不要重复执行 npm ci/)
  assert.doesNotMatch(calls[0].prompt, /profile|Provider|宿主/)
})

test('verification runs dependency preflight before starting the agent', async () => {
  let called = false
  const { runner } = fixture(plan, { prepareOperation: async () => { throw new Error('依赖未就绪') } })
  await assert.rejects(runner.verifyOperation(input({ commit: 'commit-a', validation })), /依赖未就绪/)
  assert.equal(called, false)
})

test('verification startup budget aborts an agent that never initializes', async () => {
  let observedSignal
  const execute = ({ signal }) => {
    observedSignal = signal
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const runner = createAgent({ execute, getModel: async () => model, prepareOperation: async () => {}, verificationStartupTimeoutMs: 15 })
  await assert.rejects(runner.verifyOperation(input({ commit: 'commit-a', validation })), /启动超时/)
  assert.equal(observedSignal.aborted, true)
})

test('agent cancellation reaches the utility process and preserves structured errors', async () => {
  const controller = new AbortController()
  let received
  const execute = ({ signal }) => new Promise((resolve, reject) => {
    received = signal
    if (signal.aborted) { reject(new Error('已取消')); return }
    signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true })
  })
  const runner = createAgent({ execute, getModel: async () => model })
  const pending = runner.design(input({ signal: controller.signal }))
  controller.abort()
  await assert.rejects(pending, /已取消/)
  assert.equal(received.aborted, true)
})
