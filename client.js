window.__ModuleLoader__.load({
  id: '@local/dsh-feishu-development-agent',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const id = 'feishu-development-agent'
    const namespace = 'feishuDevelopmentAgent'
    const packageName = '@local/dsh-feishu-development-agent'
    const locales = {
      zh: {
        dispatchTab: '调度', channelTab: '渠道配置', appId: 'App ID', userId: '操作人 Open ID', dataDirectory: '数据目录',
        appSecret: 'App Secret', secretSet: '已保存。留空保留现有凭据。', secretUnset: '尚未保存。',
        channelEnabled: '开启飞书长连接', channelSave: '保存配置', channelSaving: '正在保存…', channelSaved: '配置已保存。',
        channelLoad: '正在读取飞书配置…', channelLoadError: '无法读取飞书配置。', channelSaveError: '无法保存飞书配置，请检查应用字段和现有项目配置。',
        channelHint: '使用飞书企业自建应用。开启长连接前，请先在「项目仓库」添加仓库。',
        claudeTab: '模型配置', baseUrl: 'Base URL', apiKey: 'API Key', model: '模型名称',
        claudeSave: '保存模型配置', claudeHint: '只需填写 Anthropic 兼容接口信息，其余 Provider 和委派配置自动沿用。',
        claudeLoad: '正在读取模型配置…', claudeLoadError: '无法读取模型配置，请检查设计 Provider 的 profile。',
        claudeSaveError: '无法保存模型配置，请根据提示重试。',
        projectsTab: '项目仓库', projectName: '项目名称', projectPath: '本地 Git 仓库', projectAliases: '项目别名（逗号分隔）',
        baseBranch: '基线分支', remote: '推送远程', chooseFolder: '选择文件夹', inspectRepo: '读取 Git 配置',
        projectAdd: '添加仓库', projectEdit: '编辑', projectCancel: '取消编辑', projectEmpty: '尚未添加项目仓库。',
        projectLoadError: '读取项目仓库失败。', projectInspectError: '无法读取 Git 仓库，请检查本地路径。',
        projectSaveError: '保存项目仓库失败。', projectHint: '选择已有的 Git 仓库，验证通过后任务分支会推送到选定的远程。',
        projectBusy: '正在处理…', push: '已推送到远程', noRepoRemote: '这个仓库还没有 Git 远程。添加远程后重新读取 Git 配置。', noRepoBranch: '这个仓库还没有可用的本地分支。',
        title: '飞书需求开发', eyebrow: 'FEISHU / DEVELOPMENT', subtitle: '查看需求调度、开发进度与项目配置。', source: '飞书', list: '调度列表',
        loading: '正在读取调度记录…', empty: '暂无调度记录', send: '在飞书发送「开发需求｜项目名」或「修复缺陷｜项目名」，下一行填写需求。',
        unconfigured: '配置飞书应用和数据目录后，调度记录会显示在这里。', error: '读取调度记录失败。',
        refresh: '刷新', settings: '插件详情', detail: '开发过程', noHistory: '暂无阶段记录。',
        requirement: '需求正文', summary: '实现方案', scope: '影响范围', risks: '风险与待澄清事项',
        invocation: '调用详情', startedAt: '开始时间', heartbeat: '插件心跳', waitingResponse: '正在等待模型返回…',
        designOutput: '设计返回', developmentOutput: '开发返回', seconds: '秒',
        modelOutput: '模型输出', modelOutputTruncated: '较早的输出已省略。',
        verification: '验证计划', branch: '分支', commit: '提交', changes: '改动', checks: '验证结果',
        passed: '通过', failed: '失败', run: '委派 ID', note: '返工说明', failure: '阻塞原因',
        deliveryIssue: '飞书卡片发送异常', lastDeliveryError: '最近一次飞书卡片错误', retryAt: '下次重试',
        deliveryFailures: '失败次数', deliveryCode: '飞书错误码', deliveryLogId: '飞书 Log ID',
        delivery_create: '发送卡片', delivery_patch: '更新卡片', delivery_api: '飞书 API 拒绝请求', delivery_http: 'HTTP 请求失败',
        delivery_transport: '连接失败或响应不可识别', delivery_local: '本地处理失败', delivery_missing_message_id: '飞书未返回消息 ID',
        stale: '刷新失败，以下为上次读取的记录。', comments: '方案修改意见',
        confirm: '待补充需求', design_queued: '等待设计', designing: '设计中', approval: '历史待审批', held: '历史暂缓', queued: '等待开发',
        developing: '开发中', verify_queued: '等待验证', verifying: '验证中', blocked: '阻塞', review: '待验收', accepted: '已验收', cancelled: '已取消',
      },
      en: {
        dispatchTab: 'Dispatch', channelTab: 'Channels', appId: 'App ID', userId: 'Operator Open ID', dataDirectory: 'Data directory',
        appSecret: 'App Secret', secretSet: 'Saved. Leave blank to keep the existing credential.', secretUnset: 'No credential saved.',
        channelEnabled: 'Enable Feishu persistent connection', channelSave: 'Save settings', channelSaving: 'Saving…', channelSaved: 'Settings saved.',
        channelLoad: 'Loading Feishu settings…', channelLoadError: 'Could not load Feishu settings.', channelSaveError: 'Could not save Feishu settings. Check the application fields and project configuration.',
        channelHint: 'Use a custom Feishu app. Add a repository under Project repositories before enabling the connection.',
        claudeTab: 'Model', baseUrl: 'Base URL', apiKey: 'API Key', model: 'Model name',
        claudeSave: 'Save model settings', claudeHint: 'Only the Anthropic-compatible connection is required. Provider and delegation settings are preserved automatically.',
        claudeLoad: 'Loading model settings…', claudeLoadError: 'Could not load model settings. Check the design provider profile.',
        claudeSaveError: 'Could not save model settings. Review the message and retry.',
        projectsTab: 'Project repositories', projectName: 'Project name', projectPath: 'Local Git repository', projectAliases: 'Aliases (comma-separated)',
        baseBranch: 'Base branch', remote: 'Push remote', chooseFolder: 'Choose folder', inspectRepo: 'Read Git configuration',
        projectAdd: 'Add repository', projectEdit: 'Edit', projectCancel: 'Cancel editing', projectEmpty: 'No project repositories configured.',
        projectLoadError: 'Could not read project repositories.', projectInspectError: 'Could not read the Git repository. Check its local path.',
        projectSaveError: 'Could not save project repositories.', projectHint: 'Choose an existing Git repository. Verified task branches are pushed to the selected remote.',
        projectBusy: 'Working…', push: 'Pushed to remote', noRepoRemote: 'This repository has no Git remote. Add one and read its Git configuration again.', noRepoBranch: 'This repository has no local branches.',
        title: 'Feishu development', eyebrow: 'FEISHU / DEVELOPMENT', subtitle: 'Track requests, development progress, and project settings.', source: 'Feishu', list: 'Dispatch history',
        loading: 'Loading dispatch records…', empty: 'No dispatch records', send: 'Send “开发需求｜Project name” or “修复缺陷｜Project name” to the Feishu bot, followed by the request on the next line.',
        unconfigured: 'Configure the Feishu application and data directory to see dispatch records here.', error: 'Could not read dispatch records.',
        refresh: 'Refresh', settings: 'Plugin details', detail: 'Development history', noHistory: 'No recorded stages.',
        requirement: 'Request', summary: 'Implementation plan', scope: 'Scope', risks: 'Risks and open questions',
        invocation: 'Invocation details', startedAt: 'Started at', heartbeat: 'Plugin heartbeat', waitingResponse: 'Waiting for the model to respond…',
        designOutput: 'Design response', developmentOutput: 'Development response', seconds: 's',
        modelOutput: 'Model output', modelOutputTruncated: 'Earlier output was trimmed.',
        verification: 'Verification plan', branch: 'Branch', commit: 'Commit', changes: 'Changes', checks: 'Verification results',
        passed: 'Passed', failed: 'Failed', run: 'Delegation ID', note: 'Rework notes', failure: 'Blocker',
        deliveryIssue: 'Feishu card delivery failed', lastDeliveryError: 'Last Feishu card error', retryAt: 'Next retry',
        deliveryFailures: 'Failed attempts', deliveryCode: 'Feishu error code', deliveryLogId: 'Feishu Log ID',
        delivery_create: 'Send card', delivery_patch: 'Update card', delivery_api: 'Feishu API rejected the request', delivery_http: 'HTTP request failed',
        delivery_transport: 'Connection failed or response was unrecognized', delivery_local: 'Local processing failed', delivery_missing_message_id: 'Feishu did not return a message ID',
        stale: 'Refresh failed. Showing previously loaded records.', comments: 'Plan feedback',
        confirm: 'Needs information', design_queued: 'Design queued', designing: 'Designing', approval: 'Legacy approval', held: 'Legacy hold', queued: 'Development queued',
        developing: 'Developing', verify_queued: 'Verification queued', verifying: 'Verifying', blocked: 'Blocked', review: 'Awaiting acceptance', accepted: 'Accepted', cancelled: 'Cancelled',
      },
    }

    const css = `
      .feishu-development-panel { --fd-surface: var(--dsw-alias-bg-layer-1, #fff); --fd-border: var(--dsw-alias-border-l2, #e5eaf2); --fd-blue: var(--dsw-alias-state-business-primary, #5279df); box-sizing: border-box; height: 100%; min-height: 0; overflow: hidden; padding: clamp(16px, 3vw, 32px) clamp(16px, 4vw, 48px) 0; color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--fd-surface) 96%, var(--fd-blue)); }
      .feishu-development-panel *, .feishu-development-panel *::before, .feishu-development-panel *::after { box-sizing: border-box; }
      .feishu-development-content { max-width: 1440px; height: 100%; min-height: 0; margin: 0 auto; display: flex; flex-direction: column; container-type: inline-size; }
      .feishu-development-body { min-height: 0; flex: 1; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; padding: 6px 2px 28px; }
      .feishu-development-body.is-dispatch { overflow: hidden; padding-bottom: 20px; }
      .feishu-development-panel h1 { margin: 0; font-size: clamp(24px, 2.5vw, 32px); line-height: 1.2; font-weight: 700; letter-spacing: -.025em; }
      .feishu-development-panel h2 { margin: 0; font-size: 18px; line-height: 1.35; font-weight: 650; }
      .feishu-development-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
      .feishu-development-hero { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; min-width: 0; padding: 4px 0 22px; }
      .feishu-development-hero-title { display: flex; align-items: center; gap: 18px; min-width: 0; }
      .feishu-development-hero-icon { width: 58px; height: 58px; flex: none; display: grid; place-items: center; color: #fff; background: var(--fd-blue); border-radius: 16px; box-shadow: 0 8px 20px color-mix(in srgb, var(--fd-blue) 22%, transparent); }
      .feishu-development-hero-icon svg { width: 28px; height: 28px; }
      .feishu-development-eyebrow { margin: 0 0 5px; color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 700; letter-spacing: .1em; }
      .feishu-development-subtitle { margin: 6px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
      .feishu-development-list { list-style: none; margin: 14px 0 0; padding: 0; }
      .feishu-development-row { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; padding: 14px; border: 1px solid var(--fd-border); border-radius: 12px; margin: 0 0 10px; background: var(--fd-surface); transition: background-color .18s ease, border-color .18s ease, box-shadow .18s ease; }
      .feishu-development-row[aria-current='true'], .feishu-development-panel button.feishu-development-row[aria-current='true']:hover { background: color-mix(in srgb, var(--fd-surface) 92%, var(--fd-blue)); border-color: var(--fd-blue); box-shadow: inset 3px 0 var(--fd-blue); }
      .feishu-development-row-title, .feishu-development-row strong { display: block; overflow-wrap: anywhere; font-weight: 650; }
      .feishu-development-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
      .feishu-development-panel button { font: inherit; color: inherit; background: transparent; cursor: pointer; }
      .feishu-development-button { min-height: 36px; padding: 7px 14px; border: 1px solid var(--fd-border); border-radius: 9px; background: var(--fd-surface) !important; font-weight: 600 !important; transition: background-color .18s ease, border-color .18s ease, box-shadow .18s ease; }
      .feishu-development-button-primary { color: #fff !important; background: var(--fd-blue) !important; border-color: var(--fd-blue); box-shadow: 0 4px 12px color-mix(in srgb, var(--fd-blue) 18%, transparent); }
      .feishu-development-panel button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .feishu-development-panel button.feishu-development-row:not([aria-current='true']):hover { background: color-mix(in srgb, var(--fd-surface) 95%, var(--fd-blue)); border-color: var(--fd-blue); }
      .feishu-development-button:hover { background: color-mix(in srgb, var(--fd-surface) 90%, var(--fd-blue)) !important; }
      .feishu-development-button-primary:hover { background: color-mix(in srgb, var(--fd-blue) 86%, #000) !important; }
      .feishu-development-panel :is(button, input, select, summary):focus-visible { outline: 2px solid var(--fd-blue); outline-offset: 2px; }
      .feishu-development-tabpanel { height: 100%; min-height: 0; }
      .feishu-development-dispatch { display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); gap: 20px; height: 100%; min-height: 0; animation: feishu-development-enter .2s ease-out; }
      .feishu-development-tasks, .feishu-development-output { min-width: 0; min-height: 0; padding: 22px; background: var(--fd-surface); border: 1px solid var(--fd-border); border-radius: 14px; box-shadow: 0 5px 18px color-mix(in srgb, var(--dsw-alias-label-primary, #233047) 4%, transparent); }
      .feishu-development-tasks { display: flex; flex-direction: column; }
      .feishu-development-output { overflow: auto; scrollbar-gutter: stable; }
      .feishu-development-output-heading { margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--fd-border); }
      .feishu-development-output-heading h2 { margin-bottom: 7px; overflow-wrap: anywhere; }
      .feishu-development-output-heading p { margin: 0; }
      .feishu-development-task-list { min-height: 0; flex: 1; overflow: auto; scrollbar-gutter: stable; }
      .feishu-development-task-list .feishu-development-row { display: grid; gap: 6px; }
      .feishu-development-task-list .feishu-development-row:focus-visible { outline-offset: -2px; }
      .feishu-development-output details > summary { cursor: pointer; font-weight: 600; }
      .feishu-development-output details { margin: 14px 0; padding: 12px 14px; border: 1px solid var(--fd-border); border-radius: 10px; }
      .feishu-development-output details[open] { animation: feishu-development-enter .18s ease-out; }
      .feishu-development-response { margin-top: 10px; padding: 2px 14px; border-left: 2px solid var(--dsw-alias-state-business-primary); max-width: 72ch; }
      .feishu-development-stream { max-height: 22rem; overflow: auto; padding: 8px 4px; }
      .feishu-development-stream pre { margin: 0; font: inherit; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
      .feishu-development-timeline { list-style: none; margin: 20px 0 0 5px; padding: 0 0 0 20px; border-left: 1px solid var(--fd-border); }
      .feishu-development-timeline > li { position: relative; padding: 0 0 24px 10px; overflow-wrap: anywhere; }
      .feishu-development-timeline > li::before { content: ''; position: absolute; left: -20px; top: .4em; width: 9px; height: 9px; border-radius: 50%; background: var(--stage-color, var(--dsw-alias-label-secondary)); }
      .feishu-development-timeline > li:last-child { padding: 12px; border: 1px solid var(--fd-border); border-radius: 10px; background: color-mix(in srgb, var(--fd-surface) 96%, var(--fd-blue)); }
      .feishu-development-timeline > li:last-child::before { left: -28px; top: 16px; box-shadow: 0 0 0 4px var(--fd-surface); }
      .feishu-development-row[data-stage], .feishu-development-output[data-stage], .feishu-development-timeline > li[data-stage] { --stage-color: var(--dsw-alias-label-secondary); }
      .feishu-development-row[data-stage='designing'], .feishu-development-row[data-stage='developing'], .feishu-development-row[data-stage='verifying'], .feishu-development-output[data-stage='designing'], .feishu-development-output[data-stage='developing'], .feishu-development-output[data-stage='verifying'], .feishu-development-timeline > li[data-stage='designing'], .feishu-development-timeline > li[data-stage='developing'], .feishu-development-timeline > li[data-stage='verifying'] { --stage-color: var(--fd-blue); }
      .feishu-development-row[data-stage='blocked'], .feishu-development-output[data-stage='blocked'], .feishu-development-timeline > li[data-stage='blocked'] { --stage-color: var(--dsw-alias-state-error, #b5474e); }
      .feishu-development-row[data-stage='accepted'], .feishu-development-output[data-stage='accepted'], .feishu-development-timeline > li[data-stage='accepted'] { --stage-color: var(--dsw-alias-state-success, #14805c); }
      .feishu-development-status { display: inline-flex; align-items: center; width: fit-content; padding: 3px 8px; border-radius: 6px; color: var(--stage-color, var(--dsw-alias-label-secondary)); background: color-mix(in srgb, var(--fd-surface) 88%, var(--stage-color, var(--dsw-alias-label-secondary))); font-size: 12px; font-weight: 700; }
      .feishu-development-detail-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
      .feishu-development-field { display: grid; gap: 3px; margin: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .feishu-development-field strong { font-size: 12px; }
      .feishu-development-panel p { line-height: 1.6; }
      .feishu-development-tabs { display: flex; gap: 20px; flex: none; overflow-x: auto; border-bottom: 1px solid var(--fd-border); margin: 0 0 18px; }
      .feishu-development-tabs button { flex: none; padding: 13px 4px 12px; border: 0; border-bottom: 3px solid transparent; color: var(--dsw-alias-label-secondary); font-weight: 600; transition: color .18s ease, border-color .18s ease; }
      .feishu-development-tabs button[aria-selected='true'] { color: var(--fd-blue); border-bottom-color: var(--fd-blue); }
      .feishu-development-tabs button:hover { background: transparent; color: var(--fd-blue); }
      .feishu-development-tabpanel { animation: feishu-development-enter .2s ease-out; }
      @keyframes feishu-development-enter { from { opacity: .65; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      @media (prefers-reduced-motion: reduce) { .feishu-development-panel *, .feishu-development-panel *::before, .feishu-development-panel *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
      .feishu-development-settings { max-width: 960px; min-height: 100%; padding: clamp(18px, 3vw, 32px); background: var(--fd-surface); border: 1px solid var(--fd-border); border-radius: 14px; box-shadow: 0 5px 18px color-mix(in srgb, var(--dsw-alias-label-primary, #233047) 4%, transparent); }
      .feishu-development-settings > h2 { margin-bottom: 6px; }
      .feishu-development-settings > .feishu-development-meta { margin: 0 0 24px; }
      .feishu-development-form { max-width: 620px; display: grid; gap: 18px; margin: 20px 0; }
      .feishu-development-form label { display: grid; gap: 7px; min-width: 0; font-weight: 600; }
      .feishu-development-form select, .feishu-development-form input:not([type='checkbox']) { width: 100%; min-height: 40px; font: inherit; font-weight: 400; color: inherit; background: var(--fd-surface); border: 1px solid var(--dsw-alias-border-l3, var(--fd-border)); border-radius: 9px; padding: 9px 12px; min-width: 0; }
      .feishu-development-form-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .feishu-development-form button[type='submit'] { color: #fff !important; background: var(--fd-blue) !important; border-color: var(--fd-blue); }
      .feishu-development-form button[type='submit']:hover { background: color-mix(in srgb, var(--fd-blue) 86%, #000) !important; }
      .feishu-development-form label.feishu-development-toggle { display: flex; align-items: center; }
      .feishu-development-form button:disabled { opacity: .6; cursor: default; }
      @container (max-width: 680px) {
        .feishu-development-body.is-dispatch { overflow-y: auto; }
        .feishu-development-tabpanel, .feishu-development-dispatch { height: auto; }
        .feishu-development-dispatch { grid-template-columns: minmax(0, 1fr); gap: 16px; }
        .feishu-development-task-list { max-height: 35vh; flex: none; }
        .feishu-development-output { overflow: visible; }
      }
      @container (max-width: 420px) {
        .feishu-development-hero-title { gap: 11px; }
        .feishu-development-hero-icon { width: 44px; height: 44px; border-radius: 12px; }
        .feishu-development-hero-icon svg { width: 23px; height: 23px; }
        .feishu-development-tabs { gap: 14px; }
        .feishu-development-tasks, .feishu-development-output { padding: 16px; }
        .feishu-development-row { flex-wrap: wrap; }
      }
    `

    function Icon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7l-5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm5 5-2 2 2 2m4-4 2 2-2 2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function Field({ label, value }) {
      if (value == null || value === '') return null
      return h('div', { className: 'feishu-development-field' }, h('strong', null, label), h('span', null, value))
    }

    function time(value) {
      if (value == null) return ''
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
    }

    function elapsed(attempt, t, running) {
      if (!attempt?.startedAt) return ''
      const end = attempt.finishedAt ?? (running ? Date.now() : attempt.heartbeatAt ?? attempt.startedAt)
      return `${Math.max(0, Math.round((end - attempt.startedAt) / 1000))} ${t('seconds')}`
    }

    function ModelOutput({ output, latest, t }) {
      const scroll = useRef(null)
      const follow = useRef(true)
      useEffect(() => {
        if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
      }, [output.text, latest])
      return h('details', { className: 'feishu-development-response', open: latest },
        h('summary', null, t('modelOutput')),
        output.truncated && h('div', { className: 'feishu-development-meta' }, t('modelOutputTruncated')),
        h('div', {
          ref: scroll, className: 'feishu-development-stream', role: 'region', tabIndex: 0, 'aria-label': t('modelOutput'),
          onScroll(event) {
            const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
            if (clientHeight) follow.current = scrollHeight - scrollTop - clientHeight < 24
          },
        }, h('pre', null, output.text)))
    }

    function Timeline({ entries, activeAttemptId, modelOutputs = {}, t }) {
      if (!entries.length) return h('p', null, t('noHistory'))
      const calls = new Map()
      for (const { attempt } of entries) {
        if (attempt?.id && attempt.kind !== 'verifying') calls.set(attempt.id, attempt)
      }
      const latestCall = [...calls.keys()].at(-1)
      return h('ol', { className: 'feishu-development-timeline' }, entries.map((entry, index) => {
        const previous = entries[index - 1]
        const field = (label, value) => h(Field, { key: label, label: t(label), value })
        const changed = key => JSON.stringify(entry[key]) !== JSON.stringify(previous?.[key])
        const newAttempt = entry.attempt?.id !== previous?.attempt?.id
        const call = newAttempt ? calls.get(entry.attempt?.id) : null
        const running = call?.status === 'running' && call.id === activeAttemptId
        const output = call && modelOutputs[call.id]
        const plan = changed('planVersion') || changed('plan') ? entry.plan : null
        const development = newAttempt || changed('development') ? entry.development : null
        const result = changed('result') ? entry.result : null
        const failure = entry.stage === 'blocked' && (previous?.stage !== 'blocked' || changed('error')) ? entry.error : null
        const comment = changed('comments') && entry.comments?.at(-1)
        const rework = changed('rework') && entry.rework
        if (entry.stage === previous?.stage && !call && !plan && !development && !result && !failure && !comment && !rework) return null

        return h('li', { key: entry.revision, 'data-stage': entry.stage },
          h('strong', { className: 'feishu-development-status' }, t(entry.stage)), ' ', h('time', { className: 'feishu-development-meta' }, time(entry.recordedAt)),
          call && h('div', null,
            h('div', { className: 'feishu-development-meta' }, [call.provider, elapsed(call, t, running)].filter(Boolean).join(' · ')),
            running && call.childId && !output && h('p', { role: 'status' }, t('waitingResponse')),
            (call.childId || call.heartbeatAt) && h('details', null, h('summary', null, t('invocation')),
              field('run', call.childId), field('startedAt', time(call.startedAt)),
              running && field('heartbeat', time(call.heartbeatAt))),
            output && h(ModelOutput, { output, latest: call.id === latestCall, t })),
          field('comments', comment || null), field('note', rework || null), field('failure', failure),
          plan && h('div', { className: 'feishu-development-response' },
            h('strong', null, t('designOutput')), field('summary', plan.summary), field('scope', plan.scope),
            field('risks', plan.risks), field('verification', plan.verification)),
          development && h('div', { className: 'feishu-development-response' }, field('developmentOutput', development.summary)),
          result && [field('branch', result.branch), field('commit', result.commit), field('push', result.remote && `${result.remote}/${result.branch}`), field('changes', result.changes), field('checks', result.checks?.map(check => `${t(check.passed ? 'passed' : 'failed')} · ${check.label}${check.output ? `\n${check.output}` : ''}`).join('\n'))])
      }))
    }

    function TaskDetail({ row, t, loadDetail, listRefresh }) {
      const [state, setState] = useState({ loading: true })
      const [version, refresh] = useState(0)
      const polling = ['design_queued', 'designing', 'queued', 'developing'].includes(row.stage)
      useEffect(() => {
        let current = true
        let pending = false
        async function read() {
          if (pending) return
          pending = true
          try {
            const value = await loadDetail(row.id)
            if (current) setState({ value })
          } catch {
            if (current) setState(previous => ({ ...previous, loading: false, error: true }))
          } finally {
            pending = false
          }
        }
        void read()
        const timer = polling ? setInterval(read, 1500) : undefined
        return () => { current = false; clearInterval(timer) }
      }, [loadDetail, row.id, row.revision, row.deliveryFailures, row.attempt?.heartbeatAt, polling, version, listRefresh])
      const detail = state.value
      const delivery = detail?.delivery
      const lastError = delivery?.lastError
      const history = detail?.history ?? []
      const current = history.at(-1)
      const activeAttemptId = ['designing', 'developing'].includes(current?.stage) ? current.attempt?.id : undefined
      return h('section', { id: `${id}-output`, className: 'feishu-development-output', 'data-stage': row.stage, 'aria-labelledby': `${id}-output-title` },
        h('div', { className: 'feishu-development-output-heading' },
          h('h2', { id: `${id}-output-title` }, row.summary || t('detail')),
          h('div', { className: 'feishu-development-detail-meta' },
            h('span', { className: 'feishu-development-meta' }, [row.project, row.id].filter(Boolean).join(' · ')),
            h('span', { className: 'feishu-development-status' }, t(row.stage)))),
        state.loading && !detail && h('p', { role: 'status' }, t('loading')),
        state.error && h('p', { role: 'alert' }, t('error'), ' ', h('button', {
          className: 'feishu-development-button', type: 'button',
          onClick: () => { setState(previous => ({ ...previous, loading: true, error: false })); refresh(value => value + 1) },
        }, t('refresh'))),
        detail && h('div', null,
          detail.requirement?.body && h('details', null, h('summary', null, t('requirement')),
            h('div', { className: 'feishu-development-field' }, detail.requirement.body)),
          delivery?.failures > 0 && h('p', { role: 'status' }, `${t('deliveryIssue')} · ${t('deliveryFailures')} ${delivery.failures} · ${t('retryAt')} ${time(delivery.retryAt)}`),
          lastError && h('section', null,
            h('h3', null, t('lastDeliveryError')),
            h('p', null, [t(`delivery_${lastError.operation}`), t(`delivery_${lastError.kind}`), time(lastError.recordedAt)].filter(Boolean).join(' · ')),
            h(Field, { label: t('deliveryCode'), value: lastError.code }),
            h(Field, { label: 'HTTP', value: lastError.httpStatus }),
            h(Field, { label: t('deliveryLogId'), value: lastError.logId })),
          h(Timeline, { entries: history, activeAttemptId, modelOutputs: detail.modelOutputs, t })))
    }

    function ChannelSettings({ t, loadChannel, saveChannel, hidden }) {
      const [draft, setDraft] = useState(null)
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      const [reload, setReload] = useState(0)
      useEffect(() => {
        if (hidden || draft) return
        let current = true
        loadChannel().then(value => {
          if (current) setDraft({ ...value, appSecret: '' })
        }, () => {
          if (current) setMessage({ error: true, key: 'channelLoadError' })
        })
        return () => { current = false }
      }, [loadChannel, reload, hidden, draft])

      async function submit(event) {
        event.preventDefault()
        if (busy || !draft) return
        setBusy(true)
        setMessage(null)
        try {
          const { appId, userId, dataDirectory, enabled, appSecret } = draft
          const saved = await saveChannel({ appId, userId, dataDirectory, enabled, ...(appSecret ? { appSecret } : {}) })
          setDraft({ ...saved, appSecret: '' })
          setMessage({ key: 'channelSaved' })
        } catch (error) {
          if (error.code === 'feishu-channel/partial-save') {
            setDraft(value => ({ ...value, appSecret: '', secretConfigured: true }))
          }
          setMessage({ error: true, key: 'channelSaveError', reason: error.safeReason })
        } finally {
          setBusy(false)
        }
      }

      const change = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
      const field = (key, options = {}) => h('label', { key }, t(key), h('input', {
        value: draft[key] ?? '', disabled: busy, onChange: event => change(key, event.target.value), ...options,
      }))
      return h('section', { hidden, className: 'feishu-development-settings', role: 'tabpanel', id: `${id}-channel-panel`, 'aria-labelledby': `${id}-channel-tab` },
        h('h2', null, t('source')),
        h('p', { className: 'feishu-development-meta' }, t('channelHint')),
        !draft && !message && h('p', { role: 'status' }, t('channelLoad')),
        draft && h('form', { className: 'feishu-development-form', onSubmit: submit },
          field('appId', { spellCheck: false, autoComplete: 'off', placeholder: 'cli_…' }),
          field('appSecret', { type: 'password', autoComplete: 'new-password', 'aria-describedby': `${id}-secret-status` }),
          h('span', { id: `${id}-secret-status`, className: 'feishu-development-meta' }, t(draft.secretConfigured ? 'secretSet' : 'secretUnset')),
          field('userId', { spellCheck: false, autoComplete: 'off', placeholder: 'ou_…' }),
          field('dataDirectory', { spellCheck: false, autoComplete: 'off' }),
          h('label', { className: 'feishu-development-toggle' }, h('input', {
            type: 'checkbox', checked: Boolean(draft.enabled), disabled: busy, onChange: event => change('enabled', event.target.checked),
          }), t('channelEnabled')),
          h('div', { className: 'feishu-development-form-actions' }, h('button', { type: 'submit', disabled: busy, className: 'feishu-development-button feishu-development-button-primary' }, t(busy ? 'channelSaving' : 'channelSave')))),
        message && h('p', { role: message.error ? 'alert' : 'status' }, message.reason || t(message.key)),
        !draft && message && h('button', { className: 'feishu-development-button', type: 'button', onClick: () => { setMessage(null); setReload(value => value + 1) } }, t('refresh')))
    }

    function ClaudeSettings({ t, loadClaude, saveClaude, hidden }) {
      const [draft, setDraft] = useState(null)
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      const [reload, setReload] = useState(0)
      useEffect(() => {
        if (hidden || draft) return
        let current = true
        loadClaude().then(value => {
          if (current) setDraft({ ...value, apiKey: '' })
        }, () => {
          if (current) setMessage({ error: true, key: 'claudeLoadError' })
        })
        return () => { current = false }
      }, [loadClaude, reload, hidden, draft])

      async function submit(event) {
        event.preventDefault()
        if (busy || !draft) return
        setBusy(true)
        setMessage(null)
        try {
          const saved = await saveClaude({
            baseUrl: draft.baseUrl, model: draft.model, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
          })
          setDraft({ ...saved, apiKey: '' })
          setMessage({ key: 'channelSaved' })
        } catch (error) {
          setMessage({ error: true, key: 'claudeSaveError', reason: error.safeReason })
        } finally {
          setBusy(false)
        }
      }

      const change = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
      const field = (key, options = {}) => h('label', { key }, t(key), h('input', {
        required: true, value: draft[key] ?? '', disabled: busy, onChange: event => change(key, event.target.value), ...options,
      }))
      return h('section', { hidden, className: 'feishu-development-settings', role: 'tabpanel', id: `${id}-claude-panel`, 'aria-labelledby': `${id}-claude-tab` },
        h('h2', null, t('claudeTab')),
        h('p', { className: 'feishu-development-meta' }, t('claudeHint')),
        !draft && !message && h('p', { role: 'status' }, t('claudeLoad')),
        draft && h('form', { className: 'feishu-development-form', onSubmit: submit },
          field('baseUrl', { spellCheck: false, inputMode: 'url', placeholder: 'https://…/anthropic' }),
          field('model', { spellCheck: false }),
          field('apiKey', { required: false, type: 'password', autoComplete: 'new-password', spellCheck: false }),
          h('span', { className: 'feishu-development-meta' }, t(draft.apiKeyConfigured ? 'secretSet' : 'secretUnset')),
          h('div', { className: 'feishu-development-form-actions' }, h('button', { type: 'submit', disabled: busy, className: 'feishu-development-button feishu-development-button-primary' }, t(busy ? 'channelSaving' : 'claudeSave')))),
        message && h('p', { role: message.error ? 'alert' : 'status' }, message.reason || t(message.key)),
        !draft && message && h('button', { className: 'feishu-development-button', type: 'button', onClick: () => { setMessage(null); setReload(value => value + 1) } }, t('refresh')))
    }

    function ProjectSettings({ t, hidden, projectApi }) {
      const [projects, setProjects] = useState(null)
      const [editor, setEditor] = useState(null)
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      const [reload, setReload] = useState(0)
      const [path, setPath] = useState('')
      const button = (label, props) => h('button', { type: 'button', className: 'feishu-development-button', disabled: busy, ...props }, t(label))

      useEffect(() => {
        if (hidden || projects) return
        let current = true
        projectApi.read().then(value => {
          if (current) setProjects(value.projects)
        }, () => {
          if (current) setMessage({ key: 'projectLoadError', error: true })
        })
        return () => { current = false }
      }, [hidden, projectApi, projects, reload])

      async function perform(key, action) {
        setBusy(true)
        setMessage(null)
        try {
          await action()
        } catch (error) {
          setMessage({ key, error: true, reason: error.safeReason })
        } finally {
          setBusy(false)
        }
      }

      async function inspect(folder, existing, index = -1) {
        const repo = await projectApi.inspect(folder)
        const branch = existing?.baseBranch ?? repo.baseBranch
        const remoteName = existing?.remote ?? repo.remote
        const baseBranch = repo.branches.includes(branch) ? branch : repo.branches[0] ?? ''
        const remote = repo.remotes.includes(remoteName) ? remoteName : repo.remotes[0] ?? ''
        setPath(repo.path)
        setEditor({ index, repo, project: { ...existing, path: repo.path, name: existing?.name ?? repo.name, baseBranch, remote, checks: existing?.checks ?? [] }, aliases: (existing?.aliases ?? []).join(', ') })
      }

      function submit(event) {
        event.preventDefault()
        if (!editor || busy) return
        const { index, project, aliases } = editor
        const next = { ...project, name: project.name.trim(), aliases: aliases.split(/[,，]/u).map(alias => alias.trim()).filter(Boolean) }
        const items = index < 0 ? [...projects, next] : projects.map((item, position) => position === index ? next : item)
        void perform('projectSaveError', async () => {
          const saved = await projectApi.save(items)
          setProjects(saved.projects)
          setEditor(null)
          setPath('')
          setMessage({ key: 'channelSaved' })
        })
      }

      const change = (key, value) => setEditor(previous => ({ ...previous, project: { ...previous.project, [key]: value } }))
      const select = (key, options) => h('label', null, t(key), h('select', {
        required: true, value: editor.project[key] ?? '', disabled: busy, onChange: event => change(key, event.target.value),
      }, h('option', { value: '', disabled: true }, '—'), options.map(option => h('option', { key: option, value: option }, option))))
      return h('section', { hidden, className: 'feishu-development-settings', role: 'tabpanel', id: `${id}-projects-panel`, 'aria-labelledby': `${id}-projects-tab` },
        h('h2', null, t('projectsTab')),
        h('p', { className: 'feishu-development-meta' }, t('projectHint')),
        !projects && !message && h('p', { role: 'status' }, t('projectBusy')),
        !projects && message && button('refresh', { onClick: () => { setMessage(null); setReload(value => value + 1) } }),
        projects && h('div', null,
          !projects.length && h('p', null, t('projectEmpty')),
          h('ul', { className: 'feishu-development-list' }, projects.map((project, index) => h('li', { key: project.name, className: 'feishu-development-row' },
            h('div', { style: { minWidth: 0 } }, h('strong', null, project.name),
              h('div', { className: 'feishu-development-meta', style: { overflowWrap: 'anywhere' } }, [project.path, project.baseBranch, project.remote].filter(Boolean).join(' · '))),
            button('projectEdit', { onClick: () => void perform('projectInspectError', () => inspect(project.path, project, index)) })))),
          !editor && h('form', { className: 'feishu-development-form', onSubmit: event => {
            event.preventDefault()
            if (path.trim() && !busy) void perform('projectInspectError', () => inspect(path.trim()))
          } }, h('label', null, t('projectPath'), h('input', { value: path, disabled: busy, onChange: event => setPath(event.target.value), spellCheck: false })),
          h('div', { className: 'feishu-development-form-actions' }, projectApi.pick && button('chooseFolder', { onClick: () => void perform('projectInspectError', async () => {
            const folder = await projectApi.pick()
            if (folder) await inspect(folder)
          }) }), button('inspectRepo', { type: 'submit', disabled: busy || !path.trim() }))),
          editor && h('form', { className: 'feishu-development-form', onSubmit: submit },
            h(Field, { label: t('projectPath'), value: editor.project.path }),
            h('label', null, t('projectName'), h('input', { required: true, value: editor.project.name, disabled: busy, onChange: event => change('name', event.target.value) })),
            h('label', null, t('projectAliases'), h('input', { value: editor.aliases, disabled: busy, onChange: event => {
              const aliases = event.target.value
              setEditor(previous => ({ ...previous, aliases }))
            } })),
            select('baseBranch', editor.repo.branches), select('remote', editor.repo.remotes),
            !editor.repo.branches.length && h('p', { role: 'status' }, t('noRepoBranch')),
            !editor.repo.remotes.length && h('p', { role: 'status' }, t('noRepoRemote')),
            h('div', { className: 'feishu-development-form-actions' },
              button(editor.index < 0 ? 'projectAdd' : 'channelSave', { type: 'submit', disabled: busy || !editor.project.baseBranch || !editor.project.remote }),
              button('projectCancel', { onClick: () => { setEditor(null); setPath(''); setMessage(null) } })))),
        busy && h('p', { role: 'status' }, t('projectBusy')),
        message && h('p', { role: message.error ? 'alert' : 'status' }, message.reason || t(message.key)))
    }

    const panelTabs = ['dispatch', 'channel', 'claude', 'projects']
    function Panel({ t, loadList, loadDetail, openDetails, loadChannel, saveChannel, loadClaude, saveClaude, projectApi }) {
      const [tab, setTab] = useState('dispatch')
      const tabs = useRef({})
      const body = useRef(null)
      const [state, setState] = useState({ loading: true, items: [] })
      const [selected, select] = useState(null)
      const [refresh, setRefresh] = useState(0)
      useEffect(() => {
        if (tab !== 'dispatch') return
        let current = true
        let pending = false
        async function read() {
          if (pending) return
          pending = true
          try {
            const result = await loadList()
            if (current) setState({ items: result.items, status: result.status })
          } catch {
            if (current) setState(previous => ({ ...previous, loading: false, error: true }))
          } finally {
            pending = false
          }
        }
        void read()
        const timer = setInterval(read, 5000)
        return () => { current = false; clearInterval(timer) }
      }, [loadList, refresh, tab])
      // 切换标签时只重置内容滚动，标题与标签始终留在可见区域。
      function changeTab(next) {
        setTab(next)
        if (body.current) body.current.scrollTop = 0
      }
      // 沿用标签键盘导航并保持焦点在新标签上。
      function handleTabKey(event) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = panelTabs.indexOf(tab)
        const step = event.key === 'ArrowLeft' ? -1 : 1
        const next = event.key === 'Home' ? panelTabs[0] : event.key === 'End' ? panelTabs.at(-1) : panelTabs[(index + step + panelTabs.length) % panelTabs.length]
        changeTab(next)
        tabs.current[next]?.focus()
      }
      const row = state.items.find(item => item.id === selected) ??
        state.items.find(item => ['designing', 'developing', 'verifying'].includes(item.stage)) ?? state.items[0]
      const taskList = h('section', { className: 'feishu-development-tasks', 'aria-labelledby': `${id}-tasks` },
        h('div', { className: 'feishu-development-heading' },
          h('h2', { id: `${id}-tasks` }, t('list')),
          h('button', { className: 'feishu-development-button', type: 'button', onClick: () => setRefresh(value => value + 1) }, t('refresh'))),
        state.loading && h('p', { role: 'status' }, t('loading')),
        state.error && h('p', { role: 'alert' }, t(state.items.length ? 'stale' : 'error')),
        !state.loading && !state.error && !state.items.length && h('div', null,
          h('p', null, t('empty')), h('p', { className: 'feishu-development-meta' }, t(state.status === 'unconfigured' ? 'unconfigured' : 'send'))),
        h('ul', { className: 'feishu-development-list feishu-development-task-list' }, state.items.map(item =>
          h('li', { key: item.id }, h('button', {
            className: 'feishu-development-row', type: 'button',
            'aria-current': row?.id === item.id ? 'true' : undefined,
            'data-stage': item.stage,
            'aria-controls': `${id}-output`,
            onClick: () => select(item.id),
          },
          h('span', { className: 'feishu-development-row-title' }, item.summary || item.id),
          h('span', { className: 'feishu-development-meta' }, item.project && `${item.project} · `,
            h('span', { className: 'feishu-development-status' }, t(item.stage))),
          item.deliveryFailures > 0 && h('span', { className: 'feishu-development-meta' }, t('deliveryIssue')))))))
      return h('main', { className: 'feishu-development-panel', 'aria-labelledby': `${id}-title` },
        h('style', null, css),
        h('div', { className: 'feishu-development-content' },
          h('div', { className: 'feishu-development-hero' },
            h('div', { className: 'feishu-development-hero-title' },
              h('div', { className: 'feishu-development-hero-icon' }, h(Icon)),
              h('div', null,
                h('p', { className: 'feishu-development-eyebrow' }, t('eyebrow')),
                h('h1', { id: `${id}-title` }, t('title')),
                h('p', { className: 'feishu-development-subtitle' }, t('subtitle')))),
            h('button', { className: 'feishu-development-button', type: 'button', onClick: openDetails }, t('settings'))),
          h('div', { className: 'feishu-development-tabs', role: 'tablist', 'aria-label': t('title'), onKeyDown: handleTabKey },
            panelTabs.map(key => h('button', { key, id: `${id}-${key}-tab`, ref: element => { tabs.current[key] = element },
              type: 'button', role: 'tab', 'aria-selected': tab === key, 'aria-controls': `${id}-${key}-panel`, tabIndex: tab === key ? 0 : -1,
              onClick: () => changeTab(key),
            }, t(`${key}Tab`)))),
          h('div', { ref: body, className: `feishu-development-body${tab === 'dispatch' ? ' is-dispatch' : ''}` },
            h(ChannelSettings, { t, loadChannel, saveChannel, hidden: tab !== 'channel' }),
            h(ClaudeSettings, { t, loadClaude, saveClaude, hidden: tab !== 'claude' }),
            h(ProjectSettings, { t, projectApi, hidden: tab !== 'projects' }),
            h('section', {
              className: 'feishu-development-tabpanel', hidden: tab !== 'dispatch', role: 'tabpanel', id: `${id}-dispatch-panel`, 'aria-labelledby': `${id}-dispatch-tab`,
            },
            h('div', { className: 'feishu-development-dispatch' }, taskList,
              row && tab === 'dispatch' && h(TaskDetail, { key: row.id, row, t, loadDetail, listRefresh: refresh }))))))
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, locales))
        const t = ctx.locale.bind(namespace)
        async function call(method, ...args) {
          const result = await ctx.connection.rpc.call('/api', `feishuDispatch/${method}`, args[0] ?? {})
          if (result?.ok) return result.value
          throw new Error('Dispatch data unavailable')
        }
        const loadList = () => call('list')
        const loadDetail = taskId => call('detail', { taskId })
        async function channelCall(method, payload = {}) {
          const result = await ctx.connection.rpc.call('/api', `feishuChannel/${method}`, payload)
          if (result?.ok) return result.value
          const error = new Error('Feishu settings unavailable')
          if (result?.error?.code?.startsWith('feishu-channel/')) {
            error.code = result.error.code
            error.safeReason = result.error.message
          }
          throw error
        }
        const loadChannel = () => channelCall('read')
        const saveChannel = payload => channelCall('save', payload)
        async function claudeCall(method, payload = {}) {
          const result = await ctx.connection.rpc.call('/api', `feishuClaude/${method}`, payload)
          if (result?.ok) return result.value
          const error = new Error('Claude settings unavailable')
          if (result?.error?.code?.startsWith('feishu-claude/')) {
            error.code = result.error.code
            error.safeReason = result.error.message
          }
          throw error
        }
        const loadClaude = () => claudeCall('read')
        const saveClaude = payload => claudeCall('save', payload)
        async function projectCall(method, payload = {}) {
          const result = await ctx.connection.rpc.call('/api', `feishuProjects/${method}`, payload)
          if (result?.ok) return result.value
          const error = new Error('Project settings unavailable')
          if (result?.error?.code?.startsWith('feishu-project')) error.safeReason = result.error.message
          throw error
        }
        const projectApi = {
          read: () => projectCall('read'), inspect: path => projectCall('inspect', { path }), save: projects => projectCall('save', { projects }),
          pick: globalThis.__DSH_DIRECTORY_PICKER__?.pick ? () => globalThis.__DSH_DIRECTORY_PICKER__.pick() :
            ctx.get('uiWorkspace')?.pickDirectory ? () => ctx.get('uiWorkspace').pickDirectory() : null,
        }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: id, locale: namespace,
          inject: () => ({ loadList, loadDetail, loadChannel, saveChannel, loadClaude, saveClaude, projectApi, openDetails: () => ctx.get('pluginNavigation')?.openBundle(packageName) }),
        }, Panel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id, locale: namespace, label: () => t('title'), order: 10,
        }, Icon))
      },
    }
  },
})
