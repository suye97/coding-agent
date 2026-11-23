import { execFile } from 'node:child_process'
import { cp, lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const executablePaths = { win32: 'electron.exe', darwin: 'Electron.app/Contents/MacOS/Electron', linux: 'electron' }

async function fileType(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export async function prepareOperationElectron({ cwd, signal, execute = exec }) {
  const executable = executablePaths[process.platform]
  if (!executable) throw new Error('UI 验证预检失败：当前平台没有可用的 Electron 运行时。')
  const directory = join(cwd, 'node_modules', 'electron')
  if (!(await fileType(directory))?.isDirectory()) throw new Error('UI 验证预检失败：工作树内缺少 Electron npm 包。')
  const metadata = await readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined)
  const version = metadata?.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/iu.test(version)) {
    throw new Error('UI 验证预检失败：无法确认工作树的 Electron 版本。')
  }
  const dist = join(directory, 'dist')
  const pathFile = join(directory, 'path.txt')
  const options = { cwd, signal, windowsHide: true, maxBuffer: 256 * 1024 }
  const ignored = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_SKIP_BINARY_DOWNLOAD'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !ignored.has(name.toUpperCase())))
  const assertOrdinaryPaths = async () => {
    const distEntry = await fileType(dist)
    const pathEntry = await fileType(pathFile)
    if ((distEntry && !distEntry.isDirectory()) || (pathEntry && !pathEntry.isFile())) {
      throw new Error('UI 验证预检失败：Electron 运行时必须安装在工作树的 Electron 包内。')
    }
    return { distEntry, pathEntry }
  }
  const installed = async () => {
    const { distEntry, pathEntry } = await assertOrdinaryPaths()
    return distEntry && pathEntry && (await readFile(pathFile, 'utf8')).trim() === executable &&
      (await fileType(join(dist, executable)))?.isFile()
  }
  if (!(await installed())) {
    const installer = join(directory, 'install.js')
    if (!(await fileType(installer))?.isFile()) throw new Error('UI 验证预检失败：Electron npm 包缺少运行时安装入口。')
    const attempts = env.ELECTRON_MIRROR ? [env] : [env, { ...env, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' }]
    let failure
    for (const attemptEnv of attempts) {
      try {
        // Electron's own Node mode avoids depending on a shell-specific Node installation.
        // Limit ELECTRON_RUN_AS_NODE to the installer; target runtime probes must stay Electron.
        await execute(process.execPath, [installer], { ...options, env: { ...attemptEnv, ELECTRON_RUN_AS_NODE: '1' }, timeout: 180_000 })
        failure = undefined
        break
      } catch (error) {
        signal?.throwIfAborted()
        failure = error
      }
    }
    if (failure) {
      const code = String(failure?.code ?? '未知错误').replace(/[^a-z0-9_.-]/giu, '').slice(0, 40) || '未知错误'
      throw new Error(`UI 验证预检失败：无法下载或安装 Electron ${version} 可执行文件 (${code})，请检查下载缓存、网络和镜像。`)
    }
    if (!(await installed())) throw new Error(`UI 验证预检失败：Electron ${version} 安装后仍缺少可执行文件。`)
  }
  signal?.throwIfAborted()
  const temporary = await mkdtemp(join(tmpdir(), 'feishu-electron-verify-'))
  const dispose = () => rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  const probe = async runtime => {
    try {
      const { stdout } = await execute(join(runtime, executable), ['--version', `--user-data-dir=${join(temporary, 'probe')}`], {
        ...options, env, timeout: 10_000,
      })
      signal?.throwIfAborted()
      return stdout.trim() === `v${version}`
    } catch {
      signal?.throwIfAborted()
      return false
    }
  }
  try {
    if (await probe(dist)) {
      await dispose()
      return { electronDist: dist }
    }
    if (process.platform === 'win32') {
      // A Windows worktree can inherit a low-integrity label even when the app uses a normal profile.
      const staged = join(temporary, 'dist')
      await cp(dist, staged, { recursive: true })
      signal?.throwIfAborted()
      if (await probe(staged)) return { electronDist: staged, dispose }
    }
    throw new Error(`UI 验证预检失败：Electron ${version} 可执行文件存在，但未通过本机启动检查。`)
  } catch (error) {
    await dispose().catch(() => {})
    throw error
  }
}
