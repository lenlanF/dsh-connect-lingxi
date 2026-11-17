import assert from 'node:assert/strict'
import test from 'node:test'
import { createLingxiAdapter, toolDiscoveryGuidance } from '../src/adapter.mjs'

const CREDENTIAL = { wpsSid: 'SYNTHETIC_ONLY' }
const bash = { name: 'bash', description: 'host shell', parameters: { type: 'object',
  properties: { command: { type: 'string' } }, required: ['command'] } }
const todo = { name: 'todo_write', description: 'host todo management', parameters: { type: 'object',
  properties: { todos: { type: 'array' } }, required: ['todos'] } }
const market = { name: 'plugin_market', description: 'Search available plugin bundles', parameters: { type: 'object',
  properties: { query: { type: 'string' } }, required: ['query'] } }
const manager = { name: 'plugin_manager', description: 'Manage host plugins', parameters: { type: 'object',
  properties: { action: { type: 'string' } }, required: ['action'] } }

function adapterWith(upstream, logger) {
  const seen = []
  const client = {
    async listModels() { return [] },
    async *chatNative(_credential, options) {
      seen.push(options)
      yield* upstream(options, seen.length)
    },
  }
  return { seen, adapter: createLingxiAdapter({ client, logger, resolveCredential: async () => CREDENTIAL }) }
}
async function chunksOf(adapter, tools, messages = [{ role: 'user', content: 'Complete the work' }]) {
  const chunks = []
  for await (const chunk of adapter.stream({ model: 'offline', tools, messages })) chunks.push(chunk)
  return chunks
}

test('provider does not claim DSH addition-only tool updates it cannot deserialize', async () => {
  const { adapter } = adapterWith(async function* () {})
  const info = await adapter.resolveModel('lingxi', 'offline')
  assert.equal(Object.hasOwn(info, 'toolUpdate'), false)
})

test('available tool discovery guidance never introduces unoffered plugin helpers', () => {
  const note = toolDiscoveryGuidance([bash])
  assert.match(note, /todo_write/)
  assert.match(note, /plan in normal text/)
  assert.match(note, /No plugin discovery tool is offered/)
  assert.doesNotMatch(note, /Currently offered discovery tools:/)
})

test('discovery is limited to actual host-offered market and manager schemas', () => {
  assert.match(toolDiscoveryGuidance([bash, market]), /plugin_market: search/)
  assert.doesNotMatch(toolDiscoveryGuidance([bash, market]), /plugin_manager: inspect/)
  assert.match(toolDiscoveryGuidance([bash, manager]), /plugin_manager: inspect/)
  assert.doesNotMatch(toolDiscoveryGuidance([bash, manager]), /plugin_market: search/)
  const both = toolDiscoveryGuidance([market, manager])
  assert.match(both, /user to explicitly authorize/)
  assert.match(both, /Never perform plugin installation/)
})

test('native request tool list and prompts reflect current host tools, never stale earlier turn', async () => {
  const { adapter, seen } = adapterWith(async function* (_options, index) {
    if (index === 1) {
      yield { type: 'tool_call', name: 'todo_write', arguments: '{"todos":[]}' }
    } else if (index < 4) {
      yield { type: 'tool_call', name: 'todo_write', arguments: '{"todos":[]}' }
    } else {
      yield { type: 'tool_call', name: 'todo_write', arguments: '{"todos":[]}' }
    }
  })
  const first = await chunksOf(adapter, [bash])
  assert.equal(first.at(-1).reason.failure.code, 'TOOL_PROTOCOL')
  assert.equal(first.some(c => c.type === 'tool-call-delta'), false)
  const second = await chunksOf(adapter, [bash, todo])
  assert.equal(second.at(-1).reason.kind, 'tool-calls')
  assert.deepEqual(second.filter(c => c.type === 'tool-call-delta').map(c => c.name), ['todo_write'])
  assert.equal(seen.length, 4)
  assert.deepEqual(seen[0].tools.map(t => t.function.name), ['bash'])
  assert.deepEqual(seen[3].tools.map(t => t.function.name), ['bash', 'todo_write'])
})

test('host-offered read-only discovery call can be forwarded but no unoffered installer appears', async () => {
  const { adapter, seen } = adapterWith(async function* () {
    yield { type: 'tool_call', name: 'plugin_market', arguments: '{"query":"csv"}' }
  })
  const chunks = await chunksOf(adapter, [bash, market])
  assert.deepEqual(chunks.filter(c => c.type === 'tool-call-delta').map(c => c.name), ['plugin_market'])
  assert.deepEqual(seen[0].tools.map(t => t.function.name), ['bash', 'plugin_market'])
  assert.match(JSON.stringify(seen[0].messages), /explicitly authorize/)
})

test('unknown host tool diagnostic logs only tool name and inventory flags, never arguments', async () => {
  const warnings = []
  const { adapter } = adapterWith(async function* (_opts, nth) {
    if (nth === 1) yield { type: 'tool_call', name: 'unauthorized_tool', arguments: '{"secret":"DO_NOT_LOG"}' }
    else yield { type: 'text_delta', text: 'Continuing using available DSH tools.' }
  }, { warn: msg => warnings.push(msg) })
  const chunks = await chunksOf(adapter, [bash])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.match(warnings.join('\n'), /unoffered native tool rejected name=unauthorized_tool/)
  assert.match(warnings.join('\n'), /offered_count=1 todo_write_offered=false/)
  assert.doesNotMatch(warnings.join('\n'), /DO_NOT_LOG|SYNTHETIC_ONLY/)
  assert.equal(chunks.some(c => c.type === 'tool-call-delta'), false)
})
