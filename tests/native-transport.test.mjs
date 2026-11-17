import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeBody, nativeChat } from '../src/cowork/native.mjs'
import { createLingxiClient } from '../src/cowork/index.mjs'
import { createLingxiAdapter, nativeMessages } from '../src/adapter.mjs'

const CREDENTIAL = { wpsSid: 'SYNTHETIC_OFFLINE_ONLY', source: 'synthetic' }
const TOOL = { name: 'run_code', description: 'PTC transport',
  parameters: { type: 'object', required: ['code', 'description'],
    properties: { code: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1 } } } }
const toolArgs = '{"code":"console.log(1)","description":"test"}'
const request = (name='run_code') => [
  { role: 'system', content: 'Use DSH tools only' },
  { role: 'user', content: 'Execute local echo' },
]
function response(data) {
  return { ok: true, status: 200, json: async () => data }
}
function sse(...frames) {
  const encoder = new TextEncoder()
  return { ok: true, status: 200,
    body: new ReadableStream({
      start(controller) {
        const txt = frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('')
        // Split across JSON bytes and SSE line boundaries to verify buffering.
        controller.enqueue(encoder.encode(txt.slice(0, 51)))
        controller.enqueue(encoder.encode(txt.slice(51, 124)))
        controller.enqueue(encoder.encode(txt.slice(124)))
        controller.close()
      },
    }),
  }
}
function fakeFetch(frames) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/cowork/sessions')) return response({data:{session_id:'synthetic-session'}})
    if (url.endsWith('/credits/runs')) return response({data:{run_id:'synthetic-run'}})
    if (url.endsWith('/chat/completions')) return sse(...frames)
    throw Error('Unexpected remote URL')
  }
  return { fn, calls }
}

test('native request body sends actual structured tools instead of text JSON marker protocol', () => {
  const body = nativeBody({ model: 'offline', messages: request(), tools: [
    { type: 'function', function: TOOL },
  ] })
  assert.equal(body.stream, true)
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.tools[0].function.name, 'run_code')
  assert.equal(body.messages[0].role, 'system')
  assert.doesNotMatch(JSON.stringify(body.messages), /<dsh_tool>/)
})

test('native chat performs 3-step handshake and recovers fragmented tool-call args', async () => {
  const {fn, calls} = fakeFetch([
    { code: 'Success', choices: [{ text:'', tool_calls:[
      {index:0,id:'upstream-id',function:{name:'run_code',arguments:'{"code":"console.'}},
    ] }]},
    { code: 'Success', choices: [{ tool_calls:[
      {index:0,function:{arguments:'log(1)","description":"test"}'}},
    ],finish_reason:'tool_calls'}]},
  ])
  const events = []
  for await(const event of nativeChat(fn,CREDENTIAL,{
    model:'offline',messages:request(),tools:[{type:'function',function:TOOL}],
  })) events.push(event)
  assert.deepEqual(events.map(e=>e.type),['tool_call','done'])
  assert.equal(events[0].name,'run_code')
  assert.deepEqual(JSON.parse(events[0].arguments),JSON.parse(toolArgs))
  assert.deepEqual(calls.map(c=>new URL(c.url).pathname),[
    '/api/aioffice/v1/cowork/sessions',
    '/api/public/v1/credits/runs',
    '/api/public/v1/agent-runtime/chat/completions',
  ])
  assert.equal(JSON.parse(calls[2].init.body).tools[0].function.name,'run_code')
  assert.equal(JSON.parse(calls[2].init.body).tool_choice,'auto')
  assert.match(calls[2].init.headers.Cookie,/^wps_sid=SYNTHETIC_OFFLINE_ONLY;/)
  assert.equal(calls[2].init.headers['X-Cc-Run-ID'],'synthetic-run')
  assert.ok(!calls[2].init.body.includes(CREDENTIAL.wpsSid))
})

test('host assistant tool call and tool-role result keep pairing in native messages', () => {
  const original = [
    {role:'assistant',content:[{type:'text',text:'Running'},{
      type:'tool-call',id:'call_7',name:'run_code',arguments:toolArgs,
    }]},
    {role:'tool',toolCallId:'call_7',isError:true,content:[
      {type:'text',text:'工具run_code不存在'},
    ]},
  ]
  const messages=nativeMessages({messages:original})
  assert.equal(messages[0].tool_calls[0].function.arguments,toolArgs)
  assert.equal(messages[1].tool_call_id,'call_7')
  assert.match(messages[1].content,/status=FAILED/)
  assert.match(messages[1].content,/工具run_code不存在/)
})

test('native mode emits only DSH-provided tool call and does not retry cloud', async () => {
  const {fn,calls}=fakeFetch([{code:'Success',choices:[{
    tool_calls:[{index:0,id:'upstream-id',function:{name:'run_code',arguments:toolArgs}}],
    finish_reason:'tool_calls',
  }]}])
  const client=createLingxiClient({transport:{fetchLike:fn,wsFactory:()=>{throw Error('cowork cloud channel should not run')}}})
  const adapter=createLingxiAdapter({client,resolveCredential:async()=>CREDENTIAL})
  const chunks=[]
  for await(const chunk of adapter.stream({model:'offline',tools:[TOOL],messages:[
    {role:'user',content:'Test authorized host tool'},
  ]})) chunks.push(chunk)
  assert.equal(calls.length,3)
  const callsEmitted=chunks.filter(x=>x.type==='tool-call-delta')
  assert.equal(callsEmitted.length,1)
  assert.equal(callsEmitted[0].name,'run_code')
  assert.deepEqual(JSON.parse(callsEmitted[0].argumentsDelta),JSON.parse(toolArgs))
  assert.equal(chunks.at(-1).reason.kind,'tool-calls')
})

