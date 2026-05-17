// POST /conversation/send
// Body: { content: string }
// Returns: text/event-stream — SSE with the following events:
//   event: token        data: <text fragment>
//   event: tool_call    data: { id, name, input }
//   event: tool_result  data: { id, status, summary }
//   event: done         data: { id, source_ids, tool_calls }
//   event: error        data: { message }
//
// One conversation per user (DB-enforced via conversations.unique(user_id)).
// On first call, creates the conversation row. Persists the inbound user
// message before streaming.
//
// Multi-turn tool loop: when the model emits a tool_use, we execute the
// tool (RLS-scoped), feed the result back as a tool_result content block,
// and continue streaming. Cap at MAX_TURNS so a model that loops on its
// own can't run away. The final assistant message persists the full
// concatenated text plus a tool_calls audit trail.

import { authenticate, scopedSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { conversationSystem, renderConversationContext } from '../_shared/prompts/conversation.ts'
import { TOOL_SPECS, executeTool } from '../_shared/tools/index.ts'

interface Body { content: string }

const MAX_TURNS = 5

interface ToolCallLog {
  id: string
  name: string
  input: unknown
  status: 'ok' | 'error'
  summary: string
  data: Record<string, unknown> | null
}

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
  type ApiMessage = { role: 'user' | 'assistant'; content: any }
  const apiMessages: ApiMessage[] = []
  apiMessages.push({ role: 'user', content: contextBlock })
  apiMessages.push({ role: 'assistant', content: 'Got it. I have the current model and recent thread.' })
  for (const m of recent) {
    if (m.role === 'system_anchor') {
      apiMessages.push({ role: 'user', content: `[Anchor] ${m.content}` })
    } else if (m.role === 'user' || m.role === 'assistant') {
      apiMessages.push({ role: m.role, content: m.content })
    }
  }

  const encoder = new TextEncoder()
  let assistantBuffer = ''
  const toolCallsLog: ToolCallLog[] = []

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: string, data: unknown) => {
        const payload = typeof data === 'string' ? data : JSON.stringify(data)
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`))
      }
      try {
        let stopReason: string | null = null
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const response = await anthropic.messages.stream({
            model: MODELS.sonnet,
            max_tokens: 1024,
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            messages: apiMessages,
            tools: TOOL_SPECS,
          })

          // Stream text deltas to the client as they arrive. Tool-use
          // input deltas are not streamed — we wait for the block to
          // complete and emit a single tool_call with the full input.
          for await (const event of response) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              assistantBuffer += event.delta.text
              enqueue('token', event.delta.text)
            }
          }

          const final = await response.finalMessage()
          stopReason = final.stop_reason ?? null

          // Append the assistant turn (text + tool_use blocks) verbatim
          // so the next request sees the same content blocks the model
          // produced. Anthropic requires the original tool_use blocks
          // to be present alongside our tool_result reply.
          apiMessages.push({ role: 'assistant', content: final.content })

          if (final.stop_reason !== 'tool_use') break

          // Execute each tool_use block, surface results to the client,
          // and append a single user turn with all tool_results.
          const toolResultBlocks: Array<{
            type: 'tool_result'
            tool_use_id: string
            content: string
            is_error: boolean
          }> = []
          for (const block of final.content) {
            if (block.type !== 'tool_use') continue
            enqueue('tool_call', { id: block.id, name: block.name, input: block.input })
            const result = await executeTool(block.name, block.input, sb)
            enqueue('tool_result', { id: block.id, status: result.status, summary: result.summary })
            toolCallsLog.push({
              id: block.id,
              name: block.name,
              input: block.input,
              status: result.status,
              summary: result.summary,
              data: result.data ?? null,
            })
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.summary,
              is_error: result.status === 'error',
            })
          }
          apiMessages.push({ role: 'user', content: toolResultBlocks })
        }

        // If the loop hit the turn cap mid-tool-use, the model never got
        // to summarize its actions. Synthesize a minimal text reply from
        // tool summaries so the user always sees something.
        if (!assistantBuffer.trim() && toolCallsLog.length > 0) {
          assistantBuffer = toolCallsLog
            .filter((c) => c.status === 'ok')
            .map((c) => c.summary)
            .join('. ')
            .trim()
        }

        // Source attribution beyond the anchor is a 1.1 problem (semantic
        // retrieval). When the user just tapped a focus-item bullet, we
        // copy the anchor's source_ids onto the assistant message so the
        // iOS client can render tappable receipts under the reply.
        const carriedSourceIds = lastAnchor?.source_ids ?? null
        const { data: saved } = await sb.from('conversation_messages').insert({
          conversation_id: conversationId,
          role: 'assistant',
          content: assistantBuffer,
          source_ids: carriedSourceIds,
          tool_calls: toolCallsLog.length > 0 ? toolCallsLog : null,
        }).select('id').single()
        enqueue('done', {
          id: saved?.id ?? null,
          source_ids: carriedSourceIds ?? [],
          tool_calls: toolCallsLog,
          stop_reason: stopReason,
        })
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
