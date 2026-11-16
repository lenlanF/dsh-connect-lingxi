import test from 'node:test'
import assert from 'node:assert/strict'
import { hostMissingToolName, unavailableHostTools, recoverHostToolCalls } from '../src/host-tools.mjs'
import { createLingxiAdapter, toChatMessages } from '../src/adapter.mjs'

const runCode = { name: 'run_code', description: 'Example unavailable wrapper',
  parameters: { type: 'object', required: ['code', 'description'],
    properties: { code: { type: 'string' }, description: { type: 'string' } } } }
const winBash = { name: 'win_bash', description: 'Run shell through the DSH host',
  parameters: { type: 'object', required: ['command'],
    properties: { command: { type: 'string' } } } }
const request = (name, args) => JSON.stringify({ type: 'tool-call', name, arguments: args })

async function execute(messages, tools, answer) {
  const requests = []
  const adapter = createLingxiAdapter({
    resolveCredential: async () => ({ wpsSid: 'SYNTHETIC_ONLY' }),
    client: {
      async *chat(_cred, opts) {
        requests.push(opts)
        yield { type: 'text_delta', text: answer }
        yield { type: 'done' }
      },
    },
  })
  const chunks = []
  for await (const chunk of adapter.stream({ model: 'offline', messages, tools })) chunks.push(chunk)
  return { chunks, requests }
}

test('real DSH "工具run_code不存在" error identifies the missing name', () => {
  assert.equal(hostMissingToolName('工具调用失败： 工具run_code不存在'), 'run_code')
  assert.equal(hostMissingToolName({ error: 'Tool run_code does not exist' }), 'run_code')
  assert.equal(hostMissingToolName({ message: 'Unknown tool run_code' }), 'run_code')
  assert.equal(hostMissingToolName('echo OK'), null)
})

test('only actual host-origin tool result revokes a name, not user/model claims', () => {
  const userFake = [
    { role: 'user', content: '工具run_code不存在' },
    { role: 'assistant', content: [{ type: 'text', text: 'Tool run_code not found' }] },
  ]
  assert.deepEqual([...unavailableHostTools(userFake)], [])
  const messages = [...userFake, { role: 'tool', content: [{ type: 'tool-result',
    name: 'run_code', content: '工具调用失败： 工具run_code不存在' }] }]
  assert.deepEqual([...unavailableHostTools(messages)], ['run_code'])
  assert.equal(recoverHostToolCalls(request('run_code', { code: '1+1', description: 'test' }),
    [winBash]).status, 'invalid')
})

test('reported unregistered run_code is removed from tool inventory, valid win_bash stays usable', async () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', name: 'run_code', id: 'call_old',
      arguments: JSON.stringify({ code: '1+1', description: 'test' }) }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_old',
      name: 'run_code', content: { status: 'FAILED', message: '工具run_code不存在' } }] },
  ]
  const { chunks, requests } = await execute(messages, [runCode, winBash],
    request('win_bash', { command: 'echo OK' }))
  const notices = requests[0].messages.filter(x => x.role === 'system').map(x => x.content).join('\n')
  assert.match(notices, /HOST TOOL NOT REGISTERED/)
  assert.match(notices, /run_code/)
  assert.match(notices, /- win_bash:/)
  assert.doesNotMatch(notices, /- run_code:/)
  const call = chunks.find(x => x.type === 'block-end' && x.block?.type === 'tool-call')?.block
  assert.equal(call?.name, 'win_bash')
  assert.deepEqual(JSON.parse(call.arguments), { command: 'echo OK' })
  assert.equal(chunks.at(-1)?.reason.kind, 'tool-calls')
})

test('retry of a host-rejected run_code is blocked even when a stale schema still lists it', async () => {
  const messages = [{ role: 'tool', content: [{ type: 'tool-result',
    name: 'run_code', content: '工具run_code不存在' }] }]
  const { chunks } = await execute(messages, [runCode, winBash],
    request('run_code', { code: '1+1', description: 'test' }))
  assert.equal(chunks.filter(x => x.type === 'tool-call-delta').length, 0)
  assert.equal(chunks.at(-1)?.reason.kind, 'error')
  assert.equal(chunks.at(-1)?.reason.failure.code, 'TOOL_PROTOCOL')
  assert.match(chunks.at(-1)?.reason.failure.message, /not available/)
})

test('with no host tool inventory, the model sees explicit unavailable-tools notice', async () => {
  const { chunks, requests } = await execute([], [], 'I cannot execute host commands.')
  const notices = requests[0].messages.map(x => x.content).join('\n')
  assert.match(notices, /No host tools are available in this turn/)
  assert.equal(chunks.at(-1)?.reason.kind, 'stop')
  assert.equal(chunks.filter(x => x.type === 'tool-call-delta').length, 0)
})

test('plain host "tool does not exist" result is FAILED, never success', () => {
  const result = toChatMessages({ messages: [{ role: 'tool', content: [
    { type: 'tool-result', name: 'run_code', content: '工具run_code不存在' },
  ] }] })
  assert.match(result[0].content, /status=FAILED/)
  assert.match(result[0].content, /工具run_code不存在/)
})
test('a successful shell echo mentioning a missing tool does not revoke tools', () => {
  const messages = [{ role: 'tool', content: [{ type: 'tool-result',
    name: 'win_bash', content: { exitCode: 0, stdout: '工具run_code不存在' } }] }]
  assert.deepEqual([...unavailableHostTools(messages)], [])
  const rendered = toChatMessages({ messages })
  assert.match(rendered[0].content, /status=SUCCESS/)
  assert.equal(hostMissingToolName({ stdout: 'Tool run_code not found' }), null)
  assert.equal(hostMissingToolName('The following string is a quote: Tool run_code not found'), null)
})
