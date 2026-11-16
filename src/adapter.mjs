// Native DSH LlmAdapter (duck typed: the host only calls these methods).
// The host's StreamChunk union is: block-start | text-delta | reasoning-delta |
// tool-call-delta | block-end | usage | finish. See LlmRuntime.prepareRoutes.

import { randomUUID } from 'node:crypto'
import { visibleTools, recoverHostToolCalls, stringifyToolValue, hostMissingToolName, unavailableHostTools } from './host-tools.mjs'

const PROVIDER = 'lingxi'
const CATALOG_TTL_MS = 5 * 60 * 1000
const EFFORTS = new Set(['low', 'high', 'max'])

function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
      case 'reasoning':
        if (typeof block.text === 'string' && block.text) parts.push(block.text)
        break
      case 'tool-call':
        parts.push('[previous tool call: ' + String(block.name ?? '') + ' ' + stringifyToolValue(block.arguments) + ']')
        break
      case 'tool-result': {
        const result = block.content ?? block.text ?? block.result ?? block.output
        const failed = block.isError === true || block.error != null ||
          String(block.status ?? '').toLowerCase() === 'failed' ||
          result?.isError === true || result?.ok === false ||
          result?.success === false ||
          ['failed', 'error'].includes(String(result?.status ?? '').toLowerCase()) ||
          (!(result?.ok === true || result?.success === true || result?.exitCode === 0) &&
            hostMissingToolName(result) !== null) ||
          (typeof result?.exitCode === 'number' && result.exitCode !== 0)
        const succeeded = !failed && (result?.ok === true || result?.success === true ||
          (typeof result?.exitCode === 'number' && result.exitCode === 0))
        parts.push('[DSH tool result' +
          (block.id || block.toolCallId ? ' id=' + String(block.id ?? block.toolCallId) : '') +
          (block.name ? ' name=' + String(block.name) : '') +
          (failed ? ' status=FAILED' : succeeded ? ' status=SUCCESS' : ' status=UNVERIFIED') +
          ']: ' + stringifyToolValue(result).slice(0, 20000))
        break
      }
      case 'image':
      case 'file':
        parts.push('[' + block.type + ' attachment omitted: Lingxi upstream is text-only here]')
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

function toChatMessages(options) {
  const messages = []
  if (typeof options.system === 'string' && options.system.trim()) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    if (!message || typeof message !== 'object') continue
    let role = message.role
    if (role === 'developer') role = 'system'
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') role = 'user'
    const content = flattenContent(message.content)
    if (role === 'tool') {
      // DSH createToolResultMessage() reports failure at MESSAGE level:
      // { role: 'tool', toolCallId, isError, content: [{ type: 'text', text }] }.
      // Legacy test fixtures may already supply an inner tool-result envelope.
      const embeddedResult = Array.isArray(message.content) &&
        message.content.some((block) => block?.type === 'tool-result')
      const status = message.isError === true ? 'FAILED'
        : message.isError === false ? 'SUCCESS' : 'UNVERIFIED'
      const label = '[DSH tool result' +
        (message.toolCallId ? ' id=' + String(message.toolCallId) : '') +
        ' status=' + status + ']: '
      messages.push({ role, content: embeddedResult ? content : label + (content || '(empty result)') })
      continue
    }
    if (!content.trim()) continue
    messages.push({ role, content })
  }
  return messages
}

function effortOf(value) {
  return typeof value === 'string' && EFFORTS.has(value) ? value : undefined
}

// ---- DSH tool bridging (option C) ----
// The cowork upstream has no native external-tools channel (verified: injected
// tools / tool_result frames are ignored). We bridge by declaring the host's
// ToolSchema list in-band and asking the model to emit a marker; the adapter
// turns that marker into the host's tool-call-delta so the host performs its
// real permission gate and local execution, then returns tool-result content
// on the next turn (flattenContent already serialises tool-result blocks).
const TOOL_OPEN = '<dsh_tool>'
const TOOL_CLOSE = '</dsh_tool>'
const TOOL_MARKER_RE = /<dsh_tool>([\s\S]*?)<\/dsh_tool>/g

