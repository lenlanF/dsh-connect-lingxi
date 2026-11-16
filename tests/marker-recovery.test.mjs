import test from 'node:test'
import assert from 'node:assert/strict'
import { recoverHostToolCalls } from '../src/host-tools.mjs'
import { createLingxiAdapter, toolsPreamble } from '../src/adapter.mjs'

const TOOL = { name: 'win_bash', description: 'Run an approved host command',
  parameters: { type: 'object', properties: { command: { type: 'string', minLength: 1 } }, required: ['command'] } }
const validArgs = { command: 'echo OK' }
const validJson = JSON.stringify({ type: 'tool-call', name: TOOL.name, arguments: validArgs })
const validMarker = '<dsh_tool>' + JSON.stringify({ name: TOOL.name, arguments: validArgs }) + '</dsh_tool>'

function harness(replies) {
  const inputs = []
  let index = 0
  const adapter = createLingxiAdapter({
    resolveCredential: async () => ({ wpsSid: 'SYNTHETIC_ONLY' }),
    client: {
      async *chat(_credential, options) {
        inputs.push(options)
        const response = replies[index++]
        if (response == null) throw new Error('Unexpected additional upstream round')
        yield { type: 'text_delta', text: response }
        yield { type: 'done' }
      },
    },
  })
  return { adapter, inputs }
}

async function collect(adapter) {
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'offline-test', tools: [TOOL],
    messages: [{ role: 'user', content: 'Run authorized echo command' }],
  })) chunks.push(chunk)
  return chunks
}

test('malformed tool marker framing is repairable but never emits host calls', () => {
  for (const response of [
    '<dsh_tool>{"name":"win_bash","arguments":{"command":"echo OK"}}',
    '{"name":"win_bash","arguments":{"command":"echo OK"}}</dsh_tool>',
    '<dsh_tool><dsh_tool>{"name":"win_bash","arguments":{"command":"echo OK"}}</dsh_tool>',
    validMarker + '</dsh_tool>',
    '<dsh_tool>{"name":"win_bash","arguments":{broken}}</dsh_tool>',
  ]) {
    const result = recoverHostToolCalls(response, [TOOL])
    assert.equal(result.status, 'invalid', response)
    assert.equal(result.repairable, true, response)
    assert.deepEqual(result.calls, [], response)
  }
})

test('malformed marker self-repairs with a complete JSON envelope', async () => {
  const { adapter, inputs } = harness([
    '<dsh_tool>{"name":"win_bash","arguments":{"command":"echo OK"}}',
    validJson,
  ])
  const chunks = await collect(adapter)
  assert.equal(inputs.length, 2)
  assert.ok(inputs[1].messages.some((m) => m.role === 'system' &&
    m.content.includes('was NOT executed') && m.content.includes('complete JSON')))
  const calls = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'win_bash')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.equal(chunks.filter((c) => c.type === 'text-delta').length, 0)
})

test('persistent malformed markers fail closed after bounded retries', async () => {
  const invalid = '<dsh_tool>{"name":"win_bash","arguments":{"command":"echo OK"}}'
  const { adapter, inputs } = harness([invalid, invalid, invalid])
  const chunks = await collect(adapter)
  assert.equal(inputs.length, 3)
  assert.equal(chunks.filter((c) => c.type === 'tool-call-delta').length, 0)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'TOOL_PROTOCOL')
  assert.match(chunks.at(-1).reason.failure.message, /Malformed DSH tool marker/)
})

test('tool preamble specifies complete JSON without invalid XML placeholder examples', () => {
  const protocol = toolsPreamble([TOOL])
  assert.match(protocol, /complete JSON/)
  assert.match(protocol, /"type":"tool-call"/)
  assert.doesNotMatch(protocol, /<json object>/)
  assert.doesNotMatch(protocol, /<tool_name>/)
})

test('complete JSON envelope with literal marker string in a command is valid', () => {
  const command = 'echo "<dsh_tool>"'
  const response = JSON.stringify({ type: 'tool-call', name: 'win_bash', arguments: { command } })
  const result = recoverHostToolCalls(response, [TOOL])
  assert.equal(result.status, 'calls')
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { command })
})

test('fenced documentation marker is not promoted to host execution', () => {
  const fence = String.fromCharCode(96).repeat(3)
  const response = 'Documentation:\n' + fence + 'xml\n' + validMarker + '\n' + fence
  const result = recoverHostToolCalls(response, [TOOL])
  assert.notEqual(result.status, 'calls')
  assert.deepEqual(result.calls, [])
})

test('quoted fenced marker plus real marker is rejected atomically', () => {
  const fence = String.fromCharCode(96).repeat(3)
  const response = fence + 'xml\n' + validMarker + '\n' + fence + '\n' + validMarker
  const result = recoverHostToolCalls(response, [TOOL])
  assert.equal(result.status, 'invalid')
  assert.equal(result.repairable, true)
  assert.deepEqual(result.calls, [])
})

test('valid paired marker is still recognized for legacy turns', () => {
  const result = recoverHostToolCalls(validMarker, [TOOL])
  assert.equal(result.status, 'calls')
  assert.equal(result.calls[0].name, 'win_bash')
})
