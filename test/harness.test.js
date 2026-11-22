import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createHarness } from '../src/harness.js'

const gitCommit = async () => 'committed-head'

const validation = { kind: 'operation', operation: '筛选订单', steps: ['点击筛选'], expected: '只显示已完成订单' }
const plan = { summary: '实现状态筛选', scope: '订单', risks: '旧数据', verification: '运行检查', validation }

function fixture(outputs = [plan]) {
  const seen = []
  let activation = 0
  const agent = {}
  const handle = { agent, async dispose() { seen.push('close parent') } }
  const ctx = {
    agents: {
      get() { return undefined },
      async create(options) { seen.push(['create', options.meta.cwd]); return handle },
      async resume(options) { seen.push(['resume', options.resumeSessionId]); return handle },
    },
    subagents: {
      async startActivation(options) {
        seen.push([options.provider, options.cwd, options.delivery, options.parent])
        return {
          childId: 'child',
          result: Promise.resolve({
            stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(outputs[activation++] ?? plan) }],
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
          }),
          async dispose() { seen.push('close child') },
        }
      },
      async drainDescendants(agents) { assert.deepEqual(agents, [agent]); seen.push('drain') },
    },
  }
  const task = { id: 'ABCDEF12', requirement: {}, requirementVersion: 1, work: { worktree: 'D:/isolated', base: 'base' }, plan }
  const input = {
    task,
    project: { path: 'D:/repo', checks: [] },
    signal: new AbortController().signal,
    recordRun(id) { seen.push(id) },
    recordSession() { task.sessionCreated = true },
    recordResult(result) { seen.push(['result', result]) },
  }
  return { ctx, input, seen, agent }
}

test('Harness adapter gates unverified policy, creates and resumes a task parent, and disposes activations', async () => {
  const development = { status: 'implemented', summary: '已创建本地提交' }
  const { ctx, input, seen, agent } = fixture([plan, development])
  await assert.rejects(createHarness(ctx, {}).design(input), /尚未完成/)
  assert.deepEqual(seen, [])
  const runner = createHarness(ctx, { designProvider: 'read-only', developmentProvider: 'workspace', providerPoliciesVerified: true }, { gitCommit })
  assert.deepEqual(await runner.design(input), plan)
  const startActivation = ctx.subagents.startActivation
  ctx.subagents.startActivation = options => {
    const [{ text }] = options.prompt
    assert.match(text, /用户在需求或返工说明中明确允许将指定的本地分支（例如 master）合入当前任务分支/)
    assert.match(text, /自动生成的方案本身不授予合并权限/)
    assert.match(text, /不得切换到来源分支、修改其他分支，或把任务分支合回主线/)
    assert.match(text, /完成本地提交后交给插件执行审查、验证和自动推送，本次委派止于本地提交/)
    assert.match(text, /配置的检查、所需运行证据和人工审批都通过后，插件推送同名任务分支/)
    assert.match(text, /删除文件：repo\/relative\.txt/)
    assert.match(text, /缺陷修复需要证明基线可复现且修复后回归检查通过/)
    return startActivation(options)
  }
  assert.deepEqual(await runner.develop(input), development)
  assert.deepEqual(seen, [
    ['create', 'D:/repo'], ['read-only', 'D:/repo', 'caller', agent], 'child',
    ['result', { stopReason: 'completed' }], 'close child', 'drain', 'close parent',
    ['resume', 'feishu-dev-abcdef12'], ['workspace', 'D:/isolated', 'caller', agent], 'child',
    ['result', { stopReason: 'completed' }], 'close child', 'drain', 'close parent',
  ])
})

test('Harness rejects an invalid development result and still releases resources', async () => {
  const { ctx, input, seen } = fixture([{ status: 'unknown', summary: '无效状态' }])
  const runner = createHarness(ctx, { developmentProvider: 'workspace', providerPoliciesVerified: true }, { gitCommit })
  await assert.rejects(runner.develop(input), /开发结果需要/)
  assert.deepEqual(seen.slice(-3), ['close child', 'drain', 'close parent'])
})

test('Harness requires a structured validation plan and rejects a hidden scope change', async () => {
  const alternative = { summary: '仅展示列表', impact: '取消原来的筛选要求', validation }
  const { ctx, input } = fixture([{ ...plan, validation: undefined }, { status: 'implemented', summary: '已提交', alternative },
    { status: 'alternative', summary: '需要审批', alternative }])
  const runner = createHarness(ctx, { designProvider: 'read-only', developmentProvider: 'workspace', providerPoliciesVerified: true }, { gitCommit })
  await assert.rejects(runner.design(input), /缺少有效的操作验证计划/)
  await assert.rejects(runner.develop(input), /必须单独提交审批/)
  assert.deepEqual(await runner.develop(input), { status: 'alternative', summary: '需要审批', alternative })
})

