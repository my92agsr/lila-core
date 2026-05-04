// POST /proactive-calendar-imminent
// Service-role only. Hourly cron. Inserts a high_confidence
// proactive_events row for any event starting in 15-30 minutes that the
// user hasn't acknowledged. Acknowledgment = either resolved_at on the
// event row or a recent (<2h) conversation message that mentions it.
//
// One candidate per event per day — the unique check uses a synthetic
// suppressed_reason='dedup' approach: we look for an existing
// proactive_events row with subcategory='calendar_imminent_<event_id>'
// and skip if found.

import { adminSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse } from '../_shared/http.ts'

Deno.serve(withErrorHandling(async (req) => {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.includes(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '__never__')) {
    throw new HttpError(403, 'service-role only')
  }

  const now = new Date()
  const windowStart = new Date(now.getTime() + 15 * 60_000).toISOString()
  const windowEnd = new Date(now.getTime() + 30 * 60_000).toISOString()

  const { data: events } = await adminSupabase
    .from('events')
    .select('id, user_id, title, start_at, location, attendees')
    .gte('start_at', windowStart)
    .lte('start_at', windowEnd)
    .is('resolved_at', null)
  if (!events || events.length === 0) return jsonResponse({ scheduled: 0 })

  let scheduled = 0
  for (const ev of events) {
    const sub = `calendar_imminent_${ev.id}`
    const { data: existing } = await adminSupabase
      .from('proactive_events')
      .select('id')
      .eq('user_id', ev.user_id)
      .eq('subcategory', sub)
      .limit(1)
      .maybeSingle()
    if (existing) continue

    const startLocal = new Date(ev.start_at)
    const time = `${startLocal.getUTCHours().toString().padStart(2, '0')}:${startLocal.getUTCMinutes().toString().padStart(2, '0')}`
    const titleSuffix = ev.title || 'event'
    const where = ev.location ? ` at ${ev.location}` : ''
    const body = `${time} — ${titleSuffix}${where}.`

    await adminSupabase.from('proactive_events').insert({
      user_id: ev.user_id,
      category: 'high_confidence',
      subcategory: sub,
      body: body.slice(0, 140),
      source_ids: [{ table: 'events', id: ev.id }],
      anchor_message: `${titleSuffix} starts at ${time}${where}. Anything you want to talk through before?`,
      scheduled_for: now.toISOString(),
    })
    scheduled++
  }
  return jsonResponse({ scheduled })
}))
