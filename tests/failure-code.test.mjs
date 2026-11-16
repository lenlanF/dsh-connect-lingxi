import test from 'node:test'
import assert from 'node:assert/strict'
import { createLingxiAdapter } from '../src/adapter.mjs'

const offeredTool = { name: 'run_code', description: 'DSH host code',
  parameters: { type: 'object', properties: { code: { type: 'string' } } } }

function buildAdapter(events, { credentialError } = {}) {
  const client = {
    async *chat() {
      for (const event of events) {
        if (typeof event === 'function') yield event()
        else yield event
      }
    },
    async listModels() { return [] },
  }
  return createLingxiAdapter({
    client,
    resolveCredential: async () => {
      if (credentialError) throw credentialError
      return { wpsSid: 'fake-test-sid' }
    },
    logger: { info() {}, warn() {}, error() {} },
  })
}

async function finishFrom(adapter, options = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({ model: 'unit-model', messages: [], ...options })) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish', 'last stream event must be a finish event')
  if (finish.reason.kind === 'error' || finish.reason.kind === 'aborted') {
    assert.equal(typeof finish.reason.failure?.code, 'string', 'DSH LlmError needs a string failure.code')
    assert.ok(finish.reason.failure.code.length > 0, 'DSH LlmError code must be a non-empty string')
    assert.equal(typeof finish.reason.failure.message, 'string')
  }
  return { finish, chunks }
}

test('upstream errors have valid DSH failure codes and preserve real causes', async () => {
  const examples = [
    { status: 401, code: 'MISSING_CREDENTIAL', message: 'cookie expired' },
    { status: 403, code: 'MISSING_CREDENTIAL', message: 'forbidden' },
    { status: 429, code: 'RATE_LIMIT', message: 'throttled' },
    { status: 500, code: 'SERVER', message: 'gateway offline' },
    { status: undefined, code: 'TRANSPORT', message: 'network failed' },
  ]
  for (const item of examples) {
    const adapter = buildAdapter([{ type: 'error', status: item.status, message: item.message }])
    const { finish } = await finishFrom(adapter)
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, item.code)
    assert.match(finish.reason.failure.message, new RegExp(item.message))
  }
})

test('invalid and unavailable external tools have a TOOL_PROTOCOL code, not a blank LlmError code', async () => {
  const responses = [
    '<dsh_tool>{"name":"unsafe_tool","arguments":{}}</dsh_tool>',
    '{"type":"tool-call","name":"run_code","arguments":"bad json"}',
  ]
  for (const response of responses) {
    const adapter = buildAdapter([{ type: 'text_delta', text: response }])
    const { finish, chunks } = await finishFrom(adapter, { tools: [offeredTool] })
    assert.equal(finish.reason.failure.code, 'TOOL_PROTOCOL')
    assert.equal(chunks.some((x) => x.type === 'tool-call-delta'), false)
  }
})

test('unapproved cloud sandbox and protocol-round exhaustion emit valid TOOL_PROTOCOL code', async () => {
  const adapter = buildAdapter([{ type: 'tool', name: 'c_execute_code', code: 'x', output: 'x' }])
  const noTools = await finishFrom(adapter)
  assert.equal(noTools.finish.reason.failure.code, 'TOOL_PROTOCOL')

  const refused = await finishFrom(adapter, { tools: [offeredTool] })
  assert.equal(refused.finish.reason.failure.code, 'TOOL_PROTOCOL')
  assert.match(refused.finish.reason.failure.message, /cloud sandbox.*3 turns/)})

test('aborted turns include a failure code accepted by DSH error wrapping', async () => {
  const controller = new AbortController()
  const adapter = buildAdapter([() => { controller.abort(); return { type: 'text_delta', text: 'partial' } }])
  const { finish } = await finishFrom(adapter, { signal: controller.signal, tools: [offeredTool] })
  assert.equal(finish.reason.kind, 'aborted')
  assert.equal(finish.reason.failure.code, 'ABORTED')
})

test('unexpected transport exceptions are converted to coded finish/error instead of uncaught rejection', async () => {
  const client = {
    async *chat() { throw new Error('socket closed without finish') },
    async listModels() { return [] },
  }
  const adapter = createLingxiAdapter({ client, resolveCredential: async () => ({ wpsSid: 'fake' }) })
  const { finish } = await finishFrom(adapter)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TRANSPORT')
  assert.match(finish.reason.failure.message, /socket closed/)
})

test('credential resolution failures map to MISSING_CREDENTIAL instead of throwing uncoded errors', async () => {
  const cause = new Error('no local login found')
  cause.code = 'LINGXI_CREDENTIAL_UNAVAILABLE'
  const { finish } = await finishFrom(buildAdapter([], { credentialError: cause }))
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'MISSING_CREDENTIAL')
  assert.match(finish.reason.failure.message, /no local login found/)
})

test('normal answers and valid tool calls still use stop and tool-calls without error wrapping', async () => {
  const answer = await finishFrom(buildAdapter([{ type: 'text_delta', text: 'hello' }]))
  assert.equal(answer.finish.reason.kind, 'stop')
  const call = await finishFrom(buildAdapter([
    { type: 'text_delta', text: '{"type":"tool-call","name":"run_code","arguments":{"code":"return 42"}}' },
  ]), { tools: [offeredTool] })
  assert.equal(call.finish.reason.kind, 'tool-calls')
  assert.equal(call.chunks.filter((chunk) => chunk.type === 'tool-call-delta').length, 1)
})
