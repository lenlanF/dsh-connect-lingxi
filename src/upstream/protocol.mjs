export const LINGXI_BASE = 'https://lingxi.kdocs.cn'
export const PLANS_PATH = '/api/aioffice/v1/sessions/plans'
export const CREDITS_PATH = '/api/public/v1/credits/balance?credit_type=total'
export const TASKS_PATH = '/api/public/v1/tasks'
export const DAILY_TASK_KEY = 'daily_check_in'
export const CREDITS_UNKNOWN = -1
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

export function upstreamHeaders(sid, base = LINGXI_BASE) {
  return {
    Accept: 'application/json',
    Cookie: 'wps_sid=' + sid + '; csrf=' + sid,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Origin: base,
    Referer: base + '/',
  }
}

/** Strip decorations such as "～0.12x"; non-finite or unparseable values are omitted. */
export function parseMultiplier(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : undefined
  if (typeof raw !== 'string') return undefined
  const match = raw.replace(/,/g, '').match(/\d+(?:\.\d+)?/)
  if (match === null) return undefined
  const value = Number(match[0])
  return Number.isFinite(value) ? value : undefined
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positiveNumber(value) {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

/** Parse only data.models; data.plans is a mode list and is not a model catalog. */
export function parseModelsV2(payload) {
  const entries = Array.isArray(payload?.data?.models) ? payload.data.models : []
  const models = []
  const seen = new Set()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.key === 'string' && entry.key !== ''
      ? entry.key
      : typeof entry.id === 'string' && entry.id !== '' ? entry.id : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const model = {
      id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
      enabled: true,
    }
    if (typeof entry.multiplier === 'string' && entry.multiplier !== '') {
      model.multiplier = entry.multiplier
    }
    const multiplierValue = parseMultiplier(entry.multiplier)
    if (multiplierValue !== undefined) model.multiplierValue = multiplierValue
    const contextWindow = finiteNumber(entry.max_context_tokens) ?? finiteNumber(entry.context_window)
    if (contextWindow !== undefined) model.contextWindow = contextWindow
    const maxTokens = finiteNumber(entry.max_new_tokens) ?? finiteNumber(entry.max_tokens)
    if (maxTokens !== undefined) model.maxTokens = maxTokens
    const efforts = Array.isArray(entry.reasoning_efforts) ? entry.reasoning_efforts : []
    model.reasoning = efforts.length > 0 || entry.reasoning === true || entry.reasoning === 'true'
    const defaultEffort = ['low', 'high', 'max'].find((effort) => efforts.includes(effort))
    if (defaultEffort !== undefined) model.defaultEffort = defaultEffort
    models.push(model)
  }
  return models
}

/** Sum the two balance arrays; -1 when neither shape is available. */
export function parseBalanceV2 (payload) {
  const data = payload?.data
  if (data === null || typeof data !== 'object') return null
  const grants = []
  for (const key of ['bonus_credits', 'purchased_credits']) {
    if (!Array.isArray(data[key])) continue
    for (const entry of data[key]) {
      const value = finiteNumber(entry?.value)
      const consumed = finiteNumber(entry?.consumed)
      const balance = finiteNumber(entry?.balance)
      if (balance === undefined) continue
      const grant = { value: value ?? balance, consumed: consumed ?? 0, balance }
      if (typeof entry?.expire_time === 'string' && entry.expire_time) grant.expiresAt = entry.expire_time
      grants.push(grant)
    }
  }
  const total = finiteNumber(data.total_balance)
    ?? finiteNumber(data.balance)
    ?? (grants.length ? grants.reduce(function (sum, g) { return sum + g.balance }, 0) : undefined)
  if (total === undefined) return null
  return {
    total: Math.round(total),
    bonus: Math.round(finiteNumber(data.total_bonus) ?? 0),
    purchased: Math.round(finiteNumber(data.total_purchased) ?? 0),
    contract: Math.round(finiteNumber(data.total_contract) ?? 0),
    grants
  }
}

/** Backward-compatible scalar: ONLY the authoritative total, never a sum-of-grants. */
export function parseCreditsV2 (payload) {
  const balance = parseBalanceV2(payload)
  return balance ? balance.total : CREDITS_UNKNOWN
}

function upstreamDate(value) {
  if (typeof value === 'string' && value !== '') return value
  if (value !== null && typeof value === 'object') {
    return typeof value.date === 'string' && value.date !== '' ? value.date : undefined
  }
  return undefined
}

/** Read the daily-check-in task without claiming it; dates come only from upstream. */
export function parseDailyTask(payload) {
  const key = DAILY_TASK_KEY
  if (!Array.isArray(payload?.data?.tasks)) return { key, status: 'unknown' }
  const daily = payload.data.tasks.find((task) => task?.task_key === key)
  if (daily === undefined || daily === null || typeof daily !== 'object') return { key, status: 'unavailable' }
  const extra = daily.extra !== null && typeof daily.extra === 'object' ? daily.extra : {}
  const days = Array.isArray(extra.check_in_days) ? extra.check_in_days : []
  const dateFields = [
    extra.today,
    extra.today_date,
    extra.claimable_date,
    extra.date,
    daily.date,
    payload.data.today,
    payload.data.date,
    payload.today,
    payload.date,
  ]
  const rootToday = dateFields.map(upstreamDate).find((value) => value !== undefined)
  const todayDay = positiveNumber(extra.today_day)
  const todayEntry = days.find((day) => day !== null && typeof day === 'object' && (
    (todayDay !== undefined && day.day === todayDay) ||
    (rootToday !== undefined && day.date === rootToday)
  ))
  const availableEntry = days.find((day) => day?.status === 'available' || day?.status === 'claimable')
  const rawStatus = daily.status
  let status
  if (rawStatus === 'claimed' || rawStatus === 'completed' || todayEntry?.status === 'claimed') status = 'claimed'
  else if (rawStatus === 'claimable' || availableEntry !== undefined || todayEntry?.status === 'claimable') status = 'claimable'
  else if (typeof rawStatus === 'string' || days.length > 0) status = 'unavailable'
  else status = 'unknown'
  const result = { key, status }
  const date = [availableEntry, todayEntry, ...dateFields].map(upstreamDate).find((value) => value !== undefined)
  if (date !== undefined) result.date = date
  const reward = positiveNumber(daily.reward_amount) ??
    positiveNumber(extra.today_reward) ??
    positiveNumber(availableEntry?.reward) ??
    positiveNumber(todayEntry?.reward)
  if (reward !== undefined) result.reward = reward
  const consecutiveDays = positiveNumber(extra.consecutive_days)
  if (consecutiveDays !== undefined) result.consecutiveDays = consecutiveDays
  return result
}

/** Extract a short, credential-free upstream message from a task claim response. */
export function claimMessage(payload) {
  for (const value of [
    payload?.hint,
    payload?.msg,
    payload?.message,
    payload?.error?.message,
    payload?.error,
    payload?.result,
  ]) {
    if (typeof value === 'string' && value !== '') return value.slice(0, 240)
  }
  return undefined
}

export function isAlreadyClaimed(status, payload) {
  if (payload?.data?.status === 'claimed' || payload?.data?.extra?.status === 'claimed') return true
  if (payload?.code === 'already_claimed' || payload?.code === 'AlreadyClaimed') return true
  if (payload?.data?.already_claimed === true) return true
  if (payload?.result === 'ok' && status >= 400) return true
  if (status < 400 || status >= 500) return false
  const text = [
    payload?.hint,
    payload?.msg,
    payload?.message,
    payload?.error?.message,
    payload?.error,
    payload?.code,
    typeof payload?.result === 'string' ? payload.result : '',
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase()
  return /already|claimed|duplicate|repeat|received|signed|已领|已签|重复|领取过|签到过/.test(text)
}
