// POST /capture/classify
// Body: { capture_id: string, raw_text: string }
// Returns: { type, confidence, rationale }
//
// Haiku-based structural classification. Doesn't write anything — the
// caller (capture-shape, usually) routes on the returned type.

import { authenticate, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { CLASSIFY_SYSTEM, CLASSIFY_USER } from '../_shared/prompts/classify.ts'
import { parseJsonObject } from '../_shared/json.ts'

interface Body { capture_id?: string; raw_text: string }
interface Result { type: string; confidence: number; rationale: string }

Deno.serve(withErrorHandling(async (req) => {
  await authenticate(req)
  const body = await readJson<Body>(req)
  if (!body.raw_text || typeof body.raw_text !== 'string') {
    throw new HttpError(400, 'raw_text is required')
  }

  const response = await anthropic.messages.create({
    model: MODELS.haiku,
    max_tokens: 256,
    system: [{ type: 'text', text: CLASSIFY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: CLASSIFY_USER(body.raw_text) }],
  })

  const text = response.content.find((b) => b.type === 'text')?.type === 'text'
    ? (response.content[0] as { text: string }).text
    : ''
  const parsed = parseJsonObject<Result>(text)
  return jsonResponse(parsed)
}))
