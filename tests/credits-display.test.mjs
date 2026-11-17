import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { creditReadout, registerLingxiRoutes, PREFIX } from '../src/routes.mjs'

test('balance projection selects the credential actually used, not the sum of all accounts', () => {
  const status = { accounts: [
    { id: 'disabled', label: '已停用', wpsSid: 'NEVER_LEAK', enabled: false, sidLength: 24, state: 'ok', credits: 999 },
    { id: 'current', label: '首选账号', wpsSid: 'NEVER_LEAK2', enabled: true, sidLength: 24, state: 'ok', credits: 123.75,
      balance: { total: 123.75, bonus: 100, purchased: 23.75, grants: [{ balance: 100 }] }, lastCheckedAt: 1234 },
    { id: 'secondary', label: '备用账号', wpsSid: 'NEVER_LEAK3', enabled: true, sidLength: 24, state: 'ok', credits: 50 },
  ]}
  const value = creditReadout(status)
  assert.equal(value.provider, 'lingxi')
  assert.equal(value.activeIndex, 1)
  assert.equal(value.credits, 123.75)
  assert.deepEqual(value.accounts.map(a => a.credits), [999, 123.75, 50])
  assert.equal(value.accounts[1].bonus, 100)
  assert.equal(value.accounts[1].purchased, 23.75)
  assert.ok(!JSON.stringify(value).includes('NEVER_LEAK'))
  assert.ok(!JSON.stringify(value).includes('grants'))
  assert.ok(!JSON.stringify(value).includes('sidLength'))
  assert.ok(!JSON.stringify(value).includes('"id"'))
})

test('unknown credit is not confused with zero; disabled and expired accounts are excluded', () => {
  const value = creditReadout({ accounts: [
    { label: '会话失效', enabled: true, sidLength: 20, state: 'session_dead', credits: 77 },
    { label: '未知', enabled: true, sidLength: 20, state: 'unknown', credits: -1 },
    { label: '零余额', enabled: true, sidLength: 20, state: 'ok', credits: 0 },
  ] })
  assert.equal(value.activeIndex, 1)
  assert.equal(value.credits, null)
  assert.equal(value.accounts[1].credits, null)
  assert.equal(value.accounts[2].credits, 0)
  assert.deepEqual(creditReadout({ accounts: [] }).accounts, [])
  assert.equal(creditReadout({ accounts: [] }).activeIndex, -1)
  assert.equal(creditReadout({ accounts: [] }).credits, null)
})

test('/credits is read-only, loopback-only and returns a strict safe projection', async () => {
  const routes = new Map()
  const status = async () => ({ accounts: [
    { id: 'very-private', wpsSid: 'NEVER_LEAK', sidLength: 21,
      label: '测试账号', enabled: true, state: 'ok', credits: 42,
      balance: { total: 42, bonus: 20, purchased: 22, grants: [{ expiresAt: 'tomorrow' }] } },
  ] })
  registerLingxiRoutes({ webServer: { register: definition => {
    routes.set(definition.path, definition)
    return () => routes.delete(definition.path)
  } } }, { status })
  const call = async (method, address = '127.0.0.1') => {
    const result = { status: null, body: '' }
    const req = { method, socket: { remoteAddress: address },
      async *[Symbol.asyncIterator]() {} }
    const res = { writeHead: code => { result.status = code }, end: body => { result.body = body ?? '' } }
    await routes.get(PREFIX + '/credits').handler(req, res)
    return result
  }
  const ok = await call('GET')
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).credits, 42)
  assert.ok(!/NEVER_LEAK|very-private|sidLength|grants|expiresAt/.test(ok.body))
  assert.equal((await call('POST')).status, 405)
  assert.equal((await call('GET', '192.168.1.2')).status, 403)
})

/** Minimal slot-host and React fake verifies browser bundle registration and
 * actual view behavior without touching user's running DSH Desktop. */
