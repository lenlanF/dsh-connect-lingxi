import {
  CREDITS_PATH,
  CREDITS_UNKNOWN,
  DAILY_TASK_KEY,
  LINGXI_BASE,
  PLANS_PATH,
  TASKS_PATH,
  claimMessage,
  isAlreadyClaimed,
  parseCreditsV2,
  parseBalanceV2,
  parseDailyTask,
  parseModelsV2,
  upstreamHeaders,
} from './protocol.mjs'

const STATIC_MESSAGE = 'lingxi upstream request failed'
const CLAIM_ENVELOPE_OK = 'ok'

/** Non-secret summaries only. Never includes a sid, URL, header or response body. */
function safeMessage(error, fallback) {
  const name = error?.name
  if (name === 'AbortError' || name === 'TimeoutError') return 'lingxi upstream request aborted'
  if (name === 'TypeError') return 'lingxi upstream transport failure'
  if (name === 'SyntaxError') return 'lingxi upstream invalid JSON'
  return fallback
}

function combinedSignal(outer, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  const onAbort = () => controller.abort()
  if (outer?.aborted) controller.abort()
  else outer?.addEventListener?.('abort', onAbort, { once: true })
  return controller.signal
}

function endpoint(base, path) {
  return String(base).replace(/\/+$/, '') + path
}

function unauthorized(payload, status) {
  return status === 401 || status === 403 || payload?.result === 'UserUnauthorized'
}

function redactMessage(message, sid) {
  if (message === undefined || typeof sid !== 'string' || sid === '') return message
  return message.split(sid).join('[redacted]')
}

function withFields(result, message, status) {
  if (message !== undefined) result.message = message
  if (status !== undefined) result.status = status
  return result
}

function rewardOf(payload) {
  const raw = payload?.data?.extra?.today_reward ?? payload?.data?.reward_amount
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw)
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Math.round(Number(raw))
  return undefined
}

/** Create the frozen four-method upstream capability; inject fetchLike/base for offline tests. */
export function createLingxiUpstream(options = {}) {
  const base = options.base ?? LINGXI_BASE
  const fetchLike = options.fetchLike ?? ((url, init) => fetch(url, init))
  const timeoutMs = options.timeoutMs ?? 20000

  async function request(sid, path, signal, init = {}) {
    const headers = { ...upstreamHeaders(sid, base), ...(init.headers ?? {}) }
    const response = await fetchLike(endpoint(base, path), {
      ...init,
      method: init.method ?? 'GET',
      headers,
      signal: combinedSignal(signal, timeoutMs),
    })
    let payload = {}
    let parseFailed = false
    try {
      if (typeof response.text === 'function') {
        const text = await response.text()
        if (text !== '') payload = JSON.parse(text)
      } else if (typeof response.json === 'function') {
        payload = await response.json()
      }
    } catch {
      payload = {}
      parseFailed = true
    }
    const numericStatus = Number(response.status)
    const status = Number.isFinite(numericStatus) && numericStatus > 0 ? numericStatus : response.ok === true ? 200 : 0
    return { status, ok: response.ok !== false && status >= 200 && status < 300, payload, parseFailed }
  }

  async function fetchModels(sid, signal = undefined) {
    try {
      const { status, ok, payload, parseFailed } = await request(sid, PLANS_PATH, signal)
      if (!ok || parseFailed || unauthorized(payload, status)) return []
      return parseModelsV2(payload)
    } catch {
      return []
    }
  }

  async function fetchBalance(sid, signal = undefined) {
    try {
      const { status, ok, payload, parseFailed } = await request(sid, CREDITS_PATH, signal)
      if (!ok || parseFailed || unauthorized(payload, status)) return null
      return parseBalanceV2(payload)
    } catch {
      return null
    }
  }

  async function fetchCredits(sid, signal = undefined) {
    const balance = await fetchBalance(sid, signal)
    return balance ? balance.total : CREDITS_UNKNOWN
  }

  /** Read-only task center lookup. Never issues the claim POST. */
  async function fetchDailyTask(sid, signal = undefined) {
    try {
      const { status, ok, payload, parseFailed } = await request(sid, TASKS_PATH, signal)
      if (unauthorized(payload, status) || parseFailed) return { key: DAILY_TASK_KEY, status: 'unknown' }
      if (!ok) return { key: DAILY_TASK_KEY, status: 'unavailable' }
      return parseDailyTask(payload)
    } catch {
      return { key: DAILY_TASK_KEY, status: 'unknown' }
    }
  }

  /** Claim exactly one caller-supplied upstream date. Dates are never computed here. */
  async function claimDaily(sid, date, signal = undefined) {
    const path = TASKS_PATH + '/' + encodeURIComponent(DAILY_TASK_KEY) + '/claim' +
      (typeof date === 'string' && date !== '' ? '?date=' + encodeURIComponent(date) : '')
    try {
      const { status, ok, payload, parseFailed } = await request(sid, path, signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (status === 401 || status === 403 || payload?.result === 'UserUnauthorized') {
        return withFields({ outcome: 'failed', message: 'session_dead' }, undefined, status)
      }
      if (parseFailed) {
        return withFields({ outcome: 'failed', message: 'lingxi upstream invalid JSON' }, undefined, status)
      }
      const message = redactMessage(claimMessage(payload), sid)
      if (
        (typeof payload?.result === 'string' && payload.result.toLowerCase() !== CLAIM_ENVELOPE_OK) ||
        !ok
      ) {
        return withFields({ outcome: isAlreadyClaimed(status, payload) ? 'already' : 'failed' }, message, status)
      }
      if (isAlreadyClaimed(status, payload)) return withFields({ outcome: 'already' }, message, status)
      const reward = rewardOf(payload)
      return reward === undefined ? { outcome: 'claimed' } : { outcome: 'claimed', reward }
    } catch (error) {
      return { outcome: 'failed', message: safeMessage(error, STATIC_MESSAGE) }
    }
  }

  return { fetchModels, fetchBalance, fetchCredits, fetchDailyTask, claimDaily }
}
