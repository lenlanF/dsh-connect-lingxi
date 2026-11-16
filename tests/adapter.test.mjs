import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLingxiAdapter, flattenContent, toChatMessages, toolsPreamble, parseToolCalls, stripToolMarkers } from '../src/adapter.mjs'

const credential = { wpsSid: 'test-only', source: 'manual' }

function fakeClient(events) {
  return {
    async listModels() { return [{ id: 'qwen3.8_flash', name: 'Qwen3.8 Flash', contextWindow: 128000 }] },
    async credits() { return 8000 },
    async *chat(_credential, options) {
      fakeClient.lastOptions = options
      for (const event of events) yield event
    },
    resolveCredential: async () => credential,
  }
}

function adapterFor(events, onUsage) {
  const client = fakeClient(events)
  return createLingxiAdapter({ client, resolveCredential: async () => credential, onUsage })
}

async function collect(gen) {
  const chunks = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

test('flattenContent handles strings, text blocks, tool calls and images', () => {
  assert.equal(flattenContent('hello'), 'hello')
  assert.equal(flattenContent([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }]), 'a\nb')
  assert.match(flattenContent([{ type: 'tool-call', name: 'bash', arguments: '{}' }]), /previous tool call/)
  assert.match(flattenContent([{ type: 'image' }]), /attachment omitted/)
})

test('toChatMessages prepends system and maps developer role', () => {
  const out = toChatMessages({
    system: 'SYS',
    messages: [
      { role: 'developer', content: [{ type: 'text', text: 'DEV' }] },
      { role: 'user', content: 'ASK' },
    ],
  })
  assert.deepEqual(out.map((m) => m.role), ['system', 'system', 'user'])
  assert.equal(out[2].content, 'ASK')
})

test('stream maps Lingxi events to DSH StreamChunk in order', async () => {
  const usage = []
  const adapter = adapterFor([
    { type: 'reasoning_delta', text: 'think' },
    { type: 'text_delta', text: 'hello' },
    { type: 'text_delta', text: ' world' },
    { type: 'tool', name: 'c_execute_code', code: 'print(1)', output: '1\n', text: '' },
    { type: 'usage', usage: { sessionCreditConsumed: 12 } },
    { type: 'done' },
  ], (u) => usage.push(u))

  const chunks = await collect(adapter.stream({
    provider: 'lingxi', model: 'qwen3.8_flash', system: 'SYS',
    messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high',
  }))

  // Forced protocol: one upstream turn is buffered, then emitted. Reasoning
  // deltas are internal; sandbox tool output is NEVER released to the host.
  assert.equal(chunks.at(-1).reason.kind, 'error', 'unapproved cloud sandbox activity is not a DSH host tool')
  assert.ok(!chunks.some((c) => c.type === 'text-delta' && c.text.includes('hello')))
  assert.ok(!chunks.some((c) => c.type === 'text-delta' && c.text.includes('c_execute_code')), 'cloud sandbox output must be blocked')
  assert.ok(!chunks.some((c) => c.type === 'reasoning-delta'), 'reasoning is internal in forced mode')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.ok(['stop','error'].includes(chunks.at(-1).reason.kind))
  assert.deepEqual(usage, [{ sessionCreditConsumed: 12 }])
  assert.equal(fakeClient.lastOptions.reasoningEffort, 'high')
  assert.equal(fakeClient.lastOptions.messages[0].role, 'system')
})

test('stream still finishes when upstream emits no content frames', async () => {
  const adapter = adapterFor([{ type: 'usage', usage: {} }, { type: 'done' }])
  const chunks = await collect(adapter.stream({ provider: 'lingxi', model: 'm', messages: [] }))
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }])
})

test('stream surfaces upstream error as finish:error (never throws)', async () => {
  const adapter = adapterFor([
    { type: 'text_delta', text: 'partial' },
    { type: 'error', message: 'session dead', status: 401 },
  ])
  const chunks = await collect(adapter.stream({ provider: 'lingxi', model: 'm', messages: [] }))
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /session dead/)
})

test('listModels returns catalog from client and caches it', async () => {
  let calls = 0
  const client = {
    ...fakeClient([]),
    async listModels() { calls++; return [{ id: 'kimi-k3', name: 'Kimi K3' }] },
  }
  const adapter = createLingxiAdapter({ client, resolveCredential: async () => credential })
  const a = await adapter.listModels('lingxi')
  const b = await adapter.listModels('lingxi')
  assert.deepEqual(a, b)
  assert.equal(a[0].id, 'kimi-k3')
  assert.equal(calls, 1)
  assert.deepEqual(adapter.providerInfo('lingxi'), { id: 'lingxi', name: 'WPS 灵犀' })
})

// --- option C: host tool bridging ---
test('toolsPreamble declares host ToolSchema list', () => {
  const p = toolsPreamble([{ name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }])
  assert.match(p, /TOOL PROTOCOL/)
  assert.match(p, /read_file/)
  assert.match(p, /"type":"tool-call"/)
  assert.equal(toolsPreamble([]), '')
  assert.equal(toolsPreamble(undefined), '')
})

