import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyWith, inject } from '../src/index.mjs'
import { PREFIX } from '../src/routes.mjs'

function fakeCtx() {
  const calls = { adapters: [], providers: [], discoveries: [], routes: [], effects: [], errors: [], infos: [], injects: [] }
  const ctx = {
    logger: { info: (m) => calls.infos.push(m), warn: () => {}, error: (m, e) => calls.errors.push([m, e?.message]) },
    llm: {
      registerAdapter: (routes, adapter) => { calls.adapters.push([routes, adapter]); return () => {} },
      registerConfigurableProviders: (entries) => { calls.providers.push(entries); return () => {} },
      registerModelDiscovery: (ns, fn) => { calls.discoveries.push([ns, fn]); return () => {} },
    },
    webServer: { register: (entry) => { calls.routes.push(entry.path); return () => {} } },
    inject: (names, fn) => {
      calls.injects.push(names)
      const injected = { ...ctx, effect: (setup) => { calls.effects.push(setup); setup(); return () => {} } }
      return fn(injected)
    },
    effect: (fn) => { calls.effects.push(fn); return () => {} },
  }
  return { ctx, calls }
}

const client = {
  async listModels() { return [{ id: 'qwen3.8_flash', name: 'Qwen3.8 Flash' }] },
  async credits() { return -1 },
  async *chat() { yield { type: 'text_delta', text: 'ok' }; yield { type: 'done' } },
}
const pool = {
  refresh: async () => {},
  resolveCredential: async () => ({ wpsSid: 'x', source: 'local-cookie' }),
  status: async () => ({
    accounts: [], models: [{ id: 'qwen3.8_flash', name: 'Qwen3.8 Flash', multiplier: '～0.12x', multiplierValue: 0.12, enabled: true }],
    settings: { autoCheckin: true, timezone: 'Asia/Shanghai', disabledModelIds: [], poolOrder: [], pollIntervalMinutes: 5 },
    checkin: { today: '2026-01-01', autoEnabled: true }, diagnostics: {},
  }),
  runAutoCheckin: async () => [],
  dispose: () => {},
}
const config = () => ({ client, pool, upstream: {} })

test('bundle declares required Cordis injections', () => {
  assert.deepEqual(inject, ['llm', 'settings'])
})

test('applyWith registers provider, directory, discovery and all loopback routes', async () => {
  const { ctx, calls } = fakeCtx()
  applyWith(ctx, config())
  assert.deepEqual(calls.adapters[0][0], ['lingxi'])
  assert.equal(calls.providers[0][0].provider, 'lingxi')
  assert.equal(calls.discoveries[0][0], 'dsh-connect-lingxi')
  assert.deepEqual(calls.injects[0], ['webServer'])
  assert.equal(calls.routes.length, 17)
  assert.ok(calls.routes.includes(PREFIX + '/status'))
  const models = await calls.discoveries[0][1]({ provider: 'lingxi' })
  assert.equal(models[0].id, 'qwen3.8_flash')
  assert.equal(models[0].badge.text, '～0.12x')
  assert.equal(models[0].badge.tone, 'success')
  assert.match(calls.infos.join('\n'), /provider, routes and settings registered/)
})

test('applyWith discovery ignores foreign providers', async () => {
  const { ctx, calls } = fakeCtx()
  applyWith(ctx, config())
  assert.deepEqual(await calls.discoveries[0][1]({ provider: 'workbuddy' }), [])
})

test('disabled models are hidden', async () => {
  const { ctx, calls } = fakeCtx()
  const base = await pool.status()
  const special = { ...pool, status: async () => ({ ...base, settings: { ...base.settings, disabledModelIds: ['qwen3.8_flash'] } }) }
  applyWith(ctx, { ...config(), pool: special })
  assert.deepEqual(await calls.discoveries[0][1]({ provider: 'lingxi' }), [])
})

test('applyWith rolls back when directory registration throws', () => {
  const releases = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: {
      registerAdapter: () => { const f = () => releases.push('adapter'); return f },
      registerConfigurableProviders: () => { throw new Error('duplicate directory') },
      registerModelDiscovery: () => () => {},
    },
  }
  applyWith(ctx, config())
  assert.deepEqual(releases, ['adapter'])
})

test('applyWith tolerates a host without llm service', () => {
  assert.doesNotThrow(() => applyWith({ logger: { warn: () => {} } }, config()))
})
