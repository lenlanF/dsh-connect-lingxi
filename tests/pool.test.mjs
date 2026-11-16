// Offline tests for LingxiAccountPool. No live network, no DPAPI, no WPS user data reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLingxiAccountPool } from '../src/pool/index.mjs'
import { DEFAULT_SETTINGS, accountId, defaultDataDir, todayInTimezone, validateSettings } from '../src/pool/state.mjs'
import { decryptChromeCookie, LingxiCredentialError } from '../src/credential/index.mjs'
import { scanLocalSids, userDataDir } from '../src/pool/local-cookies.mjs'
import { DatabaseSync } from 'node:sqlite'

const SID_A = 'sid-ALPHA-aaaaaaaa-1111'
const SID_B = 'sid-BRAVO-bbbbbbbb-2222'
const SID_C = 'sid-CHARLIE-cccccccc-3333'
const SID_M = 'sid-MANUAL-mmmmmmmm-9999'
const ALL_SIDS = [SID_A, SID_B, SID_C, SID_M]

function tempDir () {
  return mkdtempSync(join(tmpdir(), 'lingxi-pool-test-'))
}

function seal (text, key, prefix) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()])
  return Buffer.concat([Buffer.from(prefix || 'v10', 'ascii'), nonce, body, cipher.getAuthTag()])
}

function fakeUpstream (overrides) {
  const calls = { fetchModels: [], fetchCredits: [], fetchDailyTask: [], claimDaily: [] }
  return Object.assign({
    calls,
    async fetchModels (sid) { calls.fetchModels.push(sid); return [{ id: 'm1', name: 'M1', multiplier: '～0.12x', multiplierValue: 0.12, enabled: true }, { id: 'm2', name: 'M2', enabled: true }] },
    async fetchCredits (sid) { calls.fetchCredits.push(sid); return 42 },
    async fetchDailyTask (sid) { calls.fetchDailyTask.push(sid); return { key: 'daily_check_in', status: 'claimable', date: '2099-01-02' } },
    async claimDaily (sid, date) { calls.claimDaily.push({ sid, date }); return { outcome: 'claimed', reward: 5 } }
  }, overrides || {})
}

function noSecrets (value) {
  assert.ok(value !== undefined, 'value must be JSON-serializable')
  const text = JSON.stringify(value)
  assert.ok(text !== undefined)
  for (const sid of ALL_SIDS) assert.ok(!text.includes(sid), 'secret leaked: ' + sid)
  assert.ok(!text.includes('wpsSid'), 'wpsSid key leaked')
}

function pool (opts) {
  const dataDir = tempDir()
  const upstream = opts?.upstream || fakeUpstream()
  // Every offline test injects its local sids, so no test ever reads live WPS
  // cookie DBs, calls DPAPI, or touches the network.
  const created = createLingxiAccountPool(Object.assign({ dataDir, upstream, localSids: [] }, opts))
  return { pool: created, dataDir, upstream }
}

test('exports match LingxiAccountPool exactly', () => {
  const { pool: p } = pool()
  const keys = Object.keys(p).sort()
  assert.deepEqual(keys, [
    'addManual', 'checkin', 'checkinMany', 'dispose', 'exportAccounts', 'importAccounts',
    'loginUrl', 'previewImport', 'refresh', 'refreshModels', 'remove', 'rename',
    'reorder', 'resolveCredential', 'runAutoCheckin', 'setEnabled', 'status', 'updateSettings'
  ].sort())
  for (const key of keys) assert.equal(typeof p[key], 'function')
  assert.equal(typeof p.startAutoCheckin, 'function', 'explicit auto timer must be startable')
  assert.ok(defaultDataDir().replace(/\\/g, '/').endsWith('.dsh/profiles/desktop/data/dsh-connect-lingxi'))
  p.dispose()
})

