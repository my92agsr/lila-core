// APNs HTTP/2 push helper. Uses an auth-key-signed JWT; key + IDs come
// from env. The function is intentionally minimal — no retries, no token
// caching beyond a single in-memory variable in the Deno process. The
// delivery worker is responsible for retry/backoff at the queue level.

import { create as createJwt, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts'

interface PushArgs {
  deviceToken: string
  body: string
  payload?: Record<string, unknown>
  threadId?: string
}

const APNS_HOST = Deno.env.get('APP_ENV') === 'production'
  ? 'https://api.push.apple.com'
  : 'https://api.sandbox.push.apple.com'

let cachedToken: { value: string; expiresAt: number } | null = null

async function buildAuthToken(): Promise<string> {
  // Apple recommends refreshing every 20 minutes. We refresh every 30 min.
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value

  const teamId = Deno.env.get('APNS_TEAM_ID')
  const keyId = Deno.env.get('APNS_KEY_ID')
  const privateKeyPem = Deno.env.get('APNS_PRIVATE_KEY')
  if (!teamId || !keyId || !privateKeyPem) {
    throw new Error('APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY env vars must be set')
  }

  const key = await importEcKey(privateKeyPem)
  const jwt = await createJwt(
    { alg: 'ES256', kid: keyId, typ: 'JWT' },
    { iss: teamId, iat: getNumericDate(0) },
    key,
  )
  cachedToken = { value: jwt, expiresAt: Date.now() + 30 * 60_000 }
  return jwt
}

async function importEcKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  const der = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0))
  return await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

export interface PushResult { ok: boolean; status: number; reason?: string }

export async function sendApnsPush(args: PushArgs): Promise<PushResult> {
  const bundle = Deno.env.get('APNS_BUNDLE_ID')
  if (!bundle) throw new Error('APNS_BUNDLE_ID must be set')

  const token = await buildAuthToken()
  const url = `${APNS_HOST}/3/device/${args.deviceToken}`

  const body = {
    aps: {
      alert: { body: args.body },
      sound: 'default',
      'thread-id': args.threadId ?? 'lila',
    },
    ...(args.payload ?? {}),
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `bearer ${token}`,
      'apns-topic': bundle,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (r.ok) return { ok: true, status: r.status }
  const text = await r.text().catch(() => '')
  return { ok: false, status: r.status, reason: text }
}
