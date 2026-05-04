// POST /capture/distill-memory
// Body: { capture_id }
//
// Pulls memory items out of an existing capture. Different from the memory
// branch of capture-shape: this can be called *alongside* a note shaping
// for captures the local classifier flagged as memory-bearing ("remember",
// "always", "prefers", "hates").

import { authenticate, scopedSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { shapeMemorySystem, shapeMemoryUser } from '../_shared/prompts/shape_memory.ts'
import { parseJsonObject } from '../_shared/json.ts'

interface Body { capture_id: string }

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req)
  if (!body.capture_id) throw new HttpError(400, 'capture_id required')

  const sb = scopedSupabase(userId)
  const { data: cap } = await sb.raw.from('captures').select('raw_text').eq('id', body.capture_id).single()
  if (!cap) throw new HttpError(404, 'capture not found')
  const { data: profile } = await sb.raw.from('profiles').select('first_name').eq('id', userId).single()
  const firstName = profile?.first_name ?? 'there'

  const r = await anthropic.messages.create({
    model: MODELS.sonnet,
    max_tokens: 1024,
    system: [{ type: 'text', text: shapeMemorySystem(firstName), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: shapeMemoryUser(cap.raw_text) }],
  })
  const text = (r.content[0] as any).text as string
  const parsed = parseJsonObject<{ memories: any[] }>(text)
  const items = Array.isArray(parsed.memories) ? parsed.memories : []
  if (items.length === 0) return jsonResponse({ inserted: 0 })

  const inserts = items.map((m) => ({
    sector: m.sector,
    content: m.content,
    topic_key: m.topic_key,
    salience: m.salience,
    source_capture_id: body.capture_id,
  }))
  const { error } = await sb.from('memories').insert(inserts)
  if (error) throw new HttpError(500, `memory insert failed: ${error.message}`)
  return jsonResponse({ inserted: inserts.length })
}))
