// Offline tests for the frozen LingxiUpstream contract. No live network is used.
import assert from 'node:assert/strict'
import test from 'node:test'
import * as upstreamModule from '../src/upstream/index.mjs'
import { createLingxiUpstream } from '../src/upstream/index.mjs'

const SID = 'FAKE_WPS_SID_FOR_OFFLINE_TESTS_ONLY_0001'
const BASE = 'https://offline.example.test'

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeUpstream(responses, options = {}) {
  const calls = []
  let index = 0
  const fetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = responses[index++]
    if (next === undefined) throw new Error('unexpected request')
    if (next instanceof Error) throw next
    if (next instanceof Response) return next
    if (typeof next === 'function') return next(url, init)
    if (typeof next === 'number') return jsonResponse({}, next)
    return jsonResponse(next, 200)
  }
  return { upstream: createLingxiUpstream({ fetchLike, base: BASE, ...options }), calls }
}

function textResponse(text, status) {
  return new Response(text, { status, headers: { 'Content-Type': 'application/json' } })
}

const MODEL_PAYLOAD = {
  data: {
    models: [
      {
        key: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        multiplier: '～0.12x',
        support_multimodal: true,
        max_context_tokens: 1048576,
        max_new_tokens: 393216,
        reasoning_efforts: ['low', 'high', 'max'],
      },
      { key: 'plain', name: 'Plain', multiplier: 'free', reasoning_efforts: [] },
      { key: 'plain' },
      null,
      { name: 'no-key' },
    ],
    plans: [{ key: 'not-a-model', name: 'Plan mode' }],
  },
}

const DAILY_PAYLOAD = (status) => ({
  result: 'ok',
  data: {
    today: '2026-10-31',
    tasks: [
      { task_key: 'other', status: 'claimable', reward_amount: 99 },
      {
        task_key: 'daily_check_in',
        status,
        reward_amount: 20,
        extra: {
          consecutive_days: 7,
          check_in_days: [
            { date: '2026-10-30', status: 'claimed' },
            { date: '2026-10-31', status: 'available' },
          ],
        },
      },
    ],
  },
})

test('exports exactly the frozen LingxiUpstream four-method interface', () => {
  assert.deepEqual(Object.keys(upstreamModule), ['createLingxiUpstream'])
  const upstream = createLingxiUpstream()
  const methods = ['fetchModels', 'fetchBalance', 'fetchCredits', 'fetchDailyTask', 'claimDaily']
  assert.deepEqual(Object.keys(upstream).sort(), methods.slice().sort())
  assert.equal(Object.getPrototypeOf(upstream), Object.prototype)
  for (const method of methods) assert.equal(typeof upstream[method], 'function')
  for (const method of ['fetchModels', 'fetchCredits', 'fetchDailyTask']) assert.equal(upstream[method].length, 1)
  assert.equal(upstream.claimDaily.length, 2)
})

test('fetchModels parses models, multiplier and metadata; plans are ignored', async () => {
  const { upstream, calls } = makeUpstream([MODEL_PAYLOAD])
  const models = await upstream.fetchModels(SID)
  assert.deepEqual(models, [
    {
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      multiplier: '～0.12x',
      multiplierValue: 0.12,
      contextWindow: 1048576,
      maxTokens: 393216,
      reasoning: true,
      defaultEffort: 'low',
      enabled: true,
    },
    { id: 'plain', name: 'Plain', multiplier: 'free', reasoning: false, enabled: true },
  ])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, BASE + '/api/aioffice/v1/sessions/plans')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.Cookie, 'wps_sid=' + SID + '; csrf=' + SID)
  assert.equal(calls[0].init.headers.Origin, BASE)
})

test('fetchCredits sums bonus and purchased balances; unavailable is -1', async () => {
  const ok = makeUpstream([{ data: { bonus_credits: [{ balance: 12.5 }, { balance: 0 }], purchased_credits: [{ balance: 7.5 }] } }])
  assert.equal(await ok.upstream.fetchCredits(SID), 20)
  assert.equal(ok.calls[0].url, BASE + '/api/public/v1/credits/balance?credit_type=total')
  const empty = makeUpstream([{ data: {} }])
  assert.equal(await empty.upstream.fetchCredits(SID), -1)
  const denied = makeUpstream([textResponse('{"result":"UserUnauthorized"}', 200), textResponse('{"result":"UserUnauthorized"}', 401)])
  assert.equal(await denied.upstream.fetchCredits(SID), -1)
  assert.equal(await denied.upstream.fetchCredits(SID), -1)
})

