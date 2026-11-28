import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { createRepository, formatRemoteFailure } from '../src/repository.js'

const exec = promisify(execFile)

test('remote failures retain classified Git diagnostics without URL credentials', () => {
  const authentication = formatRemoteFailure('origin', ['ls-remote', '--', 'https://example.invalid/repo'], {
    stderr: "fatal: Authentication failed for 'https://git-user:unit-test-only@example.invalid/repo'",
  })
  assert.match(authentication.message, /访问远端 origin 失败：Git 认证失败/)
  assert.match(authentication.message, /Git：fatal: Authentication failed/)
  assert.doesNotMatch(authentication.message, /unit-test-only|git-user/)

  const rejected = formatRemoteFailure('origin', ['push', '--', 'https://example.invalid/repo'], {
    stderr: 'remote: protected branch hook declined\n ! [remote rejected] master (pre-receive hook declined)',
  })
  assert.match(rejected.message, /更新远端 origin 失败：远端拒绝写入/)
  assert.match(rejected.message, /protected branch hook declined/)
})

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

async function deliveryFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-master-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'repo')
  const remote = join(directory, 'remote.git')
  const git = async (cwd, ...args) => (await exec('git', args, { cwd })).stdout.trim()
  await mkdir(path)
  await git(directory, 'init', '--bare', remote)
  await git(path, 'init', '-b', 'master')
  await git(path, 'remote', 'add', 'origin', remote)
  await git(path, 'config', 'user.email', 'test@example.test')
  await git(path, 'config', 'user.name', 'Test')
  async function commitFile(cwd, file, content) {
    await writeFile(join(cwd, file), content)
    await git(cwd, 'add', '--', file)
    await git(cwd, 'commit', '-m', `Update ${file}`)
    return git(cwd, 'rev-parse', 'HEAD')
  }
  const base = await commitFile(path, 'order.txt', 'baseline\n')
  await git(path, 'push', 'origin', 'master')
  const repository = createRepository(join(directory, 'worktrees'))
  const task = { id: 'ABCD1234', type: 'feature' }
  const project = { path, baseBranch: 'master', remote: 'origin', checks: [] }
  const input = { task, project, signal: new AbortController().signal }
  task.work = await repository.prepare(input)
  const source = await commitFile(task.work.worktree, 'order.txt', 'feature\n')
  const result = await repository.verify(input)
  const pushed = await repository.push({ ...input, result })
  task.work.pushedCommit = pushed.commit
  result.remote = pushed.remote
  const target = () => git(remote, 'rev-parse', 'refs/heads/master')
  const sourceRef = () => git(remote, 'rev-parse', `refs/heads/${task.work.branch}`)
  let contributor
  async function advanceMaster(file, content) {
    if (!contributor) {
      contributor = join(directory, 'contributor')
      await git(directory, 'clone', '-b', 'master', remote, contributor)
      await git(contributor, 'config', 'user.email', 'test@example.test')
      await git(contributor, 'config', 'user.name', 'Test')
    }
    const next = await commitFile(contributor, file, content)
    await git(contributor, 'push', 'origin', 'master')
    return next
  }
  let candidate
  const verify = (candidate, operationValidation) => repository.verify({ ...input, candidate, operationValidation })
  const integrate = (verifyCandidate = verify) => repository.integrate({ ...input, result, savedCandidate: candidate, verifyCandidate,
    recordCandidate: value => { candidate = value } })
  return { base, source, input, path, remote, git, target, sourceRef, advanceMaster, integrate, verify }
}

test('fast-forward delivery advances remote master without changing the local master or task HEAD', async t => {
  const fixture = await deliveryFixture(t)
  const { base, source, input, path, git, target, sourceRef, integrate } = fixture
  assert.equal(await target(), base)
  assert.equal(await sourceRef(), source)
  const verifyCandidate = () => assert.fail('Already verified the fast-forward commit')
  assert.deepEqual(await integrate(verifyCandidate), { branch: 'master', commit: source })
  assert.deepEqual(await integrate(verifyCandidate), { branch: 'master', commit: source })
  assert.equal(await target(), source)
  assert.equal(await sourceRef(), source)
  assert.equal(await git(path, 'rev-parse', 'refs/heads/master'), base)
  assert.equal(await git(input.task.work.worktree, 'rev-parse', 'HEAD'), source)
})

