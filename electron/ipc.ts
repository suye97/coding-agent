import { BrowserWindow, ipcMain, dialog } from 'electron'
import { createDispatchHandler } from '../src/dispatch.js'
import { channels } from './shared.js'
import type { ConfigInput, TaskDetail, TaskSummary } from './shared.js'
import type { ConfigStore } from './config.js'
import type { Runtime } from './runtime.js'
import { inspectRepository, validateProjects } from './project.js'

export function registerIpc(config: ConfigStore, runtime: Runtime, window: BrowserWindow) {
  const dispatch = async () => createDispatchHandler(await config.public())
  ipcMain.handle(channels.configRead, event => {
    if (event.sender.id !== window.webContents.id) throw new Error('请求来源无效。')
    return runtime.publicConfig()
  })
  ipcMain.handle(channels.configSave, async (event, input: ConfigInput) => {
    if (event.sender.id !== window.webContents.id) throw new Error('请求来源无效。')
    const projects = await validateProjects(input.projects)
    const result = await config.update({ ...input, projects })
    await runtime.restart()
    return result
  })
  ipcMain.handle(channels.projectInspect, (_event, path: string) => inspectRepository(path))
  ipcMain.handle(channels.projectChoose, async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: '选择 Git 仓库根目录' })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(channels.taskList, async () => {
    const result = await (await dispatch())('feishuDispatch/list', {}, new AbortController().signal, { principal: { kind: 'owner' } }) as
      { ok: true; value: { status: string; items: TaskSummary[] } } | { ok: false; error: { code: string; message: string } }
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  })
  ipcMain.handle(channels.taskDetail, async (_event, taskId: string) => {
    const result = await (await dispatch())('feishuDispatch/detail', { taskId }, new AbortController().signal, { principal: { kind: 'owner' } }) as
      { ok: true; value: TaskDetail } | { ok: false; error: { code: string; message: string } }
    if (!result.ok) {
      if (result.error.code.endsWith('not-found')) return null
      throw new Error(result.error.message)
    }
    return result.value
  })
}
