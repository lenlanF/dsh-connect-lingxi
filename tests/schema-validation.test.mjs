import test from 'node:test'
import assert from 'node:assert/strict'
import { recoverHostToolCalls, validateToolArguments, visibleTools } from '../src/host-tools.mjs'
import { createLingxiAdapter, toChatMessages, toolsPreamble } from '../src/adapter.mjs'

const RUN_CODE = {
  name: 'run_code',
  description: 'Run code through the DSH host with human-readable purpose',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1 },
    },
    required: ['code', 'description'],
    additionalProperties: false,
  },
}

const rawCall = (arguments_) => JSON.stringify({
  type: 'tool-call',
  name: 'run_code',
  arguments: arguments_,
})

function fakeAdapter(replies) {
  const requests = []
  let at = 0
  const adapter = createLingxiAdapter({
    client: {
      async *chat(_cred, options) {
        requests.push(options)
        const text = replies[at++]
        if (typeof text !== 'string') throw new Error('Unexpected extra upstream round')
        yield { type: 'text_delta', text }
        yield { type: 'done' }
      },
      async listModels() { return [] },
    },
    resolveCredential: async () => ({ wpsSid: 'SYNTHETIC_TEST_ONLY' }),
  })
  return { adapter, requests }
}

async function collect(stream) {
  const result = []
  for await (const event of stream) result.push(event)
  return result
}

test('the exact run_code missing code and description case is rejected locally', () => {
  for (const args of [{}, { code: 'console.log("OK")' }, { description: 'test' }]) {
    const verdict = recoverHostToolCalls(rawCall(args), [RUN_CODE])
    assert.equal(verdict.status, 'invalid')
    assert.equal(verdict.repairable, true)
    assert.match(verdict.message, /missing required/)
    assert.equal(verdict.calls.length, 0)
  }
  const both = recoverHostToolCalls(rawCall({}), [RUN_CODE])
  assert.match(both.message, /"code"/)
  assert.match(both.message, /"description"/)
})

test('the model sees the required arguments clearly ahead of truncated schema', () => {
  const text = toolsPreamble([RUN_CODE])
  assert.match(text, /REQUIRED ARGUMENTS: \["code","description"\]/)
  assert.match(text, /include EVERY required argument/)
  assert.match(text, /Never claim command execution was successful/)
  assert.match(text, /\[DSH tool result/)
  assert.deepEqual(visibleTools([RUN_CODE])[0].parameters.required, ['code', 'description'])
})

test('the schema validator enforces known types, nonempty fields and strict unknown properties', () => {
  const schema = RUN_CODE.parameters
  assert.match(validateToolArguments({ code: 123, description: 'work' }, schema), /arguments.code: expected string/)
  assert.match(validateToolArguments({ code: '', description: 'work' }, schema), /arguments.code: requires at least 1 characters/)
  assert.match(validateToolArguments({ code: 'print(1)', description: 'work', risky: true }, schema), /unsupported property/)
  assert.equal(validateToolArguments({ code: 'print(1)', description: 'work' }, schema), null)
  assert.equal(recoverHostToolCalls(rawCall({ code: 'print(1)', description: 'work' }), [RUN_CODE]).status, 'calls')
})

test('nested objects, arrays and enum constraints are checked before the host receives them', () => {
  const schema = {
    type: 'object',
    required: ['job'],
    properties: {
      job: { type: 'object', required: ['actions'], properties: {
        actions: { type: 'array', minItems: 1, items: {
          type: 'object',
          required: ['mode'],
          properties: { mode: { enum: ['safe', 'dry-run'] } },
        } },
      } },
    },
  }
  assert.match(validateToolArguments({ job: { actions: [] } }, schema), /at least 1 items/)
  assert.match(validateToolArguments({ job: { actions: [{ mode: 'unsafe' }] } }, schema), /allowed enum/)
  assert.equal(validateToolArguments({ job: { actions: [{ mode: 'dry-run' }] } }, schema), null)
})

test('the model can correct missing code and description without any invalid host tool call', async () => {
  const valid = { code: 'console.log("OK")', description: 'Verify tool invocation works' }
  const { adapter, requests } = fakeAdapter([rawCall({}), rawCall(valid)])
  const events = await collect(adapter.stream({
    model: 'unit-test-model', tools: [RUN_CODE],
    messages: [{ role: 'user', content: 'Test code execution.' }],
  }))
  assert.equal(requests.length, 2)
  assert.ok(requests[1].messages.some((msg) =>
    msg.role === 'system' && msg.content.includes('[TOOL ARGUMENT VALIDATION FAILED]') &&
    msg.content.includes('"code"') && msg.content.includes('"description"')))
  assert.equal(events.filter((event) => event.type === 'tool-call-delta').length, 1)
  const call = events.find((event) => event.type === 'block-end' && event.block?.type === 'tool-call')?.block
  assert.ok(call)
  assert.equal(call.name, 'run_code')
  assert.deepEqual(JSON.parse(call.arguments), valid)
  assert.equal(events.at(-1).reason.kind, 'tool-calls')
  assert.equal(events.filter((event) => event.type === 'text-delta').length, 0)
})

test('persistently invalid required arguments fail closed after bounded retries', async () => {
  const { adapter, requests } = fakeAdapter([rawCall({}), rawCall({}), rawCall({})])
  const events = await collect(adapter.stream({ model: 'unit-test-model', tools: [RUN_CODE], messages: [] }))
  assert.equal(requests.length, 3)
  assert.equal(events.filter((event) => event.type === 'tool-call-delta').length, 0)
  assert.equal(events.at(-1).reason.kind, 'error')
  assert.equal(events.at(-1).reason.failure.code, 'TOOL_PROTOCOL')
  assert.match(events.at(-1).reason.failure.message, /missing required/)
})

test('a failing DSH tool result is explicitly marked failed, rather than advertised as a success', () => {
  const output = toChatMessages({ messages: [
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'call_1', name: 'run_code',
        content: { exitCode: 1, stderr: 'Error: missing required property "description"' } },
    ] },
  ] })
  assert.equal(output[0].role, 'tool')
  assert.match(output[0].content, /status=FAILED/)
  assert.match(output[0].content, /exitCode":1/)
  assert.match(output[0].content, /missing required property/)
  assert.match(toolsPreamble([RUN_CODE]), /If a tool returns an error.*report the failure explicitly/)
  const confirmed = toChatMessages({ messages: [{ role: 'tool', content: [{ type: 'tool-result',
    name: 'run_code', content: { exitCode: 0, stdout: 'OK' } }] }] })
  assert.match(confirmed[0].content, /status=SUCCESS/)
  assert.match(confirmed[0].content, /stdout":"OK/)
})