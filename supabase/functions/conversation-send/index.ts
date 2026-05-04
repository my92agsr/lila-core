// POST /conversation/send
// Body: { content: string }
// Returns: text/event-stream — SSE with `event: token` chunks and a
//          terminal `event: done` carrying the saved assistant message id.
//
// One conversation per user (DB-enforced via conversations.unique(user_id)).
// On first call, creates the conversation row. Persists the inbound user
// message before streaming, persists the final assistant text after the
// stream completes.

import { authenticate, scopedSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { conversationSystem, renderConversationContext } from '../_shared/prompts/conversation.ts'

interface Body { content: string }

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await req.json().catch(() => ({})) as Body
  if (!body.content || typeof body.content !== 'string' || !body.content.trim()) {
    throw new HttpError(400, 'content required')
  }

  const sb = scopedSupabase(userId)

  // Ensure the single conversation exists for this user.
  const { data: existing } = await sb.raw.from('conversations')
    .select('id').eq('user_id', userId).maybeSingle()
  let conversationId: string
  if (existing?.id) {
    conversationId = existing.id
  } else {
    const { data: created, error } = await sb.from('conversations').insert({}).select('id').single()
    if (error || !created) throw new HttpError(500, `conversation create failed: ${error?.message}`)
    conversationId = created.id
  }

  // Persist the user message immediately.
  await sb.from('conversation_messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content: body.content,
  })

  // Load context: profile, working memory, last 20 messages, possibly an anchor.
  const [{ data: profile }, { data: wm }, { data: history }] = await Promise.all([
    sb.raw.from('profiles').select('first_name').eq('id', userId).single(),
    sb.raw.from('working_memory').select('greeting_context, focus_items, people_threads, quiet_items').eq('user_id', userId).maybeSingle(),
    sb.raw.from('conversation_messages').select('role, content, source_ids, anchor_bullet_id, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
  ])
  const firstName = profile?.first_name ?? 'there'
  const recent = (history ?? []).slice().reverse()

  // Pull anchor sources if the most-recent system_anchor message names them.
  const lastAnchor = recent.findLast?.((m: any) => m.role === 'system_anchor') ?? null
  const anchorSources: Array<{ table: string; id: string; record: unknown }> = []
  if (lastAnchor?.source_ids && Array.isArray(lastAnchor.source_ids)) {
    for (const ref of lastAnchor.source_ids as Array<{ table: string; id: string }>) {
      try {
        const { data } = await sb.raw.from(ref.table).select('*').eq('id', ref.id).maybeSingle()
        if (data) anchorSources.push({ table: ref.table, id: ref.id, record: data })
      } catch { /* skip unresolved sources */ }
    }
  }

  const systemPrompt = conversationSystem(firstName)
  const contextBlock = renderConversationContext({
    workingMemory: wm ?? null,
    anchorBulletId: lastAnchor?.anchor_bullet_id ?? null,
    anchorSources,
  })

  // Build the messages array for the API. The first user message contains
  // the rendered context block; subsequent messages are the actual thread.
  // System anchors get folded into the assistant turn that followed them
  // by being included as prior assistant context.
  const apiMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  apiMessages.push({ role: 'user', content: contextBlock })
  apiMessages.push({ role: 'assistant', content: 'Got it. I have the current model and recent thread.' })
  for (const m of recent) {
    if (m.role === 'system_anchor') {
      apiMessages.push({ role: 'user', content: `[Anchor] ${m.content}` })
    } else if (m.role === 'user' || m.role === 'assistant') {
      // Skip the just-inserted user message; it's added at the end below.
      apiMessages.push({ role: m.role, content: m.content })
    }
  }
  // Replace the last user message (which we just inserted and re-loaded) — no-op if findLast worked.

  // Stream from Anthropic; pipe SSE to the client. We also accumulate the
  // full text so we can persist the assistant message after the stream
  // finishes. This is a hand-rolled SSE re-emitter because Edge Functions
  // need a ReadableStream<Uint8Array> response.
  const encoder = new TextEncoder()
  let assistantBuffer = ''

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: string, data: unknown) => {
        const payload = typeof data === 'string' ? data : JSON.stringify(data)
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`))
      }
      try {
        const response = await anthropic.messages.stream({
          model: MODELS.sonnet,
          max_tokens: 1024,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: apiMessages,
        })
        for await (const event of response) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            assistantBuffer += event.delta.text
            enqueue('token', event.delta.text)
          }
        }
        // Persist assistant message. When the user just tapped a focus-item
        // bullet (the most-recent system_anchor row carries source_ids), we
        // copy those IDs onto the assistant message so the iOS client can
        // render tappable receipts under the reply. Spec §5.3: "the
        // reference is tappable, opens the source." Source attribution
        // beyond the anchor is a 1.1 problem (semantic retrieval).
        const carriedSourceIds = lastAnchor?.source_ids ?? null
        const { data: saved } = await sb.from('conversation_messages').insert({
          conversation_id: conversationId,
          role: 'assistant',
          content: assistantBuffer,
          source_ids: carriedSourceIds,
        }).select('id').single()
        enqueue('done', { id: saved?.id ?? null, source_ids: carriedSourceIds ?? [] })
      } catch (err: any) {
        enqueue('error', { message: err?.message ?? 'stream failed' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
    },
  })
}))