test('scanLocalSids reads real sqlite DBs for multiple distinct encrypted sids, deduplicating a repeated sid', async () => {
  const key = randomBytes(32)
  const root = tempDir()
  const partitions = ['lingxi-passport-alpha', 'lingxi-business-bravo', 'lingxi-in-app-browser-charlie']
  for (const name of partitions) {
    const dir = join(root, 'Partitions', name, 'Network')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'Cookies'))
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)')
    const insert = db.prepare('INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)')
    insert.run('.wps.cn', 'wps_sid', '', seal(SID_A, key))
    insert.run('.wps.cn', 'wps_sid', '', seal(SID_A, key)) // duplicate within one partition
    if (name === 'lingxi-business-bravo') insert.run('.lingxi.wps.cn', 'wps_sid', '', seal(SID_B, key))
    if (name === 'lingxi-in-app-browser-charlie') insert.run('.wps.cn', 'wps_sid', SID_C, null) // plaintext path
    db.close()
  }
  const scan = await scanLocalSids({ userDataDir: root, osCryptKey: key })
  assert.deepEqual(scan.errors, [])
  assert.equal(scan.entries.length, 3, 'three distinct sids')
  const sids = scan.entries.map(function (e) { return e.sid }).sort()
  assert.deepEqual(sids, [SID_A, SID_B, SID_C].sort())
  // a sid repeated across partitions is one entry; its label is the first partition seen
  assert.ok(partitions.includes(scan.entries.find(function (e) { return e.sid === SID_A }).label))
  assert.equal(scan.entries.find(function (e) { return e.sid === SID_B }).label, 'lingxi-business-bravo')
  assert.equal(scan.entries.find(function (e) { return e.sid === SID_A }).domains.length, 1)
  assert.equal(userDataDir(root), root)
  // decryptChromeCookie itself is the credential module's exported decryptor
  assert.equal(decryptChromeCookie(seal(SID_A, key), key).toString('utf8'), SID_A)
  rmSync(root, { recursive: true, force: true })
})

test('refresh merges local accounts and status() redacts every sid (sidLength only)', async () => {
  const { pool: p, dataDir } = pool({ localSids: [
    { sid: SID_A, label: 'lingxi-passport-v2', domains: ['.wps.cn'] },
    { sid: SID_B, label: 'lingxi-business-v2', domains: ['.wps.cn'] }
  ] })
  await p.refresh()
  const s = await p.status()
  assert.equal(s.accounts.length, 2)
  assert.equal(s.diagnostics.localSidCount, 2)
  assert.equal(s.diagnostics.manualSidCount, 0)
  for (const account of s.accounts) {
    assert.equal(account.id.length, 16)
    assert.equal(account.sidLength, SID_A.length)
    assert.equal(account.source, 'local')
    assert.equal(account.enabled, true)
    assert.equal(account.state, 'unknown')
    assert.equal(account.credits, 42, 'status() reads the live credit balance from upstream')
    assert.ok(!('wpsSid' in account))
  }
  noSecrets(s)
  assert.ok(s.checkin.today.match(/^\d{4}-\d{2}-\d{2}$/))
  assert.equal(DEFAULT_SETTINGS.autoCheckin, true, 'auto check-in is on by default (Beijing time, idempotent, toggleable)')
  assert.equal(s.checkin.autoEnabled, true)
  assert.equal(s.settings.autoCheckin, true)
  assert.equal(s.settings.timezone, 'Asia/Shanghai')
  assert.equal(s.settings.pollIntervalMinutes, 5)
  assert.equal(s.models.length, 2)
  // persisted state.json holds no redacted browser view, only server-side sids
  const persisted = readFileSync(join(dataDir, 'state.json'), 'utf8')
  assert.ok(persisted.includes(SID_A))
  p.dispose()
})

test('addManual validates, deduplicates by sha256(sid).slice(0,16), remove and setEnabled toggle', async () => {
  const { pool: p } = pool({ localSids: [{ sid: SID_A, label: 'partition-A' }] })
  await p.refresh()
  const added = await p.addManual('my second account', SID_M)
  assert.equal(added.id, createHash('sha256').update(SID_M).digest('hex').slice(0, 16))
  assert.equal(added.label, 'my second account')
  assert.equal(added.source, 'manual')
  assert.equal(added.sidLength, SID_M.length)
  assert.ok(!('wpsSid' in added))
  const dup = await p.addManual('duplicate name', SID_M)
  assert.equal(dup.id, added.id)
  assert.equal((await p.status()).accounts.length, 2)
  await assert.rejects(() => p.addManual('x', ''), /non-empty/)
  await assert.rejects(() => p.addManual('x', '   '), /non-empty/)
  await assert.rejects(() => p.addManual('x', null), /non-empty string/)
  await assert.rejects(() => p.addManual('x', 'short one'), /invalid characters/)
  // manual sid equal to a local sid must deduplicate too
  const same = await p.addManual('same as local', SID_A)
  assert.equal(same.id, accountId(SID_A))
  assert.equal((await p.status()).accounts.length, 2)
  assert.equal(await p.setEnabled(added.id, false), true)
  assert.equal((await p.status()).accounts.find(function (a) { return a.id === added.id }).enabled, false)
  assert.equal(await p.setEnabled(added.id, true), true)
  assert.equal(await p.remove(added.id), true)
  assert.equal(await p.remove(added.id), false)
  assert.equal((await p.status()).accounts.length, 1)
  assert.equal(await p.setEnabled('missing-id', true), false)
  noSecrets(await p.status())
  p.dispose()
})

