// Host loopback HTTP routes for the v0.2 settings page.
// Contract frozen in src/types.ts. All responses are JSON and never contain sids.
const PREFIX = '/plugins/dsh-connect-lingxi'

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}

function loopback(req, res) {
  const address = req.socket?.remoteAddress || ''
  const ok = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
  if (!ok) json(res, 403, { error: 'loopback only' })
  return ok
}

async function bodyJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

function safe(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 300 ? message.slice(0, 300) : message
}

/** Only the selected account's spendable credits are shown in the composer.
 * Never add balances across accounts: the provider sends requests using one
 * credential (the first enabled, eligible account in pool order).
 * Expose no ids, cookie lengths, tokens, grants or diagnostic paths.
 */
export function creditReadout(status) {
  const accounts = Array.isArray(status?.accounts) ? status.accounts : []
  const summaries = accounts.map(account => {
    const known = typeof account?.credits === 'number' && Number.isFinite(account.credits) && account.credits >= 0
    const balance = account?.balance
    return {
      label: String(account?.label ?? '').slice(0, 80),
      enabled: account?.enabled === true,
      state: String(account?.state ?? 'unknown'),
      credits: known ? account.credits : null,
      bonus: known && Number.isFinite(balance?.bonus) ? balance.bonus : null,
      purchased: known && Number.isFinite(balance?.purchased) ? balance.purchased : null,
      lastCheckedAt: Number.isFinite(account?.lastCheckedAt) ? account.lastCheckedAt : null,
    }
  })
  const activeIndex = accounts.findIndex(account =>
    account?.enabled === true && !['session_dead', 'unavailable'].includes(account?.state) &&
    Number.isFinite(account?.sidLength) && account.sidLength > 0)
  return {
    provider: 'lingxi',
    activeIndex,
    credits: activeIndex < 0 ? null : summaries[activeIndex].credits,
    accounts: summaries,
  }
}

/** Register GET/POST routes. Returns a disposer. */
export function registerLingxiRoutes(ctx, pool) {
  if (!ctx?.webServer?.register) return () => {}
  const disposers = []
  const route = (path, methods, handler) => {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + path,
      handler: async (req, res) => {
        if (!loopback(req, res)) return
        if (!methods.includes(req.method || '')) return json(res, 405, { error: 'method not allowed' })
        try { await handler(req, res, await bodyJson(req)) }
        catch (error) {
          const invalid = error?.code === 'LINGXI_POOL_INVALID_SETTINGS' || error?.name === 'LingxiSettingsError'
          json(res, invalid ? 400 : 500, { error: safe(error) })
        }
      },
    }))
  }

  route('/status', ['GET'], async (_req, res) => json(res, 200, await pool.status()))
  const creditsData = (force) => typeof pool.creditsStatus === 'function'
    ? pool.creditsStatus(force) : pool.status()
  route('/credits', ['GET'], async (_req, res) => json(res, 200, creditReadout(await creditsData(false))))
  route('/credits/refresh', ['POST'], async (_req, res) => json(res, 200, creditReadout(await creditsData(true))))
  route('/refresh', ['POST'], async (_req, res) => { await pool.refresh(); json(res, 200, await pool.status()) })
  route('/account', ['POST'], async (_req, res, body) => {
    if (!body || typeof body.label !== 'string' || typeof body.sid !== 'string' || !body.sid.trim()) return json(res, 400, { error: 'label and sid required' })
    json(res, 200, await pool.addManual(body.label.trim(), body.sid.trim()))
  })
  route('/account/remove', ['POST'], async (_req, res, body) => {
    if (!body || typeof body.id !== 'string') return json(res, 400, { error: 'id required' })
    json(res, 200, { ok: await pool.remove(body.id) })
  })
  route('/account/toggle', ['POST'], async (_req, res, body) => {
    if (!body || typeof body.id !== 'string' || typeof body.enabled !== 'boolean') return json(res, 400, { error: 'id and enabled required' })
    json(res, 200, { ok: await pool.setEnabled(body.id, body.enabled) })
  })
  route('/checkin', ['POST'], async (_req, res, body) => {
    const results = body?.id ? [await pool.checkin(body.id)] : await pool.runAutoCheckin()
    json(res, 200, { results })
  })
  route('/settings', ['POST'], async (_req, res, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'settings patch required' })
    json(res, 200, await pool.updateSettings(body))
  })
  route('/account/rename', ['POST'], async (_req, res, body) => {
    if (!body || typeof body.id !== 'string' || typeof body.label !== 'string') return json(res, 400, { error: 'id and label required' })
    json(res, 200, { ok: await pool.rename(body.id, body.label) })
  })
  route('/account/reorder', ['POST'], async (_req, res, body) => {
    if (!body || !Array.isArray(body.ids)) return json(res, 400, { error: 'ids array required' })
    json(res, 200, { order: await pool.reorder(body.ids) })
  })
  route('/checkin/many', ['POST'], async (_req, res, body) => {
    if (!body || !Array.isArray(body.ids)) return json(res, 400, { error: 'ids array required' })
    json(res, 200, { results: await pool.checkinMany(body.ids) })
  })
  route('/models/refresh', ['POST'], async (_req, res) => json(res, 200, await pool.refreshModels()))
  route('/transfer/export', ['POST'], async (_req, res, body) => {
    const ids = body && Array.isArray(body.ids) ? body.ids : null
    json(res, 200, await pool.exportAccounts(ids))
  })
  route('/transfer/preview', ['POST'], async (_req, res, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.accounts)) return json(res, 400, { error: 'accounts array required' })
    json(res, 200, await pool.previewImport(body))
  })
  route('/transfer/import', ['POST'], async (_req, res, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.accounts)) return json(res, 400, { error: 'accounts array required' })
    json(res, 200, await pool.importAccounts(body))
  })
  route('/login/open', ['POST'], async (_req, res) => {
    const url = typeof pool.loginUrl === 'function' ? pool.loginUrl() : 'https://lingxi.kdocs.cn'
    try {
      const { spawn } = await import('node:child_process')
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
      else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' })
      else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
      json(res, 200, { ok: true, url })
    } catch (error) {
      json(res, 200, { ok: false, url, error: safe(error) })
    }
  })

  return () => { for (const dispose of disposers) try { dispose() } catch {} }
}

export { PREFIX, loopback, safe }
