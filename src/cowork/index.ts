import type {
  LingxiChatOptions,
  LingxiClient,
  LingxiCredential,
  LingxiModel,
  LingxiStreamEvent,
} from '../types.ts'
import {
  CREDITS_UNKNOWN,
  CREDITS_URL,
  PLANS_URL,
  SANDBOX_OUTPUT_DIR,
  SANDBOX_PREVIEW_URL,
  COWORK_SESSIONS_URL,
  buildUserInput,
  coworkHeaders,
  coworkWsHeaders,
  coworkWsUrl,
  parseCredits,
  parseModels,
  parseSandboxFiles,
  parseSessionId,
  sandboxFilesUrl,
  type CoworkTransport,
  type WebSocketLike,
} from './protocol.ts'
import { CoworkStreamIterator } from './stream.ts'

/** Factory options: production uses all defaults; tests inject both seams. */
export interface CreateLingxiClientOptions {
  transport?: CoworkTransport
  resolveCredentialFn?: () => Promise<LingxiCredential>
  timeoutMs?: number
}

interface ClientDeps {
  fetchLike: (url: string, init: RequestInit) => Promise<Response>
  wsFactory: (url: string, headers: Record<string, string>) => WebSocketLike
  resolveCredentialFn: () => Promise<LingxiCredential>
  timeoutMs: number
}

function defaultWsFactory(url: string, headers: Record<string, string>): WebSocketLike {
  const ctor = (globalThis as Record<string, unknown>).WebSocket as
    | (new (url: string, options: unknown) => WebSocketLike)
    | undefined
  if (ctor === undefined) throw new Error('WebSocket is unavailable in this Node runtime')
  return new ctor(url, { headers })
}

function defaultResolveCredential(): Promise<LingxiCredential> {
  return Promise.reject(
    new Error('No local credential reader is installed. Pass resolveCredentialFn to createLingxiClient().'),
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Create a signal that aborts on an outer signal or after a timeout (built-ins only). */
function combinedSignal(outer: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') timer.unref()
  if (outer !== undefined) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

interface ChatArtifact {
  name: string
  bytes: Uint8Array
}

class CoworkLingxiClient implements LingxiClient {
  private readonly modelsCache = new Map<string, LingxiModel[]>()

  private readonly deps: ClientDeps

  constructor(deps: ClientDeps) {
    this.deps = deps
  }

  resolveCredential(): Promise<LingxiCredential> {
    return this.deps.resolveCredentialFn()
  }

  private async request(
    credential: LingxiCredential,
    url: string,
    init: RequestInit,
    outer?: AbortSignal,
  ): Promise<Response> {
    const headers = {
      ...coworkHeaders(credential.wpsSid),
      ...(init.headers as Record<string, string> | undefined),
    }
    return this.deps.fetchLike(url, {
      ...init,
      headers,
      signal: combinedSignal(outer, this.deps.timeoutMs),
    })
  }

  async listModels(credential: LingxiCredential, signal?: AbortSignal): Promise<LingxiModel[]> {
    const key = credential.source
    const cached = this.modelsCache.get(key)
    if (cached !== undefined) return cached
    try {
      const response = await this.request(
        credential,
        PLANS_URL,
        { method: 'GET', headers: { Accept: '*/*' } },
        signal,
      )
      if (!response.ok) return []
      const models = parseModels(await response.json())
      if (models.length > 0) this.modelsCache.set(key, models)
      return models
    } catch {
      return []
    }
  }

  async credits(credential: LingxiCredential, signal?: AbortSignal): Promise<number> {
    try {
      const response = await this.request(
        credential,
        CREDITS_URL,
        { method: 'GET', headers: { Accept: '*/*' } },
        signal,
      )
      if (!response.ok) return CREDITS_UNKNOWN
      return parseCredits(await response.json())
    } catch {
      return CREDITS_UNKNOWN
    }
  }

  chat(credential: LingxiCredential, options: LingxiChatOptions): AsyncIterable<LingxiStreamEvent> {
    return this.runChat(credential, options)
  }

  private async *runChat(
    credential: LingxiCredential,
    options: LingxiChatOptions,
  ): AsyncIterable<LingxiStreamEvent> {
    let sessionId: string
    try {
      const response = await this.request(
        credential,
        COWORK_SESSIONS_URL,
        { method: 'POST', body: '{}' },
        options.signal,
      )
      const text = await response.text()
      if (!response.ok) {
        yield { type: 'error', message: 'cowork create session failed (HTTP ' + response.status + ')', status: response.status }
        yield { type: 'done' }
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        yield { type: 'error', message: 'cowork create session returned invalid JSON', status: response.status }
        yield { type: 'done' }
        return
      }
      const created = parseSessionId(payload, response.status)
      if (!created.ok) {
        yield { type: 'error', message: created.message, status: created.status }
        yield { type: 'done' }
        return
      }
      sessionId = created.id
    } catch (err) {
      yield { type: 'error', message: 'cowork create session failed: ' + errorMessage(err) }
      yield { type: 'done' }
      return
    }

    let ws: WebSocketLike
    try {
      ws = this.deps.wsFactory(coworkWsUrl(sessionId), coworkWsHeaders(credential.wpsSid))
    } catch (err) {
      yield { type: 'error', message: 'cowork websocket connect failed: ' + errorMessage(err) }
      yield { type: 'done' }
      return
    }
    const iterator = new CoworkStreamIterator(ws, options.signal)
    iterator.start(JSON.stringify(buildUserInput(options)))
    yield* iterator
  }

  async artifacts(
    credential: LingxiCredential,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ChatArtifact[]> {
    const result: ChatArtifact[] = []
    try {
      const listing = await this.request(
        credential,
        sandboxFilesUrl(sessionId, SANDBOX_OUTPUT_DIR),
        { method: 'GET', headers: { Accept: '*/*' } },
        signal,
      )
      if (!listing.ok) return result
      for (const file of parseSandboxFiles(await listing.json())) {
        const preview = await this.request(
          credential,
          SANDBOX_PREVIEW_URL,
          { method: 'POST', body: JSON.stringify({ key: file.key, session_id: sessionId }) },
          signal,
        )
        if (!preview.ok) continue
        const url = (await preview.json() as { data?: { url?: unknown } }).data?.url
        if (typeof url !== 'string' || url === '') continue
        const downloaded = await this.deps.fetchLike(url, {
          method: 'GET',
          signal: combinedSignal(signal, this.deps.timeoutMs),
        })
        if (!downloaded.ok) continue
        result.push({ name: file.name, bytes: new Uint8Array(await downloaded.arrayBuffer()) })
      }
    } catch {
      // Artifacts are best-effort.
    }
    return result
  }
}

/**
 * Create a self-contained Lingxi cowork client.
 * Credentials travel only in request headers and are never logged.
 */
export function createLingxiClient(opts: CreateLingxiClientOptions = {}): LingxiClient {
  const deps: ClientDeps = {
    fetchLike: opts.transport?.fetchLike ?? ((url, init) => fetch(url, init)),
    wsFactory: opts.transport?.wsFactory ?? defaultWsFactory,
    resolveCredentialFn: opts.resolveCredentialFn ?? defaultResolveCredential,
    timeoutMs: opts.timeoutMs ?? 30000,
  }
  return new CoworkLingxiClient(deps)
}

export * from './protocol.ts'
export { CoworkStreamIterator } from './stream.ts'