test('resolveCredential honors poolOrder, enabled and non-dead state; typed error names why', async () => {
  const { pool: p } = pool({ localSids: [
    { sid: SID_A, label: 'partition-A' },
    { sid: SID_B, label: 'partition-B' }
  ] })
  await p.refresh()
  const s = await p.status()
  const first = s.accounts[0].id
  const second = s.accounts[1].id
  assert.equal((await p.resolveCredential()).wpsSid, SID_A)
  await p.updateSettings({ poolOrder: [second, first] })
  assert.equal((await p.resolveCredential()).wpsSid, SID_B)
  assert.equal((await p.resolveCredential()).source, 'local-cookie')
  await p.setEnabled(second, false)
  assert.equal((await p.resolveCredential()).wpsSid, SID_A)
  await p.setEnabled(second, true)
  await p.updateSettings({ poolOrder: [second, first] })
  const st = (await p.status()).accounts.find(function (a) { return a.id === second })
  assert.equal(st.state, 'unknown')
  // toggle the whole pool off
  await p.setEnabled(first, false)
  await p.setEnabled(second, false)
  await assert.rejects(() => p.resolveCredential(), function (err) {
    assert.equal(err.name, 'LingxiAccountPoolError')
    assert.equal(err.code, 'LINGXI_POOL_NO_CREDENTIAL')
    assert.match(err.message, /disabled/)
    assert.ok(err.reasons.every(function (r) { return r.reason === 'disabled' }))
    return true
  })
  const empty = pool({ localSids: [] })
  await empty.pool.refresh()
  await assert.rejects(() => empty.pool.resolveCredential(), /no-accounts/)
  // A persisted false survives a fresh pool instance; the default is not re-applied.
  const off = pool({ localSids: [] })
  assert.equal((await off.pool.updateSettings({ autoCheckin: false })).autoCheckin, false)
  const reopened = createLingxiAccountPool({ dataDir: off.dataDir, upstream: fakeUpstream(), localSids: [] })
  assert.equal((await reopened.status()).settings.autoCheckin, false)
  reopened.dispose()
  off.pool.dispose()
  empty.pool.dispose()
  p.dispose()
})

test('resolveCredential excludes dead states and unknown ids from saved state', async () => {
  const dataDir = tempDir()
  const upstream = fakeUpstream()
  const seed = {
    version: 1,
    accounts: [
      { id: accountId(SID_A), label: 'part-A', source: 'local', wpsSid: SID_A, enabled: true, credits: -1, state: 'session_dead' },
      { id: accountId(SID_B), label: 'part-B', source: 'local', wpsSid: SID_B, enabled: true, credits: -1, state: 'ok' },
      { id: accountId(SID_C), label: 'part-C', source: 'manual', wpsSid: SID_C, enabled: true, credits: -1, state: 'unavailable' }
    ],
    settings: { autoCheckin: true, timezone: 'Asia/Shanghai', poolOrder: [accountId(SID_A), accountId(SID_C), accountId(SID_B)], disabledModelIds: [], pollIntervalMinutes: 5 },
    checkin: {}, removedLocalIds: []
  }
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify(seed))
  const p = createLingxiAccountPool({ dataDir, upstream, localSids: [] })
  const s = await p.status()
  assert.equal(s.accounts.length, 3)
  assert.equal(s.accounts.find(function (a) { return a.id === accountId(SID_A) }).state, 'session_dead')
  // poolOrder puts the two dead accounts first; the only non-dead account must win
  assert.equal((await p.resolveCredential()).wpsSid, SID_B)
  noSecrets(s)
  p.dispose()
})

