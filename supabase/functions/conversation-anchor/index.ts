// POST /conversation/anchor
// Body: { bullet_id: string, bullet_text: string, source_ids: [{table,id}] }
//
// Inserts a `system_anchor` message into the user's conversation thread,
// naming the bullet they tapped and the source records that produced it.
// The next /conversation/send call sees this anchor in the message
// history and includes the source records in the context block.
//
// Same code path is used by notification taps — the proactive_events row
// already carries an anchor_message and source_ids, and the iOS client
// turns that into the same payload.

import { authenticate, scopedSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'

interface Body {
  bullet_id: string
  bullet_text: string
  source_ids: Array<{ table: string; id: string }>
}

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req)
  if (!body.bullet_id || !body.bullet_text) throw new HttpError(400, 'bullet_id and bullet_text required')

  const sb = scopedSupabase(userId)

  const { data: existing } = await sb.raw.from('conversations')
    .select('id').eq('user_id', userId).maybeSingle()
  let conversationId: string
  if (existing?.id) conversationId = existing.id
  else {
    const { data: created, error } = await sb.from('conversations').insert({}).select('id').single()
    if (error || !created) throw new HttpError(500, `conversation create failed: ${error?.message}`)
    conversationId = created.id
  }

  const { data: msg, error: msgErr } = await sb.from('conversation_messages').insert({
    conversation_id: conversationId,
    role: 'system_anchor',
    content: body.bullet_text,
    source_ids: body.source_ids ?? [],
    anchor_bullet_id: body.bullet_id,
  }).select('id').single()
  if (msgErr) throw new HttpError(500, `anchor insert failed: ${msgErr.message}`)

  return jsonResponse({ conversation_id: conversationId, message_id: msg!.id })
}))
