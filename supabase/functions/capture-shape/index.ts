// POST /capture/shape
// Body: { capture_id: string }
// Returns: { type, shaped_into_table, shaped_into_id }
//
// Reads the captures row, classifies it, routes to the appropriate Sonnet
// shaper, inserts the shaped row, updates captures.shaped_into_*. The
// classification step is inlined here so we save the round-trip from the
// iOS client; capture-classify still exists for explicit / preview calls.

import { authenticate, HttpError, scopedSupabase } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { CLASSIFY_SYSTEM, CLASSIFY_USER } from '../_shared/prompts/classify.ts'
import { shapeTaskSystem, shapeTaskUser } from '../_shared/prompts/shape_task.ts'
import { shapeNoteSystem, shapeNoteUser } from '../_shared/prompts/shape_note.ts'
import { shapeMemorySystem, shapeMemoryUser } from '../_shared/prompts/shape_memory.ts'
import { shapeBookmarkSystem, shapeBookmarkUser } from '../_shared/prompts/shape_bookmark.ts'
import { parseJsonObject } from '../_shared/json.ts'

interface Body { capture_id: string }
type CaptureType = 'task' | 'note' | 'memory' | 'bookmark' | 'reflection' | 'ambiguous'

const URL_REGEX = /^https?:\/\/\S+$/i

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req)
  if (!body.capture_id) throw new HttpError(400, 'capture_id is required')

  const sb = scopedSupabase(userId)

  const { data: capture, error: capErr } = await sb.from('captures').select('*').eq('id', body.capture_id).single()
  if (capErr || !capture) throw new HttpError(404, 'capture not found')
  if (capture.shaped_status === 'shaped') {
    return jsonResponse({
      type: capture.shaped_into_table,
      shaped_into_table: capture.shaped_into_table,
      shaped_into_id: capture.shaped_into_id,
      cached: true,
    })
  }

  const rawText: string = capture.raw_text ?? ''
  const profile = await loadProfile(userId)
  const firstName = profile.first_name ?? 'there'

  // 1. Classify (or short-circuit on URL).
  let type: CaptureType
  if (URL_REGEX.test(rawText.trim())) {
    type = 'bookmark'
  } else {
    const cls = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 256,
      system: [{ type: 'text', text: CLASSIFY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: CLASSIFY_USER(rawText) }],
    })
    const clsText = (cls.content[0] as any).text as string
    const parsed = parseJsonObject<{ type: CaptureType }>(clsText)
    type = parsed.type
  }

  // Ambiguous → note (lossless container).
  const effectiveType: CaptureType = type === 'ambiguous' ? 'note' : type

  // 2. Shape and insert.
  let table: string
  let row: any
  switch (effectiveType) {
    case 'task': {
      const shaped = await shapeWithSonnet({
        system: shapeTaskSystem(firstName),
        user: shapeTaskUser(rawText),
      })
      const insert = {
        title: shaped.title,
        first_step: shaped.first_step,
        notes: shaped.notes,
        domain: shaped.domain,
        layer: shaped.layer ?? 'current',
        due_at: shaped.due_at,
        source_capture_id: body.capture_id,
      }
      const { data, error } = await sb.from('tasks').insert(insert).select('id').single()
      if (error) throw new HttpError(500, `task insert failed: ${error.message}`)
      table = 'tasks'; row = data
      break
    }
    case 'note':
    case 'reflection': {
      const shaped = await shapeWithSonnet({
        system: shapeNoteSystem(firstName),
        user: shapeNoteUser(rawText),
      })
      if (effectiveType === 'reflection') {
        const { data, error } = await sb.from('reflections')
          .insert({ content: shaped.content, kind: 'ad_hoc' })
          .select('id').single()
        if (error) throw new HttpError(500, `reflection insert failed: ${error.message}`)
        table = 'reflections'; row = data
      } else {
        const { data, error } = await sb.from('notes')
          .insert({ title: shaped.title, content: shaped.content, tags: shaped.tags, source_capture_id: body.capture_id })
          .select('id').single()
        if (error) throw new HttpError(500, `note insert failed: ${error.message}`)
        table = 'notes'; row = data
      }
      break
    }
    case 'memory': {
      const shaped = await shapeWithSonnet({
        system: shapeMemorySystem(firstName),
        user: shapeMemoryUser(rawText),
      })
      const items: any[] = Array.isArray(shaped.memories) ? shaped.memories : []
      if (items.length === 0) {
        // Fall back to note when the distiller returns nothing.
        const { data, error } = await sb.from('notes')
          .insert({ content: rawText, source_capture_id: body.capture_id })
          .select('id').single()
        if (error) throw new HttpError(500, `note fallback insert failed: ${error.message}`)
        table = 'notes'; row = data
      } else {
        const inserts = items.map((m) => ({
          sector: m.sector,
          content: m.content,
          topic_key: m.topic_key,
          salience: m.salience,
          source_capture_id: body.capture_id,
        }))
        const { data, error } = await sb.from('memories').insert(inserts).select('id')
        if (error) throw new HttpError(500, `memory insert failed: ${error.message}`)
        table = 'memories'; row = data?.[0]
      }
      break
    }
    case 'bookmark': {
      const url = extractFirstUrl(rawText) ?? rawText.trim()
      const shaped = await shapeWithSonnet({
        system: shapeBookmarkSystem(firstName),
        user: shapeBookmarkUser(url),
      })
      const { data, error } = await sb.from('bookmarks')
        .insert({ url: shaped.url ?? url, title: shaped.title, summary: shaped.summary, source_capture_id: body.capture_id })
        .select('id').single()
      if (error) throw new HttpError(500, `bookmark insert failed: ${error.message}`)
      table = 'bookmarks'; row = data
      break
    }
    default:
      throw new HttpError(500, `unknown type ${effectiveType}`)
  }

  // 3. Mark capture shaped.
  await sb.from('captures').update({
    shaped_status: 'shaped',
    shaped_into_table: table,
    shaped_into_id: row.id,
  }).eq('id', body.capture_id)

  // Fire-and-forget: trigger consolidation after every Nth capture. The
  // worker checks "have we hit 3 captures since last consolidation?" and
  // skips otherwise. Don't await; this is best-effort.
  triggerThirdCaptureConsolidation(userId).catch((e) => console.error('third-capture trigger failed', e))

  return jsonResponse({
    type: effectiveType,
    shaped_into_table: table,
    shaped_into_id: row.id,
  })
}))

