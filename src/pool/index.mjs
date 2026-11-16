// LingxiAccountPool: local multi-sid pool, redacted status, daily check-in scheduling.
// No background work starts at import time; refresh() and startAutoCheckin() are explicit.
import { scanLocalSids, userDataDir as localUserDataDir, isUsableSid } from './local-cookies.mjs'
import {
  DEAD_STATES,
  LingxiAccountPoolError,
  accountId,
  cloneSettings,
  defaultDataDir,
  diagnosticError,
  loadState,
  redactAccount,
  saveState,
  scrubSecrets,
  todayInTimezone,
  validSid,
  validateSettings
} from './state.mjs'

const OUTCOMES = new Set(['claimed', 'already', 'failed'])
const DONE_OUTCOMES = new Set(['claimed', 'already'])
const MODEL_KEYS = ['id', 'name', 'multiplier', 'multiplierValue', 'contextWindow', 'maxTokens', 'reasoning', 'defaultEffort']

function normalizeEntry (value, index) {
  if (typeof value === 'string') return { sid: value, label: 'partition-' + (index + 1), domains: [] }
  if (!value || typeof value !== 'object') return null
  const sid = typeof value.wpsSid === 'string' ? value.wpsSid : (typeof value.sid === 'string' ? value.sid : '')
  if (!sid) return null
  const label = typeof value.label === 'string' && value.label
    ? value.label
    : (typeof value.partition === 'string' && value.partition
      ? value.partition
      : (typeof value.name === 'string' && value.name ? value.name : 'partition-' + (index + 1)))
  const domains = Array.isArray(value.domains)
    ? value.domains.filter(function (item) { return typeof item === 'string' && item })
    : []
  return { sid: sid, label: label, domains: domains }
}

function normalizeEntries (value) {
  let raw = value
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    if (Array.isArray(raw.entries)) raw = raw.entries
    else if (Array.isArray(raw.credentials)) raw = raw.credentials
    else if (Array.isArray(raw.accounts)) raw = raw.accounts
    else if (raw.wpsSid || raw.sid) raw = [raw]
    else raw = []
  }
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (let i = 0; i < raw.length; i++) {
    const entry = normalizeEntry(raw[i], i)
    if (!entry || !isUsableSid(entry.sid) || seen.has(entry.sid)) continue
    seen.add(entry.sid)
    out.push(entry)
  }
  return out
}

function normalizeCheckinResult (value, fallback) {
  const source = value && typeof value === 'object' ? value : {}
  const outcome = OUTCOMES.has(source.outcome) ? source.outcome : (fallback || 'failed')
  const out = { outcome: outcome }
  if (typeof source.reward === 'number' && Number.isFinite(source.reward)) out.reward = source.reward
  if (typeof source.message === 'string') out.message = source.message
  if (typeof source.status === 'number' && Number.isFinite(source.status)) out.status = source.status
  return out
}

