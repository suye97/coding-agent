import assert from 'node:assert/strict'
import test from 'node:test'
import { composeImagePrompt } from '../src/attachment-prompt.js'
import { receiveTaskMessage } from '../src/attachment-intake.js'

test('task image intake authorizes the exact card before downloading', async () => {
  const image = { bytes: Buffer.from('test') }
  const accepted = { id: 'ref' }
  const calls = []
  const workflow = {
    attachmentTarget({ replyTo }) { return replyTo === 'own-card' ? '1234ABCD' : null },
    attachImage(input) { calls.push(input); return '已接收' },
  }
  const channel = { async downloadAttachment(ref) { calls.push(ref); return image } }
  const storage = { async save(taskId, input) { assert.equal(taskId, '1234ABCD'); assert.equal(input, image); return accepted } }
  const message = { eventId: 'image-event', attachments: [{ kind: 'image', key: 'img_abc' }] }
  assert.match(await receiveTaskMessage(workflow, channel, storage, message), /直接回复/)
  assert.deepEqual(calls, [])
  assert.equal(await receiveTaskMessage(workflow, channel, storage, { ...message, replyTo: 'own-card' }), '已接收')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].eventId, 'image-event:0')
  assert.equal(calls[1].attachment, accepted)
})

test('external provider prompt uses a validated path and no image bytes', async () => {
  const task = { id: '1234ABCD', attachments: [{ id: 'ref' }] }
  const prompt = await composeImagePrompt('design', task, async (id, ref) => {
    assert.equal(id, task.id)
    assert.equal(ref, task.attachments[0])
    return { path: 'C:/private/prototype.png', bytes: Buffer.from('private-bytes'), mimeType: 'image/png', width: 10, height: 10 }
  })
  assert.equal(typeof prompt, 'string')
  assert.match(prompt, /C:\/private\/prototype\.png/)
  assert.doesNotMatch(prompt, /private-bytes/)
  await assert.rejects(composeImagePrompt('design', task, async () => ({})), /无法读取/)
})