async function shapeWithSonnet(p: { system: string; user: string }): Promise<any> {
  const r = await anthropic.messages.create({
    model: MODELS.sonnet,
    max_tokens: 1024,
    system: [{ type: 'text', text: p.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: p.user }],
  })
  const text = (r.content[0] as any).text as string
  return parseJsonObject(text)
}

async function loadProfile(userId: string): Promise<{ first_name: string | null; timezone: string | null }> {
  const sb = scopedSupabase(userId)
  const { data } = await sb.raw.from('profiles').select('first_name, timezone').eq('id', userId).single()
  return { first_name: data?.first_name ?? null, timezone: data?.timezone ?? null }
}

function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/\S+/i)
  return m ? m[0] : null
}

// Onboarding §10.2: after the user's third capture (or 24h after signup,
// whichever first), trigger an immediate consolidation. This counts the
// shaped captures and only kicks off when the threshold flips.
async function triggerThirdCaptureConsolidation(userId: string) {
  const sb = scopedSupabase(userId)
  const [{ data: caps }, { data: lastRun }] = await Promise.all([
    sb.from('captures').select('id', { count: 'exact', head: true }).eq('shaped_status', 'shaped'),
    sb.raw.from('consolidation_runs').select('ran_at').eq('user_id', userId).order('ran_at', { ascending: false }).limit(1),
  ])
  const total = (caps as any)?.length ?? 0
  const hasEverConsolidated = (lastRun?.length ?? 0) > 0
  if (!hasEverConsolidated && total >= 3) {
    const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/memory-consolidate`
    await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'content-type': 'application/json',
        'x-internal-call': 'third_capture',
      },
      body: JSON.stringify({ user_id: userId, trigger: 'third_capture' }),
    }).catch(() => {})
  }
}
