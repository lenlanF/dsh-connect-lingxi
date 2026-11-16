import type {
  LingxiChatMessage,
  LingxiChatOptions,
  LingxiModel,
  LingxiStreamEvent,
  LingxiUsage,
} from '../types.ts'

/** Base URL of the web cowork API (the aioffice host, not the aigc host). */
export const COWORK_BASE = 'https://lingxi.kdocs.cn'
export const COWORK_SESSIONS_URL = COWORK_BASE + '/api/aioffice/v1/cowork/sessions'
export const PLANS_URL = COWORK_BASE + '/api/aioffice/v1/sessions/plans'
export const CREDITS_URL = COWORK_BASE + '/api/public/v1/credits/balance?credit_type=total'

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

/** HTTP headers for cowork REST calls. */
export function coworkHeaders(wpsSid: string): Record<string, string> {
  return {
    Cookie: 'wps_sid=' + wpsSid,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Origin: COWORK_BASE,
    Referer: COWORK_BASE + '/',
  }
}

/** WebSocket handshake headers; Origin is enforced by the server. */
export function coworkWsHeaders(wpsSid: string): Record<string, string> {
  return { Cookie: 'wps_sid=' + wpsSid, Origin: COWORK_BASE, 'User-Agent': USER_AGENT }
}

export function coworkWsUrl(sessionId: string): string {
  return (
    'wss://lingxi.kdocs.cn/api/aioffice/v1/cowork/sessions/' +
    encodeURIComponent(sessionId) +
    '/sandbox/completions/ws'
  )
}

export function sandboxFilesUrl(sessionId: string, dir: string): string {
  return (
    COWORK_BASE +
    '/api/aioffice/v1/sandbox/sessions/' +
    encodeURIComponent(sessionId) +
    '/files?path=' +
    encodeURIComponent(dir)
  )
}

export const SANDBOX_PREVIEW_URL = COWORK_BASE + '/api/aioffice/v1/sandbox/file/preview'
export const SANDBOX_OUTPUT_DIR = '/home/lingxi/workspace/output'
export const DEFAULT_MODEL = 'qwen3.8_flash'
export const CREDITS_UNKNOWN = -1

/** Data payload carried by one cowork WebSocket text frame. */
export interface CoworkFrameData {
  type?: string
  id?: string
  delta?: string
  full_content?: unknown
  payload?: { brief?: string; [key: string]: unknown }
  credit_consumed?: number
  session_credit_consumed?: number
  [key: string]: unknown
}

export interface CoworkFrame {
  event: string
  data?: CoworkFrameData
}

/** Parse one JSON text frame. Unparseable frames are ignored. */
export function parseFrame(raw: string): CoworkFrame | undefined {
  try {
    const json: unknown = JSON.parse(raw)
    if (json === null || typeof json !== 'object') return undefined
    const frame = json as CoworkFrame
    return typeof frame.event === 'string' ? frame : undefined
  } catch {
    return undefined
  }
}

/** The subset of WebSocket used here; a fake can implement just this. */
export interface WebSocketLike {
  /** 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED. */
  readonly readyState: number
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void
  send(data: string): void
  close(): void
}

/** Injection seam for offline tests; never needs a live connection. */
export interface CoworkTransport {
  fetchLike?: (url: string, init: RequestInit) => Promise<Response>
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocketLike
}

export const TOOL_TYPES: ReadonlySet<string> = new Set([
  'c_execute_code',
  'c_read_file',
  'c_write_file',
  'c_edit_file',
  'c_list_files',
  'c_install_package',
  'c_websearch',
  'c_urlfetch',
])

export function isToolComponent(type: string): boolean {
  return TOOL_TYPES.has(type)
}

/** Human-readable tool name; unknown types keep their stripped name. */
export function toolLabel(type: string): string {
  return type.replace(/^c_/, '').replace(/_/g, ' ')
}

