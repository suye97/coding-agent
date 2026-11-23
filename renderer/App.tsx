import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigInput, ProjectConfig, PublicConfig, TaskDetail, TaskSummary } from '../electron/shared'
import { Icon } from './Icon.js'
import { SettingsDrawer } from './SettingsDrawer.js'

const stages: Record<string, string> = {
  confirm: '待补充', design_queued: '等待设计', designing: '设计中', queued: '等待开发',
  developing: '开发中', verify_queued: '等待验证', verifying: '验证中', blocked: '已阻塞',
  manual_review: '待审批', review: '待验收', accepted: '已验收', cancelled: '已取消',
}
const running = new Set(['design_queued', 'designing', 'queued', 'developing', 'verify_queued', 'verifying'])
const tabs = ['过程', '方案', '验证', '交付'] as const
type Tab = typeof tabs[number]
type HistoryEntry = TaskDetail['history'][number] & {
  plan?: { summary: string; scope: string; risks: string; verification: string }
  result?: { branch?: string; commit?: string; changes?: string; checks?: Array<{ label: string; passed: boolean; output?: string }>; operationEvidence?: { operation?: string; observed?: string; steps?: Array<{ action: string; observed: string }> } }
}

function StageBadge({ stage }: { stage: string }) {
  return <span className={`stage stage-${stage}`}><i />{stages[stage] ?? stage}</span>
}

