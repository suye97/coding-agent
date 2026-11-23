import { randomUUID } from 'node:crypto'
import { isOperatorId, operatorIds } from './operators.js'
import { normalizeAlternative, normalizeValidation } from './agent.js'
import { MAX_TASK_ATTACHMENTS, MAX_TASK_ATTACHMENT_BYTES } from './attachments.js'

const evidencePrefix = 'FEISHU_OPERATION_EVIDENCE '
const observation = value => typeof value === 'string' && value.trim() && value.length <= 500
const actionable = /界面|页面|屏幕|按钮|弹窗|点击|表单|输入框|交互|复现|运行时|打开|选中|拖拽|下拉|仪表盘|前端|滑动|勾选|切换|筛选|用户(?:可|能|操作)|\b(?:ui|ux|browser|dialog|screen|button|form|click|submit|navigate|repro(?:duce|duction)?|runtime|dashboard|webpage|website|dropdown|log in)\b/iu
const reworkStages = ['review', 'pushed', 'delivered']
const imageStages = ['confirm', 'design_queued', 'designing', 'blocked', ...reworkStages]
const acceptsImage = task => imageStages.includes(task.stage) ||
  (task.stage === 'manual_review' && task.manualReview?.kind === 'alternative')

// 只让明确的用户界面、交互和运行行为要求进入操作验证；修复不等于需要 GUI。
function requiresOperation(task) {
  return [task.requirement.body, ...(task.comments ?? []), task.rework, task.validationRework].some(text => actionable.test(text ?? ''))
}

function validationFor(task) {
  const approval = task.alternativeApproval
  const validApproval = approval && approval.requirementVersion === task.requirementVersion && approval.planVersion === task.planVersion
  const validation = normalizeValidation(validApproval ? approval.proposal.validation : task.plan?.validation)
  if (!validation || (validation.kind === 'checks' && !validApproval && requiresOperation(task))) {
    throw new Error('缺少适用于原需求的操作验证方案。请补充可执行步骤和预期结果后重新设计。')
  }
  return validation
}

function observedOperation(validation, reports, task) {
  let evidence
  for (const stdout of reports ?? []) {
    for (const line of stdout.split(/\r?\n/u)) {
      if (!line.startsWith(evidencePrefix) || line.length > 10_000) continue
      let report
      try { report = JSON.parse(line.slice(evidencePrefix.length)) } catch { continue }
      if (report?.operation !== validation.operation) continue
      const validSteps = Array.isArray(report.steps) && report.steps.length === validation.steps.length &&
        report.steps.every((step, index) => step?.action === validation.steps[index] && observation(step.observed))
      const observed = observation(report.observed) ? report.observed.trim() : undefined
      const validBaseline = task.type !== 'fix' || (report.baseline?.reproduced === true && observation(report.baseline.observed) &&
        report.baseline.observed.trim() !== observed)
      if (report.expected !== validation.expected || report.passed !== true || !observed || !validSteps || !validBaseline) {
        throw new Error('操作验证报告缺少适用的实测结果，或报告的步骤、预期与方案不一致。')
      }
      evidence ??= { kind: 'operation', operation: validation.operation, expected: validation.expected, observed,
        steps: report.steps.map(step => ({ action: step.action, observed: step.observed.trim() })),
        ...(task.type === 'fix' && { baseline: report.baseline.observed.trim() }) }
    }
  }
  if (!evidence) throw new Error('缺少项目操作检查产生的实测报告。请使用已配置的操作检查执行需求步骤后重试。')
  return evidence
}

function agentObservationProgress(validation, assertions, commit, baseline) {
  const firstStep = validation.type === 'fix' && !baseline ? 0 : 1
  const observations = []
  const accepted = []
  for (const assertion of assertions ?? []) {
    let record
    try { record = JSON.parse(assertion.line) } catch { continue }
    const step = firstStep + observations.length
    if (step > validation.steps.length || record?.step !== step ||
        record.commit !== (step === 0 ? validation.baseCommit : commit) || !observation(record.observed) ||
        typeof assertion.id !== 'string' || !/^[a-f0-9]{64}$/u.test(assertion.sha256)) continue
    accepted.push(assertion)
    observations.push({ observed: record.observed.trim(), toolId: assertion.id, outputSha256: assertion.sha256 })
  }
  const baselineObservation = firstStep === 0 ? observations[0] : baseline
  const steps = firstStep === 0 ? observations.slice(1) : observations
  return { accepted, observations, steps, baselineObservation }
}

function agentOperationEvidence(validation, report, commit, attempt, baseline) {
  const { observed, assertions } = report
  if (!observation(observed) || !attempt?.childId || !Array.isArray(assertions)) {
    throw new Error('验证 Agent 缺少实际操作工具记录。')
  }
  const { observations, steps, baselineObservation } = agentObservationProgress(validation, assertions, commit, baseline)
  const needsBaseline = validation.type === 'fix' && !baseline
  if (observations.length !== validation.steps.length + (needsBaseline ? 1 : 0)) {
    throw new Error('验证 Agent 缺少与待验提交匹配的逐步工具记录，或缺少基线复现。')
  }
  if (baselineObservation?.observed === observed.trim()) throw new Error('缺陷复现与修复结果相同。')
  return {
    kind: 'operation', source: 'agent', commit, childId: attempt.childId, provider: attempt.provider,
    operation: validation.operation, expected: validation.expected, observed: observed.trim(),
    steps: validation.steps.map((action, index) => ({ action, ...steps[index] })),
    ...(baselineObservation && { baseline: baselineObservation.observed,
      ...(baselineObservation.toolId && { baselineTool: baselineObservation }) }),
  }
}

