import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  decryptChromeCookie,
  decryptAuthSnapshot,
  resolveLocalCredential,
  LingxiCredentialError
} from '../src/credential/index.mjs'

const KEY = randomBytes(32)
const MARKER = 'unit-test-only-plaintext-marker-7b31'
const modulePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'credential', 'index.mjs')
const moduleUrl = pathToFileURL(modulePath).href
const moduleSource = readFileSync(modulePath, 'utf8')

function seal (text, key, prefix) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()])
  return Buffer.concat([Buffer.from(prefix, 'ascii'), nonce, body, cipher.getAuthTag()])
}

test('decryptChromeCookie decrypts synthetic v10/v11 AES-256-GCM cookies', () => {
  for (const prefix of ['v10', 'v11']) {
    const payload = seal(MARKER, KEY, prefix)
    assert.equal(decryptChromeCookie(payload, KEY).toString('utf8'), MARKER)
    assert.equal(decryptChromeCookie(payload, KEY).toString('utf8'), MARKER)
  }
})

test('decryptChromeCookie returns raw bytes for host-hash-prefixed cookies', () => {
  const hashed = Buffer.concat([randomBytes(32), Buffer.from(MARKER, 'utf8')])
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, nonce)
  const body = Buffer.concat([cipher.update(hashed), cipher.final()])
  const payload = Buffer.concat([Buffer.from('v11', 'ascii'), nonce, body, cipher.getAuthTag()])
  const plain = decryptChromeCookie(payload, KEY)
  assert.equal(plain.length, hashed.length)
  assert.equal(plain.subarray(32).toString('utf8'), MARKER)
})

test('decryptChromeCookie rejects bad input without leaking plaintext', () => {
  const wrongKey = randomBytes(32)
  const tampered = seal(MARKER, KEY, 'v10')
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => decryptChromeCookie(seal(MARKER, KEY, 'v20'), KEY), LingxiCredentialError)
  assert.throws(() => decryptChromeCookie(Buffer.from('v10short'), KEY), LingxiCredentialError)
  assert.throws(() => decryptChromeCookie(seal(MARKER, KEY, 'v10'), Buffer.alloc(16)), LingxiCredentialError)
  assert.throws(() => decryptChromeCookie(seal(MARKER, KEY, 'v10'), wrongKey), LingxiCredentialError)
  assert.throws(() => decryptChromeCookie(tampered, KEY), LingxiCredentialError)
  assert.throws(() => decryptChromeCookie('not-a-buffer', KEY), TypeError)
  for (const run of [
    () => decryptChromeCookie(seal(MARKER, KEY, 'v10'), wrongKey),
    () => decryptChromeCookie(seal(MARKER, KEY, 'v20'), KEY),
    () => decryptChromeCookie(tampered, KEY)
  ]) {
    try {
      run()
      assert.fail('expected a typed error')
    } catch (err) {
      assert.ok(err instanceof LingxiCredentialError)
      assert.ok(!String(err).includes(MARKER))
      assert.ok(!String(err.message).includes(MARKER))
      assert.ok(!JSON.stringify(err.blockedSources).includes(MARKER))
    }
  }
})

test('module source and runtime output contain no plaintext or credential values', () => {
  assert.ok(!/console\.(log|info|warn|error|debug|trace)\s*\(/.test(moduleSource))
  assert.ok(!/process\.(stdout|stderr)\.write\s*\(/.test(moduleSource))
  const script = [
    'import { decryptChromeCookie } from ' + JSON.stringify(moduleUrl) + ';',
    'const key = Buffer.from(' + JSON.stringify(KEY.toString('hex')) + ", 'hex');",
    'const data = Buffer.from(' + JSON.stringify(seal(MARKER, KEY, 'v10').toString('hex')) + ", 'hex');",
    'const value = decryptChromeCookie(data, key).toString(\'utf8\');',
    "process.stdout.write('ok=' + (value.length === " + MARKER.length + ") + ' len=' + value.length);"
  ].join('\n')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  })
  assert.equal(result.status, 0)
  assert.equal(String(result.stdout).trim(), 'ok=true len=' + MARKER.length)
  assert.ok(!String(result.stdout).includes(MARKER))
  assert.ok(!String(result.stderr).includes(MARKER))
})

test('resolveLocalCredential throws a typed error naming every blocked source', () => {
  const empty = mkdtempSync(join(tmpdir(), 'lingxi-empty-'))
  try {
    const script = [
      'import { resolveLocalCredential, LingxiCredentialError } from ' + JSON.stringify(moduleUrl) + ';',
      'try { await resolveLocalCredential(); process.stdout.write("unexpected-success"); }',
      'catch (err) { process.stdout.write("typed=" + (err instanceof LingxiCredentialError)',
      ' + " code=" + err.code + " sources=" + err.blockedSources.map(function (b) { return b.source; }).join(",")); }'
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { LINGXI_USER_DATA: empty })
    })
    assert.equal(result.status, 0)
    const out = String(result.stdout)
    assert.ok(out.includes('typed=true'))
    assert.ok(out.includes('LINGXI_CREDENTIAL_UNAVAILABLE'))
    assert.ok(out.includes('local-cookie:Cookies'))
    assert.ok(out.includes('auth-snapshot:auth-snapshot.json'))
    assert.ok(!String(result.stderr).includes(MARKER))
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('real-machine resolveLocalCredential returns the local wps_sid', async () => {
  if (process.platform !== 'win32' || process.env.LINGXI_SKIP_LIVE_TEST === '1') return
  const cred = await resolveLocalCredential()
  assert.equal(typeof cred.wpsSid, 'string')
  assert.ok(cred.wpsSid.length >= 8, 'local wps_sid is too short')
  assert.equal(cred.source, 'local-cookie')
  assert.ok(Array.isArray(cred.domains) && cred.domains.length > 0)
  console.log('live: success=' + (cred.wpsSid.length > 0) + ' sidLength=' + cred.wpsSid.length + ' domainCount=' + cred.domains.length)
})

test('credential entry points have the required shapes', () => {
  assert.equal(typeof decryptChromeCookie, 'function')
  assert.equal(typeof resolveLocalCredential, 'function')
  assert.equal(typeof decryptAuthSnapshot, 'function')
  assert.ok(Buffer.isBuffer(decryptChromeCookie(seal(MARKER, KEY, 'v10'), KEY)))
  assert.equal(resolveLocalCredential.constructor.name, 'AsyncFunction')
  assert.equal(decryptAuthSnapshot.constructor.name, 'AsyncFunction')
})
