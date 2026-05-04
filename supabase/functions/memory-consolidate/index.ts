// POST /memory/consolidate
// Body: { user_id?: string, trigger?: 'cron'|'manual'|'third_capture' }
//
// Two calling modes:
//   1. User-authed (Authorization: Bearer <user JWT>) — consolidates the
//      authed user. trigger defaults to 'manual'.
//   2. Internal (Authorization: Bearer <service-role key> + body.user_id)
//      — used by the third-capture hook, the nightly cron, and refresh.
//
// Reads recent activity, runs the Sonnet consolidation prompt, upserts
// working_memory, logs to consolidation_runs, then kicks off
// proactive-scan in the background.

import { adminSupabase, authenticate, HttpError, scopedSupabase } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { consolidationSystem, consolidationUser, ConsolidationVars } from '../_shared/prompts/consolidation.ts'
import { parseJsonObject } from '../_shared/json.ts'

interface Body {
  user_id?: string
  trigger?: 'cron' | 'manual' | 'third_capture'
  lookback_window_days?: number
}

const DEFAULT_LOOKBACK = 7

Deno.serve(withErrorHandling(async (req) => {
  const body = await readJson<Body>(req).catch(() => ({} as Body))

  // Resolve who we're consolidating for. If the caller is service-role,
  // body.user_id is required. Otherwise, take the authed user.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const auth = req.headers.get('authorization') ?? ''
  const isService = serviceKey && auth.includes(serviceKey)

  let userId: string
  let trigger: 'cron' | 'manual' | 'third_capture' = body.trigger ?? 'manual'
  if (isService) {
    if (!body.user_id) throw new HttpError(400, 'user_id required for service calls')
    userId = body.user_id
    trigger = body.trigger ?? 'cron'
  } else {
    const a = await authenticate(req)
    userId = a.userId
  }

  const lookback = body.lookback_window_days ?? DEFAULT_LOOKBACK
  const t0 = Date.now()
  let success = false
  let error: string | null = null
  let usage = { input_tokens: 0, output_tokens: 0 }

  try {
    const profile = await loadProfile(userId)
    const firstName = profile.first_name ?? 'there'
    const tz = profile.timezone ?? 'UTC'

    const inputs = await loadInputs(userId, lookback)

    const sys = consolidationSystem(firstName)
    const usr = consolidationUser({
      firstName,
      currentDate: new Date().toISOString().slice(0, 10),
      lookbackWindowDays: lookback,
      recentActivity: inputs.recentActivity,
      previousWorkingMemory: inputs.previousWorkingMemory,
      retrievedMemories: inputs.retrievedMemories,
      todayEvents: inputs.upcomingEvents,
    })

    const response = await anthropic.messages.create({
      model: MODELS.sonnet,
      max_tokens: 2048,
      system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: usr }],
    })
    usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens }
    const text = (response.content[0] as any).text as string
    const parsed = parseJsonObject<{
      greeting_context: string | null
      focus_items: any[]
      people_threads: any[]
      quiet_items: any[]
    }>(text)

    // Upsert working_memory (one row per user).
    const sb = scopedSupabase(userId)
    const { error: upsertErr } = await sb.from('working_memory').upsert({
      user_id: userId,
      greeting_context: parsed.greeting_context,
      focus_items: parsed.focus_items ?? [],
      people_threads: parsed.people_threads ?? [],
      quiet_items: parsed.quiet_items ?? [],
      generated_at: new Date().toISOString(),
    } as any, { onConflict: 'user_id' } as any)
    if (upsertErr) throw new Error(`working_memory upsert failed: ${upsertErr.message}`)

    success = true

    // Fire-and-forget proactive scan.
    triggerProactiveScan(userId, parsed, inputs.recentActivity).catch((e) => console.error('proactive-scan trigger failed', e))

    return jsonResponse({ ok: true, generated_at: new Date().toISOString(), trigger, tz })
  } catch (e: any) {
    error = e?.message ?? String(e)
    throw e
  } finally {
    // Always log the run, success or failure.
    await adminSupabase.from('consolidation_runs').insert({
      user_id: userId,
      trigger,
      duration_ms: Date.now() - t0,
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens,
      success,
      error,
    })
  }
}))

