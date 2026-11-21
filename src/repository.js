import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const gitOptions = ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null')]

// 执行 Git 命令，并把可供任务卡片展示的错误限制为短消息。
async function git(cwd, signal, ...args) {
  try {
    const { stdout } = await exec('git', [...gitOptions, ...args], { cwd, signal, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true })
    return stdout.trimEnd()
  } catch (error) {
    signal.throwIfAborted()
    const detail = error.stderr?.trim().replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1***@')
    throw new Error(`Git ${args[0]} 失败${detail ? `：${detail.slice(0, 350)}` : '。'}`)
  }
}

// 建立项目名称索引，同时校验仓库与远端配置。
export function createProjects(configuration) {
  const byName = new Map()
  for (const project of configuration) {
    if (!isAbsolute(project.path) || !project.baseBranch || project.baseBranch.startsWith('-')) throw new Error('项目需要绝对仓库路径和有效的基线分支。')
    if (project.remote != null && !validRemote(project.remote)) throw new Error('项目远端名称无效。')
    for (const name of [project.name, ...project.aliases]) {
      const key = name.trim().toLowerCase()
      if (!key || byName.has(key)) throw new Error('项目名或别名为空或重复。')
      byName.set(key, project)
    }
  }
  return {
    get(name) { return byName.get(name?.toLowerCase()) },
    resolve(name) { return byName.get(name?.toLowerCase())?.name },
  }
}

// 远端只接受已配置的 Git 名称，避免把配置值解释为选项或任意地址。
function validRemote(remote) {
  return typeof remote === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)
}

// 使用上海日期生成分支后缀，已有工作树的分支名称始终沿用任务记录。
function branchFor(task) {
  if (task.work?.branch) return task.work.branch
  if (!/^[A-Za-z0-9]+$/.test(task.id)) throw new Error('任务编号不能用于 Git 分支。')
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replaceAll('-', '')
  return `${task.type === 'fix' ? 'fix' : 'feature'}/${task.id.toLowerCase()}_${date}`
}

