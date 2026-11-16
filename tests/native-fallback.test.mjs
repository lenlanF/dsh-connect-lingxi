import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeChat } from '../src/cowork/native.mjs'

const cred = { wpsSid: 'SYNTHETIC_ONLY' }
const TOOL = { type:'function', function:{name:'run_code',
  parameters:{type:'object',required:['code','description'],properties:{
    code:{type:'string'},description:{type:'string'},
  }},
}}

test('native session handshake tries WPS base, then kdocs; never retries an issued completion', async()=>{
  const urls=[],encoder=new TextEncoder()
  const requests=async(url)=>{
    urls.push(url)
    if(url==='https://lingxi.wps.cn/api/aioffice/v1/cowork/sessions')return {ok:false,status:404}
    if(url.endsWith('/cowork/sessions'))return {ok:true,status:200,json:async()=>({data:{session_id:'S'}})}
    if(url.endsWith('/credits/runs'))return {ok:true,status:200,json:async()=>({data:{run_id:'R'}})}
    if(url.endsWith('/chat/completions'))return {ok:true,status:200,body:new ReadableStream({start(c){
      c.enqueue(encoder.encode('data: {"code":"Success","choices":[{"text":"pong","finish_reason":"stop"}]}\n\n'))
      c.close()
    }})}
    throw Error('unexpected request')
  }
  const out=[]
  for await(const event of nativeChat(requests,cred,{model:'offline',messages:[
    {role:'user',content:'ping'},
  ],tools:[TOOL]}))out.push(event)
  assert.equal(urls.length,4)
  assert.equal(urls[0].startsWith('https://lingxi.wps.cn/'),true)
  assert.ok(urls.slice(1).every(x=>x.startsWith('https://lingxi.kdocs.cn/')))
  assert.deepEqual(out.map(x=>x.type),['text_delta','done'])
  assert.equal(out[0].text,'pong')
})

test('401 and 403 are returned as diagnostic failures without credential strings', async()=>{
  const visited=[]
  const fetchLike=async(url)=>{visited.push(url);return {ok:false,status:401}}
  const out=[]
  for await(const item of nativeChat(fetchLike,cred,{model:'offline',messages:[],tools:[TOOL]}))out.push(item)
  assert.equal(visited.length,2)
  assert.equal(out[0].type,'error')
  assert.equal(out[0].status,401)
  assert.doesNotMatch(out[0].message,/SYNTHETIC_ONLY/)
})