interface ConsolidationInputs {
  recentActivity: any[]
  previousWorkingMemory: any | null
  retrievedMemories: any[]
  upcomingEvents: any[]
}

async function loadInputs(userId: string, lookbackDays: number): Promise<ConsolidationInputs> {
  const sb = scopedSupabase(userId)
  const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString()
  const upcomingTo = new Date(Date.now() + 7 * 86400_000).toISOString()

  const [captures, tasks, notes, reflections, events, memories, prevWm] = await Promise.all([
    sb.raw.from('captures').select('id, raw_text, created_at, shaped_into_table, shaped_into_id').eq('user_id', userId).gte('created_at', since).order('created_at', { ascending: true }),
    sb.raw.from('tasks').select('id, title, first_step, notes, layer, due_at, resolved_at, updated_at, created_at').eq('user_id', userId).gte('updated_at', since),
    sb.raw.from('notes').select('id, title, content, created_at').eq('user_id', userId).gte('created_at', since),
    sb.raw.from('reflections').select('id, content, kind, created_at').eq('user_id', userId).gte('created_at', since),
    sb.raw.from('events').select('id, title, start_at, end_at, attendees, location, notes').eq('user_id', userId).gte('start_at', since).lte('start_at', upcomingTo).order('start_at', { ascending: true }),
    sb.raw.from('memories').select('id, sector, content, topic_key, salience, created_at').eq('user_id', userId).order('salience', { ascending: false }).limit(20),
    sb.raw.from('working_memory').select('greeting_context, focus_items, people_threads, quiet_items, generated_at').eq('user_id', userId).single(),
  ])

  const recentActivity: any[] = []
  for (const c of captures.data ?? []) {
    recentActivity.push({ record: { table: 'captures', id: c.id }, kind: 'capture', ts: c.created_at, text: c.raw_text })
  }
  for (const t of tasks.data ?? []) {
    recentActivity.push({ record: { table: 'tasks', id: t.id }, kind: 'task', ts: t.updated_at, title: t.title, status: t.resolved_at ? 'resolved' : 'open', due: t.due_at, note: t.notes })
  }
  for (const n of notes.data ?? []) {
    recentActivity.push({ record: { table: 'notes', id: n.id }, kind: 'note', ts: n.created_at, title: n.title, text: n.content })
  }
  for (const r of reflections.data ?? []) {
    recentActivity.push({ record: { table: 'reflections', id: r.id }, kind: 'reflection', ts: r.created_at, text: r.content })
  }
  for (const e of events.data ?? []) {
    recentActivity.push({ record: { table: 'events', id: e.id }, kind: 'event', ts: e.start_at, title: e.title, starts_at: e.start_at, ends_at: e.end_at, attendees: e.attendees, location: e.location })
  }
  recentActivity.sort((a, b) => (a.ts < b.ts ? -1 : 1))

  const upcomingEvents = events.data ?? []
  const retrievedMemories = (memories.data ?? []).map((m: any) => ({
    ts: m.created_at, salience: m.salience, text: m.content, sector: m.sector,
  }))

  return {
    recentActivity,
    previousWorkingMemory: prevWm.data ?? null,
    retrievedMemories,
    upcomingEvents,
  }
}

async function loadProfile(userId: string) {
  const { data } = await adminSupabase.from('profiles').select('first_name, timezone').eq('id', userId).single()
  return { first_name: data?.first_name ?? null, timezone: data?.timezone ?? null }
}

async function triggerProactiveScan(userId: string, workingMemory: any, recentActivity: any[]) {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/memory-proactive-scan`
  await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId, working_memory: workingMemory, recent_activity: recentActivity }),
  })
}