test('fetchDailyTask is read-only and extracts upstream status, date, reward and streak', async () => {
  const claimable = makeUpstream([DAILY_PAYLOAD('claimable')])
  assert.deepEqual(await claimable.upstream.fetchDailyTask(SID), {
    key: 'daily_check_in', status: 'claimable', date: '2026-10-31', reward: 20, consecutiveDays: 7,
  })
  assert.equal(claimable.calls.length, 1)
  assert.equal(claimable.calls[0].url, BASE + '/api/public/v1/tasks')
  assert.equal(claimable.calls[0].init.method, 'GET')
  assert.equal(claimable.calls[0].init.body, undefined)
  assert.ok(claimable.calls.every((call) => !call.url.includes('/claim')), 'no claim POST from a read-only task fetch')

  const claimed = makeUpstream([DAILY_PAYLOAD('claimed')])
  assert.equal((await claimed.upstream.fetchDailyTask(SID)).status, 'claimed')
  const missing = makeUpstream([textResponse('{"data":{"tasks":[{"task_key":"other","status":"claimable"}]}}', 200), textResponse('{"data":{}}', 500)])
  assert.deepEqual(await missing.upstream.fetchDailyTask(SID), { key: 'daily_check_in', status: 'unavailable' })
  const denied = makeUpstream([401])
  assert.deepEqual(await denied.upstream.fetchDailyTask(SID), { key: 'daily_check_in', status: 'unknown' })
  const noDate = makeUpstream([{ data: { tasks: [{ task_key: 'daily_check_in', status: 'claimable', reward_amount: 3, extra: { check_in_days: [{ date: '2026-10-30', status: 'claimed' }] } }] } }])
  const noDateResult = await noDate.upstream.fetchDailyTask(SID)
  assert.equal(noDateResult.date, undefined, 'no locally computed or already-claimed date')
  const availableDate = makeUpstream([{ data: { tasks: [{ task_key: 'daily_check_in', status: 'claimable', reward_amount: 3, extra: { check_in_days: [{ date: '2026-10-30', status: 'claimed' }, { date: '2026-11-01', status: 'available' }] } }] } }])
  assert.equal((await availableDate.upstream.fetchDailyTask(SID)).date, '2026-11-01')
})

test('fetchDailyTask maps the live incomplete+available daily_check_in shape to claimable', async () => {
  const liveShape = {
    result: 'ok',
    data: {
      tasks: [
        {
          task_key: 'daily_check_in',
          type: 'daily',
          reward_amount: 100,
          status: 'incomplete',
          extra: {
            check_in_days: [
              { day: 1, date: '2026-11-10', status: 'claimed' },
              { day: 2, date: '2026-11-11', reward: 100, status: 'available' },
              { day: 3, date: '2026-11-12', reward: 100, status: 'locked' },
            ],
            consecutive_days: 1,
            today_day: 2,
            today_reward: 100,
          },
        },
      ],
    },
  }
  const { upstream, calls } = makeUpstream([liveShape])
  assert.deepEqual(await upstream.fetchDailyTask(''), {
    key: 'daily_check_in', status: 'claimable', date: '2026-11-11', reward: 100, consecutiveDays: 1,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].url, BASE + '/api/public/v1/tasks')
  assert.equal(calls.every((call) => !call.url.includes('/claim')), true)

  const completed = structuredClone(liveShape)
  completed.data.tasks[0].status = 'completed'
  const claimed = structuredClone(liveShape)
  claimed.data.tasks[0].status = 'claimed'
  claimed.data.tasks[0].extra.check_in_days[1].status = 'claimed'
  const unavailable = structuredClone(liveShape)
  unavailable.data.tasks[0].extra.check_in_days[1].status = 'locked'
  delete unavailable.data.tasks[0].extra.today_reward
  const unparseable = structuredClone(liveShape)
  delete unparseable.data.tasks
  for (const [payload, expected] of [[completed, 'claimed'], [claimed, 'claimed'], [unavailable, 'unavailable'], [unparseable, 'unknown']]) {
    const fixture = makeUpstream([payload])
    assert.equal((await fixture.upstream.fetchDailyTask('')).status, expected)
  }
})

