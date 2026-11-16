// Offline tests for the Lingxi cowork WebSocket protocol. No live network.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CoworkFrameState,
  CoworkStreamIterator,
  buildUserInput,
  createLingxiClient,
  coworkWsUrl,
  parseCredits,
  parseModels,
  parseFrame,
} from '../src/cowork/index.mjs'

const CREDENTIAL = { wpsSid: 'unit-test-sid', source: 'manual' }
const OPTIONS = (extra = {}) => ({
  model: 'qwen3.8_flash',
  messages: [{ role: 'user', content: 'sort this list' }],
  ...extra,
})

/** Minimal injectable WebSocket fake: push-model, never touches the network. */
class FakeWebSocket {
  readyState = 1
  sent = []
  pending = []
  listeners = new Map()
  closed = false
  addEventListener(type, listener, options) {
    const arr = this.listeners.get(type) ?? []
    arr.push({ listener, once: options?.once === true })
    this.listeners.set(type, arr)
    const queued = this.pending.filter((x) => x.type === type)
    if (queued.length > 0) {
      this.pending = this.pending.filter((x) => x.type !== type)
      for (const item of queued) this.emit(type, item.event)
    }
  }
  emit(type, event = {}) {
    const entries = this.listeners.get(type) ?? []
    if (entries.length === 0) {
      this.pending.push({ type, event })
      return
    }
    for (const entry of [...entries]) {
      entry.listener(event)
      if (entry.once) this.listeners.set(type, this.listeners.get(type).filter((x) => x !== entry))
    }
  }
  frame(obj) {
    this.emit('message', { data: JSON.stringify(obj) })
  }
  send(data) {
    this.sent.push(data)
  }
  close() {
    // The protocol terminates on run.end / error frames; the fake does not
    // synthesize an extra close event (tests emit it explicitly when needed).
    this.closed = true
    this.readyState = 3
    this.emit('close', {})
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeClient(ws, fetchLike = async () => jsonResponse({ data: { session_id: 'session-42' } })) {
  const calls = []
  const client = createLingxiClient({
    transport: {
      wsFactory: (url, headers) => {
        calls.push({ kind: 'ws', url, headers })
        return ws
      },
      fetchLike: async (url, init) => {
        calls.push({ kind: 'fetch', url, init })
        return fetchLike(url, init)
      },
    },
  })
  return { client, calls }
}

function syntheticFrames(ws) {
  ws.frame({ event: 'user.input', data: {} })
  ws.frame({ event: 'run.start', data: { id: 'run-1', group_id: 'g-1' } })
  ws.frame({ event: 'component.start', data: { type: 'c_reasoning', id: 'r1' } })
  ws.frame({ event: 'component.content', data: { type: 'c_reasoning', id: 'r1', delta: 'think ' } })
  ws.frame({ event: 'component.content', data: { type: 'c_reasoning', id: 'r1', delta: 'hard' } })
  ws.frame({ event: 'component.end', data: { type: 'c_reasoning', id: 'r1', full_content: 'think hard' } })
  ws.frame({ event: 'component.start', data: { type: 'c_text', id: 't1' } })
  ws.frame({ event: 'component.content', data: { type: 'c_text', id: 't1', delta: 'Hello ' } })
  ws.frame({ event: 'component.content', data: { type: 'c_text', id: 't1', delta: 'world' } })
  ws.frame({ event: 'component.end', data: { type: 'c_text', id: 't1', full_content: 'Hello world' } })
  ws.frame({ event: 'component.start', data: { type: 'c_execute_code', id: 'x1', payload: { brief: 'demo' } } })
  ws.frame({ event: 'component.content', data: { type: 'c_execute_code', id: 'x1', delta: 'pri' } })
  ws.frame({ event: 'component.content', data: { type: 'c_execute_code', id: 'x1', delta: 'nt(1)' } })
  ws.frame({ event: 'component.end', data: {
    type: 'c_execute_code', id: 'x1',
    full_content: { arguments: { code: 'print(1)', brief: 'demo' }, output: '1\n' },
  } })
  ws.frame({ event: 'turn.end', data: { type: 'c_text', id: 't1', agent_time: 12 } })
  ws.frame({ event: 'run.end', data: { id: 'run-1', credit_consumed: 3, session_credit_consumed: 11 } })
}

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

test('synthetic frame sequence produces exact normalized event order', async () => {
  const ws = new FakeWebSocket()
  const { client, calls } = makeClient(ws)
  const stream = client.chat(CREDENTIAL, OPTIONS({ reasoningEffort: 'high' }))
  const iterator = stream[Symbol.asyncIterator]()
  const first = iterator.next()
  syntheticFrames(ws)
  const events = []
  for (let item = await first; !item.done; item = await iterator.next()) events.push(item.value)

  assert.deepEqual(events.map((e) => e.type), [
    'reasoning_delta', 'text_delta', 'tool', 'usage', 'done',
  ])
  assert.equal(events[0].text, 'think hard', 'consecutive reasoning deltas coalesce')
  assert.equal(events[1].text, 'Hello world', 'consecutive text deltas coalesce')
  assert.equal(events[2].name, 'c_execute_code')
  assert.equal(events[2].code, 'print(1)', 'tool code rendered once at component.end')
  assert.equal(events[2].output, '1\n')
  assert.match(events[2].text, /demo/)
  assert.ok(events[2].text.includes('print(1)'))
  assert.equal(events.filter((e) => e.type === 'text_delta' || e.type === 'reasoning_delta').length, 2, 'no half-written code delta events')
  assert.deepEqual(events[3].usage, { creditConsumed: 3, sessionCreditConsumed: 11 })
  assert.equal(ws.sent.length, 1)
  assert.deepEqual(JSON.parse(ws.sent[0]), buildUserInput(OPTIONS({ reasoningEffort: 'high' })))
  assert.equal(calls[0].kind, 'fetch')
  assert.equal(calls[0].url, 'https://lingxi.kdocs.cn/api/aioffice/v1/cowork/sessions')
  assert.equal(calls[0].init.headers.Cookie, 'wps_sid=unit-test-sid')
  assert.equal(calls[1].kind, 'ws')
  assert.equal(calls[1].url, coworkWsUrl('session-42'))
  assert.equal(calls[1].headers.Origin, 'https://lingxi.kdocs.cn')
  assert.equal(calls[1].headers.Cookie, 'wps_sid=unit-test-sid')
  assert.equal(ws.closed, true)
})

test('pull-style consumer does not hang on frames that produce no output', async () => {
  const ws = new FakeWebSocket()
  const { client } = makeClient(ws)
  const iterator = new CoworkStreamIterator(ws)
  iterator.start('{}')
  // Start the pull first so its waiter and listeners are installed synchronously.
  const first = iterator.next()
  // 12 leading frames that each produce zero events (README's known hang).
  for (let i = 0; i < 4; i++) {
    ws.frame({ event: 'run.start', data: { id: 'r' + i } })
    ws.frame({ event: 'component.start', data: { type: 'c_recommend', id: 'c' + i } })
    ws.frame({ event: 'turn.start', data: { agent_time: i } })
  }
  ws.frame({ event: 'component.content', data: { type: 'c_text', id: 'txt', delta: 'ok' } })
  const timeout = Symbol('timeout')
  const result = await Promise.race([
    first,
    new Promise((resolve) => setTimeout(() => resolve(timeout), 700)),
  ])
  assert.notEqual(result, timeout, 'pending pull must wake on an output frame')
  assert.deepEqual(result.value, { type: 'text_delta', text: 'ok' })
  ws.frame({ event: 'run.end', data: { credit_consumed: 1 } })
  const rest = []
  for (let item = await iterator.next(); !item.done; item = await iterator.next()) rest.push(item.value)
  assert.deepEqual(rest.map((e) => e.type), ['usage', 'done'])
})

test('interleaved deltas keep their frame order and boundary', () => {
  const state = new CoworkFrameState()
  const events = []
  for (const frame of [
    { event: 'component.content', data: { type: 'c_text', id: 'a', delta: 'A' } },
    { event: 'component.content', data: { type: 'c_reasoning', id: 'b', delta: 'B' } },
    { event: 'component.end', data: { type: 'c_read_file', id: 'c', full_content: { arguments: { path: '/tmp/x' }, output: 'data' } } },
    { event: 'component.content', data: { type: 'c_text', id: 'a', delta: 'D' } },
  ]) events.push(...state.step(frame).events)
  events.push(...state.finish())
  assert.deepEqual(events.map((e) => e.type), ['text_delta', 'reasoning_delta', 'tool', 'text_delta', 'done'])
  assert.deepEqual(events.map((e) => e.type), ['text_delta', 'reasoning_delta', 'tool', 'text_delta', 'done'])
  assert.equal(events[2].name, 'c_read_file')
  assert.deepEqual(events.map((e) => e.text ?? e.name).slice(0, 2), ['A', 'B'])
  assert.equal(events[2].code, '/tmp/x')
  assert.equal(events[2].output, 'data')
})

test('upstream error frame emits error and finishes, with no duplicate done', async () => {
  const ws = new FakeWebSocket()
  const { client } = makeClient(ws)
  const iterator = client.chat(CREDENTIAL, OPTIONS())[Symbol.asyncIterator]()
  const first = iterator.next()
  ws.frame({ event: 'run.start', data: {} })
  ws.frame({ event: 'component.content', data: { type: 'c_text', id: 't', delta: 'partial' } })
  ws.frame({ event: 'error', data: { message: 'quota exhausted', status: 429, code: 'rate_limit' } })
  const events = []
  for (let item = await first; !item.done; item = await iterator.next()) events.push(item.value)
  assert.deepEqual(events.map((e) => e.type), ['text_delta', 'error', 'done'])
  assert.equal(events[1].message, 'quota exhausted')
  assert.equal(events[1].status, 429)
  assert.equal(events[1].code, 'rate_limit')
})

test('websocket close without run.end flushes and finishes', async () => {
  const ws = new FakeWebSocket()
  const { client } = makeClient(ws)
  const iterator = client.chat(CREDENTIAL, OPTIONS())[Symbol.asyncIterator]()
  const first = iterator.next()
  ws.frame({ event: 'component.content', data: { type: 'c_text', id: 't', delta: 'tail' } })
  ws.emit('close', {})
  const events = []
  for (let item = await first; !item.done; item = await iterator.next()) events.push(item.value)
  assert.deepEqual(events.map((e) => e.type), ['text_delta', 'done'])
  assert.equal(events[0].text, 'tail')
})

test('websocket error emits error then done', async () => {
  const ws = new FakeWebSocket()
  const { client } = makeClient(ws)
  const iterator = client.chat(CREDENTIAL, OPTIONS())[Symbol.asyncIterator]()
  const first = iterator.next()
  ws.emit('error', {})
  const events = []
  for (let item = await first; !item.done; item = await iterator.next()) events.push(item.value)
  assert.deepEqual(events.map((e) => e.type), ['error', 'done'])
  assert.match(events[0].message, /websocket error/)
})

test('session creation failure emits error and done without opening a socket', async () => {
  let opened = 0
  const client = createLingxiClient({
    transport: {
      fetchLike: async () => jsonResponse({ error: 'unauthorized' }, 401),
      wsFactory: () => { opened++; return new FakeWebSocket() },
    },
  })
  const events = await collect(client.chat(CREDENTIAL, OPTIONS()))
  assert.deepEqual(events.map((e) => e.type), ['error', 'done'])
  assert.equal(events[0].status, 401)
  assert.equal(opened, 0)
})

test('abort signal terminates the stream', async () => {
  const ws = new FakeWebSocket()
  const { client } = makeClient(ws)
  const controller = new AbortController()
  const iterator = client.chat(CREDENTIAL, OPTIONS({ signal: controller.signal }))[Symbol.asyncIterator]()
  const first = iterator.next()
  controller.abort()
  const events = []
  for (let item = await first; !item.done; item = await iterator.next()) events.push(item.value)
  assert.deepEqual(events.map((e) => e.type), ['error', 'done'])
  assert.equal(events[0].code, 'aborted')
  assert.equal(ws.closed, true)
})

test('listModels and credits are best-effort and use the documented endpoints', async () => {
  const urls = []
  const client = createLingxiClient({
    transport: {
      fetchLike: async (url) => {
        urls.push(url)
        if (url.includes('/sessions/plans')) {
          return jsonResponse({ data: { models: [
            { key: 'qwen3.8_flash', name: 'Qwen', max_context_tokens: 128000, reasoning_efforts: ['high'] },
            { key: 'qwen3.8_flash', name: 'duplicate' },
            { name: 'no key' },
          ] } })
        }
        if (url.includes('/credits/balance')) {
          return jsonResponse({ data: { bonus_credits: [{ balance: 12.5 }], purchased_credits: [{ balance: 7.5 }] } })
        }
        return jsonResponse({})
      },
    },
  })
  const models = await client.listModels(CREDENTIAL)
  assert.deepEqual(models, [{ id: 'qwen3.8_flash', name: 'Qwen', contextWindow: 128000, reasoning: true, defaultEffort: 'high' }])
  assert.equal(await client.credits(CREDENTIAL), 20)
  assert.ok(urls.some((u) => u === 'https://lingxi.kdocs.cn/api/aioffice/v1/sessions/plans'))
  assert.ok(urls.some((u) => u === 'https://lingxi.kdocs.cn/api/public/v1/credits/balance?credit_type=total'))
  const failing = createLingxiClient({ transport: { fetchLike: async () => { throw new Error('offline') } } })
  assert.deepEqual(await failing.listModels(CREDENTIAL), [])
  assert.equal(await failing.credits(CREDENTIAL), -1)
  assert.deepEqual(parseModels({ data: {} }), [])
  assert.equal(parseCredits({ data: {} }), -1)
  assert.equal(parseFrame('not json'), undefined)
})

test('createLingxiClient() with no arguments is constructible and does no I/O', () => {
  const client = createLingxiClient()
  assert.equal(typeof client.chat, 'function')
  assert.equal(typeof client.listModels, 'function')
  assert.equal(typeof client.credits, 'function')
  assert.equal(typeof client.resolveCredential, 'function')
})
