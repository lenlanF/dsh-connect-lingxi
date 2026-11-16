// Local persistent state, settings validation, and redaction helpers for the account pool.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STATE_FILE = 'state.json'
export const POLL_INTERVAL_MINUTES = [1, 5, 10, 30, 60]
export const SETTING_KEYS = ['autoCheckin', 'timezone', 'poolOrder', 'disabledModelIds', 'pollIntervalMinutes']
export const DEFAULT_SETTINGS = Object.freeze({
  autoCheckin: true,
  timezone: 'Asia/Shanghai',
  poolOrder: [],
  disabledModelIds: [],
  pollIntervalMinutes: 5
})
export const DEAD_STATES = new Set(['session_dead', 'unavailable'])
const ACCOUNT_STATES = new Set(['ok', 'rate_limit', 'quota', 'session_dead', 'unavailable', 'transport', 'unknown'])
const CHECKIN_OUTCOMES = new Set(['claimed', 'already', 'failed'])
const KNOWN_SETTINGS = new Set(SETTING_KEYS)

export class LingxiAccountPoolError extends Error {
  constructor (message, reasons) {
    super(message)
    this.name = 'LingxiAccountPoolError'
    this.code = 'LINGXI_POOL_NO_CREDENTIAL'
    this.reasons = Array.isArray(reasons) ? reasons : []
  }
}

export class LingxiSettingsError extends TypeError {
  constructor (field, message) {
    super('invalid Lingxi setting ' + field + ': ' + message)
    this.name = 'LingxiSettingsError'
    this.code = 'LINGXI_POOL_INVALID_SETTINGS'
    this.field = field
  }
}

export function defaultDataDir () {
  return join(homedir(), '.dsh', 'profiles', 'desktop', 'data', 'dsh-connect-lingxi')
}

export function accountId (sid) {
  return createHash('sha256').update(sid, 'utf8').digest('hex').slice(0, 16)
}

export function validSid (value) {
  if (typeof value !== 'string') throw new TypeError('addManual: wpsSid must be a non-empty string')
  const trimmed = value.trim()
  if (!trimmed) throw new TypeError('addManual: wpsSid must be a non-empty string')
  if (trimmed.length > 512 || /[\s\u0000-\u001f]/.test(trimmed)) {
    throw new TypeError('addManual: wpsSid contains invalid characters')
  }
  return trimmed
}

const CANONICAL_SLASHLESS_ZONES = new Set(['UTC', 'GMT'])

export function validTimeZone (value) {
  if (typeof value !== 'string' || !value.trim()) return false
  const zone = value.trim()
  // Intl accepts legacy aliases such as 'EST'; allow only canonical IANA identifiers.
  if (CANONICAL_SLASHLESS_ZONES.has(zone)) return true
  if (!zone.includes('/')) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** Format NOW in the configured IANA timezone; the ONLY source of the daily idempotency marker. */
export function todayInTimezone (timeZone, nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(nowMs))
  const get = function (type) {
    const part = parts.find(function (item) { return item.type === type })
    return part ? part.value : ''
  }
  return get('year') + '-' + get('month') + '-' + get('day')
}

export function validateSettings (patch, base) {
  if (patch === undefined || patch === null) return cloneSettings(base)
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    throw new LingxiSettingsError('patch', 'must be a plain object')
  }
  const next = cloneSettings(base)
  for (const pair of Object.entries(patch)) {
    const key = pair[0]
    const value = pair[1]
    if (!KNOWN_SETTINGS.has(key)) throw new LingxiSettingsError(key, 'unknown setting')
    if (key === 'autoCheckin') {
      if (typeof value !== 'boolean') throw new LingxiSettingsError(key, 'must be a boolean')
      next.autoCheckin = value
    } else if (key === 'timezone') {
      if (!validTimeZone(value)) throw new LingxiSettingsError(key, 'must be a valid IANA timezone')
      next.timezone = value.trim()
    } else if (key === 'pollIntervalMinutes') {
      if (typeof value !== 'number' || !Number.isFinite(value) || !POLL_INTERVAL_MINUTES.includes(value)) {
        throw new LingxiSettingsError(key, 'must be one of ' + POLL_INTERVAL_MINUTES.join(','))
      }
      next.pollIntervalMinutes = value
    } else {
      if (!Array.isArray(value)) throw new LingxiSettingsError(key, 'must be an array of strings')
      const clean = []
      for (const item of value) {
        if (typeof item !== 'string' || !item.trim()) {
          throw new LingxiSettingsError(key, 'must contain non-empty strings')
        }
        const text = item.trim()
        if (!clean.includes(text)) clean.push(text)
      }
      next[key] = clean
    }
  }
  return next
}

export function cloneSettings (settings) {
  return {
    autoCheckin: Boolean(settings.autoCheckin),
    timezone: settings.timezone,
    poolOrder: Array.isArray(settings.poolOrder) ? settings.poolOrder.slice() : [],
    disabledModelIds: Array.isArray(settings.disabledModelIds) ? settings.disabledModelIds.slice() : [],
    pollIntervalMinutes: settings.pollIntervalMinutes
  }
}