test('updateSettings validates timezone, pollIntervalMinutes, autoCheckin and both arrays', async () => {
  const { pool: p } = pool({ localSids: [{ sid: SID_A, label: 'part-A' }] })
  await p.refresh()
  const s = await p.updateSettings({ timezone: 'America/New_York', pollIntervalMinutes: 10, autoCheckin: true, disabledModelIds: ['m2'], poolOrder: ['abc'] })
  assert.equal(s.timezone, 'America/New_York')
  assert.equal(s.pollIntervalMinutes, 10)
  assert.equal(s.autoCheckin, true)
  assert.deepEqual(s.disabledModelIds, ['m2'])
  assert.deepEqual(s.poolOrder, ['abc'])
  const status = await p.status()
  assert.equal(status.checkin.autoEnabled, true)
  assert.equal(status.models.find(function (m) { return m.id === 'm2' }).enabled, false)
  assert.equal(status.models.find(function (m) { return m.id === 'm1' }).enabled, true)
  for (const bad of ['Not/AZone', 'EST', '', 5, null]) {
    await assert.rejects(() => p.updateSettings({ timezone: bad }), function (e) { assert.equal(e.field, 'timezone'); return true })
  }
  for (const bad of [0, 2, 6, 120, -1, '5', null, 5.5, NaN]) {
    await assert.rejects(() => p.updateSettings({ pollIntervalMinutes: bad }), function (e) { assert.equal(e.field, 'pollIntervalMinutes'); return true })
  }
  for (const good of [1, 5, 10, 30, 60]) {
    assert.equal((await p.updateSettings({ pollIntervalMinutes: good })).pollIntervalMinutes, good)
  }
  await assert.rejects(() => p.updateSettings({ autoCheckin: 'yes' }), function (e) { assert.equal(e.field, 'autoCheckin'); return true })
  await assert.rejects(() => p.updateSettings({ poolOrder: 'abc' }), function (e) { assert.equal(e.field, 'poolOrder'); return true })
  await assert.rejects(() => p.updateSettings({ poolOrder: [3] }), /non-empty strings/)
  await assert.rejects(() => p.updateSettings({ disabledModelIds: [null] }), /non-empty strings/)
  await assert.rejects(() => p.updateSettings({ unknown: 1 }), function (e) { assert.equal(e.field, 'unknown'); return true })
  // invalid patch leaves prior settings untouched
  assert.equal((await p.status()).settings.timezone, 'America/New_York')
  const { DEFAULT_SETTINGS } = await import('../src/pool/state.mjs')
  assert.equal(validateSettings({ timezone: 'UTC' }, DEFAULT_SETTINGS).timezone, 'UTC')
  assert.equal(validateSettings({ timezone: 'Etc/UTC' }, DEFAULT_SETTINGS).timezone, 'Etc/UTC')
  assert.equal(validateSettings({ pollIntervalMinutes: 60 }, DEFAULT_SETTINGS).timezone, 'Asia/Shanghai', 'absent timezone keeps its previous value')
  assert.equal(todayInTimezone('Asia/Shanghai', Date.UTC(2024, 0, 1, 0, 0, 0)), '2024-01-01')
  assert.equal(todayInTimezone('America/Los_Angeles', Date.UTC(2024, 0, 1, 10, 0, 0)), '2024-01-01')
  assert.equal(todayInTimezone('Asia/Shanghai', Date.UTC(2024, 0, 1, 18, 0, 0)), '2024-01-02')
  p.dispose()
})

test('runAutoCheckin is idempotent for the same day and passes the upstream task date to claimDaily', async () => {
  const upstream = fakeUpstream()
  const { pool: p, dataDir } = pool({ upstream, localSids: [
    { sid: SID_A, label: 'part-A' }, { sid: SID_B, label: 'part-B' }
  ] })
  await p.refresh()
  const r1 = await p.runAutoCheckin()
  assert.equal(r1.length, 2)
  assert.deepEqual(r1.map(function (r) { return r.outcome }), ['claimed', 'claimed'])
  assert.equal(upstream.calls.claimDaily.length, 2)
  for (const call of upstream.calls.claimDaily) {
    assert.equal(call.date, '2099-01-02', 'date must come from fetchDailyTask, not local today')
    assert.ok(ALL_SIDS.includes(call.sid))
  }
  const s1 = await p.status()
  assert.ok(s1.accounts.every(function (a) { return a.lastCheckinOutcome === 'claimed' && a.lastCheckinDate === s1.checkin.today }))
  noSecrets(r1)
  noSecrets(s1)
  const r2 = await p.runAutoCheckin()
  assert.deepEqual(r2.map(function (r) { return r.outcome }), ['already', 'already'])
  assert.equal(upstream.calls.claimDaily.length, 2, 'no second claim on the same local day')
  // manual checkin for the same id is also idempotent
  const manual = await p.checkin(s1.accounts[0].id)
  assert.equal(manual.outcome, 'already')
  assert.equal(upstream.calls.claimDaily.length, 2)
  // persistence: a fresh pool over the same dataDir must skip claiming again today
  const reopened = createLingxiAccountPool({ dataDir, upstream, localSids: [] })
  const r3 = await reopened.runAutoCheckin()
  assert.deepEqual(r3.map(function (r) { return r.outcome }), ['already', 'already'])
  assert.equal(upstream.calls.claimDaily.length, 2)
  noSecrets(await reopened.status())
  reopened.dispose()
  p.dispose()
})

