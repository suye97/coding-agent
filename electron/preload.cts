import { contextBridge, ipcRenderer } from 'electron'
import type { ConfigInput, DesktopApi } from './shared.js'

const channels = {
  configRead: 'config:read', configSave: 'config:save', projectInspect: 'project:inspect',
  projectChoose: 'project:choose', taskList: 'task:list', taskDetail: 'task:detail', tasksChanged: 'tasks:changed',
} as const

const api: DesktopApi = {
  getConfig: () => ipcRenderer.invoke(channels.configRead),
  saveConfig: (input: ConfigInput) => ipcRenderer.invoke(channels.configSave, input),
  inspectProject: path => ipcRenderer.invoke(channels.projectInspect, path),
  chooseProject: () => ipcRenderer.invoke(channels.projectChoose),
  listTasks: () => ipcRenderer.invoke(channels.taskList),
  getTask: taskId => ipcRenderer.invoke(channels.taskDetail, taskId),
  subscribe(listener) {
    const notify = () => listener()
    ipcRenderer.on(channels.tasksChanged, notify)
    return () => ipcRenderer.removeListener(channels.tasksChanged, notify)
  },
}

contextBridge.exposeInMainWorld('desktop', api)