/** Explicit whitelist: wpsSid and any other secret-bearing field never reach the browser. */
export function redactAccount (account) {
  const out = {
    id: account.id,
    label: account.label,
    source: account.source,
    enabled: Boolean(account.enabled),
    credits: Number.isFinite(account.credits) ? account.credits : -1,
    state: account.state,
    sidLength: typeof account.wpsSid === 'string' ? account.wpsSid.length : 0
  }
  if (typeof account.lastCheckedAt === 'number') out.lastCheckedAt = account.lastCheckedAt
  if (typeof account.lastCheckinDate === 'string') out.lastCheckinDate = account.lastCheckinDate
  if (CHECKIN_OUTCOMES.has(account.lastCheckinOutcome)) out.lastCheckinOutcome = account.lastCheckinOutcome
  const balance = account.balance
  if (balance && typeof balance === 'object') {
    out.balance = {
      total: Number.isFinite(balance.total) ? balance.total : -1,
      bonus: Number.isFinite(balance.bonus) ? balance.bonus : 0,
      purchased: Number.isFinite(balance.purchased) ? balance.purchased : 0,
      contract: Number.isFinite(balance.contract) ? balance.contract : 0,
      grants: Array.isArray(balance.grants) ? balance.grants.slice(0, 12).map(function (g) {
        return {
          value: Number.isFinite(g?.value) ? g.value : 0,
          consumed: Number.isFinite(g?.consumed) ? g.consumed : 0,
          balance: Number.isFinite(g?.balance) ? g.balance : 0,
          ...typeof g?.expiresAt === 'string' ? { expiresAt: g.expiresAt } : {}
        }
      }) : []
    }
  }
  return out
}

export function initialState () {
  return {
    version: 1,
    accounts: [],
    settings: cloneSettings(DEFAULT_SETTINGS),
    checkin: {},
    removedLocalIds: []
  }
}

export function normalizeState (raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const rawSettings = source.settings && typeof source.settings === 'object' ? source.settings : {}
  const settingsPatch = {}
  for (const key of SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(rawSettings, key)) settingsPatch[key] = rawSettings[key]
  }
  let settings
  try {
    settings = validateSettings(settingsPatch, DEFAULT_SETTINGS)
  } catch {
    settings = cloneSettings(DEFAULT_SETTINGS)
  }
  const accounts = []
  const seen = new Set()
  for (const item of Array.isArray(source.accounts) ? source.accounts : []) {
    if (!item || typeof item !== 'object' || typeof item.wpsSid !== 'string' || !item.wpsSid) continue
    const id = accountId(item.wpsSid)
    if (seen.has(id)) continue
    seen.add(id)
    const account = {
      id: id,
      label: typeof item.label === 'string' ? item.label : '',
      source: item.source === 'manual' ? 'manual' : 'local',
      wpsSid: item.wpsSid,
      enabled: item.enabled !== false,
      credits: Number.isFinite(item.credits) ? item.credits : -1,
      state: ACCOUNT_STATES.has(item.state) ? item.state : 'unknown'
    }
    if (typeof item.lastCheckedAt === 'number') account.lastCheckedAt = item.lastCheckedAt
    if (typeof item.lastCheckinDate === 'string') account.lastCheckinDate = item.lastCheckinDate
    if (CHECKIN_OUTCOMES.has(item.lastCheckinOutcome)) account.lastCheckinOutcome = item.lastCheckinOutcome
    if (Array.isArray(item.domains)) {
      account.domains = item.domains.filter(function (domain) { return typeof domain === 'string' })
    }
    accounts.push(account)
  }
  const checkin = {}
  if (source.checkin && typeof source.checkin === 'object') {
    if (typeof source.checkin.lastRunAt === 'number') checkin.lastRunAt = source.checkin.lastRunAt
    if (typeof source.checkin.lastError === 'string') checkin.lastError = source.checkin.lastError
  }
  return {
    version: 1,
    accounts: accounts,
    settings: settings,
    checkin: checkin,
    removedLocalIds: Array.isArray(source.removedLocalIds)
      ? source.removedLocalIds.filter(function (id) { return typeof id === 'string' })
      : []
  }
}

export function loadState (dataDir) {
  try {
    return normalizeState(JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8')))
  } catch {
    return initialState()
  }
}

export function saveState (dataDir, state) {
  mkdirSync(dataDir, { recursive: true })
  const target = join(dataDir, STATE_FILE)
  const temp = target + '.tmp'
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  renameSync(temp, target)
  return target
}

/** Diagnostics carry a category token and HTTP status only -- never an error message that could echo a sid. */
export function diagnosticError (kind, err) {
  const status = err && typeof err.status === 'number' ? ':http-' + err.status : ''
  return kind + status
}

/** Last-line defence: scrub every known sid out of any object returned to callers. */
export function scrubSecrets (value, secrets) {
  if (typeof value === 'string') {
    let out = value
    for (const secret of secrets) {
      if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]')
    }
    return out
  }
  if (Array.isArray(value)) {
    return value.map(function (item) { return scrubSecrets(item, secrets) })
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const pair of Object.entries(value)) out[pair[0]] = scrubSecrets(pair[1], secrets)
    return out
  }
  return value
}
