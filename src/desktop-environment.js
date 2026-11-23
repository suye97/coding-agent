import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const manifestName = 'feishu-desktop-environment.json'

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function directory(path) {
  const stat = await lstat(path).catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  return stat?.isDirectory() && !stat.isSymbolicLink()
}

async function copyTree(source, destination, signal) {
  if (!await directory(source)) throw new Error('Desktop 模板 profile 不存在或包含目录链接。')
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    signal?.throwIfAborted()
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Desktop 模板不能包含符号链接。')
    if (entry.isDirectory()) await copyTree(from, to, signal)
    else if (entry.isFile()) await copyFile(from, to)
    else throw new Error('Desktop 模板只能包含普通文件和目录。')
  }
}

async function hashTree(source, hash = createHash('sha256'), prefix = '', signal) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    signal?.throwIfAborted()
    const path = join(source, entry.name)
    const relative = `${prefix}${entry.name}`
    if (entry.isSymbolicLink()) throw new Error('Desktop 模板不能包含符号链接。')
    if (entry.isDirectory()) await hashTree(path, hash, `${relative}/`, signal)
    else if (entry.isFile()) hash.update(relative).update(await readFile(path))
    else throw new Error('Desktop 模板只能包含普通文件和目录。')
  }
  return hash
}

async function terminateProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return
  if (process.platform === 'win32') {
    await exec('taskkill', ['/pid', String(child.pid), '/t', '/f'], { timeout: 10_000, windowsHide: true }).catch(() => {})
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* 已退出。 */ }
  }
}

