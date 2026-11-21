import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createProjectSettingsHandler, registerProjectSettings } from '../src/project-settings.js'

const exec = promisify(execFile)

/** 创建带有本地分支和含凭据远端地址的临时仓库。 */
async function repository(t) {
  const path = await mkdtemp(join(tmpdir(), 'feishu-project-settings-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const git = (...args) => exec('git', args, { cwd: path, windowsHide: true })
  await git('init', '-b', 'main')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    'commit', '--allow-empty', '-m', 'initial')
  await git('branch', 'release')
  await git('remote', 'add', 'origin', 'https://user:test-private-token@example.invalid/project.git')
  await mkdir(join(path, 'nested'))
  return path
}

/** 通过 Connection 信封调用项目配置路由并保留持久化状态。 */
function host(config) {
  const routes = new Map()
  const entry = { options: { config: { ...config, appId: 'kept-app', designProvider: 'kept-provider' } } }
  const ctx = {
    fiber: { entry },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    configEditor: {
      async edit(target, change) {
        assert.equal(target, entry)
        entry.options.config = change(entry.options.config)
      },
    },
  }
  registerProjectSettings(ctx, config)
  /** 发送与客户端相同格式的 RPC 请求。 */
  async function call(method, payload = {}) {
    const route = routes.get(`/api/feishuProjects/${method}`)
    const response = await route.fetch(new Request(`http://localhost${route.path}`, {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'project-request', method: `feishuProjects/${method}`, payload }),
    }))
    return { status: response.status, body: await response.json() }
  }
  return { ctx, routes, entry, call }
}

test('project routes inspect repository names only and preserve checks and other settings', async t => {
  const path = await repository(t)
  const checks = [{ label: '构建', command: 'npm', args: ['run', 'build'], timeoutMs: 120000 }]
  const config = { projects: [{ name: '现有项目', path, aliases: ['旧称'], baseBranch: 'main', checks }] }
  const fixture = host(config)
  assert.deepEqual([...fixture.routes.keys()], [
    '/api/feishuProjects/read', '/api/feishuProjects/inspect', '/api/feishuProjects/save',
  ])
  const read = await fixture.call('read')
  assert.deepEqual(read.body.result.value, { projects: [{ ...config.projects[0], remote: 'origin' }] })
  const inspected = await fixture.call('inspect', { path })
  assert.deepEqual(inspected.body.result.value, {
    path, name: '现有项目', branches: ['main', 'release'], remotes: ['origin'], baseBranch: 'main', remote: 'origin',
  })
  const saved = await fixture.call('save', { projects: [{ name: '现有项目', path, aliases: ['新称'], baseBranch: 'release', checks: [] }] })
  assert.equal(saved.body.result.ok, true)
  assert.deepEqual(saved.body.result.value.projects[0], {
    name: '现有项目', path, aliases: ['新称'], baseBranch: 'release', checks, remote: 'origin',
  })
  assert.equal(fixture.entry.options.config.appId, 'kept-app')
  assert.equal(fixture.entry.options.config.designProvider, 'kept-provider')
  assert.deepEqual((await fixture.call('read')).body.result.value, saved.body.result.value)
  for (const response of [read, inspected, saved]) assert.ok(!JSON.stringify(response).includes('test-private-token'))
})

test('project routes reject nonroots, absent branches and remotes without saving', async t => {
  const path = await repository(t)
  const fixture = host({ projects: [] })
  const project = { name: '测试', path, aliases: [], baseBranch: 'main', remote: 'origin', checks: [] }
  assert.equal((await fixture.call('inspect', { path: join(path, 'nested') })).body.result.error.code, 'feishu-projects/invalid-repository')
  assert.equal((await fixture.call('inspect', { path: 'relative/path' })).body.result.error.code, 'feishu-projects/invalid-repository')
  assert.equal((await fixture.call('save', { projects: [{ ...project, baseBranch: 'missing' }] })).body.result.error.code, 'feishu-projects/invalid-branch')
  assert.equal((await fixture.call('save', { projects: [{ ...project, remote: 'missing' }] })).body.result.error.code, 'feishu-projects/invalid-remote')
  assert.equal((await fixture.call('save', { projects: [{ ...project, path: join(path, 'nested') }] })).body.result.error.code, 'feishu-projects/invalid-repository')
  assert.deepEqual(fixture.entry.options.config.projects, [])
  const success = await fixture.call('save', { projects: [{ name: '测试', path, aliases: [], baseBranch: 'main' }] })
  assert.equal(success.body.result.value.projects[0].remote, 'origin')
  const wrongMethod = await fixture.routes.get('/api/feishuProjects/read').fetch(new Request('http://localhost/api/feishuProjects/read', {
    method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'wrong', method: 'feishuProjects/save', payload: {} }),
  }))
  assert.equal(wrongMethod.status, 400)
  const handler = createProjectSettingsHandler(fixture.ctx, fixture.entry.options.config)
  assert.equal((await handler('feishuProjects/read', {}, undefined, { principal: { kind: 'guest' } })).error.code, 'feishu-projects/denied')
})
