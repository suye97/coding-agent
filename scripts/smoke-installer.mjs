import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, copyFile, mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { _electron } from 'playwright-core'
import { smokePackagedAgent } from './smoke-packaged-agent.mjs'

const [mode, installer, expectedVersion, displayName, oldInstaller, oldVersion] = process.argv.slice(2)
assert.ok(process.platform === 'win32' && mode === '--isolated' && installer && expectedVersion && displayName && Boolean(oldInstaller) === Boolean(oldVersion),
  'Usage (clean Windows account/VM or artifacts with a separate test identity only): node scripts/smoke-installer.mjs --isolated <installer> <version> <display-and-shortcut-name> [<old-installer> <old-version>]')

const execute = promisify(execFile)
const exeName = process.env.DELIVERY_SMOKE_EXECUTABLE || '需求交付台.exe'
assert.match(exeName, /^[^/\\:]+\.exe$/i, 'Expected a Windows executable filename')
const uninstallName = `Uninstall ${exeName}`
const query = async (script, values = {}) => {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; ${script}`],
  { env: { ...process.env, ...values }, timeout: 30_000, windowsHide: true })
  return JSON.parse(stdout)
}
const identity = { DELIVERY_SMOKE_NAME: displayName, DELIVERY_SMOKE_EXE: exeName }
const registryRows = () => query(`$keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall') | Where-Object { Test-Path $_ };
  ConvertTo-Json -InputObject @(Get-ChildItem $keys | Get-ItemProperty | Where-Object { $_.DisplayName -eq $env:DELIVERY_SMOKE_NAME -or $_.DisplayName -eq ($env:DELIVERY_SMOKE_NAME + ' ' + $_.DisplayVersion) } | Select-Object DisplayVersion,UninstallString) -Compress`, identity)
const linkTargets = () => query(`$wsh = New-Object -ComObject WScript.Shell;
  $paths = @([Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('Programs'));
  ConvertTo-Json -InputObject @($paths | ForEach-Object { $link = Join-Path $_ ($env:DELIVERY_SMOKE_NAME + '.lnk'); if (Test-Path -LiteralPath $link) { $wsh.CreateShortcut($link).TargetPath } }) -Compress`, identity)
assert.deepEqual(await registryRows(), [], 'An installation with this identity already exists; use an isolated Windows account or test artifact')
assert.deepEqual(await linkTargets(), [], 'Shortcuts with this name already exist; use an isolated test artifact')
assert.equal(await query(`$name = [IO.Path]::GetFileNameWithoutExtension($env:DELIVERY_SMOKE_EXE); @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count`, identity), 0,
  'Close all application instances before testing')

const root = await mkdtemp(join(tmpdir(), 'delivery-installer-smoke-'))
const installation = join(root, 'installed')
const userData = join(root, 'profile')
const executable = join(installation, exeName)
const uninstaller = join(installation, uninstallName)
const runSetup = (path, args) => execute(path, args, { timeout: 90_000, windowsHide: true })
let app

async function install(artifact, version, filename) {
  // A new file in a standard temporary directory must not inherit the
  // worktree's Low mandatory label. Keep the builder artifact untouched.
  const setup = join(root, filename)
  await copyFile(resolve(artifact), setup)
  // NSIS requires /D= to be the last argument on the command line.
  await runSetup(setup, ['/S', `/D=${installation}`])
  const nativeVersion = await query(`ConvertTo-Json -InputObject ((Get-Item -LiteralPath $env:DELIVERY_SMOKE_PATH).VersionInfo.ProductVersion) -Compress`,
    { DELIVERY_SMOKE_PATH: executable })
  assert.ok([version, `${version}.0`].includes(nativeVersion), `Installed executable version ${nativeVersion} differs from ${version}`)
  await access(join(installation, 'resources', 'app.asar'))
  await access(uninstaller)
  const records = await registryRows()
  assert.equal(records.length, 1, 'Expected exactly one installed-app registry entry')
  assert.equal(records[0].DisplayVersion, version)
  assert.ok(records[0].UninstallString.toLowerCase().startsWith(`"${uninstaller.toLowerCase()}"`))
  const shortcuts = await linkTargets()
  assert.equal(shortcuts.length, 2, 'Expected both the Start menu and desktop shortcuts')
  for (const shortcutTarget of shortcuts) assert.equal(shortcutTarget.toLowerCase(), executable.toLowerCase())
  return shortcuts[0]
}

async function launch(target, version) {
  app = await _electron.launch({ executablePath: target, cwd: installation,
    args: [`--user-data-dir=${userData}`], timeout: 30_000 })
  const page = await app.firstWindow()
  await page.getByRole('heading', { name: '需求交付台', exact: true }).waitFor({ timeout: 20_000 })
  assert.deepEqual(await app.evaluate(({ app, BrowserWindow }) => ({
    noSandbox: app.commandLine.hasSwitch('no-sandbox'),
    windowSandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox,
  })), { noSandbox: false, windowSandbox: true })
  assert.equal(await page.evaluate(async () => {
    const config = await window.desktop.getConfig()
    return !config.enabled && typeof process === 'undefined' && typeof require === 'undefined'
  }), true)
  console.log(`${version}: registered, both shortcuts target the new executable, sandboxed renderer and local IPC ready`)
}

async function exists(path) {
  return stat(path).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error
    return false
  })
}

async function uninstall() {
  await runSetup(uninstaller, ['/S'])
  // The NSIS uninstaller can relaunch from TEMP before removing its source directory.
  const deadline = Date.now() + 15_000
  while (await exists(installation)) {
    if (Date.now() >= deadline) throw new Error(`Uninstall did not remove ${installation}`)
    await delay(250)
  }
}

try {
  if (oldInstaller) {
    await launch(await install(oldInstaller, oldVersion, 'baseline.exe'), oldVersion)
    const marker = join(userData, 'installer-preservation.txt')
    await writeFile(marker, 'keep this profile')
    const child = app.process()
    const target = await install(installer, expectedVersion, 'candidate.exe')
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Previous app is still running after upgrade')
    app = undefined
    assert.equal(await readFile(marker, 'utf8'), 'keep this profile')
    await launch(target, expectedVersion)
  } else {
    await launch(await install(installer, expectedVersion, 'candidate.exe'), expectedVersion)
  }
  await smokePackagedAgent(app, root)
  await app.close()
  app = undefined
  await uninstall()
  assert.deepEqual(await registryRows(), [])
  assert.deepEqual(await linkTargets(), [])
  console.log('Uninstall removed installed files, registration and shortcuts')
} finally {
  await app?.close()
  if (await exists(uninstaller)) await uninstall()
  if ((await registryRows()).length || (await linkTargets()).length) {
    throw new Error(`Installation state remains after cleanup; preserving ${root} for diagnosis`)
  }
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
