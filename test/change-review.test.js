import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { inspectChanges } from '../src/change-review.js'
import { createRepository } from '../src/repository.js'

const exec = promisify(execFile)

const retiredFile = 'old design.txt'
const packagedFile = 'package.json'

test('change review requires a standalone owner directive and preserves renamed source paths', async () => {
  const commit = 'target'
  const sample = {
    commit,
    comparisons: ['base'],
    diffEntries: async () => [
      { kind: 'D', path: retiredFile, mode: '000000' },
      { kind: 'A', path: 'new design.txt', mode: '100644' },
      { kind: 'M', path: packagedFile, mode: '100644' },
    ],
    addedLines: async () => 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-"old": "git reset --hard"\n+"new": "node --test"\n',
  }
  const surroundingText = await inspectChanges({ ...sample, requirement: `说明中提到删除文件：${retiredFile}` })
  assert.deepEqual(surroundingText.unapprovedDeletions, [retiredFile])
  assert.deepEqual(surroundingText.warnings, [])
  assert.equal(surroundingText.approvalRequired, true)
  const explicitDirective = await inspectChanges({ ...sample, requirement: `说明\r\n删除文件：${retiredFile}\r\n` })
  assert.deepEqual(explicitDirective.deletions, [retiredFile])
  assert.equal(explicitDirective.approvalRequired, false)
  const excessive = { ...sample, diffEntries: async () => Array.from({ length: 13 }, (_, index) => ({ kind: 'D', path: `file-${index}`, mode: '000000' })) }
  await assert.rejects(inspectChanges(excessive), /审查超出/)
})

test('repository gates checks and local bare-remote delivery on the current reviewed commit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-change-review-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'repo')
  const remote = join(directory, 'remote.git')
  const marker = join(directory, 'verified.txt')
  const git = (cwd, ...args) => exec('git', args, { cwd })
  await git(directory, 'init', '-b', 'main', path)
  await git(directory, 'init', '--bare', remote)
  await git(path, 'remote', 'add', 'origin', remote)
  await git(path, 'config', 'user.email', 'test@example.test')
  await git(path, 'config', 'user.name', 'Test')
  await writeFile(join(path, retiredFile), 'retire me\n')
  await git(path, 'add', '.')
  await git(path, 'commit', '-m', 'Initial')

  const repository = createRepository(join(directory, 'worktrees'))
  const task = { id: '1234ABCD', type: 'fix', requirement: { body: '更新项目' } }
  const project = { path, baseBranch: 'main', checks: [{
    label: 'operation', kind: 'operation', command: process.execPath,
    args: ['-e', 'require("fs").writeFileSync(process.argv[1], "checked"); console.log(JSON.stringify([process.env.FEISHU_VALIDATED_COMMIT, process.env.FEISHU_OPERATION_VALIDATION]))', marker],
    timeoutMs: 10_000,
  }] }
  const operationValidation = { operation: 'open settings' }
  const input = { task, project, signal: new AbortController().signal, operationValidation }
  task.work = await repository.prepare(input)
  const worktree = task.work.worktree
  await git(worktree, 'rm', '--', retiredFile)
  await writeFile(join(worktree, packagedFile), '{"scripts":{"sample":"git reset --hard"}}\n')
  await git(worktree, 'add', '.')
  await git(worktree, 'commit', '-m', 'Proposed changes')

  const pending = await repository.verify(input)
  assert.equal(pending.changeReview.approvalRequired, true)
  assert.deepEqual(pending.changeReview.unapprovedDeletions, [retiredFile])
  assert.deepEqual(pending.changeReview.warnings.map(({ path }) => path), [packagedFile])
  assert.deepEqual(pending.operationReports, [])
  await assert.rejects(access(marker), { code: 'ENOENT' })
  const fabricatedChecks = { ...pending, checks: [{ passed: true }] }
  await assert.rejects(repository.push({ ...input, result: fabricatedChecks }), /改动尚未通过人工审查/)

  task.changeReviewApproval = { commit: pending.commit }
  await writeFile(join(worktree, 'notes.txt'), 'dirty\n')
  assert.equal((await repository.verify(input)).checks.at(-1).passed, false)
  await assert.rejects(access(marker), { code: 'ENOENT' })
  await git(worktree, 'add', '.')
  await git(worktree, 'commit', '-m', 'Add notes')
  const newer = await repository.verify(input)
  assert.notEqual(newer.commit, pending.commit)
  assert.equal(newer.changeReview.approvalRequired, true)
  await assert.rejects(access(marker), { code: 'ENOENT' })

  task.changeReviewApproval = { commit: newer.commit }
  const structural = await repository.verify({ ...input, operationValidation: undefined })
  assert.equal(structural.checks.length, 1)
  assert.equal(structural.checks[0].passed, true)
  assert.deepEqual(structural.operationReports, [])
  await assert.rejects(access(marker), { code: 'ENOENT' })
  const reviewed = await repository.verify(input)
  assert.equal(reviewed.changeReview.approvalRequired, false)
  assert.ok(reviewed.checks.every(({ passed }) => passed))
  assert.deepEqual(JSON.parse(reviewed.operationReports[0]), [reviewed.commit, JSON.stringify(operationValidation)])
  await access(marker)
  const pushed = await repository.push({ ...input, result: reviewed })
  assert.equal(pushed.commit, reviewed.commit)
  assert.equal((await git(remote, 'rev-parse', task.work.branch)).stdout.trim(), reviewed.commit)

  const secondMarker = join(directory, 'next-check.txt')
  project.checks.push({
    label: 'mutates tracked content', command: process.execPath,
    args: ['-e', 'require("fs").writeFileSync("notes.txt", "modified after review")'], timeoutMs: 10_000,
  }, {
    label: 'must wait for fresh review', command: process.execPath,
    args: ['-e', 'require("fs").writeFileSync(process.argv[1], "unexpected")', secondMarker], timeoutMs: 10_000,
  })
  const changedByCheck = await repository.verify(input)
  assert.equal(changedByCheck.checks.at(-1).passed, false)
  assert.deepEqual(changedByCheck.operationReports, [])
  await assert.rejects(access(secondMarker), { code: 'ENOENT' })
})
