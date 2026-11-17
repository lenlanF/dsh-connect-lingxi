// DSH host tool boundary. This module never executes tools or changes permissions.
// Only tools supplied in the current GenerateOptions may become tool-call blocks.
export function visibleTools(tools) {
  if (!Array.isArray(tools)) return []
  const names = new Set()
  const result = []
  for (const item of tools) {
    const fn = item?.type === 'function' && item.function ? item.function : item
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim() || names.has(fn.name)) continue
    names.add(fn.name)
    const schema = fn.parameters ?? fn.inputSchema ?? fn.input_schema
    result.push({ name: fn.name, description: typeof fn.description === 'string' ? fn.description : '',
      parameters: schema && typeof schema === 'object' && !Array.isArray(schema)
        ? schema : { type: 'object', properties: {} },
      ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}) })
  }
  return result
}

export function openAiTools(tools) {
  return visibleTools(tools).map(({ name, description, parameters, strict }) => ({
    type: 'function', function: { name, description, parameters, ...(strict === undefined ? {} : { strict }) },
  }))
}

export function stringifyToolValue(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) return value.map((part) =>
    typeof part?.text === 'string' ? part.text : stringifyToolValue(part?.content ?? part)).join('\n')
  try { return JSON.stringify(value) } catch { return '[unserializable tool value]' }
}

export function normalizedArguments(value) {
  let parsed = value
  if (typeof parsed === 'string') {
    if (!parsed.trim()) parsed = {}
    else {
      try { parsed = JSON.parse(parsed) } catch { return null }
    }
  }
  if (parsed === undefined || parsed === null) parsed = {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null
  try { return JSON.stringify(parsed) } catch { return null }
}

/**
 * Validate the subset of JSON Schema constraints advertised by the DSH host.
 * Never guess or fill in missing arguments: the host is still the authority.
 * Unknown schema extensions remain host-owned, while known invalid calls
 * must not be emitted to DSH as apparently valid tool-call chunks.
 * @returns {string|null} an actionable error or null when locally valid.
 */
export function validateToolArguments(value, schema, path = 'arguments', depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null
  if (depth >= 12) return path + ': tool argument schema exceeds safe nesting depth'

  const descend = (item, childSchema, childPath) =>
    validateToolArguments(item, childSchema, childPath, depth + 1)
  const oneOf = schema.oneOf
  const anyOf = schema.anyOf
  if (Array.isArray(oneOf) && oneOf.length &&
      oneOf.filter((branch) => !descend(value, branch, path)).length !== 1)
    return path + ': arguments must match exactly one allowed schema'
  if (Array.isArray(anyOf) && anyOf.length && !anyOf.some((branch) => !descend(value, branch, path)))
    return path + ': arguments do not match any allowed schema'
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const error = descend(value, branch, path)
      if (error) return error
    }
  }
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const acceptedTypes = typeof schema.type === 'string' ? [schema.type]
    : Array.isArray(schema.type) ? schema.type : []
  const matches = (type) => type === actual ||
    (type === 'integer' && actual === 'number' && Number.isInteger(value)) ||
    (type === 'number' && actual === 'number')
  if (acceptedTypes.length && !acceptedTypes.some(matches) &&
      !(schema.nullable === true && value === null))
    return path + ': expected ' + acceptedTypes.join(' or ') + ', got ' + actual

  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value)))
    return path + ': value is not in the allowed enum'
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value))
    return path + ': value must equal the defined constant'

  if (value !== null && actual === 'object') {
    const required = Array.isArray(schema.required) ? schema.required : []
    const missing = required.filter((key) =>
      typeof key === 'string' && !Object.hasOwn(value, key))
    if (missing.length) return path + ': missing required ' +
      (missing.length === 1 ? 'property ' : 'properties ') + missing.map((key) => '"' + key + '"').join(', ')
    const properties = schema.properties && typeof schema.properties === 'object' &&
      !Array.isArray(schema.properties) ? schema.properties : {}
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const error = descend(child, properties[key], path + '.' + key)
        if (error) return error
      } else if (schema.additionalProperties === false) {
        return path + ': unsupported property "' + key + '"'
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const error = descend(child, schema.additionalProperties, path + '.' + key)
        if (error) return error
      }
    }
  }
  if (actual === 'array') {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems)
      return path + ': requires at least ' + schema.minItems + ' items'
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems)
      return path + ': exceeds maximum ' + schema.maxItems + ' items'
    if (schema.items && typeof schema.items === 'object') {
      for (let i = 0; i < value.length; i++) {
        const error = descend(value[i], schema.items, path + '[' + i + ']')
        if (error) return error
      }
    }
  }
  if (actual === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength)
      return path + ': requires at least ' + schema.minLength + ' characters'
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength)
      return path + ': exceeds maximum ' + schema.maxLength + ' characters'
  }
  return null
}