function TaskList({ items, selected, onSelect }: { items: TaskSummary[]; selected: string; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const filtered = items.filter(item => `${item.summary} ${item.project} ${item.id}`.toLowerCase().includes(query.toLowerCase()))
  return <aside className="task-pane">
    <div className="task-pane-heading"><div><h1>需求交付台</h1><p>从需求到可核验的提交</p></div><span className="task-count">{items.length}</span></div>
    <label className="search"><Icon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务或项目" /></label>
    <div className="section-label"><span>任务队列</span><span>{filtered.length} 项</span></div>
    <div className="task-list">
      {!filtered.length && <div className="empty-list"><span>暂无匹配任务</span><p>飞书收到完整需求后，任务会自动出现在这里。</p></div>}
      {filtered.map(item => <button key={item.id} className={`task-card ${selected === item.id ? 'selected' : ''}`} onClick={() => onSelect(item.id)}>
        <div className="task-card-top"><span className="project-name">{item.project ?? '待匹配项目'}</span><StageBadge stage={item.stage} /></div>
        <strong>{item.summary || '等待补充需求正文'}</strong>
        <div className="task-card-foot"><span>#{item.id}</span><time>{item.recordedAt ? new Date(item.recordedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '刚刚'}</time></div>
        {running.has(item.stage) && <span className="live-line" />}
      </button>)}
    </div>
    <div className="sidebar-foot"><span className="connection-dot" />本地任务数据已持久化</div>
  </aside>
}

function EmptyWorkspace({ onSettings }: { onSettings: () => void }) {
  return <main className="workspace empty-workspace"><div className="empty-symbol"><Icon name="branch" /></div><h2>等待第一项需求</h2><p>在飞书发送“开发需求｜项目名”并附上需求正文。设计、开发和验证会在这里持续更新。</p><button className="primary" onClick={onSettings}><Icon name="settings" />检查渠道与项目配置</button></main>
}

const processKinds: Record<string, string> = { designing: '方案设计', developing: '代码开发', verifying: '交付验证' }
const attemptStatuses: Record<string, string> = { running: '正在运行', completed: '调用完成', error: '执行失败', cancelled: '已取消' }

function ProcessView({ entries, outputs }: { entries: TaskDetail['timeline']; outputs: TaskDetail['modelOutputs'] }) {
  const outputRef = useRef<HTMLPreElement>(null)
  const activeId = entries.find(entry => entry.attempt?.status === 'running')?.attempt?.id
  const activeText = activeId ? outputs[activeId]?.text : undefined
  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }) }, [activeId, activeText])
  if (!entries.length) return <div className="content-empty">任务尚未开始调用模型。进入设计后，这里会显示实际返回的正文。</div>
  return <div className="timeline">{entries.map(({ revision, stage, attempt, error }, index) => {
    const output = attempt ? outputs[attempt.id] : undefined
    const live = attempt?.status === 'running'
    const waitingForModel = live && (stage !== 'verifying' || Boolean(attempt.provider))
    const status = attempt?.stopReason === 'interrupted' ? '已中断' : attempt?.status && (attemptStatuses[attempt.status] ?? '已结束')
    return <article className="run-entry" key={attempt ? `attempt-${attempt.id}` : `stage-${revision}`}>
      <div className="run-marker"><span>{index + 1}</span></div>
      <div className="run-body">
        <header>
          <h3>{processKinds[stage] ?? stages[stage] ?? stage}</h3>
          {status && <span className={`run-status ${attempt?.status}`}>{status}</span>}
        </header>
        {attempt?.provider && <div className="run-meta">执行器 {attempt.provider}{attempt.startedAt ? ` · ${new Date(attempt.startedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</div>}
        {output?.text ? <pre className="model-output" ref={live ? outputRef : undefined}>{output.text}{live && <span className="cursor">▋</span>}</pre> : waitingForModel ? <div className="waiting-output"><i /><i /><i />等待模型正文</div> : null}
        {output?.truncated && <p className="output-note">仅保留本次调用最近的输出片段。</p>}
        {error && (error.current ? <div className="error-box">{error.message}</div> : <details className="historical-error"><summary>查看历史错误</summary><div className="error-box">{error.message}</div></details>)}
      </div>
    </article>
  })}</div>
}

function PlanView({ entry }: { entry: HistoryEntry }) {
  if (!entry.plan) return <div className="content-empty">设计方案生成后，会在这里显示实现范围、风险和验证计划。</div>
  return <div className="document"><section><span className="document-label">实现方案</span><p>{entry.plan.summary}</p></section><div className="document-grid"><section><span className="document-label">影响范围</span><p>{entry.plan.scope}</p></section><section><span className="document-label">风险与约束</span><p>{entry.plan.risks}</p></section></div><section><span className="document-label">验证计划</span><p>{entry.plan.verification}</p></section></div>
}

function ValidationView({ entry }: { entry: HistoryEntry }) {
  const evidence = entry.result?.operationEvidence
  const checks = entry.result?.checks ?? []
  if (!evidence && !checks.length) return <div className="content-empty">固定项目检查和实际操作证据会一起显示，模型自述不能替代验证结果。</div>
  return <div className="document"><section><span className="document-label">固定项目检查</span><div className="check-list">{checks.map(check => <div key={check.label}><span className={check.passed ? 'check-pass' : 'check-fail'}>{check.passed ? '通过' : '失败'}</span><strong>{check.label}</strong></div>)}</div></section>{evidence && <section><span className="document-label">实际操作证据</span><h3>{evidence.operation}</h3><p>{evidence.observed}</p><ol className="evidence-steps">{evidence.steps?.map(step => <li key={step.action}><strong>{step.action}</strong><p>{step.observed}</p></li>)}</ol></section>}</div>
}

function DeliveryView({ entry }: { entry: HistoryEntry }) {
  if (!entry.result) return <div className="content-empty">开发、检查和验证完成后，这里会显示可交付的分支与提交。</div>
  return <div className="document"><section><span className="document-label">交付提交</span><div className="commit-block"><Icon name="branch" /><div><strong>{entry.result.branch ?? '任务分支'}</strong><code>{entry.result.commit ?? '等待提交'}</code></div></div></section><section><span className="document-label">变更摘要</span><pre className="change-summary">{entry.result.changes || '没有文件变更记录'}</pre></section></div>
}

function Workspace({ detail, task }: { detail: TaskDetail | null; task: TaskSummary }) {
  const [tab, setTab] = useState<Tab>('过程')
  const entry = (detail?.history.at(-1) ?? {}) as HistoryEntry
  return <main className="workspace">
    <header className="workspace-head"><div><div className="workspace-kicker"><span>{task.project ?? '未匹配项目'}</span><span>#{task.id}</span></div><h2>{task.summary}</h2></div><StageBadge stage={task.stage} /></header>
    <nav className="workspace-tabs" aria-label="任务详情">{tabs.map(name => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</nav>
    <div className="workspace-content">{tab === '过程' && <ProcessView entries={detail?.timeline ?? []} outputs={detail?.modelOutputs ?? {}} />}{tab === '方案' && <PlanView entry={entry} />}{tab === '验证' && <ValidationView entry={entry} />}{tab === '交付' && <DeliveryView entry={entry} />}</div>
    <footer className="workspace-foot"><span>{detail?.history.length ?? 0} 个任务修订</span><span>显示安全的模型正文与验证摘要</span></footer>
  </main>
}

export function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [selected, setSelected] = useState('')
  const [loadedDetail, setLoadedDetail] = useState<{ taskId: string; value: TaskDetail | null } | null>(null)
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const selectedTask = useMemo(() => tasks.find(task => task.id === selected) ?? tasks[0], [tasks, selected])
  const detail = loadedDetail && loadedDetail.taskId === selectedTask?.id ? loadedDetail.value : null

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const [list, settings] = await Promise.all([window.desktop.listTasks(), window.desktop.getConfig()])
        if (!active) return
        setTasks(list.items); setConfig(settings); setError('')
        setSelected(current => current || list.items[0]?.id || '')
      } catch { if (active) setError('无法读取本地任务数据。请重启应用后再试。') }
    }
    void load()
    const unsubscribe = window.desktop.subscribe(() => { void load() })
    const timer = window.setInterval(() => { void load() }, 5000)
    return () => { active = false; unsubscribe(); clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (!selectedTask) { setLoadedDetail(null); return }
    let active = true
    const taskId = selectedTask.id
    const load = () => window.desktop.getTask(taskId).then(value => { if (active) setLoadedDetail({ taskId, value }) }).catch(() => {})
    void load()
    const timer = running.has(selectedTask.stage) ? window.setInterval(load, 1500) : undefined
    return () => { active = false; if (timer) clearInterval(timer) }
  }, [selectedTask?.id, selectedTask?.stage, selectedTask?.revision])

  const saveConfig = async (input: ConfigInput) => {
    const saved = await window.desktop.saveConfig(input)
    setConfig(saved)
  }
  return <div className="app-shell">
    <TaskList items={tasks} selected={selectedTask?.id ?? ''} onSelect={setSelected} />
    {selectedTask ? <Workspace detail={detail} task={selectedTask} /> : <EmptyWorkspace onSettings={() => setSettingsOpen(true)} />}
    <button className="settings-button" onClick={() => setSettingsOpen(true)} title="设置"><Icon name="settings" /><span>设置</span></button>
    {error && <div className="toast">{error}</div>}
    {settingsOpen && config && <SettingsDrawer config={config} onClose={() => setSettingsOpen(false)} onSave={saveConfig} />}
  </div>
}
