// POST /connectors/calendar/sync
// Body: { events: [{ external_id, title, start_at, end_at, location?, attendees?, notes? }] }
// Returns: { upserted, removed_external_ids }
//
// Idempotent. iOS reads EventKit and posts the next 30 days. The function
// upserts on (user_id, connector='apple_calendar', external_id) and
// tombstones any prior connector-rows whose external_id is no longer in
// the payload (vendor-deletion semantics).

import { authenticate, scopedSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'

interface Incoming {
  external_id: string
  title: string
  start_at: string
  end_at: string | null
  location?: string | null
  attendees?: string[] | null
  notes?: string | null
}
interface Body {
  connector?: string
  events: Incoming[]
}

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req)
  const connector = body.connector ?? 'apple_calendar'
  if (!Array.isArray(body.events)) throw new HttpError(400, 'events array required')

  const sb = scopedSupabase(userId)

  // Pull the existing rows once so we can compute the tombstone set.
  const { data: existing } = await sb.raw.from('events')
    .select('id, external_id, resolved_at')
    .eq('user_id', userId)
    .eq('connector', connector)

  const incomingIds = new Set(body.events.map((e) => e.external_id))
  const toTombstone = (existing ?? []).filter(
    (r: any) => !incomingIds.has(r.external_id) && !r.resolved_at,
  )

  // Upsert each incoming event. We split into chunks of 100 to keep
  // payloads reasonable.
  let upserted = 0
  for (let i = 0; i < body.events.length; i += 100) {
    const chunk = body.events.slice(i, i + 100).map((e) => ({
      title: e.title,
      start_at: e.start_at,
      end_at: e.end_at,
      location: e.location ?? null,
      attendees: e.attendees ?? null,
      notes: e.notes ?? null,
      connector,
      external_id: e.external_id,
      resolved_at: null,
    }))
    const { error } = await sb.from('events').upsert(chunk as any, { onConflict: 'user_id,connector,external_id' } as any)
    if (error) throw new HttpError(500, `upsert failed: ${error.message}`)
    upserted += chunk.length
  }

  // Tombstone vendor-deleted rows.
  if (toTombstone.length > 0) {
    const ids = toTombstone.map((r: any) => r.id)
    const { error } = await sb.raw.from('events')
      .update({ resolved_at: new Date().toISOString() })
      .in('id', ids).eq('user_id', userId)
    if (error) console.error('tombstone update failed', error)
  }

  return jsonResponse({
    upserted,
    removed_external_ids: toTombstone.map((r: any) => r.external_id),
  })
}))