test('claimDaily posts body {} with the caller-supplied upstream date and parses today_reward', async () => {
  const { upstream, calls } = makeUpstream([{ result: 'ok', data: { extra: { today_reward: 25 } } }])
  assert.deepEqual(await upstream.claimDaily(SID, '2026-10-31'), { outcome: 'claimed', reward: 25 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, BASE + '/api/public/v1/tasks/daily_check_in/claim?date=2026-10-31')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.body, '{}')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  const noDate = makeUpstream([{ result: 'ok', data: { reward_amount: 4 } }])
  assert.deepEqual(await noDate.upstream.claimDaily(SID, undefined), { outcome: 'claimed', reward: 4 })
  assert.equal(noDate.calls[0].url, BASE + '/api/public/v1/tasks/daily_check_in/claim', 'no date is computed locally')
  const encoded = makeUpstream([{ result: 'ok' }])
  assert.equal((await encoded.upstream.claimDaily(SID, '2026-10-31&evil=1')).outcome, 'claimed')
  assert.equal(encoded.calls[0].url, BASE + '/api/public/v1/tasks/daily_check_in/claim?date=2026-10-31%26evil%3D1')
})

test('claimDaily maps already-claimed, session-dead and transport failures without throwing', async () => {
  const already = makeUpstream([textResponse('{"result":"error","hint":"already claimed today"}', 409)])
  assert.equal((await already.upstream.claimDaily(SID, '2026-10-31')).outcome, 'already')
  const alreadyEn = makeUpstream([{ result: 'ok', data: { status: 'claimed', extra: {} } }])
  assert.equal((await alreadyEn.upstream.claimDaily(SID, '2026-10-31')).outcome, 'already')
  const alreadyChinese = makeUpstream([textResponse('{"result":"error","hint":"今日已签到"}', 400)])
  assert.equal((await alreadyChinese.upstream.claimDaily(SID, '2026-10-31')).outcome, 'already')
  const dead401 = makeUpstream([textResponse('Unauthorized', 401)])
  assert.deepEqual(await dead401.upstream.claimDaily(SID, '2026-10-31'), { outcome: 'failed', message: 'session_dead', status: 401 })
  const dead403 = makeUpstream([textResponse('{"result":"UserUnauthorized"}', 403)])
  assert.deepEqual(await dead403.upstream.claimDaily(SID, '2026-10-31'), { outcome: 'failed', message: 'session_dead', status: 403 })
  const failed = makeUpstream([textResponse('{"result":"error","hint":"task center unavailable"}', 500)])
  const failedResult = await failed.upstream.claimDaily(SID, '2026-10-31')
  assert.equal(failedResult.outcome, 'failed')
  assert.equal(failedResult.status, 500)
  const thrown = makeUpstream([new TypeError('network down')])
  assert.equal((await thrown.upstream.claimDaily(SID, '2026-10-31')).outcome, 'failed')
  const malformed = makeUpstream([textResponse('not JSON', 200)])
  assert.deepEqual(await malformed.upstream.claimDaily(SID, '2026-10-31'), { outcome: 'failed', message: 'lingxi upstream invalid JSON', status: 200 })
  const echoed = makeUpstream([textResponse('{"result":"error","hint":"credential ' + SID + ' rejected"}', 409)])
  const echoedResult = await echoed.upstream.claimDaily(SID, '2026-10-31')
  assert.equal(echoedResult.outcome, 'failed')
  assert.equal(JSON.stringify(echoedResult).includes(SID), false)
})