function bindEvidenceIdentity(evidence, task, validation) {
  return {
    ...evidence,
    requirementVersion: task.requirementVersion,
    planVersion: task.planVersion,
    validationSteps: [...validation.steps],
    baseCommit: validation.baseCommit,
  }
}

function evidenceIdentityMatches(evidence, task, validation, commit) {
  return evidence?.commit === commit && evidence.operation === validation.operation &&
    evidence.expected === validation.expected && evidence.baseCommit === validation.baseCommit &&
    evidence.requirementVersion === task.requirementVersion && evidence.planVersion === task.planVersion &&
    JSON.stringify(evidence.validationSteps) === JSON.stringify(validation.steps)
}

function completeStoredEvidence(evidence, validation, task, commit) {
  if (!evidence) return false
  const validSteps = Array.isArray(evidence?.steps) && evidence.steps.length === validation.steps.length &&
    evidence.steps.every((step, index) => step?.action === validation.steps[index] && observation(step.observed) &&
      (!['agent', 'development'].includes(evidence.source) ||
        (typeof step.toolId === 'string' && /^[a-f0-9]{64}$/u.test(step.outputSha256))))
  const validBaseline = task.type !== 'fix' || (observation(evidence?.baseline) && evidence.baseline.trim() !== evidence.observed?.trim())
  return evidenceIdentityMatches(evidence, task, validation, commit) && observation(evidence?.observed) && validSteps && validBaseline
}

function resumeCheckpoint(task, validation, commit, baseline, candidate) {
  const saved = task.operationCheckpoint
  const matches = saved?.commit === commit && saved.operation === validation.operation &&
    saved.expected === validation.expected && saved.baseCommit === validation.baseCommit &&
    saved.requirementVersion === task.requirementVersion && saved.planVersion === task.planVersion &&
    JSON.stringify(saved.steps) === JSON.stringify(validation.steps)
  // 开发阶段不完整证据也进入同一检查点，只补未完成的步骤。
  const source = matches ? saved : evidenceIdentityMatches(candidate, task, validation, commit) ? candidate : undefined
  const checkpoint = {
    commit, operation: validation.operation, expected: validation.expected, steps: validation.steps,
    baseCommit: validation.baseCommit, requirementVersion: task.requirementVersion, planVersion: task.planVersion,
    assertions: source && Array.isArray(source.assertions) ? source.assertions.slice(0, 64) : [],
    preflight: matches ? saved.preflight : undefined,
    startedAt: matches ? saved.startedAt : Date.now(),
    stepStartedAt: Date.now(),
    lastRecordedAt: matches ? saved.lastRecordedAt : undefined,
  }
  const progress = agentObservationProgress(validation, checkpoint.assertions, commit, baseline)
  checkpoint.assertions = progress.accepted
  checkpoint.completedSteps = progress.steps.map((_, index) => index + 1)
  checkpoint.baselineReproduced = progress.observations.length > progress.steps.length
  checkpoint.phase = validation.type === 'fix' && !checkpoint.baselineReproduced && !baseline ? 'baseline' : 'step'
  return { checkpoint, progress }
}

const titles = {
  confirm: '待补充需求', design_queued: '等待设计', designing: '设计中', approval: '历史待审批', held: '历史暂缓任务',
  queued: '开发已入队', developing: '开发中', verify_queued: '等待验证', verifying: '验证中', blocked: '任务阻塞',
  manual_review: '待所有者审批', review: '已推送', pushed: '已推送', accepted: '已验收', delivered: '已交付', cancelled: '已取消',
}
const deliveryActions = [['details', '查看改动'], ['rework', '要求返工', true], ['revise', '调整范围并重新设计', true]]
const actions = {
  confirm: [['supplement', '补充信息', true], ['cancel', '取消']],
  design_queued: [['cancel', '取消']], designing: [['cancel', '取消']],
  queued: [['cancel', '取消']], developing: [['cancel', '取消']], verify_queued: [['cancel', '取消']], verifying: [['cancel', '取消']],
  blocked: [['retry', '重试'], ['fix_checks', '返工后重新验证', true], ['supplement', '提交补充', true], ['cancel', '取消']],
  manual_review: [['approve_manual', '批准'], ['decline_manual', '拒绝'], ['cancel', '取消']],
  review: deliveryActions, pushed: deliveryActions, delivered: deliveryActions,
}
const inFlight = ['designing', 'developing', 'verifying']
const textLimit = 12000

