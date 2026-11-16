
export interface LingxiBalance {
  /** Authoritative spendable balance (data.total_balance), -1 when unknown. */
  total: number
  /** Grant totals by source, as published by upstream. */
  bonus: number
  purchased: number
  contract: number
  /** Per-grant breakdown: value/consumed/balance/expiry. */
  grants: Array<{ value: number; consumed: number; balance: number; expiresAt?: string }>
}

// ---- v0.2 frozen contracts ----

/** One account in the local credential pool. Never log or return wpsSid to the browser. */
export interface LingxiAccount {
  id: string
  label: string
  source: 'local' | 'manual'
  /** Opaque credential handle; the host keeps the sid server-side. */
  wpsSid: string
  enabled: boolean
  /** Cached balance, -1 when unknown. */
  credits: number
  state: 'ok' | 'rate_limit' | 'quota' | 'session_dead' | 'unavailable' | 'transport' | 'unknown'
  lastCheckedAt?: number
  lastCheckinDate?: string
  lastCheckinOutcome?: 'claimed' | 'already' | 'failed'
}

export interface LingxiModelV2 {
  id: string
  name: string
  /** Upstream raw string, e.g. "～0.12x". */
  multiplier?: string
  /** Parsed numeric multiplier, if the string is parseable. */
  multiplierValue?: number
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  defaultEffort?: 'low' | 'high' | 'max'
  enabled: boolean
}

export interface LingxiSettingsV2 {
  autoCheckin: boolean
  /** IANA timezone used for the daily check-in boundary. */
  timezone: string
  /** Order of account ids used when selecting a request credential. */
  poolOrder: string[]
  /** Model ids excluded from the DSH picker. */
  disabledModelIds: string[]
  /** Poll interval for balance/task reads, in minutes. */
  pollIntervalMinutes: number
}

export interface LingxiStatusV2 {
  accounts: Array<Omit<LingxiAccount, 'wpsSid'> & { sidLength: number }>
  models: LingxiModelV2[]
  settings: LingxiSettingsV2
  checkin: { today: string; autoEnabled: boolean; lastRunAt?: number; lastError?: string }
  diagnostics: { userDataDir: string; upstream: string; localSidCount: number; manualSidCount: number; lastError?: string }
}

/** Upstream capability module (child A). All methods take an explicit sid. */
export interface LingxiUpstream {
  /** data.models with multiplier, context and reasoning metadata. */
  fetchModels(sid: string, signal?: AbortSignal): Promise<LingxiModelV2[]>
  /** Credits balance, -1 when unavailable. */
  fetchCredits(sid: string, signal?: AbortSignal): Promise<number>
  /** Task center state for daily_check_in (no side effects). */
  fetchDailyTask(sid: string, signal?: AbortSignal): Promise<LingxiDailyTask>
  /** Claim today's daily check-in exactly once for the upstream date. */
  claimDaily(sid: string, date: string | undefined, signal?: AbortSignal): Promise<LingxiCheckinResult>
}

export interface LingxiDailyTask {
  key: string
  status: 'claimable' | 'claimed' | 'unavailable' | 'unknown'
  /** Upstream-provided claimable date, never computed locally. */
  date?: string
  reward?: number
  consecutiveDays?: number
}

export interface LingxiCheckinResult {
  outcome: 'claimed' | 'already' | 'failed'
  reward?: number
  message?: string
  status?: number
}