function loadUi(fakeFetch = async () => ({ ok: true, json: async () => ({ provider: 'lingxi', activeIndex: 0,
  credits: 215, accounts: [{ label: '模拟账号', enabled: true, state: 'ok', credits: 215 }] }) })) {
  const seats = []
  const hooks = []
  const effects = []
  let cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const i = cursor++
      if (!(i in hooks)) hooks[i] = initial
      return [hooks[i], next => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next }]
    },
    useRef(initial) {
      const i = cursor++
      if (!(i in hooks)) hooks[i] = { current: initial }
      return hooks[i]
    },
    useCallback(fn) { cursor++; return fn },
    useEffect(fn) { if (!effects.length) effects.push(fn) },
  }
  let extension
  const clientSource = readFileSync(join(process.cwd(), 'client.js'), 'utf8')
  const ctx = {
    slots: {
      inject(_name, register) { register() },
      register(options, component) { seats.push({ options, component }); return () => {} },
    },
  }
  vm.runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(entry) { extension = entry.factory(name => {
      if (name === 'react') return react
      throw Error('Unexpected module ' + name)
    }) } } },
    React: react, console, Intl, fetch: fakeFetch,
    setInterval: () => 19, clearInterval: () => {}, setTimeout: () => {}, clearTimeout: () => {},
  }, { filename: 'lingxi/client.js' })
  extension.apply(ctx)
  return { seats, effects, reset() { cursor = 0 } }
}

test('composer slot mounts alongside settings, and only appears for the Lingxi provider', () => {
  const ui = loadUi()
  assert.ok(ui.seats.some(s => s.options.name === 'settings.section'))
  const seat = ui.seats.find(s => s.options.name === 'conversation.input.right')
  assert.ok(seat)
  assert.equal(seat.options.id, 'dsh-connect-lingxi-composer-credits')
  assert.equal(seat.component({ useProjection: () => ({ next: { provider: 'workbuddy' } }) }), null)
  assert.equal(seat.component({ useProjection: () => ({ lastUsed: { provider: 'lingxi' } }) }).type.name, 'LingxiComposerCredits')
  assert.equal(seat.component({ useProjection: () => ({
    next: { provider: 'workbuddy' }, lastUsed: { provider: 'lingxi' },
  }) }), null)
})

test('composer pill shows real current credits after fetch, not model multiplier', async () => {
  let reads = 0
  const ui = loadUi(async url => {
    reads++
    assert.equal(url, PREFIX + '/credits')
    return { ok: true, json: async () => ({ provider: 'lingxi', activeIndex: 0,
      credits: 215, accounts: [{ label: '模拟账号', credits: 215, enabled: true, state: 'ok' }] }) }
  })
  const seat = ui.seats.find(s => s.options.name === 'conversation.input.right')
  const component = seat.component({ useProjection: () => ({ next: { provider: 'lingxi' } }) }).type
  ui.reset()
  component()
  assert.equal(ui.effects.length, 1)
  ui.effects[0]()
  await new Promise(setImmediate)
  await new Promise(setImmediate)
  ui.reset()
  const view = component()
  const button = view.props.children.find(child => child?.type === 'button')
  assert.match(button.props.title, /灵犀 215 智点/)
  assert.doesNotMatch(button.props.title, /0\.11x|倍率/)
  assert.equal(reads, 1)
})

test('failed balance fetch never falsely renders a 0-point balance', async () => {
  const ui = loadUi(async () => { throw Error('offline') })
  const seat = ui.seats.find(s => s.options.name === 'conversation.input.right')
  const component = seat.component({ useProjection: () => ({ next: { provider: 'lingxi' } }) }).type
  ui.reset()
  component()
  ui.effects[0]()
  await new Promise(setImmediate)
  ui.reset()
  const view = component()
  const button = view.props.children.find(child => child?.type === 'button')
  assert.match(button.props.title, /灵犀 — 智点/)
  assert.match(button.props.title, /刷新失败/)
})

test('credits pill opens account details, marks the current account, and remains read-only', async () => {
  const ui = loadUi(async () => ({ ok: true, json: async () => ({
    provider: 'lingxi', activeIndex: 1, credits: 0, accounts: [
      { label: '备用账号', enabled: true, state: 'ok', credits: 120 },
      { label: '当前账号', enabled: true, state: 'ok', credits: 0 },
    ],
  }) }))
  const seat = ui.seats.find(s => s.options.name === 'conversation.input.right')
  const component = seat.component({ useProjection: () => ({ next: { provider: 'lingxi' } }) }).type
  ui.reset()
  component()
  ui.effects[0]()
  await new Promise(setImmediate)
  ui.reset()
  let rendered = component()
  const button = rendered.props.children.find(child => child?.type === 'button')
  assert.match(button.props.title, /灵犀 0 智点/)
  button.props.onClick()
  ui.reset()
  rendered = component()
  const dialog = rendered.props.children.find(child => child?.props?.role === 'dialog')
  assert.ok(dialog)
  assert.match(JSON.stringify(dialog), /备用账号|当前账号/)
  assert.match(JSON.stringify(dialog), /当前使用/)
  assert.ok(!JSON.stringify(dialog).includes('wpsSid'))
})

