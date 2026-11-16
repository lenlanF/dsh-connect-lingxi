// Native tool-capable Lingxi agent-runtime transport. Only returns tool requests;
// host-side DSH retains exclusive control of execution and approval.
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { COWORK_BASE, USER_AGENT } from './protocol.mjs'

const SESSIONS = '/api/aioffice/v1/cowork/sessions'
const RUNS = '/api/public/v1/credits/runs'
const COMPLETIONS = '/api/public/v1/agent-runtime/chat/completions'
const DEVICE_ID = createHash('sha256').update('dsh-connect-lingxi-device').digest('hex')

function httpError(stage, response) {
  const error = new Error('Lingxi native ' + stage + ' returned HTTP ' + response.status)
  error.status = response.status
  return error
}

async function jsonPost(fetchLike, url, headers, data, signal, stage) {
  const res = await fetchLike(url, {
    method: 'POST', headers, body: JSON.stringify(data), ...(signal ? { signal } : {}),
  })
  if (!res.ok) throw httpError(stage, res)
  try { return await res.json() }
  catch { throw new Error('Lingxi native ' + stage + ' returned invalid JSON') }
}

function headersFor(credential, base) {
  const cookie = 'wps_sid=' + credential.wpsSid +
    '; x-kso-app-name=win-lingxi-desktop; x-kso-app-version=1.3.31' +
    '; x-kso-device-id=' + DEVICE_ID
  return {
    Cookie: cookie,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    Referer: base + '/',
  }
}

function toolMessages(messages) {
  const items = []
  for (const message of messages ?? []) {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) continue
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) continue
      items.push({
        role: 'tool', tool_call_id: message.tool_call_id,
        content: String(message.content ?? ''),
      })
    } else {
      const item = {
        role: message.role === 'developer' ? 'system' : message.role,
        content: typeof message.content === 'string' ? message.content : '',
      }
      if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
        item.tool_calls = message.tool_calls
      }
      items.push(item)
    }
  }
  return items
}

/** Build native API body without in-band imitation of DSH tool calls. */
export function nativeBody(options) {
  const body = {
    stream: true,
    model: options.model,
    messages: toolMessages(options.messages),
  }
  if (options.tools?.length) {
    body.tools = options.tools
    body.tool_choice = 'auto'
  }
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort
    body.llm_arguments = { reasoning_effort: options.reasoningEffort }
  }
  return body
}

function appendCall(calls, tool) {
  const index = Number.isInteger(tool.index) && tool.index >= 0 ? tool.index : calls.size
  const prior = calls.get(index) ?? { id: '', name: '', arguments: '' }
  const fn = tool.function
  if (typeof tool.id === 'string' && tool.id && !prior.id) prior.id = tool.id
  if (fn && typeof fn.name === 'string' && fn.name && !prior.name) prior.name = fn.name
  if (fn && typeof fn.arguments === 'string') prior.arguments += fn.arguments
  calls.set(index, prior)
}

function* consumeFrame(frame, state) {
  if (frame?.code && !['Success', 'success', 'OK', 'ok'].includes(frame.code)) {
    throw new Error('Lingxi native completion reported unsuccessful frame')
  }
  if (frame?.usage) {
    const usage = frame.usage
    yield { type: 'usage', usage: {
      inputTokens: Number(usage.prompt_tokens ?? 0),
      outputTokens: Number(usage.completion_tokens ?? 0),
    } }
  }
  for (const choice of Array.isArray(frame?.choices) ? frame.choices : []) {
    if (typeof choice?.text === 'string' && choice.text) yield { type: 'text_delta', text: choice.text }
    if (Array.isArray(choice?.tool_calls)) {
      for (const call of choice.tool_calls) appendCall(state.calls, call)
    }
    if (choice?.finish_reason) state.finished = true
  }
}

export async function* nativeChat(fetchLike, credential, options) {
  try {
    const signal = options.signal
    let base, headers, session
    // Native agent-runtime is served by the WPS host; kdocs is a known
    // alternate Lingxi domain. Only the session handshake is retried: never
    // re-send a credit-consuming completion just because parsing failed.
    let lastSessionError
    for (const candidate of options.base ? [options.base] : ['https://lingxi.wps.cn', COWORK_BASE]) {
      try {
        const candidateHeaders = headersFor(credential, candidate)
        const created = await jsonPost(fetchLike, candidate + SESSIONS, candidateHeaders, {
          session_type: 'cowork_client',
          agent_version: 2,
          env: { device_id: DEVICE_ID, device_name: 'dsh', work_space_dir: tmpdir() },
        }, signal, 'session')
        base = candidate
        headers = candidateHeaders
        session = created
        break
      } catch (error) {
        lastSessionError = error
        if (error?.status === 429 || signal?.aborted) throw error
      }
    }
    if (!session) throw lastSessionError ?? new Error('Lingxi native session unavailable')
    const sessionId = session?.data?.session_id
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Lingxi native session id unavailable')
    const run = await jsonPost(fetchLike, base + RUNS, headers, {
      client_request_id: String(Date.now()),
      session_id: sessionId,
      model_provider: 'lingxi',
      model_id: options.model,
      agent_input: {
        text: options.messages?.filter(m => m.role === 'user').at(-1)?.content ?? '',
        files: [], file_ids: [], refs: [], expect_model: options.model,
        permission_mode: 'default', current_mode: 'agent', browser_plugin_enabled: false,
      },
    }, signal, 'run')
    const runId = run?.data?.run_id
    if (typeof runId !== 'string' || !runId) throw new Error('Lingxi native run id unavailable')
    const res = await fetchLike(base + COMPLETIONS, {
      method: 'POST',
      headers: {
        ...headers,
        'X-Client-Type': 'lingxi_claw', 'X-Client-Lang': 'zh-CN',
        'X-Cc-Agent-Type': 'lingxi_claw',
        'X-Request-Id': randomUUID(),
        'X-Cc-Session-ID': sessionId, 'X-Cc-Run-ID': runId,
      },
      body: JSON.stringify(nativeBody(options)),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) throw httpError('completion', res)
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('Lingxi native completion has no SSE body')
    }
    const reader = res.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    const state = { calls: new Map(), finished: false }
    const processLine = function* (line) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') return
      let frame
      try { frame = JSON.parse(payload) }
      catch { throw new Error('Lingxi native completion contains invalid SSE JSON') }
      yield* consumeFrame(frame, state)
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(done ? undefined : value, { stream: !done })
        let pos
        while ((pos = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, pos)
          buffer = buffer.slice(pos + 1)
          yield* processLine(line)
        }
        if (done) break
      }
      if (buffer.trim()) yield* processLine(buffer)
    } finally {
      reader.releaseLock()
    }
    if (!state.finished) throw new Error('Lingxi native completion ended before finish_reason')
    for (const [index, call] of [...state.calls].sort((a,b) => a[0]-b[0])) {
      if (!call.name || !call.arguments) throw new Error('Lingxi native completion returned incomplete tool call')
      yield { type: 'tool_call', index, id: call.id || 'call_' + randomUUID(),
        name: call.name, arguments: call.arguments }
    }
    yield { type: 'done' }
  } catch (error) {
    yield { type: 'error', status: error?.status,
      message: error instanceof Error ? error.message : 'Lingxi native transport failed' }
    yield { type: 'done' }
  }
}