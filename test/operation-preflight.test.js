import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareOperationEnvironment } from '../src/operation-preflight.js'

async function fixture(t, lockfile = true) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-preflight-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'package.json'), '{"name":"fixture"}\n')
  if (lockfile) await writeFile(join(directory, 'package-lock.json'), '{"lockfileVersion":3}\n')
  return directory
}

test('Host UI preflight installs once and invalidates the environment when the lockfile changes', async t => {
  const directory = await fixture(t)
  const calls = []
  const install = async (args, { cwd }) => {
    calls.push(args)
    await mkdir(join(cwd, 'node_modules'), { recursive: true })
  }
  assert.deepEqual(await prepareOperationEnvironment({ cwd: directory, install, check: async () => {} }), { status: 'ready', cached: false })
  assert.deepEqual(await prepareOperationEnvironment({ cwd: directory, install, check: async () => {} }), { status: 'ready', cached: true })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['ci', '--no-audit', '--no-fund'])
  const marker = JSON.parse(await readFile(join(directory, 'node_modules', '.feishu-operation-preflight.json'), 'utf8'))
  assert.match(marker.fingerprint, /^[a-f0-9]{64}$/)
  await writeFile(join(directory, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n')
  assert.equal((await prepareOperationEnvironment({ cwd: directory, install })).cached, false)
  assert.equal(calls.length, 2)
})

test('Host UI preflight leaves projects without an npm lockfile to their own setup', async t => {
  const directory = await fixture(t, false)
  const result = await prepareOperationEnvironment({ cwd: directory, install: () => assert.fail('不应安装') })
  assert.deepEqual(result, { status: 'unmanaged', cached: false })
})

test('real npm ci prepares an empty isolated project without network dependencies', async t => {
  const directory = await fixture(t)
  const manifest = { name: 'feishu-preflight-integration', version: '1.0.0', private: true }
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({
    ...manifest, lockfileVersion: 3, requires: true,
    packages: { '': { name: manifest.name, version: manifest.version } },
  }))
  assert.equal((await prepareOperationEnvironment({ cwd: directory })).cached, false)
  assert.equal((await prepareOperationEnvironment({ cwd: directory })).cached, true)
})

test('a damaged dependency cache is checked and reinstalled', async t => {
  const directory = await fixture(t)
  let healthy = true
  let installs = 0
  let checks = 0
  const install = async (args, { cwd }) => {
    installs++
    await mkdir(join(cwd, 'node_modules'), { recursive: true })
  }
  const check = async () => {
    checks++
    if (!healthy) throw Object.assign(new Error('missing dependency'), { code: 1 })
  }
  const input = { cwd: directory, install, check }
  assert.equal((await prepareOperationEnvironment(input)).cached, false)
  assert.equal((await prepareOperationEnvironment(input)).cached, true)
  healthy = false
  assert.equal((await prepareOperationEnvironment(input)).cached, false)
  healthy = true
  assert.equal((await prepareOperationEnvironment(input)).cached, true)
  assert.equal(installs, 2)
  assert.equal(checks, 3)
})

test('failed dependency installation is not cached and can be retried', async t => {
  const directory = await fixture(t)
  await assert.rejects(prepareOperationEnvironment({ cwd: directory,
    install: async () => { throw Object.assign(new Error('private output'), { code: 1 }) },
  }), error => {
    assert.match(error.message, /依赖安装未完成 \(1\)/)
    assert.doesNotMatch(error.message, /private output/)
    return true
  })
  const install = async (args, { cwd }) => mkdir(join(cwd, 'node_modules'), { recursive: true })
  assert.equal((await prepareOperationEnvironment({ cwd: directory, install })).cached, false)
})