/** Serialise host ToolSchema[] into an in-band protocol preamble. */
function toolsPreamble(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const lines = [
    '[TOOL PROTOCOL - host-provided external tools]',
    'When a task needs a listed host tool, output exactly ONE complete JSON object, without Markdown or prose.',
    'The JSON must contain "type":"tool-call", "name" (the exact listed tool name), and "arguments" (a JSON object with every required field).',
    'Never output partial JSON, sample placeholders, unmatched XML tags, or quoted examples as a tool request.',
    'The DSH host, not you, decides whether to approve and execute any tool call. Results arrive as messages beginning with "[DSH tool result".',
    'Only names in the Available tools list below are valid in THIS turn. Past messages and old tool lists do not authorize a name.',
    'Never assume a universal tool wrapper or alias exists. Do not invent tool names.',
    'If a REAL DSH host tool result says a tool does not exist, do not retry it with alternate JSON or marker syntax.',
    'Before requesting a tool, include EVERY required argument with the correct JSON type; never send {} if the schema has required properties.',
    'If a tool returns an error, status=FAILED, or invalid arguments, report the failure explicitly and correct the call when possible.',
    'Never claim command execution was successful without an actual DSH tool result confirming success.',
    'Never invent tool results, never answer from imagination before the result arrives, and never use your built-in sandbox for a host tool.',
    'Available tools:',
  ]
  for (const tool of visibleTools(tools)) {
    let params = '{}'
    try { params = JSON.stringify(tool.parameters ?? {}) } catch {}
    const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : []
    lines.push('- ' + tool.name + ': ' + String(tool.description ?? '').replace(/\s+/g, ' ').slice(0, 240) +
      ' | REQUIRED ARGUMENTS: ' + JSON.stringify(required) + ' | parameters: ' + params.slice(0, 2400))
  }
  return lines.join('\n')
}

/** Remove tool markers from text so they never leak to the user as prose. */
function stripToolMarkers(text) {
  return text.replace(TOOL_MARKER_RE, '').trim()
}

/** Parse completed tool markers. Unknown/malformed markers are ignored. */
function parseToolCalls(text) {
  const calls = []
  if (typeof text !== 'string') return calls
  for (const match of text.matchAll(TOOL_MARKER_RE)) {
    let obj
    try { obj = JSON.parse(match[1]) } catch { continue }
    if (!obj || typeof obj.name !== 'string' || !obj.name) continue
    let args = obj.arguments ?? {}
    if (typeof args !== 'string') { try { args = JSON.stringify(args) } catch { args = '{}' } }
    calls.push({ name: obj.name, arguments: args })
  }
  return calls
}

/** Render one upstream sandbox tool component as readable Markdown text. */
function renderTool(event) {
  const lines = ['> \u{1F527} **' + event.name + '**']
  if (event.code) lines.push('', '```python', event.code, '```')
  if (event.output) lines.push('', '**Output:**', '', '```', event.output.replace(/\s+$/, ''), '```')
  return lines.join('\n') + '\n'
}

/**
 * @param {{client: import('./types.ts').LingxiClient,
 *          resolveCredential: () => Promise<import('./types.ts').LingxiCredential>,
 *          logger?: {info?: Function, warn?: Function, error?: Function},
 *          onUsage?: Function}} deps
 */
