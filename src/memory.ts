import { readFileSync, writeFileSync, existsSync } from 'fs'
import {
  searchMemories,
  getRecentMemories,
  touchMemory,
  insertMemory,
  decayMemories as dbDecay,
  insertEmbedding,
  searchEmbeddings,
  getEmbeddingStats,
  getDb,
  getContinuationPrompt,
  clearContinuationPrompt,
  getAllEntities,
  touchEntityMention,
  getActivePlans,
  type MemoryRow,
  type EmbeddingRow,
  type EntityRow,
} from './db.js'
import {
  embedForQuery,
  embedForIndex,
  rerank,
  chunkConversation,
  chunkText,
  isVoyageAvailable,
} from './voyage.js'
import { logger } from './logger.js'

const SEMANTIC_SIGNALS = /\b(my|i am|i'm|i prefer|remember|always|never)\b/i
const REMEMBER_SIGNALS = /\b(remember this|this is important|don't forget|keep this in mind)\b/i

// #1 - Enhanced salience tier signals
const CORRECTION_SIGNALS = /\b(actually|that'?s (not|wrong|incorrect)|to clarify|i meant|wait no|correction)\b/i
const PREFERENCE_SIGNALS = /\b(i (prefer|like|love|hate|always|never)|my (favorite|preferred|go.to)|i don'?t (like|want))\b/i
const DECISION_SIGNALS = /\b(decided|going with|we('ll| will) use|final(ly| answer| decision)|the plan is|confirmed)\b/i

// Use semantic search if Voyage is available, fallback to FTS5
const USE_SEMANTIC = isVoyageAvailable()

// Working memory lives outside the transcript store so it can be edited directly.
export const WORKING_MEMORY_PATH =
  process.env['LILA_WORKING_MEMORY_PATH'] ?? `${process.env.HOME}/.lila/working-memory.md`

export function loadWorkingMemory(): string | null {
  try {
    if (!existsSync(WORKING_MEMORY_PATH)) return null
    return readFileSync(WORKING_MEMORY_PATH, 'utf-8').trim()
  } catch {
    return null
  }
}

export function updateWorkingMemorySection(section: string, newContent: string): boolean {
  try {
    const content = existsSync(WORKING_MEMORY_PATH)
      ? readFileSync(WORKING_MEMORY_PATH, 'utf-8')
      : ''

    // Update the last-updated timestamp
    const now = new Date().toISOString().slice(0, 10)
    let updated = content.replace(/^\*Last updated:.*\*$/m, `*Last updated: ${now}*`)

    // Replace the section content
    const sectionRegex = new RegExp(
      `(## ${section}\\n)([\\s\\S]*?)(?=\\n## |$)`,
      'i'
    )

    if (sectionRegex.test(updated)) {
      updated = updated.replace(sectionRegex, `$1${newContent.trimEnd()}\n\n`)
    } else {
      // Section doesn't exist, append it
      updated = `${updated.trimEnd()}\n\n## ${section}\n${newContent.trimEnd()}\n`
    }

    writeFileSync(WORKING_MEMORY_PATH, updated, 'utf-8')
    return true
  } catch (err) {
    logger.error({ err }, 'Failed to update working memory section')
    return false
  }
}

interface RetrievedMemory {
  chunkText: string
  chunkId?: string
  score: number
  rerankScore?: number
  sourceTable: string
  sourceId: number
  createdAt: string
  sector: string
  speaker?: string
}

/**
 * Build entity context block from entities mentioned in the user message.
 * Fast string matching only -- no LLM call.
 */
function buildEntityContext(userMessage: string): string | null {
  try {
    const allEntities = getAllEntities()
    if (allEntities.length === 0) return null

    const msgLower = userMessage.toLowerCase()
    const matched: EntityRow[] = []

    for (const entity of allEntities) {
      // Check entity name
      if (msgLower.includes(entity.name.toLowerCase())) {
        matched.push(entity)
        touchEntityMention(entity.name)
        continue
      }

      // Check aliases
      try {
        const aliases: string[] = JSON.parse(entity.aliases)
        if (aliases.some(a => msgLower.includes(a.toLowerCase()))) {
          matched.push(entity)
          touchEntityMention(entity.name)
        }
      } catch { /* ignore bad JSON */ }
    }

    if (matched.length === 0) return null

    const lines: string[] = ['<entity-context>']
    for (const entity of matched) {
      const typeLabel = entity.type.charAt(0).toUpperCase() + entity.type.slice(1)
      let factsStr = ''
      try {
        const factsObj = JSON.parse(entity.facts) as Record<string, unknown>
        factsStr = Object.entries(factsObj)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' | ')
      } catch { /* ignore */ }

      let lastMentionStr = ''
      if (entity.last_mentioned) {
        const diffDays = Math.floor((Date.now() / 1000 - entity.last_mentioned) / 86400)
        lastMentionStr = diffDays === 0 ? ' | Last mentioned: today' : ` | Last mentioned: ${diffDays} day${diffDays === 1 ? '' : 's'} ago`
      }

      const notesStr = entity.notes ? ` | Notes: ${entity.notes}` : ''
      const factsDisplay = factsStr ? ` | ${factsStr}` : ''
      lines.push(`[${typeLabel}: ${entity.name}]${factsDisplay}${lastMentionStr}${notesStr}`)
    }
    lines.push('</entity-context>')

    return lines.join('\n')
  } catch (e) {
    logger.warn({ error: e }, 'Entity context build failed')
    return null
  }
}

export async function buildMemoryContext(chatId: string, userMessage: string): Promise<string> {
  const parts: string[] = []

  // Continuation prompt: inject first if present (single-use, clears after injection)
  const continuationPrompt = getContinuationPrompt(chatId)
  if (continuationPrompt) {
    parts.push(`<continuation>\n${continuationPrompt}\n</continuation>`)
    clearContinuationPrompt(chatId)
  }

  // Always-on: working memory (the life model)
  const workingMemory = loadWorkingMemory()
  if (workingMemory) {
    parts.push(`<working-memory>\n${workingMemory}\n</working-memory>`)
  }

  // Entity context: inject profiles for entities mentioned in user message
  const entityBlock = buildEntityContext(userMessage)
  if (entityBlock) {
    parts.push(entityBlock)
  }

  // Active plans context
  const activePlans = getActivePlans()
  if (activePlans.length > 0) {
    const planLines = activePlans.map(({ plan, steps }) => {
      const stepLines = steps.map(s => {
        const statusIcon = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▶' : '○'
        const exec = s.executable ? ' [executable]' : ''
        return `  ${statusIcon} ${s.title}${exec}`
      }).join('\n')
      const due = plan.due_date ? ` (due: ${plan.due_date})` : ''
      return `[Plan: ${plan.title}${due}]\n${stepLines}`
    }).join('\n\n')
    parts.push(`<active-plans>\n${planLines}\n</active-plans>`)
  }

  let semanticResults: RetrievedMemory[] = []
  let ftsResults: Array<{ content: string; sector: string; id: number }> = []

  if (USE_SEMANTIC) {
    try {
      semanticResults = await semanticRetrieve(chatId, userMessage)
      logger.debug({ count: semanticResults.length }, 'Semantic retrieval complete')
    } catch (e) {
      logger.error({ error: e }, 'Semantic retrieval failed')
    }
  }

  // Always get FTS5 results for exact keyword matches
  ftsResults = ftsRetrieve(chatId, userMessage)

  // Merge and deduplicate: prefer semantic ranking, add unique FTS results
  const merged = mergeResults(semanticResults, ftsResults)

  // Touch accessed FTS memories
  for (const m of ftsResults) {
    if (m.id) touchMemory(m.id)
  }

  if (merged.length > 0) {
    parts.push(buildContextBlock(merged))
  }

  return parts.join('\n\n')
}

/**
 * Merge semantic and FTS results, deduplicate by content similarity
 */
function mergeResults(
  semantic: RetrievedMemory[],
  fts: Array<{ content: string; sector: string; id: number }>
): RetrievedMemory[] {
  const results: RetrievedMemory[] = [...semantic]
  const seenTexts = new Set(semantic.map(s => s.chunkText.slice(0, 100)))

  // Add FTS results that aren't already in semantic results
  for (const f of fts) {
    const snippet = f.content.slice(0, 100)
    if (!seenTexts.has(snippet)) {
      seenTexts.add(snippet)
      results.push({
        chunkText: f.content,
        score: 0.5, // Lower score for FTS-only results
        sourceTable: 'memories',
        sourceId: f.id,
        createdAt: new Date().toISOString(),
        sector: f.sector,
      })
    }
  }

  return results.slice(0, 8) // Cap at 8 total results
}

/**
 * Build context block for retrieved memories.
 * High-salience memories (score > 2.0 OR rerankScore > 0.7) surface in a
 * separate <priority-context> block above the normal <memory-context> block.
 */
function buildContextBlock(memories: RetrievedMemory[]): string {
  if (memories.length === 0) return ''

  const priority: RetrievedMemory[] = []
  const normal: RetrievedMemory[] = []

  for (const mem of memories) {
    if (mem.score > 2.0 || (mem.rerankScore !== undefined && mem.rerankScore > 0.7)) {
      priority.push(mem)
    } else {
      normal.push(mem)
    }
  }

  const blocks: string[] = []

  if (priority.length > 0) {
    const lines: string[] = ['<priority-context>']
    for (const mem of priority) {
      const score = mem.rerankScore ?? mem.score
      lines.push(`<memory sector="${mem.sector}" score="${score.toFixed(2)}">${mem.chunkText}</memory>`)
    }
    lines.push('</priority-context>')
    blocks.push(lines.join('\n'))
  }

  if (normal.length > 0) {
    // #6 - XML fencing for clear context boundary
    const lines: string[] = ['<memory-context>']
    for (const mem of normal) {
      const score = mem.rerankScore ?? mem.score
      lines.push(`<memory sector="${mem.sector}" score="${score.toFixed(2)}">${mem.chunkText}</memory>`)
    }
    lines.push('</memory-context>')
    blocks.push(lines.join('\n'))
  }

  return blocks.join('\n\n')
}

/**
 * FTS5 keyword retrieval for exact matches
 */
function ftsRetrieve(chatId: string, query: string): Array<{ content: string; sector: string; id: number }> {
  const ftsResults = searchMemories(query, chatId, 3)
  const recentResults = getRecentMemories(chatId, 5)

  // Deduplicate by id
  const seen = new Set<number>()
  const combined: MemoryRow[] = []
  for (const m of [...ftsResults, ...recentResults]) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      combined.push(m)
    }
  }

  return combined.map(m => ({
    content: m.content,
    sector: m.sector,
    id: m.id,
  }))
}

/**
 * Semantic retrieval with Voyage embeddings + salience weighting + reranking
 */
async function semanticRetrieve(
  chatId: string,
  query: string,
  topK = 5,
  candidateK = 20
): Promise<RetrievedMemory[]> {
  // Step 1: Embed query with voyage-4
  const { embedding } = await embedForQuery(query)

  // Step 2: Vector similarity search via sqlite-vec (top candidateK)
  const rawCandidates = searchEmbeddings(embedding, candidateK, chatId)

  if (rawCandidates.length === 0) {
    // Fall back to recent memories converted to RetrievedMemory format
    const recent = getRecentMemories(chatId, topK)
    return recent.map(m => ({
      chunkText: m.content,
      score: 1.0,
      sourceTable: 'memories',
      sourceId: m.id,
      createdAt: new Date(m.created_at).toISOString(),
      sector: m.sector,
    }))
  }

  // Step 3: Weight by salience
  // sqlite-vec returns L2 distance; convert to similarity-like score
  const candidates: RetrievedMemory[] = rawCandidates.map(c => {
    const similarity = 1.0 / (1.0 + c.distance)
    const weightedScore = similarity * c.salience

    // Parse metadata
    let sector = 'episodic'
    let speaker: string | undefined
    if (c.metadata) {
      try {
        const meta = JSON.parse(c.metadata)
        sector = meta.sector || 'episodic'
        speaker = meta.speaker
      } catch {}
    }

    return {
      chunkText: c.chunk_text,
      chunkId: c.chunk_id,
      score: weightedScore,
      sourceTable: c.source_table,
      sourceId: c.source_id,
      createdAt: c.created_at,
      sector,
      speaker,
    }
  })

  // Sort by weighted score before reranking
  candidates.sort((a, b) => b.score - a.score)

  // Step 4: Rerank with voyage rerank-2.5
  const reranked = await rerank(
    query,
    candidates.map(c => c.chunkText),
    topK
  )

  // Step 5: Map reranked results back to full metadata
  const results: RetrievedMemory[] = []
  for (const r of reranked) {
    const original = candidates[r.index]
    original.rerankScore = r.relevanceScore
    results.push(original)
  }

  return results
}

export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string,
): Promise<void> {
  // Skip very short messages or commands
  if (userMsg.length <= 20 || userMsg.startsWith('/')) return

  // #1 - Enhanced salience tier assignment
  const isCorrection = CORRECTION_SIGNALS.test(userMsg)
  const isPreference = PREFERENCE_SIGNALS.test(userMsg)
  const isDecision = DECISION_SIGNALS.test(userMsg)
  const shouldBoost = REMEMBER_SIGNALS.test(userMsg)

  let sector: 'semantic' | 'episodic' = SEMANTIC_SIGNALS.test(userMsg) ? 'semantic' : 'episodic'
  let salience = 1.0

  if (shouldBoost) {
    salience = 2.0
  } else if (isCorrection) {
    salience = 2.5
    sector = 'semantic' // corrections always go to semantic
  } else if (isPreference) {
    salience = 1.8
    sector = 'semantic' // preferences always go to semantic
  } else if (isDecision) {
    salience = 1.5
  }

  const content = `User: ${userMsg.slice(0, 500)}\nAssistant: ${assistantMsg.slice(0, 500)}`

  // Insert into FTS-backed memories table (keeps backward compatibility)
  insertMemory(chatId, content, sector)

  // Also embed for semantic search if available
  if (USE_SEMANTIC) {
    try {
      await embedConversationTurn(chatId, userMsg, assistantMsg, sector, salience)
    } catch (e) {
      logger.error({ error: e }, 'Failed to embed conversation turn')
    }
  }

  if (shouldBoost) {
    logger.info({ chatId, salience }, 'Boosted memory salience for "remember this" signal')
  } else if (isCorrection) {
    logger.info({ chatId, salience }, 'High-salience memory: correction signal')
  } else if (isPreference) {
    logger.info({ chatId, salience }, 'High-salience memory: preference signal')
  } else if (isDecision) {
    logger.info({ chatId, salience }, 'Elevated-salience memory: decision signal')
  }

  logger.debug({ chatId, sector, salience, semantic: USE_SEMANTIC }, 'Saved conversation turn to memory')
}

/**
 * Embed a conversation turn and store in vector DB
 */
async function embedConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string,
  sector: string,
  salience = 1.0
): Promise<void> {
  const chunks = chunkConversation(userMsg, assistantMsg)
  const sourceId = Date.now() // Use timestamp as source_id for conversations

  // Embed all chunks in one batch call
  const embedResults = await embedForIndex(chunks.map(c => c.text))

  // Store each chunk with its embedding
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const { embedding } = embedResults[i]
    const chunkId = `conversation:${sourceId}:${i}`

    insertEmbedding(
      chunkId,
      'conversation',
      sourceId,
      i,
      chunk.text,
      embedding,
      salience,
      {
        chat_id: chatId,
        speaker: chunk.speaker,
        sector,
        timestamp: new Date().toISOString(),
      }
    )
  }

  logger.debug({ chatId, chunks: chunks.length, salience }, 'Embedded conversation turn')
}