test('no sid or credential value is logged, thrown, or serialized in results', async () => {
  const logs = []
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug }
  for (const key of Object.keys(original)) console[key] = (...args) => logs.push(args.map(String).join(' '))
  let thrownSid = ''
  const { upstream, calls } = makeUpstream([
    () => { thrownSid = SID; throw new Error('secret ' + SID) },
    { result: 'ok', data: { models: [{ key: 'm', name: 'M', multiplier: '～0.12x' }] } },
    { result: 'ok', data: { bonus_credits: [{ balance: 1 }] } },
    textResponse('{"result":"ok","data":{"tasks":[{"task_key":"daily_check_in","status":"claimed","extra":{"consecutive_days":2}}]}}', 200),
    textResponse('{"result":"ok","data":{"extra":{"today_reward":3}}}', 200),
    { result: 'ok', data: { extra: { today_reward: 2 } } },
    { result: 'ok', data: { extra: { today_reward: 2 } } },
  ])
  try {
    const results = [
      await upstream.fetchModels(SID),
      await upstream.fetchModels(SID),
      await upstream.fetchCredits(SID),
      await upstream.fetchDailyTask(SID),
      await upstream.claimDaily(SID, '2026-10-31'),
      await upstream.claimDaily(SID, '2026-10-31'),
      await upstream.claimDaily(SID, '2026-10-31'),
    ]
    const serialized = JSON.stringify({ logs, results })
    assert.equal(serialized.includes(SID), false)
    assert.equal(thrownSid, SID, 'the fake threw a credential-bearing error; module swallowed it')
    assert.equal(logs.length, 0)
    assert.equal(calls.length, 7)
    assert.ok(results.every((result) => !JSON.stringify(result).includes(SID)))
    assert.deepEqual(results[0], [])
    assert.equal(results[6].outcome, 'claimed', 'a swallowed credential-bearing error leaves no half-written result')
  } finally {
    for (const key of Object.keys(original)) console[key] = original[key]
  }
})

test('fetchLike may return a json()-only response object', async () => {
  const calls = []
  const fetchLike = async (url, init) => {
    calls.push({ url, init })
    return { status: 200, ok: true, json: async () => MODEL_PAYLOAD }
  }
  const upstream = createLingxiUpstream({ fetchLike, base: BASE })
  const models = await upstream.fetchModels(SID)
  assert.equal(models[0].multiplierValue, 0.12)
  assert.equal(calls.length, 1)
})

test('outer abort signal reaches each injected request', async () => {
  const { upstream, calls } = makeUpstream([MODEL_PAYLOAD, { data: { bonus_credits: [{ balance: 1 }] } }, DAILY_PAYLOAD('claimable'), { result: 'ok' }])
  const controller = new AbortController()
  await upstream.fetchModels(SID, controller.signal)
  await upstream.fetchCredits(SID, controller.signal)
  await upstream.fetchDailyTask(SID, controller.signal)
  await upstream.claimDaily(SID, '2026-10-31', controller.signal)
  assert.equal(calls.length, 4)
  assert.ok(calls.every((call) => call.init.signal instanceof AbortSignal))
})

test('parseBalanceV2 prefers authoritative total_balance and keeps the grant breakdown', async () => {
  const { parseBalanceV2, parseCreditsV2 } = await import('../src/upstream/protocol.mjs')
  const payload = { data: {
    total_balance: 2397, total_bonus: 2397, total_purchased: 0, total_contract: 0,
    bonus_credits: [
      { value: 800, consumed: 3, balance: 797, expire_time: '2026-12-11T14:57:14+08:00' },
      { value: 100, consumed: 0, balance: 100, expire_time: '2026-12-11T14:57:43+08:00' }
    ],
    purchased_credits: []
  } }
  const b = parseBalanceV2(payload)
  assert.equal(b.total, 2397, 'authoritative total_balance, not sum-of-grants')
  assert.equal(b.bonus, 2397)
  assert.equal(b.purchased, 0)
  assert.equal(b.grants.length, 2)
  assert.equal(b.grants[0].balance, 797)
  assert.equal(b.grants[0].expiresAt, '2026-12-11T14:57:14+08:00')
  assert.equal(parseCreditsV2(payload), 2397)
})

test('parseBalanceV2 falls back to grants only when no total is published', async () => {
  const { parseBalanceV2 } = await import('../src/upstream/protocol.mjs')
  const b = parseBalanceV2({ data: { bonus_credits: [{ value: 10, consumed: 2, balance: 8 }] } })
  assert.equal(b.total, 8)
  assert.equal(b.grants[0].consumed, 2)
})

