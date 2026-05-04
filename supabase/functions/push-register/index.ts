// POST /push/register
// Body: { token: string, platform: 'apns' }
//
// Stores the device's APNs token on notification_preferences for the
// authed user. Idempotent — re-registration just overwrites.

import { authenticate, scopedSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'

interface Body { token: string; platform?: 'apns' }

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req)
  if (!body.token) throw new HttpError(400, 'token required')

  const sb = scopedSupabase(userId)

  // Try update first; if no row exists, insert.
  const { data: existing } = await sb.raw
    .from('notification_preferences').select('user_id').eq('user_id', userId).maybeSingle()

  if (existing) {
    const { error } = await sb.from('notification_preferences')
      .update({ push_token: body.token, updated_at: new Date().toISOString() })
    if (error) throw new HttpError(500, `update failed: ${error.message}`)
  } else {
    const { error } = await sb.from('notification_preferences').insert({
      push_token: body.token,
    })
    if (error) throw new HttpError(500, `insert failed: ${error.message}`)
  }
  return jsonResponse({ ok: true })
}))
