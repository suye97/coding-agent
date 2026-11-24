import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { commandToolObservations, observationsFromFile, observationsFromText } from '../src/agent-evidence.js'

const line = JSON.stringify({ commit: 'commit-a', step: 1, observed: '实际状态正确' })
const output = `command started\nFEISHU_AGENT_OBSERVATION ${line}\ncommand finished\n`

test('command evidence uses complete structured stdout instead of a truncated model-facing summary', async () => {
  const assertions = await commandToolObservations({
    id: 'tool-bash', kind: 'command',
    content: 'Output too large. Full output saved to a file.',
    result: { stdout: output, stderr: '', interrupted: false },
  })
  assert.deepEqual(assertions, [{
    id: 'tool-bash', line,
    sha256: createHash('sha256').update(output).digest('hex'),
  }])
})

test('command evidence retains the legacy content fallback and strict line prefix', async () => {
  assert.equal((await commandToolObservations({ id: 'tool-bash', kind: 'command', content: output, result: undefined })).length, 1)
  assert.equal(observationsFromText('tool-bash', `  FEISHU_AGENT_OBSERVATION ${line}\n`).length, 0)
  assert.equal(observationsFromText('tool-bash', `1\tFEISHU_AGENT_OBSERVATION ${line}\n`).length, 0)
})

test('read results cannot be promoted to command evidence', async () => {
  const assertions = await commandToolObservations({
    id: 'tool-read', kind: 'read', content: `1\tFEISHU_AGENT_OBSERVATION ${line}`,
    result: { type: 'text', file: { content: output } },
  })
  assert.deepEqual(assertions, [])
})

test('persisted Bash output replaces an inline preview and retains the complete hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-evidence-'))
  try {
    const persistedOutputPath = join(directory, 'persisted.log')
    await writeFile(persistedOutputPath, output)
    const assertions = await commandToolObservations({
      id: 'tool-large', kind: 'command', content: 'Full output saved to a file.',
      result: { stdout: 'preview without observation', persistedOutputPath },
    })
    assert.deepEqual(assertions, [{
      id: 'tool-large', line,
      sha256: createHash('sha256').update(output).digest('hex'),
    }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('SDK background command output files yield observations and hash the complete raw file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-evidence-'))
  try {
    const path = join(directory, 'output.log')
    await writeFile(path, output)
    const assertions = await observationsFromFile('tool-background', path)
    assert.deepEqual(assertions, [{
      id: 'tool-background', line,
      sha256: createHash('sha256').update(output).digest('hex'),
    }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
