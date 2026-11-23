import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ProjectConfig } from './shared.js'

const exec = promisify(execFile)
async function git(path: string, ...args: string[]) {
  const { stdout } = await exec('git', ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '--no-pager', ...args], {
    cwd: path, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' },
  })
  return stdout.trimEnd()
}

export async function inspectRepository(input: string) {
  if (!input || input !== input.trim() || !isAbsolute(input)) throw new Error('请选择绝对路径的 Git 仓库根目录。')
  const path = await realpath(input)
  const [top, bare, branchOutput, remoteOutput] = await Promise.all([
    git(path, 'rev-parse', '--show-toplevel'), git(path, 'rev-parse', '--is-bare-repository'),
    git(path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), git(path, 'remote'),
  ])
  if (bare !== 'false' || resolve(path) !== resolve(await realpath(top))) throw new Error('请选择 Git 工作仓库的根目录。')
  const branches = branchOutput ? branchOutput.split(/\r?\n/u) : []
  const remotes = remoteOutput ? remoteOutput.split(/\r?\n/u) : []
  return {
    path, name: basename(path), branches, remotes,
    baseBranch: branches.includes('main') ? 'main' : branches.includes('master') ? 'master' : branches[0] ?? '',
    remote: remotes.includes('origin') ? 'origin' : remotes[0] ?? '',
  }
}

export async function validateProjects(projects: ProjectConfig[]) {
  const names = new Set<string>()
  const paths = new Set<string>()
  const validated: ProjectConfig[] = []
  for (const project of projects) {
    const repository = await inspectRepository(project.path)
    if (!repository.branches.includes(project.baseBranch)) throw new Error(`${project.name} 的基线分支不存在。`)
    if (!repository.remotes.includes(project.remote)) throw new Error(`${project.name} 的远程不存在。`)
    if (paths.has(repository.path)) throw new Error('仓库路径不能重复。')
    paths.add(repository.path)
    for (const name of [project.name, ...project.aliases]) {
      const key = name.trim().toLowerCase()
      if (!key || names.has(key)) throw new Error('项目名或别名不能为空或重复。')
      names.add(key)
    }
    validated.push({ ...project, path: repository.path })
  }
  return validated
}