// 提取需求正文，并跳过旧消息中独立的验收条件段落。
function requirement(text) {
  const main = text.match(/(?:^|\n)\s*需求(?:正文)?\s*[:：]\s*/u)
  const acceptance = text.match(/(?:^|\n)\s*验收(?:条件|标准)?\s*[:：]\s*/u)
  const body = text.slice(main ? main.index + main[0].length : 0, acceptance?.index ?? text.length).trim()
  return { body }
}

// 先匹配完整配置名称，再匹配行内分隔符前的最长名称。
function parseRequest(text, projects, exactProject = false) {
  const firstLine = text.match(/^(开发需求|修复缺陷|修复bug)(?:[ \t]*[｜|][ \t]*([^\r\n]*))?[ \t]*(?:\r?\n|$)/iu)
  if (!firstLine) return
  const heading = firstLine[2]?.trim() ?? ''
  const nextLines = text.slice(firstLine[0].length)
  let project = projects.resolve(heading)
  if (exactProject && !project) return
  let inline = ''
  if (!project) {
    for (const separator of heading.matchAll(/[｜|：:\p{Zs}\t]+/gu)) {
      const matched = projects.resolve(heading.slice(0, separator.index).trimEnd())
      if (!matched) continue
      project = matched
      inline = heading.slice(separator.index + separator[0].length).replace(/^[｜|：:\s]+/u, '')
    }
  }
  const parsed = requirement([inline, nextLines].filter(Boolean).join('\n'))
  // TAPD 描述可以提出删除请求，实际授权须由操作人给出。
  if (exactProject) parsed.body = parsed.body.replace(/^[^\S\r\n]*删除文件[：:]/gmu, 'TAPD 请求删除文件：')
  return { type: firstLine[1] === '开发需求' ? 'feature' : 'fix', project, requirement: parsed }
}

// 项目可识别且去掉来源链接后仍有正文时进入设计。
function readyForDesign(task) {
  return Boolean(task.project && task.requirement?.body?.replace(/https?:\/\/[^\s]+/g, '').trim())
}

function availableActions(task) {
  return (actions[task.stage] ?? []).filter(([action]) => action !== 'fix_checks' || task.failedStage === 'verifying')
}

