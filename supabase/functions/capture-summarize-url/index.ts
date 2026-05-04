// POST /capture/summarize-url
// Body: { capture_id, url }
// Returns: { bookmark_id }
//
// Fetches the URL (best-effort, 5s timeout), runs Sonnet to summarize,
// inserts a bookmark row, points the capture at it.

import { authenticate, scopedSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'
import { anthropic, MODELS } from '../_shared/client.ts'
import { shapeBookmarkSystem, shapeBookmarkUser } from '../_shared/prompts/shape_bookmark.ts'
import { parseJsonObject } from '../_shared/json.ts'

interface Body { capture_id: string; url: string }

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req)
  if (!body.url) throw new HttpError(400, 'url required')

  const sb = scopedSupabase(userId)
  const { data: profile } = await sb.raw.from('profiles').select('first_name').eq('id', userId).single()
  const firstName = profile?.first_name ?? 'there'

  const pageContent = await fetchPageText(body.url).catch(() => null)

  const r = await anthropic.messages.create({
    model: MODELS.sonnet,
    max_tokens: 512,
    system: [{ type: 'text', text: shapeBookmarkSystem(firstName), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: shapeBookmarkUser(body.url, pageContent ?? undefined) }],
  })
  const text = (r.content[0] as any).text as string
  const shaped = parseJsonObject<{ url?: string; title?: string | null; summary?: string | null }>(text)

  const { data: bookmark, error } = await sb.from('bookmarks').insert({
    url: shaped.url ?? body.url,
    title: shaped.title ?? null,
    summary: shaped.summary ?? null,
    source_capture_id: body.capture_id,
  }).select('id').single()
  if (error) throw new HttpError(500, `bookmark insert failed: ${error.message}`)

  if (body.capture_id) {
    await sb.from('captures').update({
      shaped_status: 'shaped',
      shaped_into_table: 'bookmarks',
      shaped_into_id: bookmark!.id,
    }).eq('id', body.capture_id)
  }

  return jsonResponse({ bookmark_id: bookmark!.id })
}))

async function fetchPageText(url: string): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('text/') && !ct.includes('application/xhtml')) return null
    const html = await res.text()
    return stripHtml(html).slice(0, 16000)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
