import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const marker = '.feishu-operation-preflight.json'

async function read(path) {
  try { return await readFile(path) } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

// 在调用模型前准备 Node 依赖；标记保存在隔离工作树的 node_modules 内。
export async function prepareOperationEnvironment({ cwd, signal, install, check } = {}) {
  const lockfile = await read(join(cwd, 'package-lock.json'))
  if (!lockfile) return { status: 'unmanaged', cached: false }
  const manifest = await read(join(cwd, 'package.json'))
  const fingerprint = createHash('sha256').update(lockfile).update(manifest ?? []).digest('hex')
  const directory = join(cwd, 'node_modules')
  const link = await lstat(directory).catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (link && !link.isDirectory()) throw new Error('UI 验证预检失败：node_modules 必须是工作树内的普通目录。')
  const options = { cwd, signal, timeout: 600_000, maxBuffer: 256 * 1024, windowsHide: true }
  // Windows 的 npm.cmd 需要命令解释器；命令为固定常量，不包含用户输入。
  const run = install ?? (process.platform === 'win32'
    ? () => exec('cmd.exe', ['/d', '/s', '/c', 'npm ci --no-audit --no-fund'], options)
    : (...args) => exec('npm', args, options))
  const inspect = check ?? (process.platform === 'win32'
    ? () => exec('cmd.exe', ['/d', '/s', '/c', 'npm ls --depth=0'], { ...options, timeout: 60_000 })
    : (...args) => exec('npm', args, { ...options, timeout: 60_000 }))
  const previous = await read(join(directory, marker)).catch(() => undefined)
  if (previous) {
    try {
      if (JSON.parse(previous.toString()).fingerprint === fingerprint) {
        signal?.throwIfAborted()
        // 标记只表示上次安装成功；仍需确认依赖目录没有缺失或损坏。
        await inspect(['ls', '--depth=0'], { cwd, signal })
        return { status: 'ready', cached: true }
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof SyntaxError) { /* 无效标记只触发重新安装。 */ }
      // 完整性检查失败时继续重新安装。
    }
  }
  signal?.throwIfAborted()
  try {
    await run(['ci', '--no-audit', '--no-fund'], { cwd, signal })
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error(`UI 验证预检失败：依赖安装未完成 (${error?.code ?? '未知错误'})。请检查锁文件、npm 缓存和网络。`)
  }
  const installed = await lstat(directory).catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (installed && !installed.isDirectory()) throw new Error('UI 验证预检失败：依赖目录无效。')
  if (!installed) await mkdir(directory, { recursive: true })
  await writeFile(join(directory, marker), JSON.stringify({ fingerprint }), { flag: 'w' })
  return { status: 'ready', cached: false }
}