function invocation(task) {
  const attempt = task.attempt?.kind === 'verifying' && !task.attempt.childId ? task.lastInvocation : task.attempt
  if (!attempt) return []
  const status = attempt.status === 'running' ? '运行中' : attempt.status === 'completed' ? '已完成' :
    attempt.status === 'cancelled' ? '已取消' : '异常结束'
  const end = attempt.finishedAt ?? attempt.heartbeatAt ?? Date.now()
  const elapsed = Math.max(0, Math.round((end - attempt.startedAt) / 1000))
  const lines = [`调用记录 ${attempt.provider ?? '正在建立委派'} · ${status} · ${elapsed} 秒`]
  if (attempt.childId) lines.push(`委派 ID ${attempt.childId}`)
  lines.push(`开始时间 ${new Date(attempt.startedAt).toLocaleString('zh-CN', { hour12: false })}`)
  if (attempt.heartbeatAt && attempt.status === 'running') {
    lines.push(`运行心跳 ${new Date(attempt.heartbeatAt).toLocaleString('zh-CN', { hour12: false })}`)
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
    lines.push(`需求 ${task.requirement.body || '待补充'}`)
    if (!task.project) lines.push('补充时请填写“项目：项目名”。')
  }
  if (['design_queued', 'designing'].includes(stage)) {
    lines.push(`需求 ${task.requirement.body}`)
  }
  if (plan && ['queued', 'developing', 'verify_queued', 'verifying'].includes(stage)) {
    lines.push(`需求 v${task.requirementVersion} / 方案 v${task.planVersion}`, `方案\n${plan.summary}`,
      `影响范围\n${plan.scope}`, `风险与待澄清事项\n${plan.risks}`, `验证计划\n${plan.verification}`)
  }
  const checkpoint = task.operationCheckpoint
  if (checkpoint && (stage === 'verifying' || (stage === 'blocked' && task.failedStage === 'verifying'))) {
    const environment = {
      ready: '验证依赖已就绪', checking: '正在检查验证依赖',
    }[checkpoint.preflight] ?? '正在准备环境'
    const completed = checkpoint.completedSteps?.length ?? 0
    const current = Math.min(completed + 1, checkpoint.steps.length)
    const end = checkpoint.finishedAt ?? Date.now()
    const seconds = typeof checkpoint.stepElapsedMs === 'number'
      ? Math.max(0, Math.floor(checkpoint.stepElapsedMs / 1000))
      : checkpoint.stepStartedAt ? Math.max(0, Math.floor((end - checkpoint.stepStartedAt) / 1000)) : 0
    const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`
    const activity = checkpoint.phase === 'merging'
      ? ` · ${stage === 'verifying' ? '正在更新 master' : '停在 master 合并'}`
      : checkpoint.phase === 'pushing'
      ? ` · ${stage === 'verifying' ? '正在推送' : '停在推送'}`
      : checkpoint.phase === 'baseline'
        ? ` · ${stage === 'verifying' ? '正在复现基线' : '停在基线复现'} · 本步 ${elapsed}`
        : checkpoint.preflight === 'ready' && completed < checkpoint.steps.length
          ? ` · ${stage === 'verifying' ? '正在执行' : '停在'}第 ${current} 步 · 本步 ${elapsed}` : ''
    lines.push(`UI 验证 ${environment} · 已完成 ${completed}/${checkpoint.steps.length} 步${checkpoint.baselineReproduced ? ' · 基线已复现' : ''}${activity}`)
  }
  if (stage === 'verifying' && task.delivery && result?.remote) {
    lines.push(`已推送 ${result.remote}/${result.branch} · 正在处理 ${result.remote}/master`)
  }
  if (acceptsImage(task)) lines.push(`可回复此卡片发送原型图或截图。已附 ${task.attachments?.length ?? 0}/8 张。`)
  if (stage === 'manual_review' && task.manualReview?.kind === 'alternative') {
    const { proposal } = task.manualReview
    lines.push(`原需求\n${task.requirement.body}`, `替代方案\n${proposal.summary}`, `与原需求的差异\n${proposal.impact}`)
    const { validation } = proposal
    lines.push(validation.kind === 'operation'
      ? `替代操作\n${validation.operation}\n${validation.steps.join('\n')}\n预期 ${validation.expected}`
      : `验证范围\n${validation.reason}`)
  }
  if (error && stage === 'blocked') lines.push(`失败阶段 ${titles[task.failedStage]}`, error)
  if (result && [...reworkStages, 'manual_review', 'blocked', 'accepted'].includes(stage)) {
    lines.push(`分支 ${result.branch}`, `提交 ${result.commit || '待提交'}`)
    if (result.remote) lines.push(`已推送 ${result.remote}/${result.branch}`)
    if (result.merged) lines.push(`已合入 ${result.remote}/${result.merged.branch} · ${result.merged.commit}`)
    const verification = task.mergeResult ?? result
    if (task.mergeResult && !result.merged) lines.push(`master 合并候选 ${task.mergeResult.commit}`)
    const changeReview = verification.changeReview
    if (changeReview?.deletions.length) lines.push('删除的受跟踪文件', ...changeReview.deletions)
    if (changeReview?.warnings.length) lines.push('脚本检查提示', ...changeReview.warnings.map(({ path, reason }) => `${path} ${reason}`))
    if (verification.operationEvidence) {
      const { operation, expected, observed, steps, baseline } = verification.operationEvidence
      lines.push(`实测操作 ${operation}`, `预期 ${expected}`, `实测结果 ${observed}`,
        ...steps.map(step => `${step.action}\n${step.observed}`))
      if (baseline) lines.push(`基线复现 ${baseline}`)
    }
    lines.push(`改动\n${result.changes || '暂无'}`)
    if (verification.checks?.length) lines.push(`验证\n${verification.checks.map(check => `${check.passed ? '通过' : '失败'} ${check.label}${check.output ? `\n${check.output}` : ''}`).join('\n')}`)
    if (task.showDetails && result.worktree) lines.push(`本地目录 ${result.worktree}`)
  }
  return {
    title: titles[stage], text: lines.map(line => line.slice(0, 1400)).join('\n\n').slice(0, 7800),
    actions: availableActions(task).map(([name, label, form]) => ({ label, token: `${task.id}:${task.revision}:${name}`, form })),
  }
}

export function createWorkflow({ store, projects, userId, runner, repository, onError, verificationTimeoutMs = 15 * 60_000 }) {
  let controller
  const operators = operatorIds(userId)
  const allowedOperator = actor => isOperatorId(actor) && operators !== null &&
    (operators.length === 0 || operators.includes(actor))

  function update(task, stage) {
    task.stage = stage
    store.save(task)
  }

  // 补充项目和正文后按统一条件重新决定是否入队。
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
    if (!patch.body && !project) return '请填写补充内容。'
    task.requirement = { body: [task.requirement?.body, patch.body].filter(Boolean).join('\n').slice(-textLimit) }
    task.requirementVersion++
    task.plan = null
    task.approval = null
    task.alternativeApproval = null
    task.manualReview = null
    task.changeReviewApproval = null
    task.rework = null
    task.validationRework = null
    update(task, readyForDesign(task) ? 'design_queued' : 'confirm')
    return '已保存补充信息。'
  }

  // 只用消息首行的明确命令确定任务类型，避免从需求正文猜测。
  function onMessage({ eventId, chatId, userId: actor, text, replyTo, replyRoot, group, tapdCard }) {
    if (!allowedOperator(actor) || !eventId || !chatId || typeof text !== 'string' || text.length > textLimit) return ''
    const request = parseRequest(text.trimStart(), projects, tapdCard)
    const target = text.match(/^#?([0-9a-f]{8})(?:\s+|[：:])/i)
    const repliedTask = [replyTo, replyRoot].map(id => id && store.byMessage(id)).find(Boolean)
    if (group && !request && !target && !repliedTask) return ''
    return store.once(`message:${eventId}`, () => {
      if (request) {
        let id
        do { id = randomUUID().slice(0, 8).toUpperCase() } while (store.get(id))
        const task = {
          id, chatId, owner: actor, ...request,
          requirementVersion: 1, planVersion: 0,
        }
        update(task, readyForDesign(task) ? 'design_queued' : 'confirm')
        return ''
      }
      const inferred = !group && !target && !replyTo ? store.inChat(chatId).filter(task => task.owner === actor) : []
      if (inferred.length > 1) return `请在补充信息前加任务编号 ${inferred.map(task => task.id).join('、')}。`
      const id = target?.[1].toUpperCase() ?? (repliedTask ?? inferred[0]?.id)
      const task = id && store.get(id)
      if (group && (!task || task.chatId !== chatId || task.owner !== actor)) return ''
      if (!task || task.chatId !== chatId || task.owner !== actor) return '请发送“开发需求｜项目名”或“修复缺陷｜项目名”创建任务，或回复任务卡片。'
      return respond(task, reworkStages.includes(task.stage) ? 'rework' : 'supplement',
        (target ? text.slice(target[0].length) : text).trim())
    })
  }

  function attachmentTarget({ chatId, userId: actor, replyTo, replyRoot }) {
    if (!allowedOperator(actor) || !chatId) return undefined
    for (const message of [replyTo, replyRoot]) {
      const id = message && store.byMessage(message)
      if (!id) continue
      const task = store.get(id)
      return task?.owner === actor && task.chatId === chatId && acceptsImage(task) ? id : undefined
    }
  }

  function attachImage({ taskId, chatId, userId: actor, attachment, eventId }) {
    if (!allowedOperator(actor) || !eventId || !attachment?.id || !Number.isSafeInteger(attachment.byteLength) || attachment.byteLength <= 0) return '无法保存此图片。'
    return store.once(`image:${eventId}`, () => {
      const task = store.get(taskId)
      if (!task || task.chatId !== chatId || task.owner !== actor || !acceptsImage(task)) return '请回复可接收图片的任务卡片。'
      const attachments = task.attachments ?? []
      if (attachments.some(image => image.id === attachment.id)) return '该图片已保存。'
      if (attachments.length >= MAX_TASK_ATTACHMENTS ||
          attachments.reduce((bytes, image) => bytes + image.byteLength, attachment.byteLength) > MAX_TASK_ATTACHMENT_BYTES) {
        return '任务图片已达到 8 张或 24 MiB 的上限。'
      }
      task.attachments = [...attachments, attachment]
      if (['designing', 'blocked', 'manual_review'].includes(task.stage)) {
        const refreshDesign = readyForDesign(task)
        task.plan = null
        task.approval = null
        task.alternativeApproval = null
        task.manualReview = null
        task.changeReviewApproval = null
        task.error = null
        if (task.attempt?.status === 'running') {
          task.attempt.status = 'cancelled'
          task.attempt.finishedAt = Date.now()
        }
        update(task, refreshDesign ? 'design_queued' : 'confirm')
        if (controller?.id === task.id) controller.abort()
        return refreshDesign ? '已保存任务图片，将带图重新设计。' : '已保存任务图片。'
      }
      update(task, task.stage)
      return '已保存任务图片。'
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
        task.alternativeApproval = null
        task.changeReviewApproval = null
        task.rework = null
        task.validationRework = null
        update(task, 'design_queued')
        break
      case 'approve_manual': {
        const review = task.manualReview
        if (review?.kind === 'alternative') {
          task.alternativeApproval = { proposal: review.proposal, requirementVersion: task.requirementVersion, planVersion: task.planVersion }
          task.manualReview = null
          update(task, 'queued')
        } else if (review?.kind === 'change' && review.commit === (task.mergeResult ?? task.result)?.changeReview?.commit &&
            review.commit === (task.mergeResult ?? task.result)?.commit) {
          task.changeReviewApproval = { commit: review.commit }
          task.manualReview = null
          update(task, 'verify_queued')
        } else {
          return '审批内容已失效，请重新生成。'
        }
        break
      }
      case 'decline_manual':
        task.failedStage = task.manualReview.sourceStage
        task.error = '所有者拒绝了待审批事项。'
        task.manualReview = null
        update(task, 'blocked')
        break
      case 'retry':
        update(task, { designing: 'design_queued', developing: 'queued', verifying: 'verify_queued' }[task.failedStage])
        break
      case 'fix_checks':
      case 'rework':
        task.rework = text
        update(task, actionable.test(text) ? 'design_queued' : 'queued')
        break
      case 'details':
        task.showDetails = true
        update(task, task.stage)
        return `分支 ${task.result.branch}。详情已更新至卡片。`
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
    if (!allowedOperator(actor) || !eventId || !chatId || !messageId || typeof token !== 'string') return '当前用户无法操作此任务。'
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
      // 刷新旧的待验收卡片。历史推送本身不会进入自动合并队列。
      for (const task of store.inStage('review')) update(task, 'pushed')
      // 升级后不再等待人工确认或方案审批，旧的等待任务直接进入自动流程。
      for (const task of store.inStage('confirm', 'approval', 'held')) {
        if (!readyForDesign(task)) {
          if (task.stage !== 'confirm') update(task, 'confirm')
        } else if (task.stage === 'confirm' || !task.plan) {
          update(task, 'design_queued')
        } else {
          update(task, 'queued')
        }
      }
      for (const task of store.inStage(...inFlight)) {
        if (task.attempt?.status === 'running') {
          task.attempt.status = 'error'
          task.attempt.stopReason = 'interrupted'
          task.attempt.finishedAt = Date.now()
        }
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
    const verificationTimeout = new AbortController()
    controller = running
    running.id = task.id
    const signal = AbortSignal.any([running.signal, verificationTimeout.signal])
    let verificationTimer
    const watchStage = stage => {
      if (stage !== 'verifying') {
        clearTimeout(verificationTimer)
        verificationTimer = undefined
      } else if (!verificationTimer) {
        verificationTimer = setTimeout(() => verificationTimeout.abort(new Error('验证阶段超过总时间上限，已终止本次检查、实测、推送或合并。重试可复用有效检查点。')), verificationTimeoutMs)
      }
    }
    const persist = (stage, afterTimeout = false) => store.transaction(() => {
      const executionSignal = afterTimeout ? running.signal : signal
      executionSignal.throwIfAborted()
      if (store.get(task.id)?.attempt?.id !== attemptId || store.get(task.id)?.stage === 'cancelled') throw new Error('任务运行已结束。')
      update(task, stage)
      watchStage(stage)
    })
    watchStage(task.stage)
    const recordRun = (childId, provider) => {
      task.attempt.childId = childId
      task.attempt.provider = provider
      task.attempt.heartbeatAt = Date.now()
      if (task.stage === 'verifying' && task.operationCheckpoint) {
        task.operationCheckpoint.stepStartedAt = Date.now()
        delete task.operationCheckpoint.finishedAt
        delete task.operationCheckpoint.stepElapsedMs
      }
      persist(task.stage)
    }
    let attemptId = task.attempt.id
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
    const recordSession = sessionId => {
      task.sessionCreated = true
      if (sessionId) task.agentSessionId = sessionId
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
    async function verifyCommit(project, operationValidation, candidate) {
      const previousEvidence = (candidate ? task.mergeResult?.operationEvidence : task.result?.operationEvidence)
        ?? task.result?.operationEvidence
      const { operationReports, ...result } = await repository.verify({ task, project, signal,
        ...(candidate ? { candidate } : task.verification), operationValidation })
      if (candidate) task.mergeResult = result
      else task.result = result
      if (result.changeReview?.approvalRequired) {
        task.manualReview = { kind: 'change', commit: result.changeReview.commit, sourceStage: task.stage }
        persist('manual_review')
        return
      }
      if (!result.checks?.length || !result.checks.every(check => check.passed)) throw new Error('验证未通过，请查看检查结果。')
      if (operationValidation) {
        if (operationReports?.length) {
          result.operationEvidence = bindEvidenceIdentity({ ...observedOperation(operationValidation, operationReports, task), commit: result.commit }, task, operationValidation)
          task.operationEvidence = result.operationEvidence
          persist('verifying')
        } else {
          // 完整证据和检查点使用同一套提交、步骤、需求/方案版本及基线身份。
          const storedEvidence = evidenceIdentityMatches(task.operationEvidence, task, operationValidation, result.commit)
            ? task.operationEvidence : undefined
          const baseline = ['agent', 'development'].includes(previousEvidence?.source) && previousEvidence.baseCommit === task.work.base
            ? previousEvidence.baselineTool : undefined
          let developmentEvidence
          if (storedEvidence?.source === 'development') {
            try {
              developmentEvidence = bindEvidenceIdentity(
                agentOperationEvidence(operationValidation, storedEvidence, result.commit, task.attempt, baseline), task, operationValidation)
            } catch { /* 缺少证据时进入检查点补验。 */ }
          }
          if (storedEvidence?.source === 'development' ? developmentEvidence : completeStoredEvidence(storedEvidence, operationValidation, task, result.commit)) {
            task.operationEvidence = developmentEvidence ?? storedEvidence
          } else {
            let { checkpoint, progress } = resumeCheckpoint(task, operationValidation, result.commit, baseline, storedEvidence)
            let checkpointError
            const saveCheckpoint = () => {
              task.operationCheckpoint = checkpoint
              try { persist('verifying') } catch (error) { checkpointError ??= error }
            }
            const recordPreflight = status => {
              checkpoint.preflight = status
              checkpoint.phase = status === 'ready'
                ? (operationValidation.type === 'fix' && !checkpoint.baselineReproduced && !baseline ? 'baseline' : 'step')
                : 'preflight'
              delete checkpoint.finishedAt
              delete checkpoint.stepElapsedMs
              if (status === 'ready') checkpoint.stepStartedAt = Date.now()
              saveCheckpoint()
            }
            const recordCheckpoint = assertion => {
              const next = agentObservationProgress(operationValidation, [...checkpoint.assertions, assertion], result.commit, baseline)
              if (next.accepted.length === checkpoint.assertions.length) {
                checkpoint.rejectedSteps = [...checkpoint.rejectedSteps ?? [], {
                  step: (() => { try { return JSON.parse(assertion?.line)?.step } catch {} })() ?? null,
                  commit: (() => { try { return JSON.parse(assertion?.line)?.commit } catch {} })() ?? null,
                  validOutput: typeof assertion?.id === 'string' && /^[a-f0-9]{64}$/u.test(assertion?.sha256),
                }].slice(-8)
                saveCheckpoint()
                return false
              }
              checkpoint.assertions = next.accepted
              checkpoint.completedSteps = next.steps.map((_, index) => index + 1)
              checkpoint.baselineReproduced = next.observations.length > next.steps.length
              checkpoint.phase = operationValidation.type === 'fix' && !checkpoint.baselineReproduced && !baseline ? 'baseline' : 'step'
              checkpoint.lastRecordedAt = Date.now()
              checkpoint.stepStartedAt = checkpoint.lastRecordedAt
              saveCheckpoint()
              return true
            }
            // 在调用新的 Agent 前先恢复并持久化进度，重启后的首张卡片不会回到 0/N。
            saveCheckpoint()
            if (task.attempt.kind !== 'verifying' || task.attempt.status !== 'running') {
              flushOutput()
              task.attempt = { id: randomUUID(), kind: 'verifying', startedAt: Date.now(), status: 'running' }
              persist('verifying')
              attemptId = task.attempt.id
              output = ''
              truncated = false
            }
            const verificationTask = candidate ? { ...task, sessionCreated: false, agentSessionId: undefined,
              work: { ...task.work, worktree: candidate.worktree } } : task
            const evidence = await runner.verifyOperation({ task: verificationTask, project, signal, recordRun,
              recordSession: candidate ? () => {} : recordSession, recordResult, recordOutput,
              validation: operationValidation, commit: result.commit,
              baselineObserved: Boolean(baseline) || progress.observations.length > progress.steps.length,
              ...(progress.steps.length && { checkpoint: { completedSteps: progress.steps.map((_, index) => index + 1) } }),
              recordCheckpoint, recordPreflight })
            if (checkpointError) throw checkpointError
            if (evidence.alternative) {
              delete task.operationCheckpoint
              task.manualReview = { kind: 'alternative', proposal: evidence.alternative, sourceStage: task.stage }
              persist('manual_review')
              return
            }
            try {
              task.operationEvidence = bindEvidenceIdentity(agentOperationEvidence(operationValidation,
                { ...evidence, assertions: [...checkpoint.assertions, ...evidence.assertions] }, result.commit, task.attempt, baseline), task, operationValidation)
            } catch (error) {
              if (error instanceof Error && /逐步工具记录|基线复现/u.test(error.message)) {
                // Incomplete resumed evidence is revalidated by the SDK itself; only live
                // observations rejected by recordCheckpoint belong in this diagnostic.
                const accepted = new Set(checkpoint.assertions.map(item => item.id))
                const rejected = (evidence.assertions ?? []).filter(item => !accepted.has(item.id)).map(item => {
                  try {
                    const record = JSON.parse(item.line)
                    return { step: typeof record.step === 'number' && Number.isInteger(record.step) ? record.step : null, commit: record.commit }
                  } catch { return { step: null, commit: null } }
                })
                const wrongStep = rejected.filter(item => item.step === null || item.step > operationValidation.steps.length ||
                  item.step < (operationValidation.type === 'fix' && !baseline ? 0 : 1)).length
                const commitMismatch = rejected.filter(item => typeof item.step === 'number' && Number.isInteger(item.step) &&
                  item.step >= 0 && item.step <= operationValidation.steps.length && !wrongStep &&
                  item.commit !== (item.step === 0 ? operationValidation.baseCommit : result.commit)).length
                error.message += ` 主程序已接受 ${checkpoint.completedSteps.length}/${operationValidation.steps.length} 步，验证 Agent 返回 ${evidence.assertions?.length ?? 0} 条工具记录，其中 ${commitMismatch} 条提交不匹配，${wrongStep} 条步骤编号不适用，${rejected.length - commitMismatch - wrongStep} 条缺少有效工具标识或观察结果。`
                if (operationValidation.type === 'fix' && !baseline && !checkpoint.baselineReproduced) error.message += ' 缺少基线复现的工具记录。'
                if (!evidence.assertions?.length) error.message += ' 未收到本轮工具输出中的逐步证据，模型自述不能代替实测记录。'
                if (task.attempt.stopReason === 'max_output_tokens') error.message += ' 模型输出达到长度上限，记录可能不完整。'
                if (checkpointError) error.message += ` 检查点保存失败：${checkpointError instanceof Error ? checkpointError.message.slice(0, 200) : '请重试。'}`
              }
              throw error
            }
            persist('verifying')
          }
        }
        result.operationEvidence = task.operationEvidence
        task.operationCheckpoint = {
          commit: result.commit, operation: operationValidation.operation, expected: operationValidation.expected, steps: operationValidation.steps,
          baseCommit: operationValidation.baseCommit, requirementVersion: task.requirementVersion, planVersion: task.planVersion,
          preflight: 'ready', phase: candidate ? 'merging' : 'pushing', completedSteps: operationValidation.steps.map((_, index) => index + 1),
          baselineReproduced: Boolean(task.operationEvidence.baseline), startedAt: task.operationCheckpoint?.startedAt ?? Date.now(),
          stepStartedAt: Date.now(),
        }
        delete task.operationCheckpoint.finishedAt
        delete task.operationCheckpoint.stepElapsedMs
        persist('verifying')
      }
      return result
    }

    try {
      const project = projects.get(task.project)
      if (!project) throw new Error('当前配置中缺少任务项目。')
      if (task.stage === 'designing') {
        task.plan = await runner.design({ task, project, signal, recordRun, recordSession, recordResult, recordOutput })
        task.planVersion++
        if (task.plan?.alternative != null) {
          const proposal = normalizeAlternative(task.plan.alternative)
          if (!proposal) throw new Error('替代方案缺少范围差异或验证计划。')
          task.manualReview = { kind: 'alternative', proposal, sourceStage: task.stage }
          persist('manual_review')
        } else {
          validationFor(task)
          persist('queued')
        }
        return
      }
      if (!task.plan?.validation && !task.alternativeApproval) {
        persist('design_queued')
        return
      }
      const validation = validationFor(task)
      if (!task.work) {
        task.work = await repository.intent({ task, project, signal })
        persist(task.stage)
      }
      task.work = await repository.prepare({ task, project, signal })
      persist(task.stage)
      if (task.stage === 'developing') {
        const development = await runner.develop({ task, project, signal, recordRun, recordSession, recordResult, recordOutput })
        if (!development || !['implemented', 'no_change', 'needs_clarification', 'blocked', 'alternative'].includes(development.status) ||
            typeof development.summary !== 'string' || !development.summary.trim() || development.summary.length > 1400) {
          throw new Error('开发委派返回了无效结果。')
        }
        task.attempt.development = { status: development.status, summary: development.summary, ...(development.alternative && { alternative: development.alternative }) }
        if (development.operationEvidence) {
          task.operationEvidence = bindEvidenceIdentity({
            ...development.operationEvidence,
            operation: validation.operation,
            expected: validation.expected,
            source: 'development',
          }, task, { ...validation, type: task.type, baseCommit: task.work.base })
        }
        if (development.status === 'needs_clarification') throw new Error(`开发需要补充：${development.summary}`)
        if (development.status === 'blocked') throw new Error(`开发受阻：${development.summary}`)
        if (development.status === 'alternative') {
          const proposal = normalizeAlternative(development.alternative)
          if (!proposal) throw new Error('替代方案缺少范围差异或验证计划。')
          task.manualReview = { kind: 'alternative', proposal, sourceStage: task.stage }
          persist('manual_review')
          return
        }
        delete task.delivery
        delete task.mergeResult
        task.verification = { previousCommit: task.work.pushedCommit ?? task.work.base, requireNewCommit: Boolean(task.work.pushedCommit) }
        task.validationRework = task.rework
        task.rework = null
        persist('verifying')
      }
      const operationValidation = validation.kind === 'operation' ? { ...validation, type: task.type, baseCommit: task.work.base } : undefined
      if (task.delivery?.requirementVersion !== task.requirementVersion || task.delivery?.planVersion !== task.planVersion) {
        delete task.delivery
        delete task.mergeResult
      }
      if (!task.delivery) {
        const result = await verifyCommit(project, operationValidation)
        if (!result) return
        const pushed = await repository.push({ task, project, signal, result })
        delete task.operationCheckpoint
        task.work.pushedCommit = pushed.commit
        task.result.remote = pushed.remote
        task.delivery = { requirementVersion: task.requirementVersion, planVersion: task.planVersion }
        persist('verifying')
      }
      const merged = await repository.integrate({ task, project, signal, result: task.result, savedCandidate: task.delivery.candidate,
        recordCandidate(candidate) {
          task.delivery.candidate = candidate
          if (task.mergeResult?.commit !== candidate.commit) delete task.mergeResult
          persist('verifying')
        }, verifyCandidate: candidate => verifyCommit(project, operationValidation, candidate) })
      if (!merged) return
      if (task.mergeResult?.commit !== merged.commit) delete task.mergeResult
      task.result.merged = merged
      delete task.operationCheckpoint
      task.attempt.status = 'completed'
      task.attempt.finishedAt ??= Date.now()
      persist('delivered')
    } catch (error) {
      flushOutput()
      if (!running.signal.aborted) {
        if (task.attempt?.status === 'running') {
          task.attempt.status = 'error'
          task.attempt.finishedAt = Date.now()
        }
        if (task.stage === 'verifying' && task.operationCheckpoint?.stepStartedAt) {
          task.operationCheckpoint.finishedAt = Date.now()
          task.operationCheckpoint.stepElapsedMs = Math.max(0, task.operationCheckpoint.finishedAt - task.operationCheckpoint.stepStartedAt)
        }
        task.failedStage = task.stage
        task.error = error instanceof Error ? error.message.slice(0, 600) : '执行失败。'
        persist('blocked', true)
      }
    } finally {
      clearInterval(heartbeat)
      clearTimeout(verificationTimer)
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

  return { onMessage, onAction, attachmentTarget, attachImage, recover, work, publish, stop: () => controller?.abort() }
}
