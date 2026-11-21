import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const prefix = 'feishuProjects/'
const methods = ['read', 'inspect', 'save']
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })

/** 仅执行固定的 Git 内建查询，不执行仓库中的脚本或检查命令。 */
async function queryGit(path, signal, ...args) {
  const { stdout } = await exec('git', [
    '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    '--no-pager', ...args,
  ], { cwd: path, signal, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' } })
  return stdout.trimEnd()
}

/** 把路径规范化并确认它指向工作仓库的顶层目录。 */
async function inspectRepository(inputPath, signal) {
  if (typeof inputPath !== 'string' || !inputPath || inputPath !== inputPath.trim() || !isAbsolute(inputPath)) {
    throw new Error('invalid-path')
  }
  const path = await realpath(inputPath)
  const top = await queryGit(path, signal, 'rev-parse', '--show-toplevel')
  const bare = await queryGit(path, signal, 'rev-parse', '--is-bare-repository')
  if (bare !== 'false' || resolve(path) !== resolve(await realpath(top))) throw new Error('not-root')
  const branchOutput = await queryGit(path, signal, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
  const remoteOutput = await queryGit(path, signal, 'remote')
  return {
    path,
    name: basename(path),
    branches: branchOutput ? branchOutput.split(/\r?\n/) : [],
    remotes: remoteOutput ? remoteOutput.split(/\r?\n/) : [],
  }
}

/** 只返回项目表单所需字段，并为旧配置补齐远端默认值。 */
function publicProjects(config) {
  return (Array.isArray(config.projects) ? config.projects : []).map(project => ({
    name: project.name,
    path: project.path,
    aliases: project.aliases ?? [],
    baseBranch: project.baseBranch ?? 'main',
    checks: (project.checks ?? []).map(check => ({ ...check, args: check.args ?? [], timeoutMs: check.timeoutMs ?? 120000 })),
    remote: project.remote || 'origin',
  }))
}

/** 校验项目和检查配置的字段类型，避免持久化无法使用的条目。 */
function validProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project) ||
      typeof project.name !== 'string' || !project.name.trim() || project.name !== project.name.trim() ||
      typeof project.path !== 'string' || !isAbsolute(project.path) || project.path !== project.path.trim() ||
      !Array.isArray(project.aliases) || project.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias !== alias.trim()) ||
      typeof project.baseBranch !== 'string' || !project.baseBranch ||
      typeof project.remote !== 'string' || !project.remote ||
      !Array.isArray(project.checks)) return false
  return project.checks.every(check => check && typeof check === 'object' && !Array.isArray(check) &&
    typeof check.label === 'string' && !!check.label.trim() &&
    typeof check.command === 'string' && !!check.command.trim() &&
    Array.isArray(check.args) && check.args.every(arg => typeof arg === 'string') &&
    Number.isInteger(check.timeoutMs) && check.timeoutMs >= 1 && check.timeoutMs <= 600000)
}

/** 为一个插件实例创建项目配置请求处理器。 */
export function createProjectSettingsHandler(ctx, config, entry = ctx.fiber.entry) {
  return async (endpoint, payload, signal, peer) => {
    if (peer?.principal?.kind !== 'owner' || peer.signal?.aborted) return failure('feishu-projects/denied', '仅所有者可访问项目配置。')
    if (signal?.aborted) return failure('feishu-projects/cancelled', '请求已取消。')
    if (!methods.some(method => endpoint === `${prefix}${method}`)) return failure('feishu-projects/not-found', '未知项目配置接口。')
    const current = entry?.options?.config ?? config
    if (endpoint === `${prefix}read`) return { ok: true, value: { projects: publicProjects(current) } }

    if (endpoint === `${prefix}inspect`) {
      try {
        const repository = await inspectRepository(payload?.path, signal)
        const existing = publicProjects(current).find(project => project.path === repository.path)
        const baseBranch = existing?.baseBranch ??
          (repository.branches.includes('main') ? 'main' : repository.branches.includes('master') ? 'master' : repository.branches[0] ?? '')
        return { ok: true, value: { ...repository, name: existing?.name ?? repository.name, baseBranch, remote: existing?.remote ?? 'origin' } }
      } catch {
        if (signal?.aborted) return failure('feishu-projects/cancelled', '请求已取消。')
        return failure('feishu-projects/invalid-repository', '请选择绝对路径的 Git 仓库根目录。')
      }
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.projects)) {
      return failure('feishu-projects/invalid-input', '项目配置字段格式无效。')
    }
    const existing = publicProjects(current)
    const projects = []
    const names = new Set()
    const paths = new Set()
    for (const input of payload.projects) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('feishu-projects/invalid-input', '项目配置字段格式无效。')
      const previous = existing.find(project => project.path === input.path)
      const project = {
        name: input.name,
        path: input.path,
        aliases: input.aliases ?? [],
        baseBranch: input.baseBranch ?? 'main',
        checks: previous?.checks ?? input.checks ?? [],
        remote: input.remote ?? 'origin',
      }
      if (!validProject(project)) return failure('feishu-projects/invalid-input', '项目配置字段格式无效。')
      let repository
      try { repository = await inspectRepository(project.path, signal) } catch {
        if (signal?.aborted) return failure('feishu-projects/cancelled', '请求已取消。')
        return failure('feishu-projects/invalid-repository', '请选择绝对路径的 Git 仓库根目录。')
      }
      if (!repository.branches.includes(project.baseBranch)) return failure('feishu-projects/invalid-branch', '基线分支必须是仓库中的本地分支。')
      if (!repository.remotes.includes(project.remote)) return failure('feishu-projects/invalid-remote', '远端名称必须存在于仓库中。')
      if (paths.has(repository.path)) return failure('feishu-projects/duplicate-project', '仓库路径不能重复。')
      paths.add(repository.path)
      for (const name of [project.name, ...project.aliases]) {
        const key = name.toLowerCase()
        if (names.has(key)) return failure('feishu-projects/duplicate-name', '项目名或别名不能重复。')
        names.add(key)
      }
      projects.push({ ...project, path: repository.path })
    }
    if (!entry || !ctx.configEditor) return failure('feishu-projects/config-unavailable', '当前插件配置不可编辑。')
    if (signal?.aborted) return failure('feishu-projects/cancelled', '请求已取消。')
    try {
      await ctx.configEditor.edit(entry, latest => ({ ...latest, projects }))
    } catch {
      return failure('feishu-projects/config-save-failed', '插件配置保存失败。')
    }
    return { ok: true, value: { projects } }
  }
}

/** 注册仅供已认证所有者调用的 Connection 精确路由。 */
export function registerProjectSettings(ctx, config, entry = ctx.fiber.entry) {
  const handle = createProjectSettingsHandler(ctx, config, entry)
  for (const method of methods) {
    const endpoint = `${prefix}${method}`
    ctx.connection.fetch.register({
      path: `/api/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const envelope = await request.json().catch(() => null)
        if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.method !== endpoint) {
          return new Response('Invalid request', { status: 400 })
        }
        const result = await handle(endpoint, envelope.payload, request.signal, { principal: { kind: 'owner' } })
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
      },
    })
  }
}