/**
 * Boost salience for important memories
 * Call when user says "remember this" or marks something important
 */
export function boostSalience(sourceId: number, newSalience = 2.0): void {
  const db = getDb()
  db.prepare(`
    UPDATE embeddings SET salience = ?
    WHERE source_table = 'conversation' AND source_id = ?
  `).run(newSalience, sourceId)
  logger.info({ sourceId, newSalience }, 'Boosted memory salience')
}

/**
 * Ingest a document into semantic memory
 * Used for: project specs, system prompts, reference docs
 */
export async function ingestDocument(
  docId: number,
  title: string,
  content: string,
  docType = 'document',
  chatId?: string
): Promise<void> {
  if (!USE_SEMANTIC) {
    logger.warn('Cannot ingest document: Voyage API not available')
    return
  }

  // Chunk with larger windows for documents (~500 tokens = ~2000 chars)
  const maxChars = 2000
  const paragraphs = content.split('\n\n')
  const chunks: string[] = []
  let current = `[${title}]: `

  for (const para of paragraphs) {
    if (current.length + para.length > maxChars && current.length > title.length + 4) {
      chunks.push(current.trim())
      current = `[${title}]: `
    }
    current += para + '\n\n'
  }
  if (current.trim() !== `[${title}]:`) {
    chunks.push(current.trim())
  }

  // Embed all chunks
  const embedResults = await embedForIndex(chunks)

  // Store each chunk
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = `documents:${docId}:${i}`
    insertEmbedding(
      chunkId,
      'documents',
      docId,
      i,
      chunks[i],
      embedResults[i].embedding,
      1.5, // Documents get slightly higher base salience
      {
        doc_type: docType,
        title,
        chat_id: chatId,
      }
    )
  }

  logger.info({ docId, title, chunks: chunks.length }, 'Ingested document into semantic memory')
}