function liveProvider(ctx, argv) {
  const stdout = new PassThrough()
  const terminal = Promise.withResolvers()
  const started = Promise.withResolvers()
  const launches = []
  const service = { spawn(spec) { launches.push(spec); return { stdout } } }
  let readService
  ctx.on = (event, listener) => {
    assert.equal(event, 'internal/get')
    readService = name => listener({}, name, null, () => service)
  }
  ctx.subagents.startActivation = async ({ cwd }) => {
    await Promise.resolve()
    readService('subprocess').spawn({ cwd, argv, stdio: { stdout: 'pipe' } })
    started.resolve()
    return { childId: 'live-child', result: terminal.promise, async dispose() {} }
  }
  return { stdout, terminal, started: started.promise, launches, readService: () => readService('subprocess'), service }
}

const write = (stdout, packet) => stdout.write(`${JSON.stringify(packet)}\n`)

for (const kind of ['claude', 'codex']) {
  test(`${kind} assistant text reaches the caller before the terminal result`, async () => {
    const { ctx, input } = fixture()
    const argv = kind === 'claude'
      ? ['claude', '--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-mode', 'plan', '--model', 'custom']
      : ['node', 'codex.js', 'app-server', '--stdio']
    const { stdout, terminal, started, launches, readService, service } = liveProvider(ctx, argv)
    const text = []
    input.recordOutput = value => text.push(value)
    const runner = createHarness(ctx, { designProvider: 'user-provider', providerPoliciesVerified: true })
    assert.equal(readService(), service)
    const pending = runner.design(input)
    await started
    assert.deepEqual(launches[0].argv, kind === 'claude' ? [...argv, '--include-partial-messages'] : argv)
    const codex = (method, params) => write(stdout, { method, params: { threadId: 'thread', turnId: 'turn', ...params } })
    const claude = (event, parent = null) => write(stdout, { type: 'stream_event', parent_tool_use_id: parent, event })
    if (kind === 'claude') {
      claude({ type: 'message_start', message: { id: 'message' } })
      claude({ type: 'content_block_start', content_block: { type: 'text', text: '' } })
      claude({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' } })
      claude({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'nested' } }, 'tool')
      const encoded = Buffer.from(JSON.stringify({ type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '输出' } } }) + '\r\n')
      const split = encoded.indexOf(Buffer.from('输出')) + 1
      stdout.write(encoded.subarray(0, split))
      stdout.write(encoded.subarray(split))
      write(stdout, { type: 'assistant', parent_tool_use_id: null,
        message: { id: 'message', role: 'assistant', content: [{ type: 'text', text: '输出' }] } })
    } else {
      codex('turn/started', { turn: { id: 'turn' } })
      codex('item/reasoning/textDelta', { itemId: 'thought', delta: 'private' })
      codex('item/agentMessage/delta', { threadId: 'child', itemId: 'nested', delta: 'nested' })
      codex('item/agentMessage/delta', { itemId: 'message', delta: '输出' })
      codex('item/completed', { item: { type: 'agentMessage', id: 'message', text: '输出' } })
      codex('item/completed', { item: { type: 'commandExecution', id: 'tool', text: 'tool' } })
    }
    assert.equal(text.join(''), '输出')
    terminal.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(plan) }] })
    assert.deepEqual(await pending, plan)
    assert.equal(stdout.listenerCount('data'), 0)
  })
}

test('operation evidence comes from completed tool output on the verification turn', async () => {
  const { ctx, input } = fixture()
  const { stdout, terminal, started } = liveProvider(ctx, ['node', 'codex.js', 'app-server', '--stdio'])
  const startActivation = ctx.subagents.startActivation
  ctx.subagents.startActivation = options => {
    const [{ text }] = options.prompt
    assert.match(text, /Host 已对存在 package-lock.json 的 Node 项目完成依赖预检/)
    assert.match(text, /不要重复执行 npm ci/)
    return startActivation(options)
  }
  const runner = createHarness(ctx, { developmentProvider: 'codex', providerPoliciesVerified: true })
  const pending = runner.verifyOperation({ ...input, commit: 'commit', validation })
  await started
  const packet = (method, params) => write(stdout, { method, params: { threadId: 'thread', turnId: 'turn', ...params } })
  const line = JSON.stringify({ commit: 'commit', step: 1, observed: '界面显示已更新' })
  const item = { id: 'real-tool', type: 'commandExecution', status: 'completed', exitCode: 0,
    aggregatedOutput: `log\nFEISHU_AGENT_OBSERVATION ${line}\n` }
  packet('turn/started', { turn: { id: 'turn' } })
  packet('item/completed', { item: { ...item, type: 'agentMessage' } })
  packet('item/completed', { turnId: 'older-turn', item })
  packet('item/completed', { item: { ...item, exitCode: 1 } })
  packet('item/completed', { item })
  terminal.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"status":"passed","observed":"界面已更新"}' }] })
  const result = await pending
  assert.equal(result.assertions.length, 1)
  assert.equal(result.assertions[0].id, 'real-tool')
  assert.equal(result.assertions[0].line, line)
  assert.match(result.assertions[0].sha256, /^[a-f0-9]{64}$/)
})