/** Flatten the conversation into the single agent_input.text the upstream expects. */
export function buildPrompt(messages: LingxiChatMessage[], artifactHint?: string): string {
  const parts: string[] = []
  for (const message of messages) {
    if (typeof message?.content !== 'string' || message.content === '') continue
    parts.push(message.role + ': ' + message.content)
  }
  let prompt = parts.join('\n\n')
  if (artifactHint !== undefined && artifactHint !== '') prompt += '\n\n' + artifactHint
  return prompt
}

/** user.input control plane; model and effort live here, not in the URL. */
export function buildUserInput(options: LingxiChatOptions): CoworkFrame {
  const text = buildPrompt(options.messages, options.artifactHint)
  return {
    event: 'user.input',
    data: {
      agent_input: {
        text,
        files: [],
        refs: [],
        expect_model: options.model !== '' ? options.model : DEFAULT_MODEL,
        reasoning_effort: options.reasoningEffort ?? 'low',
        current_mode: 'agent',
        permission_mode: 'default',
        browser_plugin_enabled: false,
        file_ids: [],
        upload_ids: [],
      },
      headers: { client_type: 'pc_web', open_position: 'copilotchat_web' },
    },
  }
}

interface ComponentState {
  type: string
  payload?: Record<string, unknown>
}

/** Fields extracted from a tool component's full_content. */
export interface ToolFields {
  code?: string
  output?: string
  brief?: string
}

/** Tolerant extraction from the several shapes the tool components use. */
export function extractTool(full: unknown, startPayload?: Record<string, unknown>): ToolFields {
  const out: ToolFields = {}
  let obj: Record<string, unknown> | undefined
  if (typeof full === 'string') {
    try {
      const parsed: unknown = JSON.parse(full)
      if (parsed !== null && typeof parsed === 'object') obj = parsed as Record<string, unknown>
      else out.code = full
    } catch {
      out.code = full
    }
  } else if (full !== null && typeof full === 'object') {
    obj = full as Record<string, unknown>
  }

  if (obj !== undefined) {
    const args =
      obj.arguments !== null && typeof obj.arguments === 'object'
        ? (obj.arguments as Record<string, unknown>)
        : obj
    for (const key of ['code', 'content', 'command', 'path', 'query', 'url'] as const) {
      const value = args[key]
      if (typeof value === 'string' && value !== '') {
        out.code = value
        break
      }
    }
    if (typeof obj.output === 'string') out.output = obj.output
    if (typeof args.brief === 'string' && args.brief !== '') out.brief = args.brief
    if (typeof obj.brief === 'string' && obj.brief !== '') out.brief = obj.brief
  }
  if (out.brief === undefined && typeof startPayload?.brief === 'string' && startPayload.brief !== '') {
    out.brief = startPayload.brief
  }
  return out
}

const FENCE = String.fromCharCode(96).repeat(3)

/** Markdown rendering of one completed tool component. */
export function renderTool(
  type: string,
  fields: ToolFields,
): { name: string; code?: string; output?: string; text: string } {
  const label = toolLabel(type)
  const lines: string[] = ['> **' + label + (fields.brief !== undefined ? ': ' + fields.brief : '') + '**']
  if (fields.code !== undefined && fields.code !== '') {
    const language = type === 'c_execute_code' ? 'python' : ''
    lines.push('', FENCE + language, fields.code.trimEnd(), FENCE)
  }
  if (fields.output !== undefined && fields.output !== '') {
    lines.push('', '**Output:**', '', FENCE, fields.output.trimEnd(), FENCE)
  }
  const event: { name: string; code?: string; output?: string; text: string } = {
    name: type,
    text: lines.join('\n') + '\n',
  }
  if (fields.code !== undefined && fields.code !== '') event.code = fields.code
  if (fields.output !== undefined && fields.output !== '') event.output = fields.output
  return event
}

/** One frame produces zero or more events, plus terminal flags for the driver. */
export interface FrameStep {
  events: LingxiStreamEvent[]
  done: boolean
}

type DeltaKind = 'reasoning_delta' | 'text_delta'

