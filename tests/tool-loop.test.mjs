import test from 'node:test'
import assert from 'node:assert/strict'
import { createLingxiAdapter } from '../src/adapter.mjs'

const TOOL = { name: 'run_code', description: 'Execute host code after approval',
  parameters: { type: 'object', properties: { code: { type: 'string' } } } }
const CREDENTIAL = { wpsSid: 'fake' }

async function collect(iterable) {
  const values = []
  for await (const chunk of iterable) values.push(chunk)
  return values
}

function adapterFor(responses) {
  let turns = 0
  const requests = []
  const client = {
    async listModels() { return [{ id: 'model-1', name: 'Model 1' }] },
    async *chat(_credential, opts) {
      requests.push(opts)
      const output = responses[turns++]
      for (const part of Array.isArray(output) ? output : [output]) {
        yield typeof part === 'string' ? { type: 'text_delta', text: part } : part
      }
      yield { type: 'done' }
    },
  }
  return { adapter: createLingxiAdapter({ client, resolveCredential: async () => CREDENTIAL }), requests }
}

test('raw DSH run_code response becomes a real tool call and later real result reaches the model', async () => {
  const code = 'const answer = 40 + 2;'
  const raw = JSON.stringify({ type: 'tool-call', id: 'external', name: 'run_code', arguments: JSON.stringify({ code }) })
  const { adapter, requests } = adapterFor([raw, 'The tool returned 42'])
  const opts = { model: 'model-1', system: 'safe task', tools: [TOOL],
    messages: [{ role: 'user', content: 'Calculate using run_code' }] }
  const first = await collect(adapter.stream(opts))
  const block = first.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')?.block
  assert.ok(block)
  assert.equal(block.name, 'run_code')
  assert.deepEqual(JSON.parse(block.arguments), { code })
  assert.match(block.id, /^call_/)
  assert.equal(first.at(-1).reason.kind, 'tool-calls')
  assert.equal(first.filter((c) => c.type === 'text-delta').length, 0, 'do not expose raw JSON')
  assert.match(requests[0].messages[0].content, /run_code/)
  // This is the host's permission boundary: the plugin only produces a call.
  // In this fixture we simulate the host granting permission and returning 42.
  const second = await collect(adapter.stream({ ...opts, messages: [
    ...opts.messages,
    { role: 'assistant', content: [{ type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: block.id, content: { stdout: '42', exitCode: 0 } }] },
  ] }))
  assert.equal(second.at(-1).reason.kind, 'stop')
  assert.equal(second.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'The tool returned 42')
  const sent = requests[1].messages.map((m) => m.content).join('\n')
  assert.match(sent, /DSH tool result/)
  assert.match(sent, /"stdout":"42"/)
})

test('unknown tool names and invalid argument JSON never reach DSH execution', async () => {
  for (const raw of [
    '{"type":"tool-call","name":"unapproved_bash","arguments":{}}',
    '{"type":"tool-call","name":"run_code","arguments":"not JSON"}',
    '<dsh_tool>{"name":"run_code","arguments":[1]}</dsh_tool>',
  ]) {
    const { adapter } = adapterFor([raw])
    const output = await collect(adapter.stream({ model: 'model-1', tools: [TOOL], messages: [] }))
    assert.equal(output.at(-1).reason.kind, 'error')
    assert.equal(output.filter((x) => x.type === 'tool-call-delta').length, 0)
    assert.equal(output.filter((x) => x.type === 'text-delta').length, 0)
  }
})

test('text describing a tool-call example is not treated as a real action', async () => {
  const { adapter } = adapterFor(['For example: {"type":"tool-call","name":"run_code","arguments":{}}'])
  const out = await collect(adapter.stream({ model: 'model-1', tools: [TOOL], messages: [] }))
  assert.equal(out.at(-1).reason.kind, 'stop')
  assert.equal(out.filter((x) => x.type === 'tool-call-delta').length, 0)
})

test('an upstream cloud sandbox cannot hide behind a valid DSH tool call', async () => {
  const { adapter } = adapterFor([[
    { type: 'tool', name: 'c_execute_code', output: 'untrusted result' },
    '{"type":"tool-call","name":"run_code","arguments":{"code":"1+1"}}',
  ], '<dsh_tool>{"name":"run_code","arguments":{"code":"1+1"}}</dsh_tool>'])
  const out = await collect(adapter.stream({ model: 'model-1', tools: [TOOL], messages: [] }))
  assert.equal(out.at(-1).reason.kind, 'tool-calls')
  assert.equal(out.filter((x) => x.type === 'tool-call-delta').length, 1)
  assert.ok(!out.some((x) => x.text?.includes('untrusted')))
})
