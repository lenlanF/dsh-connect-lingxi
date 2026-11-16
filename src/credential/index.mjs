import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join, relative, resolve } from 'node:path'

export class LingxiCredentialError extends Error {
  constructor (message, blockedSources, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LingxiCredentialError'
    this.code = 'LINGXI_CREDENTIAL_UNAVAILABLE'
    this.blockedSources = blockedSources || []
  }
}

const COOKIE_NAME = 'wps_sid'
const STORE_PREFIX = 'lingxi-desktop:electron-store:v1'
const USER_DIR_NAME = 'WPS 灵犀'
const SNAPSHOT_FILE = 'auth-snapshot.json'
const LOCAL_STATE_FILE = 'Local State'
const GCM_PREFIXES = ['v10', 'v11']

function psQuote (value) {
  return "'" + value.replace(/'/g, "''") + "'"
}

function sha256Hex (value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function usableSid (value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 512 && !/[\s\u0000-\u001f]/.test(value)
}

/** Chromium may prepend a 32-byte SHA-256 host hash to the cookie value. */
function stripHostHash (plain) {
  if (plain.length <= 32) return plain
  const head = plain.subarray(0, 32)
  const tail = plain.subarray(32)
  const headLooksBinary = head.some(function (byte) {
    return byte < 0x20 || byte >= 0x7f
  })
  if (!headLooksBinary) return plain
  return tail.every(function (byte) {
    return byte >= 0x20 && byte < 0x7f
  }) ? tail : plain
}

/** Pure AES-256-GCM decryptor for Chromium v10/v11 encrypted cookies; returns plaintext bytes. */
export function decryptChromeCookie (encryptedValue, aesKey) {
  if (!Buffer.isBuffer(encryptedValue) && !ArrayBuffer.isView(encryptedValue)) {
    throw new TypeError('decryptChromeCookie: encryptedValue must be a Buffer or Uint8Array')
  }
  if (!Buffer.isBuffer(aesKey) && !ArrayBuffer.isView(aesKey)) {
    throw new TypeError('decryptChromeCookie: aesKey must be a Buffer or Uint8Array')
  }
  const data = Buffer.isBuffer(encryptedValue)
    ? encryptedValue
    : Buffer.from(encryptedValue.buffer, encryptedValue.byteOffset, encryptedValue.byteLength)
  const key = Buffer.isBuffer(aesKey)
    ? aesKey
    : Buffer.from(aesKey.buffer, aesKey.byteOffset, aesKey.byteLength)
  if (key.length !== 32) {
    throw new LingxiCredentialError('decryptChromeCookie: AES-256-GCM requires a 32-byte key', [
      { source: 'decryptChromeCookie:aesKey', reason: 'keyLength=' + key.length }
    ])
  }
  if (data.length < 31) {
    throw new LingxiCredentialError('decryptChromeCookie: payload too short for a v10/v11 GCM cookie', [
      { source: 'decryptChromeCookie:encryptedValue', reason: 'byteLength=' + data.length }
    ])
  }
  const prefix = data.subarray(0, 3).toString('latin1')
  if (!GCM_PREFIXES.includes(prefix)) {
    throw new LingxiCredentialError('decryptChromeCookie: unsupported cookie prefix ' + prefix, [
      { source: 'decryptChromeCookie:prefix', reason: 'expected v10/v11' }
    ])
  }
  const nonce = data.subarray(3, 15)
  const tag = data.subarray(data.length - 16)
  const ciphertext = data.subarray(15, data.length - 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (err) {
    throw new LingxiCredentialError('decryptChromeCookie: AES-256-GCM authentication failed', [
      { source: 'decryptChromeCookie:gcm', reason: 'auth-tag-mismatch' }
    ], err)
  }
}

function runPowerShell (script) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 })
}

function userDataDir () {
  const override = process.env.LINGXI_USER_DATA
  if (override) return resolve(override)
  const base = process.env.APPDATA
  return base ? join(base, USER_DIR_NAME) : null
}