/** Pure per-turn frame state machine. */
export class CoworkFrameState {
  private readonly components = new Map<string, ComponentState>()
  private pendingKind: DeltaKind | undefined
  private pendingText = ''
  private finished = false

  /** Flush buffered deltas, then finish with done (close without run.end). */
  finish(): LingxiStreamEvent[] {
    if (this.finished) return []
    this.finished = true
    const events: LingxiStreamEvent[] = []
    this.flush(events)
    events.push({ type: 'done' })
    return events
  }

  /** Emit error then done exactly once. */
  fail(message: string, status?: number, code?: string): LingxiStreamEvent[] {
    if (this.finished) return []
    this.finished = true
    const events: LingxiStreamEvent[] = []
    this.flush(events)
    const error: LingxiStreamEvent = { type: 'error', message }
    if (status !== undefined) error.status = status
    if (code !== undefined) error.code = code
    events.push(error, { type: 'done' })
    return events
  }

  /** Emit buffered deltas without ending the turn; used when the frame queue drains. */
  flushPending(): LingxiStreamEvent[] {
    const out: LingxiStreamEvent[] = []
    this.flush(out)
    return out
  }

  private flush(out: LingxiStreamEvent[]): void {
    if (this.pendingKind !== undefined && this.pendingText !== '') {
      out.push({ type: this.pendingKind, text: this.pendingText } as LingxiStreamEvent)
    }
    this.pendingKind = undefined
    this.pendingText = ''
  }

  private coalesce(kind: DeltaKind, delta: string, out: LingxiStreamEvent[]): void {
    if (this.pendingKind !== undefined && this.pendingKind !== kind) this.flush(out)
    this.pendingKind = kind
    this.pendingText += delta
  }

  /** Process a single parsed frame; safe to call after completion (returns none). */
  step(frame: CoworkFrame): FrameStep {
    const result: FrameStep = { events: [], done: false }
    if (this.finished) return result
    const data = frame.data ?? {}
    const id = typeof data.id === 'string' ? data.id : ''
    const declaredType = typeof data.type === 'string' ? data.type : ''

    switch (frame.event) {
      case 'component.start': {
        if (id !== '') {
          const state: ComponentState = { type: declaredType }
          if (data.payload !== undefined && data.payload !== null && typeof data.payload === 'object') {
            state.payload = data.payload as Record<string, unknown>
          }
          this.components.set(id, state)
        }
        break
      }
      case 'component.content': {
        const type = declaredType !== '' ? declaredType : (this.components.get(id)?.type ?? '')
        const delta = typeof data.delta === 'string' ? data.delta : ''
        if (delta === '') break
        if (type === 'c_reasoning') this.coalesce('reasoning_delta', delta, result.events)
        else if (type === 'c_text') this.coalesce('text_delta', delta, result.events)
        // Tool code deltas are half-written; component.end renders the full call.
        break
      }
      case 'component.end': {
        const remembered = this.components.get(id)
        const type = declaredType !== '' ? declaredType : (remembered?.type ?? '')
        if (isToolComponent(type)) {
          this.flush(result.events)
          const tool = renderTool(type, extractTool(data.full_content, remembered?.payload))
          const event: LingxiStreamEvent = { type: 'tool', name: tool.name, text: tool.text }
          if (tool.code !== undefined) event.code = tool.code
          if (tool.output !== undefined) event.output = tool.output
          result.events.push(event)
        }
        this.components.delete(id)
        break
      }
      case 'run.end': {
        const usage: LingxiUsage = {}
        if (typeof data.credit_consumed === 'number') usage.creditConsumed = data.credit_consumed
        if (typeof data.session_credit_consumed === 'number') {
          usage.sessionCreditConsumed = data.session_credit_consumed
        }
        this.finished = true
        this.flush(result.events)
        result.events.push({ type: 'usage', usage }, { type: 'done' })
        result.done = true
        break
      }
      case 'error':
      case 'run.error': {
        const status = typeof data.status === 'number' ? data.status : undefined
        const code =
          typeof data.code === 'string'
            ? data.code
            : typeof data.result === 'string'
              ? data.result
              : undefined
        result.events.push(...this.fail(frameErrorMessage(data), status, code))
        result.done = true
        break
      }
      default:
        // user.input echo, run.start, turn.start/end, c_recommend, keepalives.
        break
    }
    return result
  }
}