export function createLingxiAdapter(deps) {
  const { client, resolveCredential, logger, onUsage } = deps
  let catalog = []
  let catalogAt = 0
  let catalogPromise
  let lastUsage = null

  function log(kind, message) {
    try { logger?.[kind]?.('dsh-connect-lingxi: ' + message) } catch {}
  }

  async function loadCatalog(signal) {
    if (catalog.length && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog
    if (catalogPromise) return catalogPromise
    catalogPromise = (async () => {
      const credential = await resolveCredential()
      const models = await client.listModels(credential, signal)
      catalog = models
      catalogAt = Date.now()
      log('info', 'model catalog refreshed (' + models.length + ' models)')
      return models
    })().finally(() => { catalogPromise = undefined })
    return catalogPromise
  }

  async function listModels(provider) {
    try {
      const models = await loadCatalog()
      return models.map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: ['text'],
        ...model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {},
        ...model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {},
        ...model.reasoning !== undefined ? { reasoning: model.reasoning } : {},
        ...model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {},
        ...model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {},
        ...model.multiplier !== undefined ? { multiplier: model.multiplier, multiplierValue: model.multiplierValue } : {},
        ...model.badge !== undefined ? { badge: model.badge } : {},
      }))
    } catch (error) {
      log('warn', 'model catalog unavailable: ' + (error?.message ?? String(error)))
      return []
    }
  }

  const REASONING_EFFORTS = [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ]

  async function resolveModel(provider, model, signal) {
    try { await loadCatalog(signal) } catch {}
    const found = catalog.find((entry) => entry.id === model) ?? null
    const info = {
      provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: ['text'],
      toolUpdate: 'addition-only',
      ...found?.contextWindow !== undefined ? { context: { contextWindow: found.contextWindow } } : {},
      ...found?.maxTokens !== undefined ? { defaultMaxTokens: found.maxTokens } : {},
      ...found?.badge !== undefined ? { badge: found.badge } : {},
    }
    if (found?.reasoning === true) {
      info.reasoning = { efforts: REASONING_EFFORTS }
      if (typeof found.defaultEffort === 'string' && REASONING_EFFORTS.some((e) => e.id === found.defaultEffort)) {
        info.reasoning.defaultEffort = found.defaultEffort
      }
    }
    return info
  }

  const MAX_TOOL_ROUNDS = 3

  // DSH LlmError requires a nonempty failure.code in every error finish.
  // Preserve retryable network failures and distinguish rejected tool protocol.
  function upstreamFailureCode(status) {
    if (status === 401 || status === 403) return 'MISSING_CREDENTIAL'
    if (status === 429) return 'RATE_LIMIT'
    if (Number.isInteger(status) && status >= 500) return 'SERVER'
    return 'TRANSPORT'
  }

  async function runUpstreamTurn(options, messages, signal, credential, activeTools) {
    const chatOptions = {
      model: options.model,
      messages,
      ...effortOf(options.reasoningEffort) ? { reasoningEffort: effortOf(options.reasoningEffort) } : {},
      ...signal ? { signal } : {},
    }
    let text = ''
    let sandboxUsed = false
    let upstreamError = null
    for await (const event of client.chat(credential, chatOptions)) {
      if (signal?.aborted) return { kind: 'aborted', text, sandboxUsed }
      switch (event.type) {
        case 'text_delta': text += event.text; break
        case 'tool': sandboxUsed = true; break
        case 'error': upstreamError = { message: event.message ?? 'unknown upstream error', status: event.status }; break
        case 'usage':
          lastUsage = event.usage
          onUsage?.(event.usage)
          break
        default: break
      }
    }
    if (upstreamError) return { kind: 'error', text, sandboxUsed, message: upstreamError.message, code: upstreamFailureCode(upstreamError.status) }
    // A cloud sandbox action is never equivalent to a DSH-authorized tool call.
    // Discard its output even if it appears beside a plausible host tool marker.
    if (sandboxUsed) return { kind: 'violation', text, sandboxUsed }
    const parsed = recoverHostToolCalls(text, activeTools)
    if (parsed.status === 'invalid') return { kind: 'invalid', text: '', message: parsed.message,
      repairable: parsed.repairable === true }
    if (parsed.status === 'calls') return { kind: 'tools', text, calls: parsed.calls }
    return { kind: 'text', text, sandboxUsed }
  }

  async function* stream(options) {
    const missing = unavailableHostTools(options.messages)
    const activeTools = visibleTools(options.tools).filter((tool) => !missing.has(tool.name))
    const hasTools = activeTools.length > 0
    const preamble = toolsPreamble(activeTools)
    const baseMessages = toChatMessages(options)
    const notices = [
      ...missing.size ? [
        '[DSH HOST TOOL NOT REGISTERED] An actual host result reported that these tools do not exist: ' +
          [...missing].join(', ') + '. Do not retry these names with another syntax or alias. ' +
          'Use another explicitly available tool only if it has the necessary capability, otherwise report the limitation.'
      ] : [],
      ...!hasTools ? [
        '[DSH HOST TOOL INVENTORY] No host tools are available in this turn. ' +
          'Do not use names from previous messages, examples, or imagined wrapper functions. Report inability to execute.'
      ] : [],
    ]
    const messages = [
      ...preamble ? [{ role: 'system', content: preamble }] : [],
      ...notices.map((content) => ({ role: 'system', content })),
      ...baseMessages,
    ]

    let nextIndex = 0
    const open = new Map()

    function* startBlock(kind) {
      if (open.has(kind)) return
      const index = nextIndex++
      open.set(kind, { index, text: '' })
      yield { type: 'block-start', index, blockType: kind }
    }
    function* append(kind, text) {
      if (!text) return
      yield* startBlock(kind)
      const state = open.get(kind)
      state.text += text
      yield { type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: state.index, text }
    }
    function* closeAll() {
      for (const [kind, state] of open) yield { type: 'block-end', index: state.index, block: { type: kind, text: state.text } }
      open.clear()
    }
    function* emitToolCalls(calls) {
      for (const call of calls) {
        const index = nextIndex++
        const id = 'call_' + randomUUID()
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
      }
    }
    function* fail(message, code = 'TRANSPORT') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
    }

    try {
      const credential = await resolveCredential()
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const verdict = await runUpstreamTurn(options, messages, options.signal, credential, activeTools)
        if (verdict.kind === 'aborted') {
          yield* closeAll()
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'request aborted by caller' } } }
          return
        }
        if (verdict.kind === 'error') { yield* fail('WPS Lingxi upstream error: ' + verdict.message, verdict.code); return }
        if (verdict.kind === 'invalid') {
          if (verdict.repairable && round + 1 < MAX_TOOL_ROUNDS) {
            // Invalid calls are NEVER submitted to the DSH host. Give the model
            // the exact schema error and one more chance to return valid JSON.
            const badFormat = /^(Malformed DSH tool marker|Malformed tool-call JSON|Incomplete or malformed tool-call JSON|Quoted DSH tool marker)/.test(verdict.message)
            messages.push({ role: 'system', content:
              (badFormat ? '[TOOL FORMAT VALIDATION FAILED] ' : '[TOOL ARGUMENT VALIDATION FAILED] ') +
              verdict.message + '. The previous tool call was NOT executed. ' +
              'Respond with one complete JSON object containing "type":"tool-call", "name", and valid "arguments". ' +
              'Use only a currently offered host tool and include every required argument. ' +
              'No XML markers, code fences, partial JSON, or prose. If no available tool can complete the task, explain the limitation. Never claim it succeeded.' })
            continue
          }
          yield* fail('DSH tool protocol rejected: ' + verdict.message, 'TOOL_PROTOCOL')
          return
        }
        if (verdict.kind === 'tools') {
          const stripped = stripToolMarkers(verdict.text)
          // A full JSON tool-call response is protocol, never display text.
          // Marked replies may retain ordinary explanation outside the marker.
          const clean = stripped === verdict.text.trim() ? '' : stripped
          if (clean) yield* append('text', clean)
          yield* closeAll()
          yield* emitToolCalls(verdict.calls)
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (verdict.kind === 'violation') {
          if (!hasTools) { yield* fail('Lingxi used an untrusted cloud sandbox; no DSH host tool is available', 'TOOL_PROTOCOL'); return }
          messages.push({ role: 'system', content: '[PROTOCOL VIOLATION] An upstream cloud sandbox action is not an authorized DSH tool. Output was discarded. Emit exactly one <dsh_tool>{"name":"...","arguments":{...}}</dsh_tool> marker using ONLY the offered host tools, or state that you cannot use them.' })
          continue
        }
        const clean = stripToolMarkers(verdict.text)
        if (clean) yield* append('text', clean)
        yield* closeAll()
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield* fail('Lingxi refused the host tool protocol after ' + MAX_TOOL_ROUNDS + ' rounds; no tool result was released. Every tool action requires DSH permission.', 'TOOL_PROTOCOL')
    } catch (error) {
      const message = error?.message ?? String(error)
      log('error', 'stream failed: ' + message)
      yield* closeAll()
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'request aborted by caller' } } }
      } else {
        const code = error?.code === 'LINGXI_CREDENTIAL_UNAVAILABLE'
          ? 'MISSING_CREDENTIAL' : upstreamFailureCode(error?.status)
        yield* fail('WPS Lingxi request failed: ' + message, code)
      }
      return
    }
  }

  return {
    providerInfo(provider) {
      return { id: provider, name: provider === PROVIDER ? 'WPS 灵犀' : provider }
    },
    providerRetryPolicy() { return undefined },
    imageRequestPricing() { return undefined },
    imageRequestTarget() { return undefined },
    listModels,
    resolveModel,
    async prepareCall(provider, model, signal) {
      return { model: await resolveModel(provider, model, signal), stream: (opts) => stream(opts) }
    },
    stream,
    invalidateCatalog() { catalogAt = 0; catalog = [] },
    status() { return { provider: PROVIDER, catalogSize: catalog.length, lastUsage } },
  }
}

export { flattenContent, renderTool, toChatMessages, toolsPreamble, parseToolCalls, stripToolMarkers }