import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanupBeforeExit } from '../src/lifecycle.js'

test('application exit has a bound even when resource cleanup never settles', async () => {
  const startedAt = Date.now()
  await cleanupBeforeExit(() => new Promise(() => {}), 20)
  assert.ok(Date.now() - startedAt < 500)
})

test('application exit proceeds after rejected cleanup', async () => {
  await cleanupBeforeExit(() => Promise.reject(new Error('disconnect failed')), 1000)
})
