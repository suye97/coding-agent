import { useState } from 'react'
import type { ConfigInput, ProjectConfig, PublicConfig } from '../electron/shared'

export function SettingsDrawer({ config, onClose, onSave }: { config: PublicConfig; onClose: () => void; onSave: (input: ConfigInput) => Promise<void> }) {
  const [form, setForm] = useState<ConfigInput>({ enabled: config.enabled, appId: config.appId, userId: config.userId, dataDirectory: config.dataDirectory, tapdCardSource: config.tapdCardSource ?? { chatId: '', senderId: '', operatorId: '' }, model: { baseUrl: config.model.baseUrl, name: config.model.name }, projects: config.projects })
  const [section, setSection] = useState<'channel' | 'model' | 'projects'>('channel')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const update = (patch: Partial<ConfigInput>) => setForm(current => ({ ...current, ...patch }))
  const updateProject = (index: number, patch: Partial<ProjectConfig>) => update({ projects: form.projects.map((project, position) => position === index ? { ...project, ...patch } : project) })
  const updateCheck = (projectIndex: number, checkIndex: number, patch: Partial<ProjectConfig['checks'][number]>) => {
    const project = form.projects[projectIndex]
    updateProject(projectIndex, { checks: project.checks.map((check, index) => index === checkIndex ? { ...check, ...patch } : check) })
  }
  const addProject = async () => {
    const path = await window.desktop.chooseProject()
    if (!path) return
    try {
      const info = await window.desktop.inspectProject(path)
      update({ projects: [...form.projects, { name: String(info.name ?? ''), path: String(info.path ?? path), aliases: [], baseBranch: String(info.baseBranch ?? 'main'), remote: String(info.remote ?? 'origin'), checks: [] }] })
    } catch { setMessage('请选择本机 Git 仓库的根目录。') }
  }
  const submit = async () => {
    setSaving(true); setMessage('')
    try { await onSave(form); onClose() } catch (error) { setMessage(error instanceof Error ? error.message : '配置保存失败。') } finally { setSaving(false) }
  }
  return <div className="drawer-layer" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <aside className="settings-drawer" role="dialog" aria-modal="true" aria-label="应用设置">
      <header><div><h2>设置</h2><p>渠道、模型与目标仓库</p></div><button className="icon-button" onClick={onClose} aria-label="关闭设置">×</button></header>
      <nav>{([['channel', '飞书渠道'], ['model', '模型'], ['projects', '项目仓库']] as const).map(([id, label]) => <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>{label}</button>)}</nav>
      <div className="settings-body">
        {section === 'channel' && <>
          <label className="toggle-row"><div><strong>接收并处理飞书需求</strong><span>保存后启动长连接；任务在本地持续运行。</span></div><input type="checkbox" checked={form.enabled} onChange={event => update({ enabled: event.target.checked })} /></label>
          <label>App ID<input value={form.appId} onChange={event => update({ appId: event.target.value })} placeholder="cli_…" autoComplete="off" /></label>
          <label>App Secret<input type="password" onChange={event => update({ appSecret: event.target.value })} placeholder={config.appSecretConfigured ? '已保存，留空保持不变' : '输入飞书应用密钥'} autoComplete="new-password" /></label>
          <label>操作人 Open ID<textarea value={form.userId} onChange={event => update({ userId: event.target.value })} placeholder="ou_…；多个 ID 用英文逗号分隔" /></label>
          <label>本地数据目录<input value={form.dataDirectory} onChange={event => update({ dataDirectory: event.target.value })} placeholder="留空使用应用数据目录" /></label>
          <details className="tapd-settings"><summary>TAPD 群卡片来源（可选）</summary>
            <p className="form-note">只让指定群中的指定机器人卡片创建任务，操作人必须是真人 Open ID。</p>
            {config.lastGroupCard && <button className="secondary source-fill" onClick={() => update({ tapdCardSource: { chatId: config.lastGroupCard!.chatId, senderId: config.lastGroupCard!.senderId, operatorId: form.tapdCardSource?.operatorId ?? '' } })}>填入最近收到的群卡片来源</button>}
            <label>群 ID<input value={form.tapdCardSource?.chatId ?? ''} onChange={event => update({ tapdCardSource: { ...form.tapdCardSource!, chatId: event.target.value } })} placeholder="oc_…" /></label>
            <label>机器人发送方 ID<input value={form.tapdCardSource?.senderId ?? ''} onChange={event => update({ tapdCardSource: { ...form.tapdCardSource!, senderId: event.target.value } })} /></label>
            <label>任务操作人 Open ID<input value={form.tapdCardSource?.operatorId ?? ''} onChange={event => update({ tapdCardSource: { ...form.tapdCardSource!, operatorId: event.target.value } })} placeholder="ou_…" /></label>
          </details>
          <p className="form-note">密钥由操作系统加密保存，不会出现在任务记录或模型输出中。</p>
        </>}
        {section === 'model' && <>
          <div className="settings-intro"><h3>Claude Agent SDK</h3><p>应用直接启动独立 Agent 进程。Base URL 需要与 Anthropic API 兼容。</p></div>
          <label>Base URL<input value={form.model.baseUrl} onChange={event => update({ model: { ...form.model, baseUrl: event.target.value } })} placeholder="https://api.anthropic.com" autoComplete="off" /></label>
          <label>模型名称<input value={form.model.name} onChange={event => update({ model: { ...form.model, name: event.target.value } })} placeholder="claude-opus-5-5" autoComplete="off" /></label>
          <label>API Key<input type="password" onChange={event => update({ model: { ...form.model, apiKey: event.target.value } })} placeholder={config.model.apiKeyConfigured ? '已保存，留空保持不变' : '输入模型服务密钥'} autoComplete="new-password" /></label>
          <p className="form-note">设计阶段使用只读权限，开发和验证在任务独立 worktree 中运行。</p>
        </>}
        {section === 'projects' && <>
          <div className="project-heading"><p>项目名用于匹配飞书需求，基线分支用于创建任务 worktree。</p><button className="secondary" onClick={addProject}>添加仓库</button></div>
          {!form.projects.length && <div className="settings-empty">尚未添加项目仓库。</div>}
          {form.projects.map((project, index) => <div className="project-editor" key={`${project.path}-${index}`}>
            <div className="project-editor-top"><strong>{project.name || '新项目'}</strong><button onClick={() => update({ projects: form.projects.filter((_, position) => position !== index) })}>移除</button></div>
            <label>项目名称<input value={project.name} onChange={event => updateProject(index, { name: event.target.value })} /></label>
            <label>别名<small>用英文逗号分隔</small><input value={project.aliases.join(',')} onChange={event => updateProject(index, { aliases: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })} /></label>
            <label>仓库路径<input value={project.path} onChange={event => updateProject(index, { path: event.target.value })} /></label>
            <div className="field-row"><label>基线分支<input value={project.baseBranch} onChange={event => updateProject(index, { baseBranch: event.target.value })} /></label><label>远程<input value={project.remote} onChange={event => updateProject(index, { remote: event.target.value })} /></label></div>
            <div className="checks-editor"><div className="project-editor-top"><strong>固定项目检查</strong><button onClick={() => updateProject(index, { checks: [...project.checks, { label: '回归检查', kind: 'command', command: 'node', args: [], timeoutMs: 120000 }] })}>添加检查</button></div>
              {project.checks.map((check, checkIndex) => <div className="check-editor" key={checkIndex}>
                <div className="field-row"><label>检查名称<input value={check.label} onChange={event => updateCheck(index, checkIndex, { label: event.target.value })} /></label><label>类型<select value={check.kind ?? 'command'} onChange={event => updateCheck(index, checkIndex, { kind: event.target.value as 'command' | 'operation' })}><option value="command">固定命令</option><option value="operation">操作证据</option></select></label></div>
                <label>可执行文件<input value={check.command} onChange={event => updateCheck(index, checkIndex, { command: event.target.value })} /></label>
                <label>参数<small>每行一个，不经过 shell</small><textarea value={check.args.join('\n')} onChange={event => updateCheck(index, checkIndex, { args: event.target.value.split(/\r?\n/u).filter(Boolean) })} /></label>
                <label>超时（毫秒）<input type="number" min={1} max={600000} value={check.timeoutMs} onChange={event => updateCheck(index, checkIndex, { timeoutMs: Number(event.target.value) })} /></label>
                <button className="remove-check" onClick={() => updateProject(index, { checks: project.checks.filter((_, position) => position !== checkIndex) })}>移除此检查</button>
              </div>)}
            </div>
          </div>)}
        </>}
      </div>
      <footer><span className="save-message">{message}</span><button className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving} onClick={submit}>{saving ? '正在保存' : '保存设置'}</button></footer>
    </aside>
  </div>
}