function listCookieDbs (root) {
  const found = []
  for (const rel of ['Network/Cookies', 'Default/Network/Cookies']) {
    const candidate = join(root, ...rel.split('/'))
    if (existsSync(candidate)) found.push(candidate)
  }
  const partitions = join(root, 'Partitions')
  try {
    for (const entry of readdirSync(partitions, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(partitions, entry.name, 'Network', 'Cookies')
      if (existsSync(candidate)) found.push(candidate)
    }
  } catch {}
  return found
}

/** Copy a live Cookies DB without terminating WPS Lingxi. */
function copyShared (src, dst) {
  rmSync(dst, { force: true })
  let firstFailure = 'copy-blocked'
  try {
    copyFileSync(src, dst)
    if (existsSync(dst) && statSync(dst).size > 0) return { ok: true, method: 'plain-copy' }
    firstFailure = 'empty-copy'
  } catch (err) {
    firstFailure = 'copy-' + (err && err.code ? err.code : 'failed')
  }
  rmSync(dst, { force: true })
  const vss = spawnSync('esentutl.exe', ['/y', src, '/d', dst, '/vss'], {
    stdio: 'ignore', windowsHide: true, timeout: 60000
  })
  if (vss.status === 0 && existsSync(dst) && statSync(dst).size > 0) {
    return { ok: true, method: 'vss-copy' }
  }
  rmSync(dst, { force: true })
  const script = [
    "$ErrorActionPreference='Stop'",
    'try {',
    '$share = [System.IO.FileShare]::ReadWrite',
    '$f = [System.IO.File]::Open(' + psQuote(src) + ',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,$share)',
    '$o = [System.IO.File]::Open(' + psQuote(dst) + ',[System.IO.FileMode]::Create,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)',
    '$f.CopyTo($o); $o.Close(); $f.Close(); Write-Output "OK"',
    '} catch { Write-Output "ERR" }'
  ].join('\n')
  const shared = runPowerShell(script)
  if (shared.status === 0 && String(shared.stdout || '').includes('OK') && existsSync(dst) && statSync(dst).size > 0) {
    return { ok: true, method: 'shared-copy' }
  }
  rmSync(dst, { force: true })
  return {
    ok: false,
    reason: firstFailure + '/vss-exit-' + String(vss.status) + '/shared-exit-' + String(shared.status)
  }
}

function readAesKey (root) {
  const localState = join(root, LOCAL_STATE_FILE)
  if (!existsSync(localState)) return { ok: false, reason: 'Local State missing' }
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$j = Get-Content -Raw ' + psQuote(localState) + ' | ConvertFrom-Json',
    '$e = [Convert]::FromBase64String($j.os_crypt.encrypted_key)',
    "if ($e.Length -lt 38) { throw 'short-blob' }",
    "if ([System.Text.Encoding]::ASCII.GetString($e[0..4]) -ne 'DPAPI') { throw 'unsupported-prefix' }",
    '$blob = $e[5..($e.Length-1)]',
    '$k = [System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    "if ($k.Length -ne 32) { throw 'invalid-key-length' }",
    "Write-Output ([BitConverter]::ToString($k).Replace('-','').ToLowerInvariant())"
  ].join('\n')
  const result = runPowerShell(script)
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      reason: 'dpapi-' + (result.error ? (result.error.code || 'spawn-error') : 'exit-' + result.status)
    }
  }
  const lines = String(result.stdout || '').split(/\r?\n/).map(function (line) {
    return line.trim()
  }).filter(Boolean)
  const hex = lines.pop()
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) return { ok: false, reason: 'dpapi-key-invalid' }
  return { ok: true, key: Buffer.from(hex, 'hex') }
}

