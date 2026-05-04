// POST /capture/extract-tasks
// Body: { source_table: 'notes'|'captures', source_id }
//
// Pull task items out of a longer body of text. Used alongside note
// shaping when the capture is multi-paragraph and likely contains
// embedded actions.

import { authenticate, scopedSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { extractTasksSystem, extractTasksUser } from '../_shared/prompts/extract_tasks.ts'
import { parseJsonObject } from '../_shared/json.ts'

interface Body { source_table: 'notes' | 'captures'; source_id: string }

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req)
  if (!body.source_id || !['notes', 'captures'].includes(body.source_table)) {
    throw new HttpError(400, 'source_table must be notes or captures, source_id required')
  }

  const sb = scopedSupabase(userId)
  const textColumn = body.source_table === 'notes' ? 'content' : 'raw_text'
  const { data: src } = await sb.raw.from(body.source_table).select(`id, ${textColumn}`).eq('id', body.source_id).single()
  if (!src) throw new HttpError(404, 'source not found')
  const { data: profile } = await sb.raw.from('profiles').select('first_name').eq('id', userId).single()
  const firstName = profile?.first_name ?? 'there'

  const r = await anthropic.messages.create({
    model: MODELS.sonnet,
    max_tokens: 1024,
    system: [{ type: 'text', text: extractTasksSystem(firstName), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: extractTasksUser(((src as any)[textColumn] as string) ?? '') }],
  })
  const text = (r.content[0] as any).text as string
  const parsed = parseJsonObject<{ tasks: any[] }>(text)
  const items = Array.isArray(parsed.tasks) ? parsed.tasks : []
  if (items.length === 0) return jsonResponse({ inserted: 0 })

  const sourceCaptureId = body.source_table === 'captures' ? body.source_id : null
  const inserts = items.map((t) => ({
    title: t.title,
    first_step: t.first_step,
    notes: t.evidence ? `From source ${body.source_table}/${body.source_id}: ${t.evidence}` : null,
    layer: 'current',
    due_at: t.due_at,
    source_capture_id: sourceCaptureId,
  }))
  const { error } = await sb.from('tasks').insert(inserts)
  if (error) throw new HttpError(500, `task insert failed: ${error.message}`)
  return jsonResponse({ inserted: inserts.length })
}))