function normalizeModel (value, disabledIds) {
  const source = value && typeof value === 'object' ? value : {}
  const out = {
    id: typeof source.id === 'string' ? source.id : '',
    name: typeof source.name === 'string' ? source.name : '',
    enabled: !disabledIds.includes(source.id)
  }
  for (const key of MODEL_KEYS.slice(2)) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

/**
 * @param {object} [options]
 * @param {import('../types.ts').LingxiUpstream} [options.upstream]
 * @param {string} [options.dataDir] DSH profile data directory for state.json.
 * @param {object} [options.credential] Credential module injection for offline tests.
 * @param {Array|string} [options.localSids] Direct local sid injection for offline tests.
 * @param {Buffer|string} [options.osCryptKey] Injected AES key; skips the live DPAPI read.
 * @param {string} [options.userDataDir] Override the WPS Lingxi user data root.
 * @param {boolean} [options.autoRefresh] Scan local cookies on first use.
 * @param {boolean} [options.autoStart] Explicitly start the auto check-in timer.
 * @returns {import('../types.ts').LingxiAccountPool}
 */
export function createLingxiAccountPool (options) {
  const opts = options && typeof options === 'object' ? options : {}
  const dataDir = opts.dataDir || defaultDataDir()
  const upstream = opts.upstream || null
  let state = loadState(dataDir)
  const hadPersistedAccounts = state.accounts.length > 0
  let diagnostics = {
    userDataDir: localUserDataDir(opts.userDataDir) || 'APPDATA/WPS 灵犀',
    upstream: opts.upstreamName || (upstream ? 'lingxi' : 'none'),
    localSidCount: 0,
    manualSidCount: 0
  }
  let didRefresh = false
  let scanErrors = []
  let models = []
  let modelsAt = 0
  let creditsAt = 0
  let timer = null
  let autoArmed = false
  let disposed = false
  let chain = Promise.resolve()

  function serialize (fn) {
    const result = chain.then(fn, fn)
    chain = result.catch(function () {})
    return result
  }

  function secrets () {
    return state.accounts.map(function (account) { return account.wpsSid })
  }

  function persist () {
    try {
      saveState(dataDir, state)
      return true
    } catch (err) {
      scanErrors.push(diagnosticError('state-write', err))
      return false
    }
  }

  /** Explicit injection wins; otherwise the read-only Partitions/* Cookies scan is used. */
  async function discoverLocal () {
    const dir = localUserDataDir(opts.userDataDir) || 'APPDATA/WPS 灵犀'
    if (typeof opts.scanLocalSids === 'function') {
      try {
        return { entries: normalizeEntries(await opts.scanLocalSids()), errors: [], userDataDir: dir }
      } catch (err) {
        return { entries: [], errors: [diagnosticError('scan-injected', err)], userDataDir: dir }
      }
    }
    if (opts.localSids !== undefined) {
      return { entries: normalizeEntries(opts.localSids), errors: [], userDataDir: dir }
    }
    if (opts.localCredentials !== undefined) {
      return { entries: normalizeEntries(opts.localCredentials), errors: [], userDataDir: dir }
    }
    const injected = opts.credential
    if (Array.isArray(injected)) {
      return { entries: normalizeEntries(injected), errors: [], userDataDir: dir }
    }
    if (injected && typeof injected === 'object') {
      for (const key of ['scanLocalSids', 'listLocalCredentials', 'listCredentials', 'resolveLocalCredentials']) {
        if (typeof injected[key] !== 'function') continue
        try {
          return { entries: normalizeEntries(await injected[key]()), errors: [], userDataDir: dir }
        } catch (err) {
          return { entries: [], errors: [diagnosticError(key, err)], userDataDir: dir }
        }
      }
      if (!opts.userDataDir && !opts.osCryptKey && typeof injected.resolveLocalCredential === 'function') {
        try {
          return { entries: normalizeEntries([await injected.resolveLocalCredential()]), errors: [], userDataDir: dir }
        } catch (err) {
          return { entries: [], errors: [diagnosticError('resolveLocalCredential', err)], userDataDir: dir }
        }
      }
    }
    try {
      const scan = await scanLocalSids({
        userDataDir: opts.userDataDir,
        osCryptKey: opts.osCryptKey,
        credential: injected
      })
      return { entries: normalizeEntries(scan.entries), errors: scan.errors.slice(), userDataDir: scan.userDataDir || dir }
    } catch (err) {
      return { entries: [], errors: [diagnosticError('local-scan', err)], userDataDir: dir }
    }
  }

  async function doRefresh () {
    didRefresh = true
    const discovered = await discoverLocal()
    diagnostics.userDataDir = discovered.userDataDir
    scanErrors = discovered.errors.slice()
    const byId = new Map(state.accounts.map(function (account) { return [account.id, account] }))
    const seenLocal = new Set()
    for (const entry of discovered.entries) {
      const id = accountId(entry.sid)
      if (seenLocal.has(id) || state.removedLocalIds.includes(id)) continue
      seenLocal.add(id)
      let account = byId.get(id)
      if (!account) {
        account = {
          id: id,
          label: entry.label,
          source: 'local',
          wpsSid: entry.sid,
          enabled: true,
          credits: -1,
          state: 'unknown'
        }
        if (entry.domains.length) account.domains = entry.domains.slice()
        state.accounts.push(account)
        byId.set(id, account)
      } else {
        account.wpsSid = entry.sid
        if (account.source === 'local') account.label = entry.label
        if (entry.domains.length) account.domains = entry.domains.slice()
      }
    }
    // A conclusive scan can retire local accounts whose cookie disappeared; a failed
    // scan keeps them so a transient lock/DPAPI failure never empties the pool.
    if (!discovered.errors.length) {
      state.accounts = state.accounts.filter(function (account) {
        return account.source !== 'local' || seenLocal.has(account.id)
      })
    }
    persist()
  }

  function injectionPresent () {
    if (opts.scanLocalSids || opts.localSids !== undefined || opts.localCredentials !== undefined) return true
    if (opts.osCryptKey || opts.userDataDir) return true
    const injected = opts.credential
    if (Array.isArray(injected)) return true
    if (injected && typeof injected === 'object') {
      return ['scanLocalSids', 'listLocalCredentials', 'listCredentials', 'resolveLocalCredentials', 'resolveLocalCredential']
        .some(function (key) { return typeof injected[key] === 'function' })
    }
    return false
  }

  async function ensureRefreshed () {
    if (didRefresh) return
    // Persisted accounts survive a restart until an explicit refresh(). Without
    // any persisted state, first use discovers local cookies (production wiring
    // passes only { upstream }); injected test sources keep that scan offline.
    if (hadPersistedAccounts) { didRefresh = true; return }
    await doRefresh()
  }

  async function ensureRefreshedSafe () {
    try { await ensureRefreshed() } catch (err) { scanErrors.push(diagnosticError('refresh', err)) }
  }

  function orderedAccounts () {
    const byId = new Map(state.accounts.map(function (account) { return [account.id, account] }))
    const out = []
    const seen = new Set()
    for (const id of state.settings.poolOrder) {
      const account = byId.get(id)
      if (account && !seen.has(id)) { out.push(account); seen.add(id) }
    }
    for (const account of state.accounts) {
      if (!seen.has(account.id)) { out.push(account); seen.add(account.id) }
    }
    return out
  }

  function eligibleAccounts () {
    return orderedAccounts().filter(function (account) {
      return account.enabled && !DEAD_STATES.has(account.state) && typeof account.wpsSid === 'string' && account.wpsSid
    })
  }

  function unusableError () {
    const reasons = []
    for (const account of orderedAccounts()) {
      if (!account.enabled) reasons.push({ id: account.id, reason: 'disabled' })
      else if (DEAD_STATES.has(account.state)) reasons.push({ id: account.id, reason: 'state:' + account.state })
      else if (!account.wpsSid) reasons.push({ id: account.id, reason: 'missing-credential' })
    }
    if (!state.accounts.length) reasons.push({ id: '-', reason: 'no-accounts' })
    const summary = reasons.length
      ? reasons.map(function (item) { return item.id + ':' + item.reason }).join(', ')
      : 'all-accounts-excluded'
    return new LingxiAccountPoolError('no usable Lingxi account (' + summary + ')', reasons)
  }

  async function ensureModels (settings) {
    if (!upstream || typeof upstream.fetchModels !== 'function') return []
    const ttl = Math.max(1, settings.pollIntervalMinutes) * 60000
    if (models.length && Date.now() - modelsAt < ttl) {
      return models.map(function (model) {
        return Object.assign({}, model, { enabled: !settings.disabledModelIds.includes(model.id) })
      })
    }
    const account = eligibleAccounts()[0]
    if (!account) return []
    try {
      const raw = await upstream.fetchModels(account.wpsSid)
      models = normalizeEntriesModels(raw)
      modelsAt = Date.now()
    } catch (err) {
      diagnostics.lastError = diagnosticError('fetchModels', err)
    }
    return models.map(function (model) {
      return Object.assign({}, model, { enabled: !settings.disabledModelIds.includes(model.id) })
    })
  }

  function normalizeEntriesModels (raw) {
    if (!Array.isArray(raw)) return []
    return raw.map(function (item) { return normalizeModel(item, []) }).filter(function (item) { return item.id })
  }

  function eligibleById (id) {
    return state.accounts.find(function (account) { return account.id === id }) || null
  }

  function doneToday (account, today) {
    return account.lastCheckinDate === today && DONE_OUTCOMES.has(account.lastCheckinOutcome)
  }

  function recordCheckin (account, result, today) {
    account.lastCheckedAt = Date.now()
    account.lastCheckinDate = today
    account.lastCheckinOutcome = result.outcome
  }

  /** Internal check-in; never throws -- failures are recorded on the account. */
  async function doCheckin (account, today) {
    if (doneToday(account, today)) {
      return { outcome: 'already', message: 'already checked in today' }
    }
    if (!upstream || typeof upstream.claimDaily !== 'function') {
      const result = { outcome: 'failed', message: 'upstream unavailable' }
      recordCheckin(account, result, today)
      return result
    }
    let date
    if (typeof upstream.fetchDailyTask === 'function') {
      try {
        const task = await upstream.fetchDailyTask(account.wpsSid)
        date = task && typeof task.date === 'string' ? task.date : undefined
      } catch (err) {
        const result = { outcome: 'failed', message: 'daily task unavailable' }
        recordCheckin(account, result, today)
        return result
      }
    }
    let result
    try {
      // date comes ONLY from the upstream task; claimDaily owns idempotency upstream.
      result = normalizeCheckinResult(await upstream.claimDaily(account.wpsSid, date), 'claimed')
    } catch (err) {
      result = { outcome: 'failed', message: 'claimDaily failed' }
      if (err && typeof err.status === 'number') result.status = err.status
    }
    recordCheckin(account, result, today)
    return result
  }

  function clearTimer () {
    if (timer) { clearInterval(timer); timer = null }
  }

  function restartTimer () {
    clearTimer()
    if (disposed || !autoArmed || !state.settings.autoCheckin) return
    const ms = Math.max(1, state.settings.pollIntervalMinutes) * 60000
    timer = setInterval(function () {
      if (!state.settings.autoCheckin) return
      runAutoCheckin().catch(function () {})
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function startAutoCheckin () {
    autoArmed = true
    restartTimer()
    return state.settings.autoCheckin && timer !== null
  }

  /** Best-effort structured balance; scalar credits stays a compat mirror. */
  async function ensureCredits (settings) {
    if (!upstream) return
    const hasBalance = typeof upstream.fetchBalance === 'function'
    if (!hasBalance && typeof upstream.fetchCredits !== 'function') return
    const ttl = Math.max(1, settings.pollIntervalMinutes) * 60000
    if (creditsAt && Date.now() - creditsAt < ttl) return
    const accounts = eligibleAccounts()
    if (!accounts.length) return
    let changed = false
    for (const account of accounts) {
      try {
        const balance = hasBalance ? await upstream.fetchBalance(account.wpsSid) : null
        const scalar = balance ? balance.total : await upstream.fetchCredits(account.wpsSid)
        if (Number.isFinite(scalar) && scalar >= 0 && scalar !== account.credits) {
          account.credits = Math.round(scalar)
          changed = true
        }
        if (balance && typeof balance === 'object') {
          account.balance = {
            total: balance.total,
            bonus: balance.bonus,
            purchased: balance.purchased,
            contract: balance.contract,
            grants: Array.isArray(balance.grants) ? balance.grants.slice(0, 12) : []
          }
          changed = true
        }
        account.lastCheckedAt = Date.now()
        if (DEAD_STATES.has(account.state)) account.state = 'ok'
      } catch (err) {
        diagnostics.lastError = diagnosticError('fetchBalance', err)
      }
    }
    creditsAt = Date.now()
    if (changed) persist()
  }

  async function refresh () {
    return serialize(async function () {
      await doRefresh()
    })
  }

  async function status () {
    return serialize(async function () {
      await ensureRefreshedSafe()
      const settings = cloneSettings(state.settings)
      const today = todayInTimezone(settings.timezone, Date.now())
      const modelList = await ensureModels(settings)
      await ensureCredits(settings)
      const accounts = orderedAccounts().map(function (account) { return redactAccount(account) })
      const checkin = { today: today, autoEnabled: Boolean(settings.autoCheckin) }
      if (typeof state.checkin.lastRunAt === 'number') checkin.lastRunAt = state.checkin.lastRunAt
      const lastError = state.checkin.lastError || (scanErrors.length ? scanErrors.join('; ') : undefined)
      if (lastError) checkin.lastError = lastError
      const out = {
        accounts: accounts,
        models: modelList,
        settings: settings,
        checkin: checkin,
        diagnostics: {
          userDataDir: diagnostics.userDataDir,
          upstream: diagnostics.upstream,
          localSidCount: state.accounts.filter(function (a) { return a.source === 'local' }).length,
          manualSidCount: state.accounts.filter(function (a) { return a.source === 'manual' }).length
        }
      }
      if (diagnostics.lastError || scanErrors.length) {
        out.diagnostics.lastError = diagnostics.lastError || scanErrors.join('; ')
      }
      return scrubSecrets(out, secrets())
    })
  }

  async function resolveCredential () {
    return serialize(async function () {
      await ensureRefreshedSafe()
      const account = eligibleAccounts()[0]
      if (!account) throw unusableError()
      const out = {
        wpsSid: account.wpsSid,
        source: account.source === 'manual' ? 'manual' : 'local-cookie'
      }
      if (Array.isArray(account.domains) && account.domains.length) out.domains = account.domains.slice()
      return out
    })
  }

  async function addManual (label, sid) {
    return serialize(async function () {
      const cleanSid = validSid(sid)
      const id = accountId(cleanSid)
      const existing = state.accounts.find(function (account) { return account.id === id })
      if (existing) return redactAccount(existing)
      const cleanLabel = typeof label === 'string' && label.trim() ? label.trim() : 'Manual account'
      const account = {
        id: id,
        label: cleanLabel,
        source: 'manual',
        wpsSid: cleanSid,
        enabled: true,
        credits: -1,
        state: 'unknown'
      }
      state.accounts.push(account)
      if (state.removedLocalIds.includes(id)) {
        state.removedLocalIds = state.removedLocalIds.filter(function (item) { return item !== id })
      }
      persist()
      return redactAccount(account)
    })
  }

  async function remove (id) {
    return serialize(async function () {
      const index = state.accounts.findIndex(function (account) { return account.id === id })
      if (index < 0) return false
      const account = state.accounts[index]
      state.accounts.splice(index, 1)
      if (account.source === 'local' && !state.removedLocalIds.includes(id)) state.removedLocalIds.push(id)
      state.settings.poolOrder = state.settings.poolOrder.filter(function (item) { return item !== id })
      persist()
      return true
    })
  }

  async function setEnabled (id, enabled) {
    return serialize(async function () {
      const account = eligibleById(id)
      if (!account) return false
      account.enabled = Boolean(enabled)
      persist()
      return true
    })
  }

  async function runAutoCheckin () {
    return serialize(async function () {
      await ensureRefreshedSafe()
      const today = todayInTimezone(state.settings.timezone, Date.now())
      const results = []
      let failed = false
      for (const account of eligibleAccounts()) {
        if (doneToday(account, today)) {
          results.push({ outcome: 'already', message: 'already checked in today' })
          continue
        }
        let result
        try {
          result = await doCheckin(account, today)
        } catch (err) {
          result = { outcome: 'failed', message: 'checkin failed' }
        }
        if (result.outcome === 'failed') failed = true
        results.push(result)
      }
      state.checkin.lastRunAt = Date.now()
      if (failed) state.checkin.lastError = 'auto-checkin-partial-failure'
      else delete state.checkin.lastError
      persist()
      return scrubSecrets(results, secrets())
    })
  }

  async function checkin (id) {
    return serialize(async function () {
      const account = eligibleById(id)
      if (!account) return { outcome: 'failed', message: 'unknown account id' }
      const today = todayInTimezone(state.settings.timezone, Date.now())
      let result
      try {
        result = await doCheckin(account, today)
      } catch (err) {
        result = { outcome: 'failed', message: 'checkin failed' }
      }
      if (result.outcome === 'failed') state.checkin.lastError = 'manual-checkin-failure'
      else delete state.checkin.lastError
      persist()
      return scrubSecrets(result, secrets())
    })
  }

  async function updateSettings (patch) {
    return serialize(async function () {
      state.settings = validateSettings(patch, state.settings)
      restartTimer()
      persist()
      return cloneSettings(state.settings)
    })
  }

  async function rename (id, label) {
    return serialize(async function () {
      const account = eligibleById(id)
      if (!account) return false
      const clean = String(label ?? '').trim().slice(0, 80)
      if (!clean) return false
      account.label = clean
      persist()
      return true
    })
  }

  async function reorder (ids) {
    if (!Array.isArray(ids)) throw new TypeError('reorder: ids must be an array')
    return serialize(async function () {
      const current = orderedAccounts().map(function (a) { return a.id })
      const picked = ids.filter(function (id) { return current.includes(id) })
      const rest = current.filter(function (id) { return !picked.includes(id) })
      state.settings.poolOrder = [...picked, ...rest]
      persist()
      return state.settings.poolOrder.slice()
    })
  }

  async function checkinMany (ids) {
    if (!Array.isArray(ids) || ids.length === 0) return []
    const out = []
    for (const id of ids) out.push(await checkin(id))
    return out
  }

  async function exportAccounts (ids) {
    return serialize(async function () {
      const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null
      const records = state.accounts
        .filter(function (a) { return !wanted || wanted.has(a.id) })
        .map(function (a) {
          return { label: a.label, sid: a.wpsSid, source: a.source === 'manual' ? 'manual' : 'local' }
        })
      return { format: 'dsh-connect-lingxi/accounts', version: 1, exportedAt: Date.now(), accounts: records }
    })
  }

  async function importAccounts (payload) {
    const raw = payload && typeof payload === 'object' ? payload : {}
    const list = Array.isArray(raw.accounts) ? raw.accounts : (Array.isArray(raw) ? raw : null)
    if (!list) throw new TypeError('importAccounts: accounts array required')
    const seen = new Set()
    const candidates = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const sid = validSid(typeof item.sid === 'string' ? item.sid : (typeof item.wpsSid === 'string' ? item.wpsSid : ''))
      const id = accountId(sid)
      if (seen.has(id)) continue
      seen.add(id)
      candidates.push({
        sid,
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : '导入账号',
        source: item.source === 'local' ? 'local' : 'manual'
      })
    }
    let imported = 0
    let skipped = 0
    const existingIds = new Set(state.accounts.map(function (a) { return a.id }))
    for (const item of candidates) {
      const id = accountId(item.sid)
      if (existingIds.has(id)) { skipped++; continue }
      try {
        const result = await addManual(item.label, item.sid)
        if (result && result.id) { imported++; existingIds.add(id) }
        else skipped++
      } catch {
        skipped++
      }
    }
    return { imported, skipped, total: candidates.length }
  }

  async function previewImport (payload) {
    const raw = payload && typeof payload === 'object' ? payload : {}
    const list = Array.isArray(raw.accounts) ? raw.accounts : (Array.isArray(raw) ? raw : null)
    if (!list) throw new TypeError('previewImport: accounts array required')
    const seen = new Set()
    const out = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      let sid
      try { sid = validSid(typeof item.sid === 'string' ? item.sid : (typeof item.wpsSid === 'string' ? item.wpsSid : '')) } catch { continue }
      const id = accountId(sid)
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ label: typeof item.label === 'string' ? item.label : '', sidLength: sid.length, source: item.source === 'local' ? 'local' : 'manual' })
    }
    return { count: out.length, accounts: out }
  }

  async function refreshModels () {
    modelsAt = 0
    return status()
  }

  function loginUrl () {
    return 'https://lingxi.kdocs.cn'
  }

  function dispose () {
    autoArmed = false
    disposed = true
    clearTimer()
  }

  const pool = {
    refresh,
    status,
    resolveCredential,
    addManual,
    remove,
    setEnabled,
    rename,
    reorder,
    checkinMany,
    exportAccounts,
    importAccounts,
    previewImport,
    refreshModels,
    loginUrl,
    runAutoCheckin,
    checkin,
    updateSettings,
    dispose
  }
  // Explicit auto-timer control without widening the frozen LingxiAccountPool key set.
  Object.defineProperty(pool, 'startAutoCheckin', { value: startAutoCheckin, enumerable: false })
  if (opts.autoStart === true) startAutoCheckin()
  return pool
}
