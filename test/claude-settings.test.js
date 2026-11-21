import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createClaudeSettingsHandler, registerClaudeSettings, resolveClaudeDirectory } from '../src/claude-settings.js'

function host(config) {
  const routes = new Map()
  const entry = { options: { config: { ...config } } }
  const provider = { options: {
    id: 'subagent-claude-code-kimi-design',
    name: '@deepseek-ai/dsh-subagent-claude-code',
    config: {
      providerName: config.designProvider,
      model: 'K3.1-Pro',
      permissionMode: 'plan',
      disposeGraceMs: 3000,
      env: { CLAUDE_CONFIG_DIR: config.claudeConfigDirectory, CUSTOM: 'kept' },
    },
  } }
  let failedEntry
  const ctx = {
    fiber: { entry },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    configEditor: {
      entries() { return [provider] },
      async edit(target, change) {
        if (target === failedEntry) throw new Error('profile write failed')
        target.options.config = change(target.options.config)
      },
    },
  }
  registerClaudeSettings(ctx, config, entry)
  async function call(method, payload = {}) {
    const route = routes.get(`/api/feishuClaude/${method}`)
    const response = await route.fetch(new Request(`http://localhost${route.path}`, {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'claude-request', method: `feishuClaude/${method}`, payload }),
    }))
    return { status: response.status, body: await response.json() }
  }
  return { ctx, entry, provider, call, failOn(target) { failedEntry = target } }
}

const payload = { baseUrl: 'https://api.example.test/anthropic', model: 'K3.1-Pro' }

test('simple model settings update all mappings and never return API keys', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-claude-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'settings.json'), JSON.stringify({
    ui: { theme: 'dark' }, env: {
      ANTHROPIC_AUTH_TOKEN: 'test-original-key', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', CUSTOM: 'kept',
    },
  }))
  const fixture = host({
    claudeConfigDirectory: directory, designProvider: 'claude-code-kimi-design',
    developmentProvider: 'codex', providerPoliciesVerified: true, enabled: true,
  })
  const read = await fixture.call('read')
  assert.deepEqual(read.body.result.value, { baseUrl: '', model: 'K3.1-Pro', apiKeyConfigured: true })
  assert.equal(JSON.stringify(read).includes('test-original-key'), false)

  const saved = await fixture.call('save', { ...payload, apiKey: 'test-new-key' })
  assert.deepEqual(saved.body.result.value, { ...payload, apiKeyConfigured: true })
  assert.equal(JSON.stringify(saved).includes('test-new-key'), false)
  const settings = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.ui, { theme: 'dark' })
  assert.equal(settings.env.CUSTOM, 'kept')
  assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000')
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'test-new-key')
  for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    assert.equal(settings.env[key], 'K3.1-Pro')
  }

  assert.equal(fixture.provider.options.config.permissionMode, 'plan')
  assert.equal(fixture.provider.options.config.env.CLAUDE_CONFIG_DIR, directory)
  assert.equal(fixture.provider.options.config.env.CUSTOM, 'kept')
  assert.equal(fixture.entry.options.config.developmentProvider, 'codex')
  assert.equal(fixture.entry.options.config.providerPoliciesVerified, true)

  const kept = await fixture.call('save', payload)
  assert.equal(kept.body.result.ok, true)
  const unchanged = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
  assert.equal(unchanged.env.ANTHROPIC_AUTH_TOKEN, 'test-new-key')
})

test('model directory follows the design provider profile with an optional override', () => {
  const home = join('root', 'home')
  assert.equal(resolveClaudeDirectory({ designProvider: 'claude-code-kimi-design' }, home),
    join(home, '.dsh', 'profiles', 'desktop', 'claude-kimi-design'))
  assert.equal(resolveClaudeDirectory({ designProvider: 'custom' }, home),
    join(home, '.dsh', 'profiles', 'desktop', 'custom'))
  assert.throws(() => resolveClaudeDirectory({ designProvider: '../invalid' }, home))
})

test('model settings validate required fields, URL and owner access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-claude-validation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = host({ claudeConfigDirectory: directory, designProvider: 'claude-code-kimi-design' })
  const missing = await fixture.call('save', { ...payload, model: '' })
  assert.equal(missing.body.result.error.code, 'feishu-claude/invalid-input')
  const invalidUrl = await fixture.call('save', { ...payload, baseUrl: 'https://user:secret@example.test' })
  assert.equal(invalidUrl.body.result.error.code, 'feishu-claude/invalid-url')
  const handler = createClaudeSettingsHandler(fixture.ctx, fixture.entry.options.config, fixture.entry)
  const denied = await handler('feishuClaude/save', payload, undefined, { principal: { kind: 'guest' } })
  assert.equal(denied.error.code, 'feishu-claude/denied')
})

test('provider model edits preserve internal configuration and identify partial saves', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-provider-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = host({
    claudeConfigDirectory: directory, designProvider: 'claude-code-kimi-design',
    developmentProvider: 'codex', providerPoliciesVerified: true, enabled: true, custom: 'kept',
  })
  fixture.provider.options.config.custom = 'kept'
  fixture.failOn(fixture.provider)
  const providerFailed = await fixture.call('save', { ...payload, apiKey: 'private-test-token' })
  assert.equal(providerFailed.body.result.error.code, 'feishu-claude/partial-save')
  assert.equal(JSON.stringify(providerFailed).includes('private-test-token'), false)
  assert.equal(fixture.provider.options.config.permissionMode, 'plan')
  assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).env.ANTHROPIC_BASE_URL, payload.baseUrl)

  fixture.failOn(undefined)
  const saved = await fixture.call('save', { ...payload, model: 'K3.1-Pro-Next' })
  assert.equal(saved.body.result.ok, true)
  assert.equal(fixture.provider.options.config.model, 'K3.1-Pro-Next')
  assert.equal(fixture.provider.options.config.providerName, 'claude-code-kimi-design')
  assert.equal(fixture.provider.options.config.permissionMode, 'plan')
  assert.equal(fixture.provider.options.config.disposeGraceMs, 3000)
  assert.equal(fixture.provider.options.config.env.CLAUDE_CONFIG_DIR, directory)
  assert.equal(fixture.provider.options.config.custom, 'kept')
  assert.deepEqual(fixture.entry.options.config, {
    claudeConfigDirectory: directory, designProvider: 'claude-code-kimi-design',
    developmentProvider: 'codex', providerPoliciesVerified: true, enabled: true, custom: 'kept',
  })
  const reread = await fixture.call('read')
  assert.equal(reread.body.result.value.model, 'K3.1-Pro-Next')
})

test('model settings require the matching active Claude provider registration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-provider-missing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = host({ claudeConfigDirectory: directory, designProvider: 'claude-code-kimi-design' })
  fixture.provider.options.config.providerName = 'another-provider'
  const read = await fixture.call('read')
  assert.equal(read.body.result.error.code, 'feishu-claude/provider-required')
})
