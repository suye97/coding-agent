import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentProcess } from './agent-client.js'
import { createConfigStore } from './config.js'
import { registerIpc } from './ipc.js'
import { Runtime } from './runtime.js'
import { channels } from './shared.js'
import { cleanupBeforeExit } from '../src/lifecycle.js'

let window: BrowserWindow | undefined
let runtime: Runtime | undefined

async function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1000, minHeight: 680,
    backgroundColor: '#20292d', show: false, title: '需求交付台',
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged,
    },
  })
  window.once('ready-to-show', () => window?.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => {
    if (event.url !== window?.webContents.getURL()) event.preventDefault()
  })
  const config = createConfigStore(join(app.getPath('userData'), 'settings.json'))
  const agents = new AgentProcess()
  runtime = new Runtime(config, agents, () => {
    if (window && !window.isDestroyed()) window.webContents.send(channels.tasksChanged)
  })
  registerIpc(config, runtime, window)
  if (process.env.VITE_DEV_SERVER_URL) await window.loadURL(process.env.VITE_DEV_SERVER_URL)
  else await window.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'index.html'))
  await runtime.start().catch(() => {
    // 设置页仍可打开；配置修复并保存后会重新启动任务运行环境。
  })
}

app.whenReady().then(createWindow).catch(() => app.quit())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) void createWindow() })
app.on('before-quit', event => {
  if (!runtime) return
  event.preventDefault()
  const current = runtime
  runtime = undefined
  void cleanupBeforeExit(() => current.close()).finally(() => app.exit(0))
})
