import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { createRepository } from '../src/repository.js'

const exec = promisify(execFile)

test('local git worktree retains its baseline, verifies commits and records failed checks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-repository-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'repo')
  const remote = join(directory, 'remote.git')
  await mkdir(path)
  const git = (cwd, ...args) => exec('git', args, { cwd })
  await git(directory, 'init', '--bare', remote)
  await git(path, 'init', '-b', 'main')
  await git(path, 'remote', 'add', 'origin', remote)
  await git(path, 'config', 'user.email', 'test@example.test')
  await git(path, 'config', 'user.name', 'Test')
  await writeFile(join(path, 'order.txt'), 'new\n')
  await git(path, 'add', '.')
  await git(path, 'commit', '-m', 'Initial')
  await git(path, 'push', 'origin', 'main')
  const repository = createRepository(join(directory, 'worktrees'))
  const task = { id: '1234ABCD', type: 'fix' }
  const project = { path, baseBranch: 'main', remote: 'origin', checks: [
    { label: 'pass', command: process.execPath, args: ['-e', 'console.log("ok")'], timeoutMs: 10000 },
    { label: 'fail', command: process.execPath, args: ['-e', 'console.error("wrong"); process.exit(7)'], timeoutMs: 10000 },
  ] }
  const input = { task, project, signal: new AbortController().signal }
  task.work = await repository.intent(input)
  assert.equal(task.work.prepared, false)
  // 模拟 worktree 已创建、但 prepared 状态尚未保存时发生进程中断。
  await git(path, 'worktree', 'add', '-b', task.work.branch, task.work.worktree, task.work.base)
  task.work = await repository.prepare(input)
  assert.equal(task.work.prepared, true)
  assert.match(task.work.branch, /^fix\/1234abcd_\d{8}$/)
  await writeFile(join(task.work.worktree, 'order.txt'), 'confirmed\n')
  await git(task.work.worktree, 'add', '.')
  await git(task.work.worktree, 'commit', '-m', 'Confirm order')
  assert.deepEqual(await repository.prepare(input), task.work)
  const result = await repository.verify(input)
  assert.deepEqual(result.checks.map(check => check.passed), [true, false, true])
  assert.match(result.checks[1].output, /wrong/)
  assert.match(result.changes, /order\.txt/)
  assert.notEqual(result.commit, task.work.base)
  assert.equal((await git(path, 'rev-parse', 'HEAD')).stdout.trim(), task.work.base)
  await assert.rejects(repository.push({ ...input, result }), /验证未通过/)
  project.checks.pop()
  const verified = await repository.verify(input)
  assert.ok(verified.checks.every(check => check.passed))
  await git(remote, 'update-ref', `refs/heads/${task.work.branch}`, task.work.base)
  await assert.rejects(repository.push({ ...input, result: verified }), /已被其他提交占用或改动/)
  await git(remote, 'update-ref', '-d', `refs/heads/${task.work.branch}`)
  const pushed = await repository.push({ ...input, result: verified })
  assert.deepEqual(pushed, { remote: 'origin', commit: verified.commit })
  task.work.pushedCommit = pushed.commit
  assert.equal((await git(remote, 'rev-parse', `refs/heads/${task.work.branch}`)).stdout.trim(), verified.commit)
  assert.deepEqual(await repository.push({ ...input, result: verified }), pushed)
  const unchanged = await repository.verify({ ...input, previousCommit: pushed.commit, requireNewCommit: true })
  assert.equal(unchanged.checks.at(-1).passed, false)
  assert.match(unchanged.checks.at(-1).output, /本轮返工没有产生新提交/)
  await assert.rejects(repository.push({ ...input, result: unchanged }), /验证未通过/)
  await git(task.work.worktree, 'commit', '--allow-empty', '-m', 'Empty rework')
  const empty = await repository.verify({ ...input, previousCommit: pushed.commit, requireNewCommit: true })
  assert.equal(empty.checks.length, 1)
  assert.equal(empty.checks[0].passed, false)
  assert.match(empty.checks[0].output, /空提交/)
  await assert.rejects(repository.push({ ...input, result: empty }), /验证未通过/)
  await writeFile(join(task.work.worktree, 'order.txt'), 'reworked\n')
  await git(task.work.worktree, 'add', '.')
  await git(task.work.worktree, 'commit', '-m', 'Rework order')
  const reworked = await repository.verify({ ...input, previousCommit: pushed.commit, requireNewCommit: true })
  const second = await repository.push({ ...input, result: reworked })
  assert.equal((await git(remote, 'rev-parse', `refs/heads/${task.work.branch}`)).stdout.trim(), second.commit)
  await git(remote, 'update-ref', `refs/heads/${task.work.branch}`, task.work.base)
  await assert.rejects(repository.push({ ...input, result: reworked }), /已被其他提交占用或改动/)
  const feature = { id: '9876EFAB', type: 'feature' }
  const featureWork = await repository.prepare({ ...input, task: feature })
  assert.match(featureWork.branch, /^feature\/9876efab_\d{8}$/)
})