// Host 管理只读模板和每任务隔离副本；验证 Agent 只接收已经就绪的实例。
export function createDesktopEnvironment({
  root, templateDirectory, executable, readinessCommand, readinessArgs = [], provider,
  startupTimeoutMs = 60_000, launch, probe, terminate = terminateProcess,
} = {}) {
  const active = new Map()

  async function prepare({ taskId, commit, worktree, signal, onStatus }) {
    if (!/^[A-F0-9]{8}$/u.test(taskId ?? '')) throw new Error('Desktop 验证任务编号无效。')
    if (!isAbsolute(root ?? '') || !isAbsolute(templateDirectory ?? '') || !isAbsolute(executable ?? '')) {
      throw new Error('Desktop 验证环境需要绝对的数据目录、模板目录和 DSH 可执行文件路径。')
    }
    if (!readinessCommand || readinessArgs.some(value => typeof value !== 'string')) {
      throw new Error('Desktop 验证环境缺少固定健康检查命令，无法确认 Provider、样例库和仓库是否可用。')
    }
    onStatus?.('checking')
    const manifestPath = join(templateDirectory, manifestName)
    let manifestText
    let manifest
    try {
      manifestText = await readFile(manifestPath, 'utf8')
      manifest = JSON.parse(manifestText)
    } catch {
      throw new Error('Desktop 模板缺少有效的环境清单。')
    }
    if (manifest.provider !== provider || typeof manifest.fixturesVersion !== 'string' || !manifest.fixturesVersion.trim()) {
      throw new Error('Desktop 模板的测试 Provider 或样例数据版本与当前验证配置不匹配。')
    }
    if (!isAbsolute(manifest.fixtureRepository ?? '') || typeof manifest.fixtureOrigin !== 'string' || !manifest.fixtureOrigin.trim()) {
      throw new Error('Desktop 模板必须声明专用的样例 Git 仓库绝对路径和预期 origin。')
    }
    try {
      const [{ stdout: origin }, { stdout: head }] = await Promise.all([
        exec('git', ['-C', manifest.fixtureRepository, 'remote', 'get-url', 'origin'], { timeout: 10_000, windowsHide: true }),
        exec('git', ['-C', manifest.fixtureRepository, 'rev-parse', '--verify', 'HEAD'], { timeout: 10_000, windowsHide: true }),
      ])
      if (origin.trim() !== manifest.fixtureOrigin.trim() || !/^[a-f0-9]{40}$/iu.test(head.trim())) throw new Error('mismatch')
    } catch {
      throw new Error('Desktop 样例仓库不可用，或 origin 与专用测试配置不匹配。')
    }
    const templateHash = await hashTree(join(templateDirectory, 'profile'), createHash('sha256'), '', signal)
    const fingerprint = templateHash.update(manifestText).update(executable).update(provider).digest('hex')
    await mkdir(root, { recursive: true })
    const rootPath = await realpath(root)
    const tasksDirectory = join(rootPath, 'tasks')
    const taskDirectory = join(tasksDirectory, taskId)
    const profile = join(taskDirectory, 'profile')
    const runtimePath = join(taskDirectory, 'runtime.json')
    await mkdir(tasksDirectory, { recursive: true })
    if (!await directory(tasksDirectory)) throw new Error('Desktop 验证任务目录不能是符号链接。')
    await mkdir(taskDirectory, { recursive: true })
    if (!await directory(taskDirectory)) throw new Error('Desktop 验证任务目录不能是符号链接。')
    const runtimeStat = await lstat(runtimePath).catch(error => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (runtimeStat?.isSymbolicLink() || (runtimeStat && !runtimeStat.isFile())) throw new Error('Desktop 验证运行记录路径无效。')
    const runtime = await readFile(runtimePath, 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
    if (runtime?.fingerprint !== fingerprint || runtime?.healthy !== true || !await directory(profile)) {
      onStatus?.('creating')
      await rm(profile, { recursive: true, force: true })
      await copyTree(join(templateDirectory, 'profile'), profile, signal)
    }
    if (active.has(taskId)) throw new Error('该任务的 Desktop 验证环境已经启动。')
    const runtimeBody = { fingerprint, commit, worktree, provider, healthy: false, pid: null, startedAt: Date.now(), readyAt: null }
    await writeFile(runtimePath, JSON.stringify(runtimeBody), { flag: 'w' })
    signal?.throwIfAborted()
    onStatus?.('launching')
    const child = (launch ?? (({ executable: path, args }) => spawn(path, args, {
      detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: false,
    })))({ executable, args: [`--user-data-dir=${profile}`], profile })
    if (!child?.pid) {
      child?.once('error', () => {}) // spawn 的 ENOENT 在下一 tick 触发，避免未处理事件。
      throw new Error('Desktop 验证实例未能启动。')
    }
    active.set(taskId, child)
    let stopped = false
    const stop = async () => {
      if (stopped) return
      stopped = true
      active.delete(taskId)
      await terminate(child)
      await writeFile(runtimePath, JSON.stringify({ ...runtimeBody, pid: null, stoppedAt: Date.now() }), { flag: 'w' }).catch(() => {})
    }
    const exited = new Promise((_, reject) => {
      child.once('error', error => { error.desktopExit = true; reject(error) })
      child.once('exit', (code, exitSignal) => {
        const error = new Error(`Desktop 验证实例提前退出 (${exitSignal ?? code ?? '未知'})`)
        error.desktopExit = true
        reject(error)
      })
    })
    const probeEnvironment = {
      PATH: process.env.PATH ?? '',
      ...(process.platform === 'win32' && Object.fromEntries(['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
        .filter(name => process.env[name]).map(name => [name, process.env[name]]))),
      FEISHU_DESKTOP_PROFILE: profile,
      FEISHU_DESKTOP_PROVIDER: provider,
      FEISHU_DESKTOP_FIXTURES_VERSION: manifest.fixturesVersion,
      FEISHU_DESKTOP_FIXTURE_REPOSITORY: manifest.fixtureRepository,
      FEISHU_VALIDATED_COMMIT: commit,
      FEISHU_TASK_WORKTREE: worktree,
    }
    try {
      const deadline = Date.now() + startupTimeoutMs
      let lastCode = '未知'
      for (;;) {
        signal?.throwIfAborted()
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(`Desktop 验证环境健康检查超时 (${lastCode})。`)
        try {
          await Promise.race([
            (probe ?? (() => exec(readinessCommand, readinessArgs, {
              timeout: Math.min(10_000, remaining), signal, windowsHide: true, env: probeEnvironment,
            })))({
              command: readinessCommand, args: readinessArgs, signal, timeoutMs: Math.min(10_000, remaining), env: probeEnvironment,
            }),
            exited,
          ])
          break
        } catch (error) {
          signal?.throwIfAborted()
          if (error.desktopExit || child.exitCode !== null || child.signalCode) throw error
          lastCode = error?.code ?? '检查失败'
          await delay(Math.min(500, Math.max(1, deadline - Date.now())), signal)
        }
      }
      runtimeBody.readyAt = Date.now()
      runtimeBody.healthy = true
      runtimeBody.pid = child.pid
      await writeFile(runtimePath, JSON.stringify(runtimeBody), { flag: 'w' })
      onStatus?.('ready')
      return { fingerprint, profileDirectory: profile, release: stop }
    } catch (error) {
      await stop()
      if (signal?.aborted) throw signal.reason
      throw new Error(`Desktop 验证环境未就绪：${error instanceof Error ? error.message.slice(0, 300) : '健康检查失败。'}`)
    }
  }

  return {
    prepare,
    async close() {
      await Promise.allSettled([...active.values()].map(child => terminate(child)))
      active.clear()
    },
  }
}
