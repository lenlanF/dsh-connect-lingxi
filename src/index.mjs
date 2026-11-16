// DSH bundle entry (v0.2). Host contract verified against app.asar 0.2.2-rc.1:
// ctx.llm.registerAdapter / registerConfigurableProviders / registerModelDiscovery,
// ctx.webServer.register({kind:'exact', path, handler}) for loopback routes.
import { createLingxiAdapter } from './adapter.mjs'
import { registerLingxiRoutes } from './routes.mjs'
import { createLingxiClient } from './cowork/index.mjs'
import { createLingxiUpstream } from './upstream/index.mjs'
import { createLingxiAccountPool } from './pool/index.mjs'

const SETTINGS_NS = 'dsh-connect-lingxi'
const PROVIDER = 'lingxi'

export const name = SETTINGS_NS

// Cordis requires a bundle to declare every service it reads from ctx at apply time.
// Without this, the Desktop host refuses `ctx.llm` with
// "cannot get property \"llm\" without inject" and the whole fiber fails.
export const inject = ['llm', 'settings']

/**
 * @param {any} ctx
 * @param {{client:any, pool:any, upstream:any}} config
 */
export function applyWith(ctx, config) {
  const { client, pool, upstream } = config
  if (!ctx?.llm) {
    ctx?.logger?.warn?.('dsh-connect-lingxi: ctx.llm unavailable; provider not registered')
    return () => {}
  }

  // Adapter consumes the pool for credential selection and the upstream client
  // for the cowork WS chat path; models come from the v0.2 upstream module so
  // multipliers are available for the picker badge.
  const adapter = createLingxiAdapter({
    client,
    resolveCredential: () => pool.resolveCredential(),
    logger: ctx.logger,
  })
  const baseListModels = adapter.listModels.bind(adapter)
  adapter.listModels = async (provider) => {
    const models = await baseListModels(provider)
    const status = await pool.status().catch(() => null)
    const disabled = new Set(status?.settings?.disabledModelIds || [])
    const byId = new Map((status?.models || []).map((m) => [m.id, m]))
    return models.filter((m) => !disabled.has(m.id)).map((m) => {
      const live = byId.get(m.id)
      return {
        ...m,
        ...live?.multiplier ? { badge: { text: live.multiplier, tone: live.multiplierValue <= 0.2 ? 'success' : live.multiplierValue >= 1 ? 'warning' : 'neutral' } } : {},
      }
    })
  }

  let releaseAdapter
  let releaseDirectory
  let releaseDiscovery
  let releaseRoutes = () => {}
  let autoTimer

  // Workbuddy-shape: wait for webServer in a nested inject and register inside
  // an effect so the route lands on the committed service context.
  ctx.inject?.(['webServer'], (webCtx) => {
    webCtx.effect?.(() => {
      const dispose = registerLingxiRoutes(webCtx, pool)
      releaseRoutes = dispose
      return () => { dispose(); releaseRoutes = () => {} }
    })
  })

  try {
    releaseAdapter = ctx.llm.registerAdapter([PROVIDER], adapter)
    releaseDirectory = ctx.llm.registerConfigurableProviders?.([{
      provider: PROVIDER,
      displayName: 'WPS 灵犀',
      settingsNs: SETTINGS_NS,
      settingsPath: [],
      declared: false,
    }])
    releaseDiscovery = ctx.llm.registerModelDiscovery?.(SETTINGS_NS, async (request, signal) => {
      if (request?.provider && request.provider !== PROVIDER) return []
      return adapter.listModels(PROVIDER, signal)
    })
    releaseRoutes = () => {}
  } catch (error) {
    releaseAdapter?.()
    releaseDirectory?.()
    releaseDiscovery?.()
    releaseRoutes()
    ctx.logger?.error?.('dsh-connect-lingxi: registration failed', error)
    return () => {}
  }

  // Auto check-in is best-effort: one sweep on start (idempotent per Beijing day),
  // then a low-frequency timer driven by the pool's configured interval.
  const schedule = () => {
    if (autoTimer) clearInterval(autoTimer)
    const minutes = 5
    autoTimer = setInterval(() => {
      pool.runAutoCheckin().catch((error) => ctx.logger?.warn?.('dsh-connect-lingxi: auto check-in sweep failed: ' + (error?.message ?? String(error))))
    }, minutes * 60 * 1000)
    if (autoTimer?.unref) autoTimer.unref()
  }
  pool.refresh().then(() => {
    pool.runAutoCheckin().catch(() => {})
    schedule()
  }).catch((error) => ctx.logger?.warn?.('dsh-connect-lingxi: pool refresh failed: ' + (error?.message ?? String(error))))

  ctx.logger?.info?.('dsh-connect-lingxi: provider, routes and settings registered')
  const dispose = () => {
    if (autoTimer) clearInterval(autoTimer)
    releaseRoutes()
    releaseDiscovery?.()
    releaseDirectory?.()
    releaseAdapter?.()
    pool.dispose?.()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  return dispose
}

/** Production wiring: fully synchronous so Cordis sees the webServer
 * inject dependency during this plugin's own activation. An async apply that
 * calls ctx.inject in a later microtask leaves the routes unregistered. */
export function apply(ctx) {
  const upstream = createLingxiUpstream()
  const pool = createLingxiAccountPool({ upstream })
  return applyWith(ctx, { client: createLingxiClient(), pool, upstream })
}

