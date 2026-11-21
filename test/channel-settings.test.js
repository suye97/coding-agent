import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerChannelSettings } from '../src/channel-settings.js'

/** 搭建 Connection 路由与持久化服务的 Host 边界替身。 */
function host(config, options = {}) {
  const routes = new Map()
  const entry = { options: { config: { ...config, designProvider: 'claude-code-design' } } }
  let secret = options.secret
  let failConfig = false
  const ctx = {
    fiber: { entry },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    credentials: {
      async resolve() { return secret ? { value: secret } : undefined },
      async set(key, value) { assert.equal(key, config.secretKey); secret = value },
    },
    configEditor: {
      async edit(target, change) {
        assert.equal(target, entry)
        if (failConfig) throw new Error('profile write failed')
        entry.options.config = change(entry.options.config)
      },
    },
  }
  registerChannelSettings(ctx, config)
  /** 通过真实 RPC 请求信封调用已注册的路由。 */
  async function call(method, payload = {}) {
    const route = routes.get(`/api/feishuChannel/${method}`)
    const response = await route.fetch(new Request(`http://localhost${route.path}`, {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'test-request', method: `feishuChannel/${method}`, payload }),
    }))
    return { status: response.status, body: await response.json() }
  }
  return { routes, entry, call, setFailConfig(value) { failConfig = value }, getSecret() { return secret } }
}

test('Host settings routes save partial disabled configuration and preserve unrelated fields', async () => {
  const config = { enabled: false, appId: '', userId: '', secretKey: 'FEISHU_DEV_APP_SECRET', dataDirectory: '', projects: [] }
  const fixture = host(config)
  assert.deepEqual([...fixture.routes.keys()], ['/api/feishuChannel/read', '/api/feishuChannel/save'])
  const read = await fixture.call('read')
  assert.deepEqual(read.body.result.value, { appId: '', userId: '', enabled: false, dataDirectory: '', secretConfigured: false })
  const saved = await fixture.call('save', { appId: 'cli_app', userId: '', enabled: false, dataDirectory: '', appSecret: 'private-value' })
  assert.equal(saved.body.type, 'server-response')
  assert.equal(saved.body.rpcId, 'test-request')
  assert.deepEqual(saved.body.result.value, { appId: 'cli_app', userId: '', enabled: false, dataDirectory: '', secretConfigured: true })
  assert.equal(fixture.entry.options.config.designProvider, 'claude-code-design')
  assert.equal(fixture.entry.options.config.secretKey, 'FEISHU_DEV_APP_SECRET')
  assert.equal(fixture.getSecret(), 'private-value')
  assert.ok(!JSON.stringify(saved.body).includes('private-value'))
  const wrongMethod = await fixture.routes.get('/api/feishuChannel/read').fetch(new Request('http://localhost/api/feishuChannel/read', {
    method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'wrong', method: 'feishuChannel/save', payload: {} }),
  }))
  assert.equal(wrongMethod.status, 400)
})

test('Host settings routes validate enablement and report partial persistence', async () => {
  const config = { enabled: false, appId: '', userId: '', secretKey: 'FEISHU_DEV_APP_SECRET', dataDirectory: '', projects: [] }
  const fixture = host(config)
  const request = { appId: 'cli_app', userId: 'ou_approver', enabled: true, dataDirectory: join(tmpdir(), 'feishu-settings') }
  assert.equal((await fixture.call('save', request)).body.result.error.code, 'feishu-channel/projects-required')
  assert.equal(fixture.getSecret(), undefined)
  config.projects = [{ name: '示例', aliases: [], path: join(tmpdir(), 'repository'), baseBranch: 'main', checks: [] }]
  assert.equal((await fixture.call('save', request)).body.result.error.code, 'feishu-channel/app-secret-required')
  fixture.setFailConfig(true)
  const partial = await fixture.call('save', { ...request, appSecret: 'new-secret' })
  assert.equal(partial.body.result.error.code, 'feishu-channel/partial-save')
  assert.equal(fixture.getSecret(), 'new-secret')
  assert.equal(fixture.entry.options.config.enabled, false)
  assert.ok(!JSON.stringify(partial.body).includes('new-secret'))
  fixture.setFailConfig(false)
  const saved = await fixture.call('save', request)
  assert.equal(saved.body.result.ok, true)
  assert.equal(fixture.entry.options.config.enabled, true)
  assert.equal(fixture.entry.options.config.dataDirectory, request.dataDirectory)
})