test('verification resumes only the remaining steps after Host preflight', async () => {
  const { ctx, input } = fixture()
  const { stdout, terminal, started } = liveProvider(ctx, ['node', 'codex.js', 'app-server', '--stdio'])
  const startActivation = ctx.subagents.startActivation
  let prepared = false
  ctx.subagents.startActivation = options => {
    assert.equal(prepared, true)
    const [{ text }] = options.prompt
    assert.match(text, /"completedSteps":\[1\]/)
    assert.match(text, /不要重复执行或输出其证据/)
    return startActivation(options)
  }
  const statuses = []
  const checkpoints = []
  const runner = createHarness(ctx, { developmentProvider: 'codex', providerPoliciesVerified: true }, {
    prepareOperation: async () => { prepared = true },
  })
  const scenario = { ...validation, steps: ['打开列表', '点击筛选'] }
  const pending = runner.verifyOperation({ ...input, commit: 'commit', validation: scenario,
    checkpoint: { completedSteps: [1] },
    recordPreflight: status => statuses.push(status), recordCheckpoint: item => checkpoints.push(item) })
  await started
  const line = JSON.stringify({ commit: 'commit', step: 2, observed: '筛选结果正确' })
  write(stdout, { method: 'turn/started', params: { threadId: 'thread', turnId: 'turn', turn: { id: 'turn' } } })
  write(stdout, { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: {
    id: 'tool-2', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: `FEISHU_AGENT_OBSERVATION ${line}`,
  } } })
  terminal.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"status":"passed","observed":"筛选通过"}' }] })
  const result = await pending
  assert.deepEqual(statuses, ['checking', 'ready'])
  assert.equal(checkpoints.length, 1)
  assert.equal(result.assertions[0].id, 'tool-2')
})

test('development captures current-commit operation evidence without creating another session', async () => {
  const { ctx, input } = fixture([{ status: 'implemented', summary: '完成筛选', observed: '仅显示已完成订单' }])
  const { stdout, terminal, started } = liveProvider(ctx, ['node', 'codex.js', 'app-server', '--stdio'])
  let finished = false
  const runner = createHarness(ctx, { developmentProvider: 'codex', providerPoliciesVerified: true }, {
    gitCommit: async () => { assert.equal(finished, true); return 'committed-head' },
  })
  const pending = runner.develop(input)
  await started
  const packet = (method, params) => write(stdout, { method, params: { threadId: 'thread', turnId: 'turn', ...params } })
  packet('turn/started', { turn: { id: 'turn' } })
  packet('item/completed', { item: { type: 'commandExecution', id: 'tool', status: 'completed', exitCode: 0,
    aggregatedOutput: `FEISHU_AGENT_OBSERVATION ${JSON.stringify({ commit: 'committed-head', step: 1, observed: '列表筛选已生效' })}` } })
  finished = true
  terminal.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({ status: 'implemented', summary: '完成筛选', observed: '仅显示已完成订单' }) }] })
  const result = await pending
  assert.equal(result.operationEvidence.commit, 'committed-head')
  assert.equal(result.operationEvidence.assertions.length, 1)
  assert.equal(result.operationEvidence.observed, '仅显示已完成订单')
})

test('Claude development evidence accepts command results but not file contents', async () => {
  const { ctx, input } = fixture()
  const { stdout, terminal, started } = liveProvider(ctx, ['claude', '--output-format', 'stream-json', '--input-format', 'stream-json'])
  const runner = createHarness(ctx, { developmentProvider: 'claude', providerPoliciesVerified: true }, { gitCommit })
  const pending = runner.develop(input)
  await started
  const line = `FEISHU_AGENT_OBSERVATION ${JSON.stringify({ commit: 'committed-head', step: 1, observed: '实际筛选结果' })}`
  const tools = blocks => write(stdout, { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: blocks } })
  const results = blocks => write(stdout, { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: blocks } })
  tools([{ type: 'tool_use', id: 'read', name: 'Read' }, { type: 'tool_use', id: 'shell', name: 'Bash' }])
  results([{ type: 'tool_result', tool_use_id: 'read', content: line }, { type: 'tool_result', tool_use_id: 'shell', content: line }])
  terminal.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({ status: 'implemented', summary: '完成', observed: '筛选生效' }) }] })
  const result = await pending
  assert.equal(result.operationEvidence.assertions.length, 1)
  assert.equal(result.operationEvidence.assertions[0].id, 'shell')
})
test('cancellation detaches the observer and keeps the terminal cancellation behavior', async () => {
  const { ctx, input } = fixture()
  const { stdout, terminal, started } = liveProvider(ctx, ['claude', '--output-format', 'stream-json', '--input-format', 'stream-json'])
  const controller = new AbortController()
  input.signal = controller.signal
  input.recordOutput = () => assert.fail('unexpected output after cancellation')
  const runner = createHarness(ctx, { designProvider: 'user-provider', providerPoliciesVerified: true })
  const pending = runner.design(input)
  await started
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  assert.equal(stdout.listenerCount('data'), 0)
  write(stdout, { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'late' } } })
  terminal.resolve({ stopReason: 'cancelled' })
  await assert.rejects(pending, { name: 'AbortError' })
})
