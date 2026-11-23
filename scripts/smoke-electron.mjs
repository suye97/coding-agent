import { _electron } from 'playwright-core'
import electron from 'electron'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { smokePackagedAgent } from './smoke-packaged-agent.mjs'

const directory = await mkdtemp(join(tmpdir(), 'delivery-desktop-smoke-'))
const screenshots = join(process.cwd(), 'test-results')
await mkdir(screenshots, { recursive: true })
let application
const packaged = Boolean(process.env.ELECTRON_EXECUTABLE)
try {
  const sandboxArgs = process.env.ELECTRON_NO_SANDBOX === '1' ? ['--no-sandbox'] : []
  application = await _electron.launch({
    executablePath: process.env.ELECTRON_EXECUTABLE || electron,
    chromiumSandbox: !sandboxArgs.length,
    args: packaged ? [...sandboxArgs, `--user-data-dir=${join(directory, 'user-data')}`] : [...sandboxArgs, '.', `--user-data-dir=${join(directory, 'user-data')}`],
    timeout: 30_000,
  })
  const page = await application.firstWindow()
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error('Renderer:', error.message) })
  page.on('console', message => { if (message.type() === 'error') console.error('Console:', message.text()) })
  console.log('Window URL:', page.url())
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('heading', { name: '需求交付台', exact: true }).waitFor({ timeout: 20_000 })
  await page.screenshot({ path: join(screenshots, 'desktop-home.png') })
  const bridge = await page.evaluate(async () => ({
    available: Boolean(window.desktop),
    config: await window.desktop.getConfig(),
    tasks: await window.desktop.listTasks(),
  }))
  if (!bridge.available || bridge.config.enabled || bridge.tasks.items.length) throw new Error('Electron IPC initial state is invalid')
  const isolated = await page.evaluate(() => typeof process === 'undefined' && typeof require === 'undefined')
  if (!isolated) throw new Error('Renderer has unexpected Node.js access')
  await page.getByTitle('设置').click()
  await page.getByRole('dialog', { name: '应用设置' }).waitFor()
  await page.getByRole('button', { name: '模型', exact: true }).click()
  await page.getByText('Claude Agent SDK', { exact: true }).waitFor()
  await page.getByRole('button', { name: '项目仓库', exact: true }).click()
  await page.getByRole('button', { name: '添加仓库', exact: true }).waitFor()
  await page.screenshot({ path: join(screenshots, 'desktop-settings.png') })
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('dialog', { name: '应用设置' }).waitFor({ state: 'hidden' })
  const restarted = await page.evaluate(() => window.desktop.getConfig())
  if (restarted.enabled) throw new Error('Smoke test must keep Feishu disabled')
  if (errors.length) throw new Error(errors.join('\n'))
  if (packaged && process.platform === 'win32') await smokePackagedAgent(application, directory)
  await writeFile(join(screenshots, 'desktop-smoke.json'), JSON.stringify({ ok: true, ipc: true, rendererIsolated: isolated, configSaveRestart: true, initialTasks: 0, settingsTabs: ['channel', 'model', 'projects'], screenshots: ['desktop-home.png', 'desktop-settings.png'] }, null, 2))
  console.log('Electron smoke passed: main, preload, React, IPC and settings tabs')
} finally {
  await application?.close()
  await rm(directory, { recursive: true, force: true })
}
