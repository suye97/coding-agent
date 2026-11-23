import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

const messageText = 'Packaged Agent is ready.'
const model = 'claude-opus-5-5'
const smokeToken = 'local-smoke-placeholder'
const events = [
  ['message_start', { message: { id: 'msg_local_smoke', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
  ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: messageText } }],
  ['content_block_stop', { index: 0 }],
  ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
  ['message_stop', {}],
].map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('')

// Exercise the shipped utility process and SDK, never a real provider or profile.
export async function smokePackagedAgent(electron, directory) {
  const workspace = await mkdtemp(join(directory, 'agent-'))
  let calls = 0
  const server = createServer((request, response) => {
    request.resume()
    if (request.method !== 'POST' || request.url?.split('?')[0] !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }
    calls++
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(events)
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const result = await electron.evaluate(({ app, utilityProcess }, { baseUrl, workspace, model, smokeToken }) => {
      const runner = `${app.getAppPath()}/dist/electron/electron/agent-runner.js`
      const systemKeys = new Set(['systemroot', 'windir', 'comspec', 'path', 'pathext', 'systemdrive'])
      const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toLowerCase())))
      const child = utilityProcess.fork(runner, [], {
        serviceName: 'Packaged Agent Smoke', stdio: 'ignore', cwd: workspace,
        env: {
          ...systemEnv, HOME: workspace, USERPROFILE: workspace, APPDATA: workspace,
          LOCALAPPDATA: workspace, TEMP: workspace, TMP: workspace, CLAUDE_CONFIG_DIR: workspace,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      })
      return new Promise((resolve, reject) => {
        let streamed = ''
        let session = ''
        let settled = false
        const timer = setTimeout(() => finish(new Error('Packaged Agent startup or response timed out')), 25_000)
        function finish(error, text) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          child.kill()
          if (error) reject(error)
          else resolve({ text, streamed, session: Boolean(session) })
        }
        child.once('exit', code => finish(new Error(`Packaged Agent utility process exited (${code})`)))
        child.on('message', message => {
          if (message.id !== 'smoke') return
          if (message.type === 'session') session = message.sessionId
          if (message.type === 'output') streamed += message.text
          if (message.type === 'error') finish(new Error(message.error))
          if (message.type === 'result') finish(undefined, message.result.text)
        })
        child.postMessage({ type: 'start', id: 'smoke', input: {
          prompt: 'Reply briefly. Do not use tools.', cwd: workspace, stage: 'design', model, baseUrl, apiKey: smokeToken,
        } })
      })
    }, { baseUrl, workspace, model, smokeToken })
    assert.ok(calls > 0, 'The native Claude Code process did not reach the loopback model stub')
    assert.deepEqual(result, { text: messageText, streamed: messageText, session: true })
    console.log('Packaged Agent smoke passed: native CLI, SDK session, streamed text and final response (loopback only)')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}
