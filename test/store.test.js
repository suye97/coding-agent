import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openStore } from '../src/store.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-store-'))
  const store = openStore(join(directory, 'state.sqlite'))
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  return store
}

test('history allocation repairs legacy revision drift without replacing existing history', async t => {
  const store = await fixture(t)
  const task = { id: 'ABCDEF12', chatId: 'chat', stage: 'blocked', requirement: { body: '需求' } }
  store.transaction(() => store.save(task))
  const stale = store.get(task.id)
  store.transaction(() => {
    task.error = '第一次中断'
    store.save(task)
  })
  assert.equal(task.revision, 2)
  // 模拟旧版本或中断留下的任务当前版本落后于历史最大值。
  store.progress(stale)
  const recovered = store.get(task.id)
  assert.equal(recovered.revision, 1)
  store.transaction(() => {
    recovered.error = null
    recovered.stage = 'verify_queued'
    store.save(recovered)
  })
  assert.equal(recovered.revision, 3)
  assert.equal(store.get(task.id).stage, 'verify_queued')
})

test('a stale task object cannot overwrite a newer task state', async t => {
  const store = await fixture(t)
  const task = { id: 'ABCDEF12', chatId: 'chat', stage: 'queued', requirement: { body: '需求' } }
  store.transaction(() => store.save(task))
  const stale = store.get(task.id)
  store.transaction(() => {
    task.stage = 'developing'
    store.save(task)
  })
  assert.throws(() => store.transaction(() => {
    stale.stage = 'blocked'
    store.save(stale)
  }), /任务状态已被其他操作更新/)
  assert.equal(store.get(task.id).stage, 'developing')
  assert.equal(store.get(task.id).revision, 2)
})
