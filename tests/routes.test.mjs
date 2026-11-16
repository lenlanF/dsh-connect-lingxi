import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerLingxiRoutes, PREFIX, loopback } from '../src/routes.mjs'

function serverHarness() {
  const routes = new Map()
  const ctx = { webServer: { register: (entry) => { routes.set(entry.path, entry); return () => routes.delete(entry.path) } } }
  return { ctx, routes }
}

function fakePool() {
  return {
    status: async () => ({ accounts: [], models: [], settings: { autoCheckin: true }, checkin: { today: '2026-01-01', autoEnabled: true }, diagnostics: {} }),
    refresh: async () => {},
    addManual: async (label) => ({ id: 'a1', label, source: 'manual', enabled: true, credits: -1, state: 'ok' }),
    remove: async () => true,
    setEnabled: async () => true,
    checkin: async () => ({ outcome: 'claimed', reward: 100 }),
    runAutoCheckin: async () => [{ outcome: 'already' }],
    updateSettings: async (patch) => ({ autoCheckin: true, ...patch }),
    rename: async () => true,
    reorder: async (ids) => ids,
    checkinMany: async (ids) => ids.map(() => ({ outcome: 'claimed' })),
    exportAccounts: async () => ({ format: 'dsh-connect-lingxi/accounts', version: 1, accounts: [] }),
    importAccounts: async () => ({ imported: 0, skipped: 0, total: 0 }),
    previewImport: async () => ({ count: 0, accounts: [] }),
    refreshModels: async () => ({ accounts: [], models: [] }),
    loginUrl: () => 'https://lingxi.kdocs.cn',
  }
}

function response() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(text) { out.body = text },
  }
}

function request(method, body = undefined, remoteAddress = '127.0.0.1') {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method, socket: { remoteAddress }, url: PREFIX + '/status',
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk },
  }
}

test('registers every loopback route', () => {
  const { ctx, routes } = serverHarness()
  const dispose = registerLingxiRoutes(ctx, fakePool())
  assert.equal(routes.size, 15)
  assert.ok(routes.has(PREFIX + '/status'))
  assert.ok(routes.has(PREFIX + '/account/toggle'))
  dispose()
  assert.equal(routes.size, 0)
})

test('non-loopback is rejected before any pool call', async () => {
  const { ctx, routes } = serverHarness()
  registerLingxiRoutes(ctx, fakePool())
  const r = response()
  await routes.get(PREFIX + '/status').handler(request('GET', undefined, '192.0.2.1'), r)
  assert.equal(r.out.status, 403)
})

test('wrong method is 405', async () => {
  const { ctx, routes } = serverHarness()
  registerLingxiRoutes(ctx, fakePool())
  const r = response()
  await routes.get(PREFIX + '/account').handler(request('GET'), r)
  assert.equal(r.out.status, 405)
})

test('status returns redacted JSON and add rejects empty sid', async () => {
  const { ctx, routes } = serverHarness()
  registerLingxiRoutes(ctx, fakePool())
  const s = response()
  await routes.get(PREFIX + '/status').handler(request('GET'), s)
  assert.equal(s.out.status, 200)
  assert.equal(JSON.parse(s.out.body).accounts.length, 0)
  const a = response()
  await routes.get(PREFIX + '/account').handler(request('POST', { label: 'x', sid: '' }), a)
  assert.equal(a.out.status, 400)
})

test('credentials never appear in status output', async () => {
  const { ctx, routes } = serverHarness()
  registerLingxiRoutes(ctx, fakePool())
  const r = response()
  await routes.get(PREFIX + '/status').handler(request('GET'), r)
  assert.equal(/wpsSid|sid=|secret/i.test(r.out.body), false)
})

test('loopback helper accepts IPv6 and rejects LAN', () => {
  const r = response()
  assert.equal(loopback({ socket: { remoteAddress: '::1' } }, r), true)
  assert.equal(loopback({ socket: { remoteAddress: '203.0.113.10' } }, r), false)
  assert.equal(r.out.status, 403)
})
