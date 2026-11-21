import { randomUUID } from 'node:crypto'

const titles = {
  confirm: '待补充需求', design_queued: '等待设计', designing: '设计中', approval: '历史待审批', held: '历史暂缓任务',
  queued: '开发已入队', developing: '开发中', verify_queued: '等待验证', verifying: '验证中', blocked: '任务阻塞',
  review: '开发交付', accepted: '已验收', cancelled: '已取消',
}
const actions = {
  confirm: [['supplement', '补充信息', true], ['cancel', '取消']],
  design_queued: [['cancel', '取消']], designing: [['cancel', '取消']],
  queued: [['cancel', '取消']], developing: [['cancel', '取消']], verify_queued: [['cancel', '取消']], verifying: [['cancel', '取消']],
  blocked: [['retry', '重试'], ['fix_checks', '返工后重新验证', true], ['supplement', '提交补充', true], ['cancel', '取消']],
  review: [['details', '查看改动'], ['rework', '要求返工', true], ['revise', '调整范围并重新设计', true], ['accept', '确认验收']],
}
const inFlight = ['designing', 'developing', 'verifying']
const textLimit = 12000

function requirement(text) {
  const main = text.match(/(?:^|\n)\s*需求(?:正文)?\s*[:：]\s*/u)
  const acceptance = text.match(/(?:^|\n)\s*验收(?:条件|标准)?\s*[:：]\s*/u)
  const body = text.slice(main ? main.index + main[0].length : 0, acceptance?.index ?? text.length).trim()
  return { body, acceptance: acceptance ? text.slice(acceptance.index + acceptance[0].length).trim() : '' }
}

function hasRequirement(task) {
  return Boolean(task.requirement.body.replace(/https?:\/\/[^\s]+/g, '').trim() && task.requirement.acceptance)
}

function availableActions(task) {
  return (actions[task.stage] ?? []).filter(([action]) => action !== 'fix_checks' || task.failedStage === 'verifying')
}

function invocation(task) {
  const attempt = task.attempt?.kind === 'verifying' ? task.lastInvocation : task.attempt
  if (!attempt || attempt.kind === 'verifying') return []
  const status = attempt.status === 'running' ? '运行中' : attempt.status === 'completed' ? '已完成' :
    attempt.status === 'cancelled' ? '已取消' : '异常结束'
  const end = attempt.finishedAt ?? attempt.heartbeatAt ?? Date.now()
  const elapsed = Math.max(0, Math.round((end - attempt.startedAt) / 1000))
  const lines = [`调用记录 ${attempt.provider ?? '正在建立委派'} · ${status} · ${elapsed} 秒`]
  if (attempt.childId) lines.push(`委派 ID ${attempt.childId}`)
  lines.push(`开始时间 ${new Date(attempt.startedAt).toLocaleString('zh-CN', { hour12: false })}`)
  if (attempt.heartbeatAt && attempt.status === 'running') {
    lines.push(`插件心跳 ${new Date(attempt.heartbeatAt).toLocaleString('zh-CN', { hour12: false })}`)
  }
  return lines
}