/**
 * Generate consolidation prompt for distilling episodic memories into working memory
 * Run nightly/weekly to prevent context noise
 */
export function generateConsolidationPrompt(recentMemories: RetrievedMemory[]): string {
  const memoryText = recentMemories.map(m => m.chunkText).join('\n\n')

  return `Review these recent conversation memories and extract any updates that should be persisted to working memory files.

Categories:
- Projects: active projects, status updates, decisions made
- People: new contacts, relationship updates, preferences learned
- Corrections: things the user corrected you on, facts to remember
- Journal: significant events, emotional context, recurring themes

Recent memories:
${memoryText}

Return a JSON object with keys matching the categories above.
Only include categories that have actual updates. Be concise.`
}

/**
 * Get recent memories for consolidation
 */
export async function getRecentMemoriesForConsolidation(
  chatId: string,
  days = 7,
  limit = 50
): Promise<RetrievedMemory[]> {
  const db = getDb()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const rows = db.prepare(`
    SELECT * FROM embeddings
    WHERE created_at > ?
    AND json_extract(metadata, '$.chat_id') = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(cutoff, chatId, limit) as EmbeddingRow[]

  return rows.map(r => {
    let sector = 'episodic'
    let speaker: string | undefined
    if (r.metadata) {
      try {
        const meta = JSON.parse(r.metadata)
        sector = meta.sector || 'episodic'
        speaker = meta.speaker
      } catch {}
    }
    return {
      chunkText: r.chunk_text,
      chunkId: r.chunk_id,
      score: r.salience,
      sourceTable: r.source_table,
      sourceId: r.source_id,
      createdAt: r.created_at,
      sector,
      speaker,
    }
  })
}

export function runDecaySweep(): void {
  logger.info('Running memory decay sweep')
  dbDecay()
}

/**
 * Get memory system stats
 */
export function getMemoryStats(): { fts: { total: number }; embeddings: ReturnType<typeof getEmbeddingStats>; semantic: boolean } {
  const embeddingStats = getEmbeddingStats()
  return {
    fts: { total: 0 }, // Could query memories table count
    embeddings: embeddingStats,
    semantic: USE_SEMANTIC,
  }
}