const OPEN = '<dsh_tool>'
const CLOSE = '</dsh_tool>'
const MARKERS = /<dsh_tool>([\s\S]*?)<\/dsh_tool>/g
const MAX_TOOL_TEXT = 131072
const MAX_CALLS = 8

/** Recognize only explicit protocol tags or a complete tool-call JSON response.
 * A quoted example in ordinary prose must never be turned into an action.
 * The DSH host remains the sole executor / permission authority.
 */
export function recoverHostToolCalls(text, tools) {
  if (typeof text !== 'string') return { status: 'none', calls: [] }
  if (text.length > MAX_TOOL_TEXT) return {
    status: text.includes(OPEN) || text.includes('"type":"tool-call"') ? 'invalid' : 'none',
    calls: [], message: 'Tool response exceeded the safe size limit',
  }
  const allowed = new Map(visibleTools(tools).map((tool) => [tool.name, tool]))
  let raw = []
  let source = text.trim()
  const jsonFence = /^\x60{3}(?:json)?\s*\n([\s\S]*?)\n\x60{3}$/i.exec(source)
  if (jsonFence) source = jsonFence[1].trim()

  // A complete JSON envelope wins over marker-looking strings embedded in
  // its arguments, e.g. a command whose literal code contains <dsh_tool>.
  if (source.startsWith('{') || source.startsWith('[')) {
    let parsed
    try { parsed = JSON.parse(source) }
    catch {
      if (/"type"\s*:\s*"tool-call"/.test(source)) {
        return { status: 'invalid', calls: [], repairable: true,
          message: 'Incomplete or malformed tool-call JSON' }
      }
    }
    if (parsed !== undefined) {
      const list = Array.isArray(parsed) ? parsed : [parsed]
      if (!list.length || !list.every((item) =>
        item && typeof item === 'object' && item.type === 'tool-call')) {
        return { status: 'none', calls: [] }
      }
      if (list.length > MAX_CALLS) {
        return { status: 'invalid', calls: [],
          message: 'Too many tool calls' }
      }
      raw = list
    }
  }

  if (!raw.length) {
    // A Markdown code example must never turn into a host call. If a reply
    // contains both a quoted and live marker, reject it atomically.
    let quotedMarker = false
    const outsideCode = text
      .replace(/\x60{3}[\s\S]*?\x60{3}|~~~[\s\S]*?~~~/g, (block) => {
        if (block.includes(OPEN) || block.includes(CLOSE)) quotedMarker = true
        return ' '
      })
      .replace(/\x60[^\x60\n]*\x60/g, (block) => {
        if (block.includes(OPEN) || block.includes(CLOSE)) quotedMarker = true
        return ' '
      })
    const hasMarker = outsideCode.includes(OPEN) || outsideCode.includes(CLOSE)
    if (quotedMarker) {
      if (!hasMarker) return { status: 'none', calls: [] }
      return { status: 'invalid', calls: [], repairable: true,
        message: 'Quoted DSH tool marker mixed with a real tool request' }
    }
    if (!hasMarker) return { status: 'none', calls: [] }
    const marked = [...outsideCode.matchAll(MARKERS)]
    const remainder = outsideCode.replace(MARKERS, '')
    if (!marked.length || marked.length > MAX_CALLS ||
        remainder.includes(OPEN) || remainder.includes(CLOSE)) {
      return { status: 'invalid', calls: [], repairable: true,
        message: 'Malformed DSH tool marker' }
    }
    for (const match of marked) {
      try { raw.push(JSON.parse(match[1])) }
      catch {
        return { status: 'invalid', calls: [], repairable: true,
          message: 'Malformed tool-call JSON inside DSH marker' }
      }
    }
  }
  if (!raw.length) return { status: 'none', calls: [] }
  if (!allowed.size) return { status: 'invalid', calls: [], message: 'No host tools are available in this turn' }
  const calls = []
  for (const item of raw) {
    const name = item?.name
    if (typeof name !== 'string' || !allowed.has(name)) {
      return { status: 'invalid', calls: [], repairable: true,
        message: 'Tool is not available in this DSH session: ' + String(name ?? '') }
    }
    const args = normalizedArguments(item.arguments)
    if (args === null) return { status: 'invalid', calls: [], message: 'Invalid JSON tool arguments for ' + name }
    const problem = validateToolArguments(JSON.parse(args), allowed.get(name).parameters)
    if (problem) return { status: 'invalid', calls: [], repairable: true,
      message: 'Tool ' + name + ' has invalid arguments: ' + problem }
    calls.push({ name, arguments: args })
  }
  return { status: 'calls', calls }
}