async function readSidFromCookies (root, blocked) {
  const dbs = listCookieDbs(root)
  if (!dbs.length) {
    blocked.push({ source: 'local-cookie:Cookies', reason: 'no Cookies DB found' })
    return null
  }
  const sqlite = await import('node:sqlite')
  const DatabaseSync = sqlite.DatabaseSync
  const work = mkdtempSync(join(tmpdir(), 'lingxi-cred-'))
  const candidates = []
  let aesKey = null
  let keyUnavailable = false
  try {
    for (let i = 0; i < dbs.length && !keyUnavailable; i++) {
      const src = dbs[i]
      const label = relative(root, src).replace(/\\/g, '/')
      const dst = join(work, 'cookies-' + i + '.db')
      const copied = copyShared(src, dst)
      if (!copied.ok) {
        blocked.push({ source: 'local-cookie:' + label, reason: copied.reason })
        continue
      }
      let db = null
      try {
        db = new DatabaseSync(dst, { readOnly: true })
      } catch (err) {
        blocked.push({ source: 'local-cookie:' + label, reason: 'sqlite-open-' + (err && err.code ? err.code : 'failed') })
        continue
      }
      let rows = []
      try {
        rows = db.prepare('SELECT host_key, value, encrypted_value FROM cookies WHERE name = ?').all(COOKIE_NAME)
      } catch (err) {
        blocked.push({ source: 'local-cookie:' + label, reason: 'sqlite-query-' + (err && err.code ? err.code : 'failed') })
      } finally {
        try { db.close() } catch {}
      }
      if (!rows.length) blocked.push({ source: 'local-cookie:rows:' + label, reason: 'no wps_sid rows' })
      for (const row of rows) {
        const domain = typeof row.host_key === 'string' ? row.host_key : ''
        const plainValue = typeof row.value === 'string' ? row.value : ''
        if (usableSid(plainValue)) {
          candidates.push({ sid: plainValue, domain: domain })
          continue
        }
        const encrypted = row.encrypted_value
        if (!encrypted || !encrypted.byteLength) continue
        if (!aesKey) {
          const keyResult = readAesKey(root)
          if (!keyResult.ok) {
            blocked.push({ source: 'local-cookie:os_crypt', reason: keyResult.reason })
            keyUnavailable = true
            break
          }
          aesKey = keyResult.key
        }
        try {
          const plain = decryptChromeCookie(Buffer.from(encrypted), aesKey)
          const sid = stripHostHash(plain).toString('utf8')
          if (usableSid(sid)) candidates.push({ sid: sid, domain: domain })
          else blocked.push({ source: 'local-cookie:value:' + label, reason: 'decrypted value is not a usable sid (len=' + plain.length + ')' })
        } catch {
          blocked.push({ source: 'local-cookie:gcm:' + label, reason: 'aes-gcm-auth-failed' })
        }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  if (!candidates.length) {
    if (!blocked.length) blocked.push({ source: 'local-cookie:Cookies', reason: 'no wps_sid row yielded a usable value' })
    return null
  }
  const groups = new Map()
  for (const candidate of candidates) {
    let domains = groups.get(candidate.sid)
    if (!domains) {
      domains = []
      groups.set(candidate.sid, domains)
    }
    if (!domains.includes(candidate.domain)) domains.push(candidate.domain)
  }
  let best = null
  for (const entry of groups) {
    const domains = entry[1].sort()
    const score = (domains.includes('.wps.cn') ? 100 : 0) + domains.length
    if (!best || score > best.score) best = { sid: entry[0], domains: domains, score: score }
  }
  return { sid: best.sid, domains: best.domains }
}

function decryptConf (data, encryptionKey) {
  if (data.length < 18) return null
  const iv = data.subarray(0, 16)
  const password = pbkdf2Sync(encryptionKey, iv.toString(), 10000, 32, 'sha512')
  const decipher = createDecipheriv('aes-256-cbc', password, iv)
  const plain = Buffer.concat([decipher.update(data.subarray(17)), decipher.final()]).toString('utf8')
  return JSON.parse(plain)
}

/** conf's encryptionKey is uy(): sha256(prefix + NUL + node-machine-id sha256). */
function storeKeyCandidates () {
  const keys = []
  let machine = null
  try {
    const result = spawnSync('reg.exe', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15000 })
    if (result.status === 0 && typeof result.stdout === 'string') {
      const parts = result.stdout.split('REG_SZ')
      if (parts.length > 1) {
        const id = parts[1].replace(/[\r\n\s]+/g, '').toLowerCase()
        if (id) machine = sha256Hex(id)
      }
    }
  } catch {}
  if (machine) keys.push(sha256Hex(STORE_PREFIX + '\0' + machine))
  try {
    keys.push(sha256Hex(STORE_PREFIX + '\0' + hostname() + ':' + userInfo().username))
  } catch {}
  keys.push(sha256Hex(STORE_PREFIX + '\0fallback'))
  return keys
}

function readAuthSnapshotObject (root, blocked) {
  const snapshotPath = join(root, SNAPSHOT_FILE)
  if (!existsSync(snapshotPath)) {
    blocked.push({ source: 'auth-snapshot:' + SNAPSHOT_FILE, reason: 'file missing' })
    return null
  }
  let data = null
  try {
    data = readFileSync(snapshotPath)
  } catch (err) {
    blocked.push({ source: 'auth-snapshot:' + SNAPSHOT_FILE, reason: 'read-' + (err && err.code ? err.code : 'failed') })
    return null
  }
  for (const key of storeKeyCandidates()) {
    try {
      const parsed = decryptConf(data, key)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {}
  }
  blocked.push({ source: 'auth-snapshot:' + SNAPSHOT_FILE, reason: 'no key candidate decrypted the store' })
  return null
}

function extractSid (value, depth) {
  if (!value || typeof value !== 'object' || depth > 6) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractSid(item, depth + 1)
      if (found) return found
    }
    return null
  }
  for (const pair of Object.entries(value)) {
    if (/^(wps_sid|wpssid|sid)$/i.test(pair[0]) && usableSid(pair[1])) return pair[1]
    const found = extractSid(pair[1], depth + 1)
    if (found) return found
  }
  return null
}

/** Read the conf-encrypted auth snapshot; returns only non-secret metadata. */
export async function decryptAuthSnapshot () {
  if (process.platform !== 'win32') return null
  const root = userDataDir()
  if (!root || !existsSync(root)) return null
  const snapshot = readAuthSnapshotObject(root, [])
  if (!snapshot) return null
  const body = snapshot.snapshot && typeof snapshot.snapshot === 'object' ? snapshot.snapshot : snapshot
  const environments = body.environments
  let active = null
  if (environments && typeof environments === 'object') {
    for (const env of Object.values(environments)) {
      if (!env || typeof env !== 'object') continue
      if (!active || (Number(env.lastUsedAt) || 0) > (Number(active.lastUsedAt) || 0)) active = env
    }
  }
  const result = {}
  if (active && typeof active.activeUserId === 'string' && active.activeUserId) {
    result.userId = active.activeUserId
  }
  if (active && active.activeCredentialBinding !== undefined) {
    result.credentialBinding = active.activeCredentialBinding
  }
  return result
}

/** Resolve the locally signed-in wps_sid without any manual paste. */
export async function resolveLocalCredential () {
  const blocked = []
  if (process.platform !== 'win32') {
    throw new LingxiCredentialError(
      'WPS Lingxi credential unavailable; blocked sources: local-cookie (non-Windows), auth-snapshot (non-Windows)',
      [
        { source: 'local-cookie:platform', reason: 'non-Windows' },
        { source: 'auth-snapshot:platform', reason: 'non-Windows' }
      ]
    )
  }
  const root = userDataDir()
  const label = root || 'APPDATA/WPS 灵犀'
  if (!root || !existsSync(root)) {
    throw new LingxiCredentialError(
      'WPS Lingxi credential unavailable; blocked sources: local-cookie (' + label + ' missing), auth-snapshot (' + label + ' missing)',
      [
        { source: 'local-cookie:' + label, reason: 'user data directory missing' },
        { source: 'auth-snapshot:' + label, reason: 'user data directory missing' }
      ]
    )
  }
  try {
    const found = await readSidFromCookies(root, blocked)
    if (found) return { wpsSid: found.sid, source: 'local-cookie', domains: found.domains }
  } catch (err) {
    blocked.push({
      source: 'local-cookie:sqlite',
      reason: 'node:sqlite unavailable (' + (err && err.code ? err.code : 'load-failed') + ')'
    })
  }
  const snapshot = readAuthSnapshotObject(root, blocked)
  if (snapshot) {
    const sid = extractSid(snapshot, 0)
    if (usableSid(sid)) return { wpsSid: sid, source: 'auth-snapshot' }
    blocked.push({ source: 'auth-snapshot:sid', reason: 'snapshot holds no usable sid' })
  }
  if (!blocked.length) {
    blocked.push({ source: 'local-cookie:Cookies', reason: 'no candidate returned' })
    blocked.push({ source: 'auth-snapshot:' + SNAPSHOT_FILE, reason: 'no candidate returned' })
  }
  const detail = blocked.map(function (item) {
    return item.source + ' (' + item.reason + ')'
  }).join('; ')
  throw new LingxiCredentialError(
    'WPS Lingxi credential unavailable; blocked sources: ' + (detail || 'none'),
    blocked
  )
}