/** Account pool + check-in scheduler (child B). Host keeps sids; browser sees redacted status. */
export interface LingxiAccountPool {
  /** Scan local Partitions/* Cookies and merge with stored manual accounts. */
  refresh(): Promise<void>
  /** Redacted status for the settings page. Never contains sids. */
  status(): Promise<LingxiStatusV2>
  /** Pick one credential for a request, honoring order/enabled/state. */
  resolveCredential(): Promise<{ wpsSid: string; source: 'local-cookie' | 'manual' | 'auth-snapshot'; domains?: string[] }>
  /** Add a manually pasted sid; returns the new redacted account. */
  addManual(label: string, sid: string): Promise<Omit<LingxiAccount, 'wpsSid'>>
  remove(id: string): Promise<boolean>
  rename(id: string, label: string): Promise<boolean>
  reorder(ids: string[]): Promise<string[]>
  setEnabled(id: string, enabled: boolean): Promise<boolean>
  /** Auto check-in sweep: Beijing date boundary, idempotent, per-account. */
  runAutoCheckin(): Promise<LingxiCheckinResult[]>
  /** Manual check-in for one account, idempotent. */
  checkin(id: string): Promise<LingxiCheckinResult>
  checkinMany(ids: string[]): Promise<LingxiCheckinResult[]>
  exportAccounts(ids?: string[]): Promise<{ format: string; version: number; exportedAt: number; accounts: { label: string; sid: string; source: string }[] }>
  importAccounts(payload: unknown): Promise<{ imported: number; skipped: number; total: number }>
  previewImport(payload: unknown): Promise<{ count: number; accounts: { label: string; sidLength: number; source: string }[] }>
  refreshModels(): Promise<LingxiStatusV2>
  loginUrl(): string
  updateSettings(patch: Partial<LingxiSettingsV2>): Promise<LingxiSettingsV2>
  dispose(): void
}

/** Host HTTP routes (owned by Lead-Core):
 *  GET  /plugins/dsh-connect-lingxi/status        -> LingxiStatusV2
 *  POST /plugins/dsh-connect-lingxi/account       {label, sid} -> redacted account
 *  POST /plugins/dsh-connect-lingxi/account/remove {id}
 *  POST /plugins/dsh-connect-lingxi/account/toggle {id, enabled}
 *  POST /plugins/dsh-connect-lingxi/checkin       {id?} -> results
 *  POST /plugins/dsh-connect-lingxi/checkin/many  {ids} -> results
 *  POST /plugins/dsh-connect-lingxi/settings      patch -> LingxiSettingsV2
 *  POST /plugins/dsh-connect-lingxi/account/rename {id, label}
 *  POST /plugins/dsh-connect-lingxi/account/reorder {ids}
 *  POST /plugins/dsh-connect-lingxi/models/refresh -> LingxiStatusV2
 *  POST /plugins/dsh-connect-lingxi/transfer/export {ids?} -> transfer file
 *  POST /plugins/dsh-connect-lingxi/transfer/preview {file} -> preview
 *  POST /plugins/dsh-connect-lingxi/transfer/import {file} -> {imported, skipped}
 *  POST /plugins/dsh-connect-lingxi/login/open     -> {ok, url}
 */

export const LINGXI_PROVIDER = 'lingxi'

export interface LingxiCredential {
  wpsSid: string
  source: 'local-cookie' | 'manual' | 'auth-snapshot'
  /** Cookie domains that accepted this sid, for diagnostics only. */
  domains?: string[]
}

export interface LingxiModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  defaultEffort?: 'low' | 'high' | 'max'
}

export interface LingxiUsage {
  creditConsumed?: number
  sessionCreditConsumed?: number
}

/** One normalized event emitted by the Lingxi cowork stream. */
export type LingxiStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool'; name: string; code?: string; output?: string; text: string }
  | { type: 'usage'; usage: LingxiUsage }
  | { type: 'done' }
  | { type: 'error'; message: string; status?: number; code?: string }

export interface LingxiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface LingxiChatOptions {
  model: string
  messages: LingxiChatMessage[]
  reasoningEffort?: 'low' | 'high' | 'max'
  signal?: AbortSignal
  /** Text appended to the final user message to request sandbox artifacts. */
  artifactHint?: string
}

export interface LingxiClient {
  /** Read the locally signed-in WPS Lingxi credential. Never log its value. */
  resolveCredential(): Promise<LingxiCredential>
  /** Fetch the live model catalog from the upstream plans endpoint. */
  listModels(credential: LingxiCredential, signal?: AbortSignal): Promise<LingxiModel[]>
  /** Read credit balance, best-effort; -1 when unavailable. */
  credits(credential: LingxiCredential, signal?: AbortSignal): Promise<number>
  /** Stream one chat turn as normalized events. */
  chat(credential: LingxiCredential, options: LingxiChatOptions): AsyncIterable<LingxiStreamEvent>
  /** Fetch sandbox artifacts produced in one session. */
  artifacts?(credential: LingxiCredential, sessionId: string, signal?: AbortSignal): Promise<Array<{ name: string; bytes: Uint8Array }>>
}