export function removeToolMarkers(text) {
  return String(text ?? '').replace(MARKERS, '').trim()
}

/** Recognize explicit "tool does not exist" diagnostics from actual host results. */
export function hostMissingToolName(value) {
  // Only diagnostic fields count. In particular, a successful command whose
  // stdout quotes an error message must NOT revoke any DSH host tool.
  const candidates = typeof value === 'string' ? [value] : [
    typeof value?.error === 'string' ? value.error : value?.error?.message,
    value?.message,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length > 20000) continue
    const text = candidate.trim()
    for (const re of [
      /^(?:(?:工具调用失败|工具执行失败|Error|Tool call failed)\s*[:：]\s*)?工具\s*["'\`]?([A-Za-z_][\w.-]{0,127})["'\`]?\s*(?:不存在|未注册|不可用)/i,
      /^(?:Error\s*[:：]\s*)?tool\s+["'\`]?([A-Za-z_][\w.-]{0,127})["'\`]?\s+(?:does\s+not\s+exist|doesn't\s+exist|not\s+found|not\s+registered|not\s+available|unavailable)\b/i,
      /^(?:Error\s*[:：]\s*)?(?:unknown|unrecognized)\s+tool\s+["'\`]?([A-Za-z_][\w.-]{0,127})/i,
    ]) {
      const match = re.exec(text)
      if (match) return match[1]
    }
  }
  return null
}

/** Only role:tool host results, not model claims or user text, revoke a stale tool. */
export function unavailableHostTools(messages) {
  const unavailable = new Set()
  if (!Array.isArray(messages)) return unavailable
  for (const msg of messages.slice(-32)) {
    if (msg?.role !== 'tool') continue
    // The actual DSH tool message has isError on the message, not inside
    // each content block. A successful echo containing an error string must
    // never revoke a tool. Unmarked legacy fixtures require a tool-result block.
    if (msg.isError === false) continue
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content]
    for (const block of blocks) {
      let value
      if (msg.isError === true) {
        value = typeof block === 'string' ? block
          : block?.type === 'text' ? block.text
          : block?.type === 'tool-result'
            ? block.content ?? block.result ?? block.output ?? block.text ?? block.error
            : block
      } else if (block?.type === 'tool-result') {
        value = block.content ?? block.result ?? block.output ?? block.text ?? block.error
      } else {
        continue
      }
      const name = hostMissingToolName(value)
      if (name) unavailable.add(name)
    }
  }
  return unavailable
}