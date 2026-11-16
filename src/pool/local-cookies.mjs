// Local WPS Lingxi multi-sid discovery. Read-only: never writes into WPS user data.
// AES-GCM cookie decryption is delegated to the credential module's exported
// decryptChromeCookie(); no crypto primitives are duplicated here.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { decryptChromeCookie } from '../credential/index.mjs'

const USER_DIR_NAME = 'WPS 灵犀'

function psQuote (value) {
  return "'" + value.replace(/'/g, "''") + "'"
}

function runPowerShell (script) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 })
}

export function userDataDir (override) {
  const value = override || process.env.LINGXI_USER_DATA
  if (value) return resolve(value)
  const base = process.env.APPDATA
  return base ? join(base, USER_DIR_NAME) : null
}

/** Local wps_sid rows live in Partitions/<name>/Network/Cookies. */
export function listCookieDbs (root) {
  const found = []
  const partitions = join(root, 'Partitions')
  try {
    for (const entry of readdirSync(partitions, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(partitions, entry.name, 'Network', 'Cookies')
      if (existsSync(candidate)) found.push({ label: entry.name, path: candidate })
    }
  } catch {}
  return found
}

/** Copy a live Cookies DB without terminating WPS Lingxi; esentutl /vss fallback for the exclusive lock. */
function copyShared (src, dst) {
  rmSync(dst, { force: true })
  try {
    copyFileSync(src, dst)
    if (existsSync(dst) && statSync(dst).size > 0) return { ok: true, method: 'plain-copy' }
  } catch {}
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
  return { ok: false, reason: 'copy/vss-exit-' + String(vss.status) + '/shared-exit-' + String(shared.status) }
}

/** Unprotect Local State's os_crypt.encrypted_key through Windows DPAPI (CurrentUser). */
export function readOsCryptKey (root) {
  const localState = join(root, 'Local State')
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
    return { ok: false, reason: 'dpapi-' + (result.error ? (result.error.code || 'spawn-error') : 'exit-' + result.status) }
  }
  const lines = String(result.stdout || '').split(/\r?\n/).map(function (line) {
    return line.trim()
  }).filter(Boolean)
  const hex = lines.pop()
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) return { ok: false, reason: 'dpapi-key-invalid' }
  return { ok: true, key: Buffer.from(hex, 'hex') }
}

export function isUsableSid (value) {
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

function normalizeKey (value) {
  if (!value) return null
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  if (typeof value === 'string') {
    const hex = value.startsWith('hex:') ? value.slice(4) : value
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex')
  }
  return null
}

/**
 * Discover every DISTINCT local wps_sid across Partitions/* Cookies.
 * Duplicate sids across partitions are merged into one entry with unioned domains.
 * Tests inject { osCryptKey, credential } so no DPAPI, live cookie DB or network is touched.
 */
export async function scanLocalSids (options) {
  const opts = options || {}
  const injected = opts.credential || {}
  const decrypt = typeof injected.decryptChromeCookie === 'function'
    ? injected.decryptChromeCookie
    : decryptChromeCookie
  const root = userDataDir(opts.userDataDir)
  const result = { entries: [], errors: [], userDataDir: root || 'APPDATA/WPS 灵犀' }
  if (!root || !existsSync(root)) {
    result.errors.push('user data directory missing')
    return result
  }
  const dbs = listCookieDbs(root)
  if (!dbs.length) {
    result.errors.push('no Partitions/*/Network/Cookies DB found')
    return result
  }
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch (err) {
    result.errors.push('node:sqlite unavailable (' + (err && err.code ? err.code : 'load-failed') + ')')
    return result
  }
  const work = mkdtempSync(join(tmpdir(), 'lingxi-pool-'))
  const found = new Map()
  let aesKey = normalizeKey(opts.osCryptKey)
  let keyUnavailable = false
  try {
    for (let i = 0; i < dbs.length; i++) {
      const dbInfo = dbs[i]
      const dst = join(work, 'cookies-' + i + '.db')
      const copied = copyShared(dbInfo.path, dst)
      if (!copied.ok) {
        result.errors.push('local-cookie:' + dbInfo.label + ' copy failed (' + copied.reason + ')')
        continue
      }
      let db = null
      try {
        db = new sqlite.DatabaseSync(dst, { readOnly: true })
      } catch (err) {
        result.errors.push('local-cookie:' + dbInfo.label + ' sqlite-open-' + (err && err.code ? err.code : 'failed'))
        continue
      }
      let rows = []
      try {
        rows = db.prepare('SELECT host_key, value, encrypted_value FROM cookies WHERE name = ?').all('wps_sid')
      } catch (err) {
        result.errors.push('local-cookie:' + dbInfo.label + ' sqlite-query-' + (err && err.code ? err.code : 'failed'))
      } finally {
        try { db.close() } catch {}
      }
      for (const row of rows) {
        const domain = typeof row.host_key === 'string' ? row.host_key : ''
        const plainValue = typeof row.value === 'string' ? row.value : ''
        let sid = null
        if (isUsableSid(plainValue)) {
          sid = plainValue
        } else {
          const encrypted = row.encrypted_value
          if (!encrypted || !encrypted.byteLength) continue
          if (!aesKey) {
            if (keyUnavailable) continue
            const keyResult = readOsCryptKey(root)
            if (!keyResult.ok) {
              result.errors.push('local-cookie:os_crypt ' + keyResult.reason)
              keyUnavailable = true
              continue
            }
            aesKey = keyResult.key
          }
          try {
            const encryptedBytes = Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength)
            const plain = decrypt(encryptedBytes, aesKey)
            const bytes = Buffer.isBuffer(plain) || ArrayBuffer.isView(plain)
              ? Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength)
              : Buffer.from(String(plain), 'utf8')
            const candidate = stripHostHash(bytes).toString('utf8')
            if (isUsableSid(candidate)) sid = candidate
          } catch {
            result.errors.push('local-cookie:' + dbInfo.label + ' aes-gcm-auth-failed')
          }
        }
        if (!sid) continue
        let entry = found.get(sid)
        if (!entry) {
          entry = { sid: sid, label: dbInfo.label, domains: [] }
          found.set(sid, entry)
        }
        if (domain && !entry.domains.includes(domain)) entry.domains.push(domain)
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  for (const entry of found.values()) entry.domains.sort()
  result.entries = Array.from(found.values())
  return result
}
