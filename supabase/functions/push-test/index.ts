// POST /push/test
// Body: { body?: string }
//
// Dev-only — gated by APP_ENV != 'production'. Sends a test push to the
// authed user's stored push_token via APNs HTTP/2.

import { authenticate, scopedSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'
import { sendApnsPush } from '../_shared/apns.ts'

interface Body { body?: string }

Deno.serve(withErrorHandling(async (req) => {
  if (Deno.env.get('APP_ENV') === 'production') {
    throw new HttpError(403, 'push-test is disabled in production')
  }
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req).catch(() => ({} as Body))

  const sb = scopedSupabase(userId)
  const { data: pref } = await sb.raw.from('notification_preferences').select('push_token').eq('user_id', userId).single()
  if (!pref?.push_token) throw new HttpError(400, 'no push_token registered for this user')

  const result = await sendApnsPush({
    deviceToken: pref.push_token,
    body: body.body ?? 'Test from Lila.',
    payload: { kind: 'test' },
  })
  return jsonResponse({ ok: true, apns: result })
}))