function frameErrorMessage(data: CoworkFrameData): string {
  for (const key of ['msg', 'message', 'error', 'result'] as const) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return 'lingxi cowork stream error'
}

/** Parse plans endpoint data.models into the frozen LingxiModel shape. */
export function parseModels(payload: unknown): LingxiModel[] {
  const root = payload as { data?: { models?: unknown[] } } | null
  const raw = Array.isArray(root?.data?.models) ? root.data.models : []
  const models: LingxiModel[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const m = entry as Record<string, unknown>
    const id = typeof m.key === 'string' && m.key !== '' ? m.key : typeof m.id === 'string' ? m.id : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const model: LingxiModel = { id, name: typeof m.name === 'string' && m.name !== '' ? m.name : id }
    if (typeof m.max_context_tokens === 'number') model.contextWindow = m.max_context_tokens
    if (typeof m.context_window === 'number') model.contextWindow = m.context_window
    if (typeof m.max_new_tokens === 'number') model.maxTokens = m.max_new_tokens
    if (typeof m.max_tokens === 'number') model.maxTokens = m.max_tokens
    const efforts = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts : []
    model.reasoning = efforts.length > 0 || m.reasoning === true
    for (const effort of ['low', 'high', 'max'] as const) {
      if (efforts.includes(effort)) {
        model.defaultEffort = effort
        break
      }
    }
    models.push(model)
  }
  return models
}

/** Sum bonus_credits and purchased_credits balances; -1 when unavailable. */
export function parseCredits(payload: unknown): number {
  const data = (payload as { data?: Record<string, unknown> } | null)?.data
  if (data === null || typeof data !== 'object') return CREDITS_UNKNOWN
  let seen = false
  let total = 0
  for (const key of ['bonus_credits', 'purchased_credits'] as const) {
    const entries = data[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const balance = (entry as Record<string, unknown> | null)?.balance
      if (typeof balance === 'number' && Number.isFinite(balance)) {
        total += balance
        seen = true
      }
    }
  }
  if (typeof data.total_balance === 'number' && Number.isFinite(data.total_balance) && !seen) {
    total = data.total_balance
    seen = true
  }
  return seen ? Math.round(total) : CREDITS_UNKNOWN
}

/** Extract data.session_id from the create-session response. */
export function parseSessionId(
  payload: unknown,
  status: number,
): { ok: true; id: string } | { ok: false; status: number; message: string } {
  const id = (payload as { data?: { session_id?: unknown } } | null)?.data?.session_id
  if (typeof id === 'string' && id !== '') return { ok: true, id }
  return { ok: false, status, message: 'cowork create session: missing session_id' }
}

export interface SandboxFileItem {
  name: string
  key: string
}

/** Directory entries may inline their children in .files; flatten one level. */
export function parseSandboxFiles(payload: unknown): SandboxFileItem[] {
  const items = (payload as { data?: { items?: unknown[] } } | null)?.data?.items
  if (!Array.isArray(items)) return []
  const out: SandboxFileItem[] = []
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (typeof item.name !== 'string') continue
    const key = typeof item.key === 'string' ? item.key : ''
    if (Array.isArray(item.files)) {
      for (const child of item.files) {
        if (child !== null && typeof child === 'object' && typeof (child as Record<string, unknown>).name === 'string') {
          const c = child as Record<string, unknown>
          out.push({ name: c.name as string, key: typeof c.key === 'string' ? c.key : key })
        }
      }
    } else if (key !== '') {
      out.push({ name: item.name, key })
    }
  }
  return out
}
