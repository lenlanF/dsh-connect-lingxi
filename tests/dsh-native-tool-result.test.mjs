import test from 'node:test'
import assert from 'node:assert/strict'
import { toChatMessages, createLingxiAdapter } from '../src/adapter.mjs'
import { unavailableHostTools, recoverHostToolCalls } from '../src/host-tools.mjs'

const runCode = { name: 'run_code', description: 'DSH PTC transport',
  parameters: { type: 'object',
    required: ['code', 'description'],
    properties: {
      code: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1 },
    },
  },
}
const winBash = { name: 'win_bash', description: 'Native shell',
  parameters: { type: 'object', required: ['command'],
    properties: { command: { type: 'string' } } },
}

const toolReply = (isError, text, id = 'call_1') => ({
  role: 'tool',
  source: { kind: 'tool', callId: id },
  toolCallId: id,
  content: [{ type: 'text', text }],
  isError,
})

test('native DSH tool-role failure with message-level isError is surfaced as FAILED', () => {
  const [out] = toChatMessages({ messages: [toolReply(true, '工具run_code不存在')] })
  assert.equal(out.role, 'tool')
  assert.match(out.content, /status=FAILED/)
  assert.match(out.content, /id=call_1/)
  assert.match(out.content, /工具run_code不存在/)
})

test('native DSH successful tool-role message is clearly SUCCESS', () => {
  const [out] = toChatMessages({ messages: [toolReply(false, 'OK')] })
  assert.match(out.content, /status=SUCCESS/)
  assert.match(out.content, /OK/)
})

test('native tool failure with empty content is not silently omitted', () => {
  const [out] = toChatMessages({ messages: [toolReply(true, '')] })
  assert.ok(out)
  assert.match(out.content, /status=FAILED/)
})

test('native DSH host failure revokes only the actually missing tool', () => {
  const prior = { role: 'assistant', content: [{
    type: 'tool-call', id: 'call_1', name: 'run_code',
    arguments: JSON.stringify({ code: 'console.log(1)', description: 'Test' }),
  }] }
  assert.deepEqual([...unavailableHostTools([prior, toolReply(true, '工具run_code不存在')])], ['run_code'])
})

test('successful tool stdout quoting an error is not treated as a tool disappearance', () => {
  const previous = { role: 'assistant', content: [{
    type: 'tool-call', id: 'call_1', name: 'win_bash', arguments: '{"command":"echo OK"}',
  }] }
  assert.deepEqual([...unavailableHostTools([
    previous, toolReply(false, '工具run_code不存在'),
  ])], [])
})

test('only the current PTC transport can be called directly when that is the full tool roster', () => {
  assert.equal(recoverHostToolCalls(JSON.stringify({
    type: 'tool-call', name: 'win_bash', arguments: { command: 'echo OK' },
  }), [runCode]).status, 'invalid')
  assert.equal(recoverHostToolCalls(JSON.stringify({
    type: 'tool-call', name: 'run_code',
    arguments: { code: 'console.log(await tools.win_bash({command:"echo OK"}))',
      description: 'Verify PTC host tools' },
  }), [runCode]).status, 'calls')
})

test('native failure remains visible in subsequent upstream model prompt', async () => {
  const seen = []
  const adapter = createLingxiAdapter({
    resolveCredential: async () => ({ wpsSid: 'SYNTHETIC_TEST_ONLY' }),
    client: {
      async *chat(_c, opts) {
        seen.push(opts)
        yield { type: 'text_delta', text: 'The tool is unavailable.' }
        yield { type: 'done' }
      },
    },
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'test-model',
    tools: [runCode, winBash],
    messages: [toolReply(true, '工具run_code不存在')],
  })) chunks.push(chunk)
  assert.equal(chunks.at(-1)?.reason.kind, 'stop')
  assert.ok(seen.length === 1)
  const rendered = seen[0].messages.map((m) => m.content).join('\n')
  assert.match(rendered, /status=FAILED/)
  assert.match(rendered, /HOST TOOL NOT REGISTERED/)
  assert.doesNotMatch(rendered, /- run_code:/)
  assert.match(rendered, /- win_bash:/)
})