test('manual refresh bypasses server TTL while ordinary read reuses the cached credits', async () => {
  const { createLingxiAccountPool } = await import('../src/pool/index.mjs')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const base = 'E:/Temp'
  const dataDir = mkdtempSync(join(base, 'lingxi-credit-refresh-'))
  let upstreamReads = 0
  const sid = 'SYNTHETIC_CREDIT_SID_ONLY'
  const pool = createLingxiAccountPool({
    dataDir, localSids: [{ sid, label: '测试' }],
    upstream: {
      fetchModels: async () => [],
      fetchBalance: async () => {
        upstreamReads++
        return { total: 100 + upstreamReads, bonus: 40, purchased: 60, contract: 0, grants: [] }
      },
    },
  })
  try {
    const first = creditReadout(await pool.creditsStatus())
    const second = creditReadout(await pool.creditsStatus())
    assert.equal(first.credits, 101)
    assert.equal(second.credits, 101)
    assert.equal(upstreamReads, 1, 'normal read respects the configured balance TTL')
    const forced = creditReadout(await pool.creditsStatus(true))
    assert.equal(forced.credits, 102)
    assert.equal(upstreamReads, 2, 'explicit refresh forces an upstream credit balance read')
    assert.ok(!JSON.stringify(forced).includes(sid))
  } finally {
    pool.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('read-only /credits GET and manually requested refresh POST use distinct pool modes', async () => {
  const calls = []
  const routes = new Map()
  registerLingxiRoutes({ webServer: { register: entry => {
    routes.set(entry.path, entry)
    return () => routes.delete(entry.path)
  } } }, { creditsStatus: async force => {
    calls.push(force)
    return { accounts: [{ label: '读取账号', enabled: true, state: 'ok', sidLength: 25, credits: 17 }] }
  } })
  const invoke = async (route, method) => {
    const req = { method, socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {} }
    const result = { status: null, body: null }
    const res = { writeHead(status) { result.status = status }, end(body) { result.body = body } }
    await routes.get(PREFIX + route).handler(req, res)
    return result
  }
  assert.equal((await invoke('/credits', 'GET')).status, 200)
  assert.equal((await invoke('/credits/refresh', 'GET')).status, 405)
  assert.equal((await invoke('/credits/refresh', 'POST')).status, 200)
  assert.deepEqual(calls, [false, true])
})

test('clicking the popover refresh button uses the explicit POST balance refresh endpoint', async () => {
  const requested = []
  const ui = loadUi(async (url, init) => {
    requested.push({ url, method: init.method })
    return { ok: true, json: async () => ({
      provider: 'lingxi', activeIndex: 0, credits: 100 + requested.length,
      accounts: [{ label: '模拟账号', credits: 100 + requested.length, enabled: true, state: 'ok' }],
    }) }
  })
  const seat = ui.seats.find(s => s.options.name === 'conversation.input.right')
  const component = seat.component({ useProjection: () => ({ next: { provider: 'lingxi' } }) }).type
  ui.reset()
  component()
  ui.effects[0]()
  await new Promise(setImmediate)
  ui.reset()
  let tree = component()
  tree.props.children.find(child => child?.type === 'button').props.onClick()
  ui.reset()
  tree = component()
  const dialog = tree.props.children.find(child => child?.props?.role === 'dialog')
  const foot = dialog.props.children.find(child => child?.type === 'div' && child.props.children.some?.(item => item?.type === 'button' && item.props.children.includes('刷新')))
  assert.ok(foot, 'refresh button must be present in the details view')
  const refresh = foot.props.children.find(item => item?.type === 'button')
  refresh.props.onClick()
  await new Promise(setImmediate)
  assert.deepEqual(requested, [
    { url: PREFIX + '/credits', method: 'GET' },
    { url: PREFIX + '/credits/refresh', method: 'POST' },
  ])
})