// 管理任务工作树、验证和经过核对的远端推送。
export function createRepository(worktreeRoot) {
  // 在任何 worktree 副作用前生成可持久化的执行意图，固定分支和基线。
  async function intent({ task, project, signal }) {
    const source = await realpath(project.path)
    await mkdir(worktreeRoot, { recursive: true })
    const root = await realpath(worktreeRoot)
    const worktree = join(root, task.id)
    const branch = branchFor(task)
    const remote = project.remote ?? 'origin'
    if (!validRemote(remote)) throw new Error('项目远端名称无效。')
    const base = task.work?.base ?? await git(source, signal, 'rev-parse', '--verify', `refs/heads/${project.baseBranch}^{commit}`)
    return { ...task.work, worktree, branch, base, source, remote,
      prepared: task.work ? task.work.prepared !== false : false }
  }

  // 保持任务工作树与分支的唯一绑定；未完成的准备可以安全续跑。
  async function prepare({ task, project, signal }) {
    const work = await intent({ task, project, signal })
    const { worktree, branch, base, source, remote } = work
    const alreadyPrepared = task.work ? work.prepared : false
    const sourceCommon = await git(source, signal, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    if (task.work && (task.work.source !== source || task.work.worktree !== worktree || task.work.branch !== branch || (task.work.remote && task.work.remote !== remote))) {
      throw new Error('项目路径或工作树配置已变更。')
    }
    const exists = await lstat(worktree).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!exists) {
      if (alreadyPrepared) throw new Error('原工作树已不存在。')
      await git(source, signal, 'worktree', 'add', '-b', branch, worktree, base)
    }
    if ((exists && !exists.isDirectory()) || await realpath(worktree) !== worktree) throw new Error('工作树路径指向其他位置。')
    const common = await git(worktree, signal, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const top = await git(worktree, signal, 'rev-parse', '--show-toplevel')
    const head = await git(worktree, signal, 'symbolic-ref', 'HEAD')
    if (await realpath(common) !== await realpath(sourceCommon) || await realpath(top) !== worktree || head !== `refs/heads/${branch}`) {
      throw new Error('已有工作树与任务记录不匹配。')
    }
    await git(worktree, signal, 'merge-base', '--is-ancestor', base, 'HEAD')
    return { ...work, prepared: true }
  }

  // 执行项目检查并确认工作树仅含已提交的任务改动。
  async function verify({ task, project, signal, previousCommit = task.work?.base, requireNewCommit = false }) {
    const { worktree, branch, base } = await prepare({ task, project, signal })
    const checks = []
    for (const check of project.checks) {
      signal.throwIfAborted()
      try {
        const { stdout, stderr } = await exec(check.command, check.args, {
          cwd: worktree, signal, timeout: check.timeoutMs, maxBuffer: 512 * 1024, windowsHide: true,
        })
        checks.push({ label: check.label, passed: true, output: `${stdout}\n${stderr}`.trim().slice(-1200) })
      } catch (error) {
        signal.throwIfAborted()
        // 只显示有限的命令输出，避免将完整命令或环境信息写入任务卡片。
        const output = [error.stderr, error.stdout].filter(Boolean).join('\n').trim().slice(-1200)
        checks.push({ label: check.label, passed: false, output: output || `执行失败 (${error.code ?? error.signal ?? '未知错误'})` })
      }
    }
    const status = await git(worktree, signal, 'status', '--porcelain=v1', '--untracked-files=normal')
    const committed = await git(worktree, signal, 'diff', '--stat', base, 'HEAD', '--')
    const changes = [committed, status].filter(Boolean).join('\n')
    const commit = await git(worktree, signal, 'rev-parse', 'HEAD')
    const expectedCommit = requireNewCommit ? (previousCommit ?? base) : base
    checks.push({ label: requireNewCommit ? '检查本轮返工提交与工作树' : '检查本地提交与工作树',
      passed: !status && commit !== expectedCommit,
      output: status ? '工作树还有未提交的改动。' : commit === expectedCommit
        ? requireNewCommit ? '本轮返工没有产生新提交。' : '分支没有新增提交。' : '' })
    return { worktree, branch, changes, commit, checks }
  }

  // 仅推送验证过的精确提交，并要求远端分支仍处于本任务上次推送的位置。
  async function push({ task, project, signal, result }) {
    if (!result?.commit || !result.checks?.length || !result.checks.every(check => check.passed)) {
      throw new Error('验证未通过，禁止推送。')
    }
    const { worktree, branch, remote } = await prepare({ task, project, signal })
    if (result.branch !== branch || !/^[0-9a-f]{40,64}$/.test(result.commit)) throw new Error('验证结果与任务分支不匹配。')
    const commit = await git(worktree, signal, 'rev-parse', 'HEAD')
    const status = await git(worktree, signal, 'status', '--porcelain=v1', '--untracked-files=normal')
    if (commit !== result.commit || status) throw new Error('验证后提交或工作树已变化，请重新验证。')
    const remoteGit = async (...args) => {
      try {
        const { stdout } = await exec('git', [...gitOptions, '-c', 'protocol.ext.allow=never', ...args], {
          cwd: worktree, signal, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        })
        return stdout.trimEnd()
      } catch {
        signal.throwIfAborted()
        throw new Error(`访问或推送远端 ${remote} 失败，请检查远端权限、凭据和连接。`)
      }
    }
    const pushUrls = (await remoteGit('remote', 'get-url', '--push', '--all', remote)).split(/\r?\n/).filter(Boolean)
    if (pushUrls.length !== 1) throw new Error(`远端 ${remote} 必须只有一个推送地址。`)
    const ref = `refs/heads/${branch}`
    const remoteHead = async () => {
      const output = await remoteGit('ls-remote', '--heads', '--', pushUrls[0], ref)
      return output.split(/\r?\n/).find(line => line.endsWith(`\t${ref}`))?.split('\t')[0]
    }
    const previous = await remoteHead()
    if (previous === commit) return { remote, commit }
    if (previous !== task.work?.pushedCommit || (previous && !task.work?.pushedCommit)) {
      throw new Error(`远端 ${remote}/${branch} 已被其他提交占用或改动，请人工核对。`)
    }
    if (previous) await git(worktree, signal, 'merge-base', '--is-ancestor', previous, commit)
    // Check the expected remote tip atomically. Existing refs must still fast-forward.
    await remoteGit('-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', 'push', '--porcelain',
      `--force-with-lease=${ref}:${previous ?? ''}`, '--', pushUrls[0], `${commit}:${ref}`)
    if (await remoteHead() !== commit) throw new Error(`远端 ${remote}/${branch} 推送后提交不匹配。`)
    return { remote, commit }
  }

  return { intent, prepare, verify, push }
}