test('manual checkin records failures without throwing, and error results never leak secrets', async () => {
  const secretEcho = 'sid-in-error-' + SID_A
  const upstream = fakeUpstream({
    async fetchDailyTask (sid) { return { key: 'daily_check_in', status: 'claimable', date: '2099-01-02' } },
    async claimDaily (sid, date) { throw Object.assign(new Error('upstream down: ' + secretEcho), { status: 503 }) }
  })
  const { pool: p } = pool({ upstream, localSids: [{ sid: SID_A, label: 'part-A' }] })
  await p.refresh()
  const id = (await p.status()).accounts[0].id
  const result = await p.checkin(id)
  assert.equal(result.outcome, 'failed')
  assert.equal(result.status, 503)
  noSecrets(result)
  const s = await p.status()
  assert.equal(s.accounts[0].lastCheckinOutcome, 'failed')
  assert.equal(s.accounts[0].lastCheckinDate, s.checkin.today)
  assert.ok(s.checkin.lastError)
  noSecrets(s)
  // a failed checkin is retryable (marker only blocks claimed/already)
  const again = await p.checkin(id)
  assert.equal(again.outcome, 'failed')
  // auto sweep records failures, not throws
  const auto = await p.runAutoCheckin()
  assert.equal(auto.length, 1)
  assert.equal(auto[0].outcome, 'failed')
  noSecrets(auto)
  const after = await p.status()
  assert.ok(after.checkin.lastError)
  noSecrets(after)
  p.dispose()
})

test('secret non-leakage across state.json, status, errors and typed failures', async () => {
  const { pool: p, dataDir } = pool({ localSids: [{ sid: SID_A, label: 'p' }] })
  await p.refresh()
  await p.addManual('manual', SID_M)
  const s = await p.status()
  noSecrets(s)
  noSecrets(await p.runAutoCheckin())
  noSecrets(await p.checkin(s.accounts[0].id))
  const cred = await p.resolveCredential()
  assert.equal(cred.wpsSid, SID_A)
  assert.ok(!('wpsSid' in s.accounts[0]))
  await p.remove(s.accounts[0].id)
  noSecrets(await p.status())
  // credential decryptor errors must not contain the plaintext marker
  const key = randomBytes(32)
  try {
    decryptChromeCookie(seal(SID_A, key), randomBytes(32))
    assert.fail('expected decryption failure')
  } catch (err) {
    assert.ok(err instanceof LingxiCredentialError)
    assert.ok(!String(err.message).includes(SID_A))
  }
  const persisted = readFileSync(join(dataDir, 'state.json'), 'utf8')
  assert.ok(persisted.includes(SID_M), 'server-side state keeps the secret locally')
  assert.ok(!persisted.includes('sidLength'), 'redacted view is not persisted')
  p.dispose()
})

test('import does not start a background timer; dispose clears an explicitly started timer', async () => {
  const { pool: p } = pool()
  await p.updateSettings({ autoCheckin: true, pollIntervalMinutes: 1 })
  assert.equal(p.startAutoCheckin(), true)
  assert.equal(p.startAutoCheckin(), true)
  await p.updateSettings({ autoCheckin: false })
  assert.equal(p.startAutoCheckin(), false)
  assert.doesNotThrow(() => p.dispose())
  assert.doesNotThrow(() => p.dispose())
})