// 根据任务阶段生成供操作人查看的卡片内容。
function render(task, project) {
  const { stage, plan, result, error } = task
  const lines = [
    `任务 ${task.id}`, `类型 ${task.type === 'fix' ? '缺陷修复' : '新功能'}`, `项目 ${task.project || '待补充'}`,
    ...invocation(task),
  ]
  const source = task.requirement.body.match(/https?:\/\/[^\s<>]+/u)?.[0]
  if (source) lines.push(`需求来源 ${source}`)
  if (stage === 'confirm') {
    if (project?.path) lines.push(`仓库 ${project.path}`)
    lines.push(`需求 ${task.requirement.body || '待补充'}`, `验收条件 ${task.requirement.acceptance || '待补充'}`)
    if (!task.project) lines.push('补充时请填写“项目：项目名”。')
  }
  if (['design_queued', 'designing'].includes(stage)) {
    lines.push(`需求 ${task.requirement.body}`, `验收条件 ${task.requirement.acceptance}`)
  }
  if (plan && ['queued', 'developing', 'verify_queued', 'verifying'].includes(stage)) {
    lines.push(`需求 v${task.requirementVersion} / 方案 v${task.planVersion}`, `方案\n${plan.summary}`,
      `影响范围\n${plan.scope}`, `风险与待澄清事项\n${plan.risks}`, `验收条件\n${task.requirement.acceptance}`, `验证计划\n${plan.verification}`)
  }
  if (error && stage === 'blocked') lines.push(`失败阶段 ${titles[task.failedStage]}`, error)
  if (result && ['review', 'blocked', 'accepted'].includes(stage)) {
    lines.push(`分支 ${result.branch}`, `提交 ${result.commit || '待提交'}`, `改动\n${result.changes || '暂无'}`)
    if (result.remote) lines.push(`已推送 ${result.remote}/${result.branch}`)
    if (result.checks?.length) lines.push(`验证\n${result.checks.map(check => `${check.passed ? '通过' : '失败'} ${check.label}${check.output ? `\n${check.output}` : ''}`).join('\n')}`)
    if (task.showDetails && result.worktree) lines.push(`本地目录 ${result.worktree}`)
  }
  return {
    title: titles[stage], text: lines.map(line => line.slice(0, 1400)).join('\n\n').slice(0, 7800),
    actions: availableActions(task).map(([name, label, form]) => ({ label, token: `${task.id}:${task.revision}:${name}`, form })),
  }
}

