// Maps Google Calendar events into rows in public.events and reconciles
// against what's already there. Idempotent: re-running with the same
// inputs is a no-op.
//
// We don't use Supabase's `.upsert({ onConflict })` here because the
// events_external_unique index is partial (WHERE connector IS NOT NULL)
// and PostgREST's conflict-target inference doesn't reliably match
// partial indexes. Manual reconcile is honest and gives us a clean
// per-event outcome for logging.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GoogleAttendee, GoogleEvent } from './fetch.js'

export const CONNECTOR = 'google_calendar'

export interface MappedEvent {
    external_id: string
    title: string
    start_at: string
    end_at: string | null
    attendees: string[]
    location: string | null
}

export interface ExistingEvent {
    id: string
    external_id: string
    title: string
    start_at: string
    end_at: string | null
    attendees: string[] | null
    location: string | null
}

export interface SyncOutcome {
    inserted: number
    updated: number
    unchanged: number
    skipped: number
}

// Cancelled events are dropped. Events without a start time (data error
// from Google's side) are also dropped — there's nothing useful to
// surface for them. We log the skip count so anomalies are visible.
export function mapEvents(events: GoogleEvent[]): { mapped: MappedEvent[]; skipped: number } {
    const mapped: MappedEvent[] = []
    let skipped = 0
    for (const e of events) {
        if (e.status === 'cancelled') {
            skipped++
            continue
        }
        const starts = e.start?.dateTime ?? toMidnightUTC(e.start?.date)
        const ends = e.end?.dateTime ?? toMidnightUTC(e.end?.date)
        if (!starts) {
            skipped++
            continue
        }
        mapped.push({
            external_id: e.id,
            title: e.summary?.trim() || '(no title)',
            start_at: starts,
            end_at: ends ?? null,
            attendees: mapAttendees(e.attendees),
            location: e.location?.trim() || null,
        })
    }
    return { mapped, skipped }
}

// Drops the user themselves (self=true) — the calendar is theirs, so
// they're trivially an attendee on every event and listing them adds
// noise to the prompt without information. Falls back to email when
// no displayName is present, since the email is at least an identifier
// the model can reason about.
function mapAttendees(attendees: GoogleAttendee[] | undefined): string[] {
    if (!attendees) return []
    const names: string[] = []
    for (const a of attendees) {
        if (a.self) continue
        const name = a.displayName?.trim() || a.email?.trim()
        if (name) names.push(name)
    }
    return names
}

// All-day events arrive as `{ date: 'YYYY-MM-DD' }` with no time/zone.
// Treating them as UTC midnight is a deliberate simplification: the
// consolidation engine cares about the day, not the wall clock, and
// timezone handling for all-day events would otherwise compound edge
// cases (Google itself stores them this way).
function toMidnightUTC(date?: string): string | null {
    if (!date) return null
    return `${date}T00:00:00Z`
}

export async function reconcile(
    client: SupabaseClient,
    userId: string,
    mapped: MappedEvent[],
): Promise<SyncOutcome> {
    if (mapped.length === 0) {
        return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 }
    }

    const externalIds = mapped.map((m) => m.external_id)
    const { data: existingRows, error: selectError } = await client
        .from('events')
        .select('id, external_id, title, start_at, end_at, attendees, location')
        .eq('user_id', userId)
        .eq('connector', CONNECTOR)
        .in('external_id', externalIds)
    if (selectError) throw new Error(`select events: ${selectError.message}`)

    const existingByExtId = new Map<string, ExistingEvent>()
    for (const row of (existingRows ?? []) as ExistingEvent[]) {
        existingByExtId.set(row.external_id, row)
    }

    const toInsert: Array<MappedEvent & { user_id: string; connector: string }> = []
    const toUpdate: Array<{ id: string; patch: Partial<MappedEvent> }> = []
    let unchanged = 0

    for (const m of mapped) {
        const existing = existingByExtId.get(m.external_id)
        if (!existing) {
            toInsert.push({ ...m, user_id: userId, connector: CONNECTOR })
            continue
        }
        if (
            existing.title === m.title &&
            normalizeISO(existing.start_at) === normalizeISO(m.start_at) &&
            normalizeISO(existing.end_at) === normalizeISO(m.end_at) &&
            sameAttendees(existing.attendees, m.attendees) &&
            (existing.location ?? null) === m.location
        ) {
            unchanged++
            continue
        }
        toUpdate.push({
            id: existing.id,
            patch: {
                title: m.title,
                start_at: m.start_at,
                end_at: m.end_at,
                attendees: m.attendees,
                location: m.location,
            },
        })
    }

    if (toInsert.length > 0) {
        const { error } = await client.from('events').insert(toInsert)
        if (error) throw new Error(`insert events: ${error.message}`)
    }

    for (const u of toUpdate) {
        const { error } = await client.from('events').update(u.patch).eq('id', u.id)
        if (error) throw new Error(`update event ${u.id}: ${error.message}`)
    }

    return {
        inserted: toInsert.length,
        updated: toUpdate.length,
        unchanged,
        skipped: 0,
    }
}

// Postgres returns timestamps in the column's stored form, which may
// differ from the ISO string we sent (e.g. trailing Z vs +00:00).
// Normalize to ms-precision UTC so equality comparisons don't churn.
function normalizeISO(value: string | null): string | null {
    if (!value) return null
    const t = Date.parse(value)
    return Number.isNaN(t) ? value : new Date(t).toISOString()
}

// Order matters for postgres text[] equality but not for our purposes —
// "are the attendees the same set" is the intent. Treats null/empty as
// equivalent so a freshly-imported empty list doesn't churn against a
// not-yet-backfilled NULL.
function sameAttendees(a: string[] | null, b: string[]): boolean {
    const aa = a ?? []
    if (aa.length !== b.length) return false
    const set = new Set(aa)
    for (const name of b) if (!set.has(name)) return false
    return true
}
