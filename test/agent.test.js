import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgent } from '../src/agent.js'
import { normalizeActivity, toolActivityKind } from '../src/agent-activity.js'

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
    if (options.activity) request.onActivity?.(options.activity)
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

test('agent forwards bounded activity categories without tool payloads', async () => {
  const activity = { id: 'tool-1', kind: 'edit', status: 'running' }
  const { runner } = fixture(plan, { activity })
  const activities = []
  await runner.design(input({ recordActivity: item => activities.push(item) }))
  assert.deepEqual(activities, [activity])
  assert.equal(toolActivityKind('Read'), 'read')
  assert.equal(toolActivityKind('Bash'), 'command')
  assert.equal(toolActivityKind('UnknownTool'), 'other')
  assert.deepEqual(normalizeActivity({ ...activity, input: 'private path', output: 'private output' }), activity)
  assert.equal(normalizeActivity({ ...activity, kind: 'private-tool-name' }), undefined)
})

test('agent rejects invalid structured plans and undeclared alternative results', async () => {
  const invalidPlan = fixture({ ...plan, validation: undefined })
  await assert.rejects(invalidPlan.runner.design(input()), /缺少有效的操作验证计划/)
  const alternative = { summary: '只读列表', impact: '取消筛选', validation }
  const invalidDevelopment = fixture({ status: 'implemented', summary: '完成', alternative })
  await assert.rejects(invalidDevelopment.runner.develop(input()), /必须单独提交审批/)
})

test('delivery automation plans use isolated integration checks instead of recursive Feishu delivery', async () => {
  const checksPlan = { ...plan, validation: { kind: 'checks', reason: '运行工作流集成测试和真实本地裸仓库测试' } }
  const { runner, calls } = fixture(checksPlan)
  const deliveryTask = structuredClone(task)
  deliveryTask.requirement.body = '取消验收环节，验证成功直接 push 到远程分支且合并到 master'
  const result = await runner.design(input({ task: deliveryTask }))
  assert.equal(result.validation.kind, 'checks')
  assert.match(calls[0].prompt, /Git 分支、提交、推送、合并、交付状态机/)
  assert.match(calls[0].prompt, /替身渠道、临时数据库和本地裸仓库/)
  assert.match(calls[0].prompt, /不要把通过飞书再提交一个需求/)
  assert.match(calls[0].prompt, /真实飞书端到端联调属于独立发布验收/)
  assert.match(calls[0].prompt, /没有自动化覆盖的真实界面行为/)
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

test('verification leaves preflight pending and skips the model when the runtime is missing', async () => {
  const progress = []
  const { runner, calls } = fixture(plan, { prepareOperation: async () => { throw new Error('Electron 运行时未就绪') } })
  await assert.rejects(runner.verifyOperation(input({ commit: 'commit-a', validation, recordPreflight: stage => progress.push(stage) })), /Electron 运行时未就绪/)
  assert.deepEqual(progress, ['checking'])
  assert.equal(calls.length, 0)
})

test('verification uses the prepared Electron distribution and releases it when the agent fails', async () => {
  const events = []
  const electronDist = 'D:/isolated/electron-dist'
  const runner = createAgent({
    getModel: async () => model,
    prepareOperation: async () => ({ electronDist, dispose: async () => events.push('disposed') }),
    execute: async request => {
      assert.equal(request.electronDist, electronDist)
      assert.match(request.prompt, /FEISHU_VERIFY_ELECTRON_DIST/)
      assert.doesNotMatch(request.prompt, /D:\/isolated\/electron-dist/)
      events.push('model')
      throw new Error('验证调用中断')
    },
  })
  await assert.rejects(runner.verifyOperation(input({ commit: 'commit-a', validation, recordPreflight: stage => events.push(stage) })), /验证调用中断/)
  assert.deepEqual(events, ['checking', 'ready', 'model', 'disposed'])
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

test('verification initializes resumed sessions and cancels the startup budget on first protocol event', async () => {
  let calls = 0
  let output
  const resumed = structuredClone(task)
  resumed.agentSessionId = 'existing-session'
  const { runner } = fixture({ status: 'passed', observed: '实际界面结果正确' }, {
    execute: async request => {
      calls++
      assert.equal(request.resumeSessionId, 'existing-session')
      // The transport sends this even when the resumed ID is unchanged.
      await new Promise(resolve => setTimeout(resolve, 5))
      request.onSession('existing-session')
      request.onOutput('已启动 Electron，正在核对界面。')
      request.onAssertion({ id: 'tool-1', line: JSON.stringify({ commit: 'commit-a', step: 1, observed: '界面实际结果正确' }), sha256: 'a'.repeat(64) })
      await new Promise(resolve => setTimeout(resolve, 25))
      return { text: JSON.stringify({ status: 'passed', observed: '实际界面结果正确' }), sessionId: 'existing-session', stopReason: 'completed' }
    },
    verificationStartupTimeoutMs: 10,
    prepareOperation: async () => {},
  })
  output = await runner.verifyOperation(input({ task: resumed, commit: 'commit-a', validation }))
  assert.equal(output.observed, '实际界面结果正确')
  assert.equal(calls, 1)
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