test('diverged master publishes the actual validated merge tree and reuses it on retry', async t => {
  const fixture = await deliveryFixture(t)
  const { base, source, input, path, remote, git, target, sourceRef, advanceMaster, integrate, verify } = fixture
  const master = await advanceMaster('master.txt', 'mainline\n')
  const operationValidation = { kind: 'operation' }
  input.project.checks.push({ label: 'Check exact merge tree', kind: 'operation', timeoutMs: 10000,
    command: process.execPath, args: ['-e', `const { readFileSync } = require('node:fs');
      const assert = require('node:assert/strict');
      assert.equal(readFileSync('master.txt', 'utf8').trimEnd(), 'mainline');
      assert.equal(readFileSync('order.txt', 'utf8').trimEnd(), 'feature');
      console.log(process.env.FEISHU_VALIDATED_COMMIT)`] })
  let candidateCommit
  const delivered = await integrate(async candidate => {
    candidateCommit = candidate.commit
    assert.equal(await target(), master)
    assert.equal(await git(candidate.worktree, 'rev-parse', 'HEAD'), candidate.commit)
    const checked = await verify(candidate, operationValidation)
    assert.equal(checked.checks[0].passed, true, checked.checks[0].output)
    assert.equal(checked.operationReports[0]?.trim(), candidate.commit)
    return checked
  })
  assert.deepEqual(delivered, { branch: 'master', commit: candidateCommit })
  assert.equal(await target(), candidateCommit)
  assert.equal(await git(remote, 'show', '-s', '--format=%P', candidateCommit), `${master} ${source}`)
  assert.equal(await sourceRef(), source)
  assert.equal(await git(path, 'rev-parse', 'refs/heads/master'), base)
  assert.equal(await git(path, 'rev-parse', 'refs/remotes/origin/master'), base)
  assert.doesNotMatch(await git(path, 'worktree', 'list', '--porcelain'), /merge-/u)
  assert.deepEqual(await integrate(() => assert.fail('The persisted candidate is already on master')), delivered)
})

test('conflicts, failed checks, concurrent updates and remote rejection leave master unchanged by delivery', async t => {
  await t.test('conflict', async t => {
    const { source, sourceRef, target, advanceMaster, integrate } = await deliveryFixture(t)
    const master = await advanceMaster('order.txt', 'conflicting change\n')
    await assert.rejects(integrate(() => assert.fail('Conflicted candidate must stay unpublished')), /冲突/u)
    assert.equal(await target(), master)
    assert.equal(await sourceRef(), source)
  })
  await t.test('candidate checks fail', async t => {
    const { source, sourceRef, input, target, advanceMaster, integrate } = await deliveryFixture(t)
    const master = await advanceMaster('master.txt', 'mainline\n')
    input.project.checks.push({ label: 'Fail merge checks', command: process.execPath, args: ['-e', 'process.exitCode = 1'], timeoutMs: 10000 })
    await assert.rejects(integrate(), /合并候选未通过/u)
    assert.equal(await target(), master)
    assert.equal(await sourceRef(), source)
  })
  await t.test('master advances during validation', async t => {
    const { source, sourceRef, target, advanceMaster, integrate, verify } = await deliveryFixture(t)
    const oldMaster = await advanceMaster('master.txt', 'mainline\n')
    let newMaster
    await assert.rejects(integrate(async candidate => {
      assert.equal(candidate.base, oldMaster)
      const checked = await verify(candidate)
      newMaster = await advanceMaster('master.txt', 'new mainline\n')
      return checked
    }), /在验证期间已变化/u)
    assert.equal(await target(), newMaster)
    assert.equal(await sourceRef(), source)
    const delivered = await integrate(async candidate => {
      assert.equal(candidate.base, newMaster)
      return verify(candidate)
    })
    assert.equal(await target(), delivered.commit)
  })
  await t.test('remote rejects master updates', async t => {
    const { base, source, sourceRef, remote, git, target, integrate } = await deliveryFixture(t)
    await git(remote, 'config', 'receive.hideRefs', 'refs/heads/master')
    await assert.rejects(integrate(), /更新 origin\/master 失败/u)
    assert.equal(await target(), base)
    assert.equal(await sourceRef(), source)
  })
})