export function createWorkflow({ store, projects, userId, runner, repository, onError }) {
  let controller

  function update(task, stage) {
    task.stage = stage
    store.save(task)
  }

  function supplement(task, text) {
    const project = text.match(/(?:^|\n)\s*项目\s*[:：]\s*([^\r\n]+)/u)
    const remainder = project ? text.replace(project[0], '').trim() : text
    const patch = requirement(remainder)
    if (project) {
      const selected = projects.resolve(project[1].trim())
      if (!selected) return '未找到该项目。'
      if (task.work && selected !== task.project) return '已创建工作树的任务不能切换项目。'
      task.project = selected
    }
    if (!patch.body && !patch.acceptance && !project) return '请填写补充内容。'
    if (patch.body) task.requirement.body = [task.requirement.body, patch.body].filter(Boolean).join('\n').slice(-textLimit)
    if (patch.acceptance) task.requirement.acceptance = patch.acceptance
    task.requirementVersion++
    task.plan = null
    task.approval = null
    update(task, task.project && hasRequirement(task) ? 'design_queued' : 'confirm')
    return '已保存补充信息。'
  }

  // 只用消息首行的明确命令确定任务类型，避免从需求正文猜测。
  function onMessage({ eventId, chatId, userId: actor, text, replyTo }) {
    if (actor !== userId || !eventId || !chatId || typeof text !== 'string' || text.length > textLimit) return ''
    return store.once(`message:${eventId}`, () => {
      const start = text.match(/^(开发需求|修复缺陷|修复bug)(?:\s*[｜|]\s*([^\r\n]*))?[ \t]*(?:\r?\n|$)/iu)
      if (start) {
        let id
        do { id = randomUUID().slice(0, 8).toUpperCase() } while (store.get(id))
        const task = {
          id, chatId, owner: actor, type: start[1] === '开发需求' ? 'feature' : 'fix',
          project: projects.resolve(start[2]?.trim()), requirement: requirement(text.slice(start[0].length)),
          requirementVersion: 1, planVersion: 0,
        }
        update(task, task.project && hasRequirement(task) ? 'design_queued' : 'confirm')
        return ''
      }
      const target = text.match(/^#?([0-9a-f]{8})(?:\s+|[：:])/i)
      const inferred = !target && !replyTo ? store.inChat(chatId).filter(task => task.owner === actor) : []
      if (inferred.length > 1) return `请在补充信息前加任务编号 ${inferred.map(task => task.id).join('、')}。`
      const id = target?.[1].toUpperCase() ?? (replyTo ? store.byMessage(replyTo) : inferred[0]?.id)
      const task = id && store.get(id)
      if (!task || task.chatId !== chatId || task.owner !== actor) return '请发送“开发需求｜项目名”或“修复缺陷｜项目名”创建任务，或回复任务卡片。'
      return respond(task, task.stage === 'review' ? 'rework' : 'supplement',
        (target ? text.slice(target[0].length) : text).trim())
    })
  }

  function respond(task, action, text) {
    const allowed = availableActions(task).find(([name]) => name === action)
    if (!allowed) return '当前阶段无法执行此操作。'
    if (allowed[2] && (!text || text.length > textLimit)) return '请输入有效的补充内容。'
    switch (action) {
      case 'supplement': return supplement(task, text)
      case 'revise':
        task.comments = [...(task.comments ?? []), text].slice(-5)
        task.plan = null
        task.approval = null
        update(task, 'design_queued')
        break
      case 'retry':
        update(task, { designing: 'design_queued', developing: 'queued', verifying: 'verify_queued' }[task.failedStage])
        break
      case 'fix_checks':
      case 'rework':
        task.rework = text
        update(task, 'queued')
        break
      case 'details':
        task.showDetails = true
        update(task, 'review')
        return `分支 ${task.result.branch}。详情已更新至卡片。`
      case 'accept': update(task, 'accepted'); break
      case 'cancel':
        if (task.attempt?.status === 'running') {
          task.attempt.status = 'cancelled'
          task.attempt.finishedAt = Date.now()
        }
        update(task, 'cancelled')
        break
    }
    return '已记录。'
  }

  function onAction({ eventId, chatId, userId: actor, messageId, token, text }) {
    if (actor !== userId || !eventId || !chatId || !messageId || typeof token !== 'string') return '当前用户无法操作此任务。'
    const [id, revision, action, extra] = token.split(':')
    const reply = store.once(`action:${eventId}`, () => {
      const task = store.get(id)
      if (extra !== undefined || !/^[0-9A-F]{8}$/.test(id) || !task || task.chatId !== chatId || task.owner !== actor || store.card(id) !== messageId) return '无法识别此任务卡片。'
      if (String(task.revision) !== revision) return '此卡片已更新，请使用当前版本。'
      return respond(task, action, typeof text === 'string' ? text.trim() : '')
    })
    if (store.get(id)?.stage === 'cancelled' && controller?.id === id) controller.abort()
    return reply
  }

  function recover() {
    store.transaction(() => {
      // 升级后不再等待人工确认或方案审批，旧的等待任务直接进入自动流程。
      for (const task of store.inStage('confirm', 'approval', 'held')) {
        if (!task.project || !hasRequirement(task)) {
          if (task.stage !== 'confirm') update(task, 'confirm')
        } else if (task.stage === 'confirm' || !task.plan) {
          update(task, 'design_queued')
        } else {
          update(task, 'queued')
        }
      }
      for (const task of store.inStage(...inFlight)) {
        task.failedStage = task.stage
        task.error = '上次运行中断。重试时会先核对已有工作树。'
        update(task, 'blocked')
      }
    })
  }

  // 串行执行设计、开发、验证与推送，失败时保留可重试状态。
  async function work() {
    if (controller) return
    const task = store.transaction(() => {
      if (store.inStage(...inFlight).length) return
      const [next] = store.inStage('design_queued', 'queued', 'verify_queued')
      if (!next) return
      const kind = { design_queued: 'designing', queued: 'developing', verify_queued: 'verifying' }[next.stage]
      next.attempt = { id: randomUUID(), kind, startedAt: Date.now(), status: 'running' }
      update(next, kind)
      return next
    })
    if (!task) return
    const running = new AbortController()
    controller = running
    running.id = task.id
    const signal = running.signal
    const persist = stage => store.transaction(() => {
      signal.throwIfAborted()
      if (store.get(task.id)?.attempt?.id !== task.attempt.id || store.get(task.id)?.stage === 'cancelled') throw new Error('任务运行已结束。')
      update(task, stage)
    })
    const recordRun = (childId, provider) => {
      task.attempt.childId = childId
      task.attempt.provider = provider
      task.attempt.heartbeatAt = Date.now()
      persist(task.stage)
    }
    const attemptId = task.attempt.id
    let output = ''
    let truncated = false
    let outputTimer
    function flushOutput() {
      if (!outputTimer) return
      clearTimeout(outputTimer)
      outputTimer = undefined
      if (signal.aborted) return
      try {
        store.transaction(() => {
          const latest = store.get(task.id)
          if (latest?.attempt?.id !== attemptId || latest.attempt.status !== 'running' || latest.stage !== latest.attempt.kind) return
          store.saveModelOutput(task.id, attemptId, output, truncated)
        })
      } catch (error) {
        onError(error)
      }
    }
    function recordOutput(text) {
      if (signal.aborted || task.attempt.status !== 'running' || typeof text !== 'string' || !text) return
      const limit = 24_000
      if (output.length + text.length > limit) truncated = true
      output = (output + text).slice(-limit).replace(/^[\uDC00-\uDFFF]/u, '')
      outputTimer ??= setTimeout(flushOutput, 400)
    }
    const recordResult = ({ stopReason }) => {
      flushOutput()
      task.attempt.status = stopReason === 'completed' ? 'completed' : 'error'
      task.attempt.stopReason = stopReason
      task.attempt.finishedAt = Date.now()
      task.lastInvocation = { ...task.attempt }
      persist(task.stage)
    }
    const recordSession = () => {
      task.sessionCreated = true
      persist(task.stage)
    }
    const heartbeat = setInterval(() => {
      try {
        store.transaction(() => {
          const latest = store.get(task.id)
          if (signal.aborted || latest?.attempt?.id !== task.attempt.id || latest.stage !== task.stage) return
          task.attempt.heartbeatAt = Date.now()
          store.progress(task)
        })
      } catch (error) {
        onError(error)
      }
    }, 15000)
    try {
      const project = projects.get(task.project)
      if (!project) throw new Error('当前配置中缺少任务项目。')
      if (task.stage === 'designing') {
        task.plan = await runner.design({ task, project, signal, recordRun, recordSession, recordResult, recordOutput })
        task.planVersion++
        persist('queued')
        return
      }
      if (!task.work) {
        task.work = await repository.intent({ task, project, signal })
        persist(task.stage)
      }
      task.work = await repository.prepare({ task, project, signal })
      persist(task.stage)
      let verification = {}
      if (task.stage === 'developing') {
        const development = await runner.develop({ task, project, signal, recordRun, recordSession, recordResult, recordOutput })
        if (!development || !['implemented', 'no_change', 'needs_clarification', 'blocked'].includes(development.status) ||
            typeof development.summary !== 'string' || !development.summary.trim() || development.summary.length > 1400) {
          throw new Error('开发委派返回了无效结果。')
        }
        task.attempt.development = development
        if (development.status === 'needs_clarification') throw new Error(`开发需要补充：${development.summary}`)
        if (development.status === 'blocked') throw new Error(`开发受阻：${development.summary}`)
        verification = { previousCommit: task.result?.commit ?? task.work.base, requireNewCommit: Boolean(task.result?.commit) }
        task.rework = null
        persist('verifying')
      }
      task.result = await repository.verify({ task, project, signal, ...verification })
      if (!task.result.checks.every(check => check.passed)) throw new Error('验证未通过，请查看检查结果。')
      const pushed = await repository.push({ task, project, signal, result: task.result })
      task.work.pushedCommit = pushed.commit
      task.result.remote = pushed.remote
      persist('review')
    } catch (error) {
      flushOutput()
      if (!signal.aborted) {
        if (task.attempt?.status === 'running') {
          task.attempt.status = 'error'
          task.attempt.finishedAt = Date.now()
        }
        task.failedStage = task.stage
        task.error = error instanceof Error ? error.message.slice(0, 600) : '执行失败。'
        persist('blocked')
      }
    } finally {
      clearInterval(heartbeat)
      controller = undefined
    }
  }

  async function publish(channel) {
    const notice = store.nextNotice()
    if (!notice) return
    const task = store.get(notice.task)
    const messageId = store.card(task.id)
    try {
      const card = render(task, projects.get(task.project))
      const snapshot = messageId ? { revision: task.revision, card } : store.firstSend(notice, task.revision, card)
      const message = await channel.publish({ chatId: task.chatId, messageId, card: snapshot.card, idempotencyKey: notice.id })
      if (!message) throw new Error('飞书消息发送后缺少消息 ID。')
      store.delivered(notice, snapshot.revision, message)
    } catch (error) {
      store.retryNotice(notice, error?.feishuDelivery ?? {
        operation: messageId ? 'patch' : 'create', kind: 'local',
      })
      onError(error)
    }
  }

  return { onMessage, onAction, recover, work, publish, stop: () => controller?.abort() }
}