test('native mode rejects unknown upstream tool instead of executing it', async () => {
  const {fn}=fakeFetch([{code:'Success',choices:[{
    tool_calls:[{index:0,id:'bad',function:{name:'outside_tool',arguments:'{}'}}],
    finish_reason:'tool_calls',
  }]}])
  const client=createLingxiClient({transport:{fetchLike:fn}})
  const adapter=createLingxiAdapter({client,resolveCredential:async()=>CREDENTIAL})
  const chunks=[]
  for await(const chunk of adapter.stream({model:'offline',tools:[TOOL],messages:[
    {role:'user',content:'Test'},
  ]})) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.kind,'error')
  assert.equal(chunks.at(-1).reason.failure.code,'TOOL_PROTOCOL')
  assert.equal(chunks.some(x=>x.type==='tool-call-delta'),false)
})

test('unknown native planning tool is rejected, repaired, and replaced by an actual offered host tool', async () => {
  let completions = 0
  const { fn, calls } = fakeFetch([])
  const adaptedFetch = async (url, init) => {
    if (!url.endsWith('/chat/completions')) return fn(url, init)
    calls.push({ url, init })
    completions++
    return sse({ code: 'Success', choices: [{
      tool_calls: [{ index: 0, id: 'model_' + completions, function: {
        name: completions === 1 ? 'todo_write' : 'run_code',
        arguments: completions === 1 ? '{"todos":[]}' : toolArgs,
      } }],
      finish_reason: 'tool_calls',
    }] })
  }
  const client = createLingxiClient({ transport: { fetchLike: adaptedFetch } })
  const adapter = createLingxiAdapter({ client, resolveCredential: async () => CREDENTIAL })
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'offline', tools: [TOOL],
    messages: [{ role: 'user', content: 'Build a Python CSV application' }],
  })) chunks.push(chunk)
  assert.equal(completions, 2)
  const emitted = chunks.filter(x => x.type === 'tool-call-delta')
  assert.deepEqual(emitted.map(x => x.name), ['run_code'])
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  const first = JSON.parse(calls[2].init.body)
  const second = JSON.parse(calls[5].init.body)
  assert.deepEqual(first.tools.map(x => x.function.name), ['run_code'])
  assert.match(JSON.stringify(first.messages), /Only these function names/)
  assert.match(JSON.stringify(second.messages), /todo_write/)
  assert.match(JSON.stringify(second.messages), /NONE of the tool calls/)
})

test('repeated unknown native tool requests never reach host and terminate after bounded retries', async () => {
  let completions = 0
  const { fn } = fakeFetch([])
  const adaptedFetch = async (url, init) => {
    if (!url.endsWith('/chat/completions')) return fn(url, init)
    completions++
    return sse({ code: 'Success', choices: [{
      tool_calls: [{ index: 0, function: { name: 'todo_write', arguments: '{}' } }],
      finish_reason: 'tool_calls',
    }] })
  }
  const client = createLingxiClient({ transport: { fetchLike: adaptedFetch } })
  const adapter = createLingxiAdapter({ client, resolveCredential: async () => CREDENTIAL })
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'offline', tools: [TOOL], messages: [{ role: 'user', content: 'Test' }],
  })) chunks.push(chunk)
  assert.equal(completions, 3)
  assert.equal(chunks.some(x => x.type === 'tool-call-delta'), false)
  assert.equal(chunks.at(-1).reason.failure.code, 'TOOL_PROTOCOL')
  assert.match(chunks.at(-1).reason.failure.message, /todo_write/)
})

test('a mixed native batch with an unoffered tool is rejected atomically before retry', async () => {
  let completions = 0
  const { fn } = fakeFetch([])
  const adaptedFetch = async (url, init) => {
    if (!url.endsWith('/chat/completions')) return fn(url, init)
    completions++
    return sse({ code: 'Success', choices: [{
      tool_calls: completions === 1
        ? [
          { index: 0, function: { name: 'run_code', arguments: toolArgs } },
          { index: 1, function: { name: 'todo_write', arguments: '{}' } },
        ]
        : [{ index: 0, function: { name: 'run_code', arguments: toolArgs } }],
      finish_reason: 'tool_calls',
    }] })
  }
  const client = createLingxiClient({ transport: { fetchLike: adaptedFetch } })
  const adapter = createLingxiAdapter({ client, resolveCredential: async () => CREDENTIAL })
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'offline', tools: [TOOL], messages: [{ role: 'user', content: 'Test' }],
  })) chunks.push(chunk)
  assert.equal(completions, 2)
  assert.deepEqual(chunks.filter(x => x.type === 'tool-call-delta').map(x => x.name), ['run_code'])
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('native HTTP errors provide status and never leak the cookie',async()=>{
  const fetchLike=async(url)=>{
    if(url.endsWith('/cowork/sessions'))return {ok:false,status:403}
    throw Error('Should not proceed')
  }
  const events=[]
  for await(const e of nativeChat(fetchLike,CREDENTIAL,{model:'offline',messages:request(),tools:[TOOL]}))events.push(e)
  assert.deepEqual(events.map(x=>x.type),['error','done'])
  assert.equal(events[0].status,403)
  assert.doesNotMatch(events[0].message,/SYNTHETIC_OFFLINE_ONLY/)
})
