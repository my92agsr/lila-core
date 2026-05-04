// POST /memory/refresh
// Body: {} (authed user)
//
// Manual trigger of consolidation. Same code path as /memory/consolidate
// but always runs as the authed user with trigger='manual'. Used by the
// pull-to-refresh affordance on the home screen.

import { authenticate } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse } from '../_shared/http.ts'

Deno.serve(withErrorHandling(async (req) => {
  const { userId, jwt } = await authenticate(req)
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/memory-consolidate`
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${jwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ trigger: 'manual' }),
  })
  const text = await r.text()
  return jsonResponse({ ok: r.ok, status: r.status, user_id: userId, body: tryParse(text) }, r.ok ? 200 : r.status)
}))

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}
