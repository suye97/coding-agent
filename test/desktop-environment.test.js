import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDesktopEnvironment } from '../src/desktop-environment.js'

const exec = promisify(execFile)

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-environment-'))
  const root = join(directory, 'runtime')
  const templateDirectory = join(directory, 'template')
  await mkdir(join(templateDirectory, 'profile'), { recursive: true })
  await writeFile(join(templateDirectory, 'profile', 'provider.json'), '{"name":"test-provider"}')
  const fixtureRepository = join(directory, 'fixture-repo')
  await exec('git', ['init', fixtureRepository])
  await exec('git', ['-C', fixtureRepository, 'config', 'user.name', 'Fixture'])
  await exec('git', ['-C', fixtureRepository, 'config', 'user.email', 'fixture@example.invalid'])
  await writeFile(join(fixtureRepository, 'sample.txt'), 'sample task')
  await exec('git', ['-C', fixtureRepository, 'add', 'sample.txt'])
  await exec('git', ['-C', fixtureRepository, 'commit', '-m', 'fixture'])
  await exec('git', ['-C', fixtureRepository, 'remote', 'add', 'origin', 'https://example.test/fixture.git'])
  await writeFile(join(templateDirectory, 'feishu-desktop-environment.json'), JSON.stringify({
    provider: 'workspace', fixturesVersion: 'v1', fixtureRepository, fixtureOrigin: 'https://example.test/fixture.git',
  }))
  const launches = []
  const probes = []
  const terminated = []
  let pid = 1000
  const manager = createDesktopEnvironment({
    root, templateDirectory, executable: join(directory, 'DeepSeek Harness.exe'), readinessCommand: 'node', readinessArgs: ['check.mjs'],
    provider: 'workspace', startupTimeoutMs: 100,
    launch(input) {
      const child = new EventEmitter()
      child.pid = ++pid
      child.exitCode = null
      child.signalCode = null
      launches.push({ ...input, child })
      return child
    },
    async probe(input) {
      probes.push(input)
      if (options.unhealthy && probes.length === 1) throw Object.assign(new Error('not ready'), { code: 1 })
    },
    async terminate(child) { terminated.push(child.pid); child.exitCode = 0 },
  })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, root, templateDirectory, manager, launches, probes, terminated }
}

const task = { taskId: 'ABCDEF12', commit: 'commit-a', worktree: 'D:/task', signal: new AbortController().signal }

test('Desktop environment copies a read-only template, checks readiness and reuses the same task profile', async t => {
  const app = await fixture(t)
  const statuses = []
  const first = await app.manager.prepare({ ...task, onStatus: status => statuses.push(status) })
  assert.match(app.launches[0].args[0], /^--user-data-dir=/)
  assert.equal(app.launches[0].profile, first.profileDirectory)
  assert.equal(app.probes[0].env.FEISHU_DESKTOP_PROVIDER, 'workspace')
  assert.equal(app.probes[0].env.FEISHU_VALIDATED_COMMIT, 'commit-a')
  assert.equal(app.probes[0].env.FEISHU_TASK_WORKTREE, 'D:/task')
  assert.equal(await readFile(join(first.profileDirectory, 'provider.json'), 'utf8'), '{"name":"test-provider"}')
  await writeFile(join(first.profileDirectory, 'state.txt'), 'keep between retries')
  await first.release()
  assert.deepEqual(app.terminated, [1001])
  const second = await app.manager.prepare(task)
  assert.equal(second.profileDirectory, first.profileDirectory)
  assert.equal(second.fingerprint, first.fingerprint)
  assert.equal(await readFile(join(second.profileDirectory, 'state.txt'), 'utf8'), 'keep between retries')
  assert.equal(app.launches.length, 2)
  assert.deepEqual(statuses, ['checking', 'creating', 'launching', 'ready'])
  await second.release()
})

test('Desktop template changes rebuild the task profile instead of reusing stale provider data', async t => {
  const app = await fixture(t)
  const first = await app.manager.prepare(task)
  await writeFile(join(first.profileDirectory, 'state.txt'), 'stale')
  await first.release()
  await writeFile(join(app.templateDirectory, 'profile', 'provider.json'), '{"name":"new-provider"}')
  const second = await app.manager.prepare(task)
  assert.notEqual(second.fingerprint, first.fingerprint)
  await assert.rejects(readFile(join(second.profileDirectory, 'state.txt'), 'utf8'), { code: 'ENOENT' })
  assert.equal(await readFile(join(second.profileDirectory, 'provider.json'), 'utf8'), '{"name":"new-provider"}')
  await second.release()
})

test('Desktop health failure terminates its process and rebuilds the profile on retry', async t => {
  const app = await fixture(t, { unhealthy: true })
  await assert.rejects(app.manager.prepare(task), /Desktop 验证环境未就绪/)
  assert.deepEqual(app.terminated, [1001])
  await writeFile(join(app.root, 'tasks', 'ABCDEF12', 'profile', 'state.txt'), 'failed-state')
  const retry = await app.manager.prepare(task)
  await assert.rejects(readFile(join(retry.profileDirectory, 'state.txt'), 'utf8'), { code: 'ENOENT' })
  await retry.release()
})

test('Desktop environment rejects a fixture repository with the wrong origin before launch', async t => {
  const app = await fixture(t)
  const manifestPath = join(app.templateDirectory, 'feishu-desktop-environment.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, fixtureOrigin: 'https://example.test/wrong.git' }))
  await assert.rejects(app.manager.prepare(task), /origin 与专用测试配置不匹配/)
  assert.equal(app.launches.length, 0)
})

test('Desktop spawn failure is contained without an unhandled process error', async t => {
  const app = await fixture(t)
  const manager = createDesktopEnvironment({
    root: app.root, templateDirectory: app.templateDirectory, executable: join(app.directory, 'missing', 'DSH.exe'),
    readinessCommand: 'node', provider: 'workspace', probe: async () => {},
  })
  await assert.rejects(manager.prepare(task), /Desktop 验证实例未能启动/)
  await new Promise(resolve => setImmediate(resolve))
})

test('Desktop environment refuses to launch without a real readiness check', async t => {
  const app = await fixture(t)
  const manager = createDesktopEnvironment({
    root: app.root, templateDirectory: app.templateDirectory, executable: join(app.directory, 'DSH.exe'), provider: 'workspace',
  })
  await assert.rejects(manager.prepare(task), /缺少固定健康检查命令/)
  assert.equal(app.launches.length, 0)
})
