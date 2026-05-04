// POST /memory/proactive-scan
// Body: { user_id, working_memory, recent_activity }
//
// Runs at the end of consolidation. Generates 0+ proactive_events
// candidates with delivered_at=null. The delivery worker decides which
// ones actually get sent. Service-role only — chained from
// memory-consolidate, never called from the iOS client.

import { adminSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { proactiveScanSystem, proactiveScanUser } from '../_shared/prompts/proactive_scan.ts'
import { parseJsonObject } from '../_shared/json.ts'

interface Body {
  user_id: string
  working_memory: any
  recent_activity: any[]
}

Deno.serve(withErrorHandling(async (req) => {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.includes(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '__never__')) {
    throw new HttpError(403, 'service-role only')
  }
  const body = await readJson<Body>(req)
  if (!body.user_id) throw new HttpError(400, 'user_id required')

  const { data: profile } = await adminSupabase.from('profiles').select('first_name, timezone').eq('id', body.user_id).single()
  const firstName = profile?.first_name ?? 'there'

  const r = await anthropic.messages.create({
    model: MODELS.sonnet,
    max_tokens: 1024,
    system: [{ type: 'text', text: proactiveScanSystem(firstName), cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: proactiveScanUser(JSON.stringify(body.working_memory, null, 2), JSON.stringify(body.recent_activity, null, 2)),
    }],
  })
  const text = (r.content[0] as any).text as string
  const parsed = parseJsonObject<{ candidates: any[] }>(text)
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : []

  if (candidates.length === 0) return jsonResponse({ generated: 0 })

  // Schedule each candidate for ~now+5min so the delivery worker picks
  // them up on the next tick, applying rate limits and quiet hours.
  const scheduledFor = new Date(Date.now() + 5 * 60_000).toISOString()
  const inserts = candidates.map((c) => ({
    user_id: body.user_id,
    category: c.category,
    subcategory: c.subcategory ?? null,
    body: c.body,
    source_ids: c.source_ids ?? [],
    anchor_message: c.anchor_message ?? null,
    scheduled_for: scheduledFor,
  }))
  const { error } = await adminSupabase.from('proactive_events').insert(inserts)
  if (error) throw new HttpError(500, `insert failed: ${error.message}`)
  return jsonResponse({ generated: inserts.length })
}))