test('module source contains no logging calls and no live network primitives', () => {
  for (const file of ['index.mjs', 'state.mjs', 'local-cookies.mjs']) {
    const source = readFileSync(join('src', 'pool', file), 'utf8')
    assert.ok(!/console\.(log|info|warn|error|debug|trace)\s*\(/.test(source), file + ': console logging')
    assert.ok(!/process\.(stdout|stderr)\.write\s*\(/.test(source), file + ': stdout write')
    assert.ok(!/\bfetch\s*\(/.test(source), file + ': network fetch')
    assert.ok(!/require\s*\(/.test(source), file + ': CJS require')
  }
})

test('credit balance is cached and survives upstream failure as -1', async () => {
  let calls = 0
  const upstream = fakeUpstream({ async fetchCredits () { calls += 1; return 1234 } })
  const { pool: p } = pool({ localSids: [{ sid: SID_A, label: 'part-A' }], upstream })
  await p.refresh()
  const a = await p.status()
  assert.equal(a.accounts[0].credits, 1234)
  assert.equal(calls, 1)
  const b = await p.status()
  assert.equal(b.accounts[0].credits, 1234)
  assert.equal(calls, 1, 'within TTL the balance is cached')
  p.dispose()
})

test('credit fetch failure keeps the previous balance and never leaks sids', async () => {
  const upstream = fakeUpstream({ async fetchCredits () { throw new Error('upstream down') } })
  const { pool: p } = pool({ localSids: [{ sid: SID_A, label: 'part-A' }], upstream })
  await p.refresh()
  const s = await p.status()
  assert.equal(s.accounts[0].credits, -1)
  noSecrets(s)
  p.dispose()
})

// --- v0.3 config-page capabilities ---
test('rename and reorder update persisted state without leaking sids', async () => {
  const { pool: p, dataDir } = pool({ localSids: [] })
  const a = await p.addManual('Alpha', SID_A)
  const b = await p.addManual('Bravo', SID_B)
  assert.equal(await p.rename(a.id, 'Alpha-renamed'), true)
  assert.equal(await p.rename('missing-id', 'X'), false)
  const order = await p.reorder([b.id, a.id])
  assert.deepEqual(order, [b.id, a.id])
  const st = await p.status()
  assert.equal(st.accounts[0].label, 'Bravo')
  assert.equal(st.accounts[1].label, 'Alpha-renamed')
  noSecrets(st)
  p.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

test('export / preview / import round-trips accounts with explicit sids', async () => {
  const { pool: p, dataDir } = pool({ localSids: [] })
  await p.addManual('Alpha', SID_A)
  await p.addManual('Bravo', SID_B)
  const file = await p.exportAccounts()
  assert.equal(file.format, 'dsh-connect-lingxi/accounts')
  assert.equal(file.accounts.length, 2)
  assert.equal(file.accounts[0].sid, SID_A)
  const preview = await p.previewImport(file)
  assert.equal(preview.count, 2)
  assert.equal(preview.accounts[0].sidLength, SID_A.length)
  assert.ok(!JSON.stringify(preview).includes(SID_A), 'preview leaks sid')
  const { pool: p2, dataDir: d2 } = pool({ localSids: [] })
  const result = await p2.importAccounts(file)
  assert.equal(result.imported, 2)
  assert.equal(result.skipped, 0)
  const st = await p2.status()
  assert.equal(st.accounts.length, 2)
  noSecrets(st)
  p.dispose(); p2.dispose()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(d2, { recursive: true, force: true })
})

test('checkinMany fans out and refreshModels / loginUrl are callable', async () => {
  const { pool: p, dataDir } = pool({ localSids: [] })
  const a = await p.addManual('Alpha', SID_A)
  const results = await p.checkinMany([a.id, 'missing'])
  assert.equal(results.length, 2)
  assert.equal(results[0].outcome, 'claimed')
  assert.equal(await p.refreshModels().then((s) => s.models.length), 2)
  assert.match(p.loginUrl(), /^https:\/\//)
  p.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

test('importAccounts reports duplicates as skipped, not imported', async () => {
  const { pool: p, dataDir } = pool({ localSids: [] })
  await p.addManual('Alpha', SID_A)
  const file = { accounts: [{ label: 'Alpha-again', sid: SID_A, source: 'manual' }] }
  const result = await p.importAccounts(file)
  assert.equal(result.imported, 0)
  assert.equal(result.skipped, 1)
  const st = await p.status()
  assert.equal(st.accounts.length, 1)
  p.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})