test('parseToolCalls parses marker, ignores malformed/unknown', () => {
  const text = 'before <dsh_tool>{"name":"bash","arguments":{"cmd":"echo hi"}}</dsh_tool> after <dsh_tool>{bad</dsh_tool>'
  const calls = parseToolCalls(text)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'bash')
  assert.deepEqual(JSON.parse(calls[0].arguments), { cmd: 'echo hi' })
  assert.equal(stripToolMarkers(text), 'before  after')
})

test('stream emits tool-call-delta and tool-calls finish for host tools', async () => {
  const emitted = []
  async function* fakeChat() {
    yield { type: 'text_delta', text: 'Let me check. ' }
    yield { type: 'text_delta', text: '<dsh_tool>{"name":"read_file","arguments":{"path":"/etc/hosts"}}</dsh_tool>' }
    yield { type: 'done' }
  }
  const client = { chat: () => fakeChat(), listModels: async () => [] }
  const ad = createLingxiAdapter({ client, resolveCredential: async () => ({ wpsSid: 'x' }), logger: {info:()=>{},warn:()=>{},error:()=>{}} })
  for await (const chunk of ad.stream({ model: 'm', messages: [{ role: 'user', content: 'read /etc/hosts' }], tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }] })) emitted.push(chunk)
  const kinds = emitted.map(c => c.type)
  assert.ok(kinds.includes('tool-call-delta'), 'must emit tool-call-delta')
  assert.ok(kinds.includes('block-end'), 'must close blocks')
  const delta = emitted.find(c => c.type === 'tool-call-delta')
  assert.equal(delta.name, 'read_file')
  assert.equal(delta.argumentsDelta, '{"path":"/etc/hosts"}')
  const finish = emitted.find(c => c.type === 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
  // marker text must not leak as prose
  assert.ok(!emitted.some(c => c.type === 'text-delta' && c.text.includes('dsh_tool')))
})

test('stream without tool calls stays a normal stop turn', async () => {
  async function* fakeChat() { yield { type: 'text_delta', text: 'Hello' }; yield { type: 'done' } }
  const client = { chat: () => fakeChat(), listModels: async () => [] }
  const ad = createLingxiAdapter({ client, resolveCredential: async () => ({ wpsSid: 'x' }), logger: {info:()=>{},warn:()=>{},error:()=>{}} })
  const out = []
  for await (const chunk of ad.stream({ model: 'm', messages: [], tools: [{ name: 'x', description: 'y', parameters: {} }] })) out.push(chunk)
  assert.ok(!out.some(c => c.type === 'tool-call-delta'))
  assert.equal(out.find(c => c.type === 'finish').reason.kind, 'stop')
  assert.equal(out.find(c => c.type === 'text-delta').text, 'Hello')
})

test('100% force: cloud sandbox output is blocked, then corrected to host tool call', async () => {
  let turn = 0
  const client = {
    listModels: async () => [],
    chat: async function* () {
      turn++
      if (turn === 1) {
        yield { type: 'tool', name: 'c_execute_code', code: 'print(secret)', output: 'LEAK' }
        yield { type: 'text_delta', text: 'I ran it myself: LEAK' }
        yield { type: 'done' }
      } else {
        yield { type: 'text_delta', text: '<dsh_tool>{"name":"bash","arguments":{"cmd":"echo ok"}}</dsh_tool>' }
        yield { type: 'done' }
      }
    },
  }
  const ad = createLingxiAdapter({ client, resolveCredential: async () => ({ wpsSid: 'x' }), logger: {info:()=>{},warn:()=>{},error:()=>{}} })
  const out = []
  for await (const c of ad.stream({ model: 'm', messages: [{role:'user',content:'run something'}], tools: [{name:'bash',description:'run',parameters:{type:'object'}}] })) out.push(c)
  assert.equal(turn, 2, 'must send a correction round')
  assert.ok(!out.some(c => c.type === 'text-delta' && /LEAK|c_execute_code/.test(c.text)), 'sandbox output never released')
  assert.ok(out.some(c => c.type === 'tool-call-delta' && c.name === 'bash'))
  assert.equal(out.at(-1).reason.kind, 'tool-calls')
})

test('100% force: persistent sandbox refusal converges to error, nothing leaks', async () => {
  const client = {
    listModels: async () => [],
    chat: async function* () {
      yield { type: 'tool', name: 'c_execute_code', output: 'SECRET' }
      yield { type: 'done' }
    },
  }
  const ad = createLingxiAdapter({ client, resolveCredential: async () => ({ wpsSid: 'x' }), logger: {info:()=>{},warn:()=>{},error:()=>{}} })
  const out = []
  for await (const c of ad.stream({ model: 'm', messages: [], tools: [{name:'bash',description:'run',parameters:{}}] })) out.push(c)
  assert.equal(out.at(-1).type, 'finish')
  assert.equal(out.at(-1).reason.kind, 'error')
  assert.ok(!out.some(c => c.type === 'text-delta' && /SECRET/.test(c.text)))
  assert.ok(!out.some(c => c.type === 'tool-call-delta'))
})