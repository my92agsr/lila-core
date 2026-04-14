import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  getDb,
  getMemoriesSince,
  insertMemory,
  upsertEntity,
  type MemoryRow,
} from './db.js'
import { ALLOWED_CHAT_ID, PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

interface ConsolidationResult {
  projects?: string[]
  people?: string[]
  preferences?: string[]
  corrections?: string[]
  journal?: string[]
}

/**
 * Track when consolidation last ran
 */
function initConsolidationTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS consolidation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at INTEGER NOT NULL,
      memories_processed INTEGER NOT NULL,
      facts_extracted INTEGER NOT NULL,
      raw_output TEXT
    )
  `)
}

function getLastConsolidationTime(): number {
  const row = getDb()
    .prepare('SELECT ran_at FROM consolidation_log ORDER BY ran_at DESC LIMIT 1')
    .get() as { ran_at: number } | undefined
  return row?.ran_at ?? 0
}

function logConsolidation(memoriesProcessed: number, factsExtracted: number, rawOutput: string): void {
  const now = Math.floor(Date.now() / 1000)
  getDb()
    .prepare('INSERT INTO consolidation_log (ran_at, memories_processed, facts_extracted, raw_output) VALUES (?, ?, ?, ?)')
    .run(now, memoriesProcessed, factsExtracted, rawOutput)
}

/**
 * Fetch episodic memories since last consolidation
 */
function getUnconsolidatedMemories(): MemoryRow[] {
  const lastRun = getLastConsolidationTime()
  const chatId = ALLOWED_CHAT_ID

  if (lastRun === 0) {
    // First run: grab last 3 days
    return getMemoriesSince(chatId, 72, 100)
  }

  // Get everything since last consolidation
  const cutoff = lastRun
  return getDb()
    .prepare(
      "SELECT * FROM memories WHERE chat_id = ? AND created_at > ? AND sector = 'episodic' ORDER BY created_at ASC LIMIT 100"
    )
    .all(chatId, cutoff) as MemoryRow[]
}

/**
 * Build the consolidation prompt with embedded memories
 */
function buildConsolidationPrompt(memories: MemoryRow[]): string {
  const memoryText = memories
    .map((m) => {
      const date = new Date(m.created_at * 1000).toISOString().split('T')[0]
      return `[${date}] ${m.content}`
    })
    .join('\n\n---\n\n')

  return `You are running a memory consolidation pass. Do NOT use any tools. Just analyze the conversation logs below and return a JSON object.

Extract durable facts from these recent conversations that would be useful weeks or months from now.

Categories:
- "projects": Active projects, status updates, decisions made, deadlines. Format: "ProjectName: fact"
- "people": People mentioned, relationships, preferences, contact info. Format: "PersonName: fact"
- "preferences": User preferences, habits, routines, opinions learned. Format: clear statement
- "corrections": Things the user corrected the assistant on. Format: clear statement
- "journal": Significant life events, emotional context, recurring themes. Format: brief note with date

Rules:
- Only extract facts useful long-term. Skip small talk and transient coordination.
- Each fact = one concise sentence.
- Omit empty categories entirely.
- Focus on the user's life, work, and preferences, not what Lila said.

Recent conversations:
${memoryText}

Return ONLY valid JSON (no markdown, no explanation):
{"projects":[],"people":[],"preferences":[],"corrections":[],"journal":[]}

If nothing worth extracting, return: {}`
}

/**
 * Send memories through the agent SDK for distillation
 */
async function distillMemories(memories: MemoryRow[]): Promise<ConsolidationResult> {
  const prompt = buildConsolidationPrompt(memories)

  let resultText: string | null = null

  const conversation = query({
    prompt,
    options: {
      cwd: PROJECT_ROOT,
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1, // No tool use, just one response
    },
  })

  for await (const event of conversation) {
    if (event.type === 'result' && event.subtype === 'success') {
      resultText = event.result ?? null
    }
  }

  if (!resultText) {
    logger.warn('Consolidation returned no result')
    return {}
  }

  // Parse JSON from response (handle markdown code blocks)
  const jsonMatch = resultText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    logger.warn({ text: resultText.slice(0, 200) }, 'Consolidation returned no parseable JSON')
    return {}
  }

  try {
    return JSON.parse(jsonMatch[0]) as ConsolidationResult
  } catch (e) {
    logger.error({ error: e, text: jsonMatch[0].slice(0, 200) }, 'Failed to parse consolidation JSON')
    return {}
  }
}

/**
 * Write extracted facts back into semantic memory
 */
function persistFacts(result: ConsolidationResult): number {
  const chatId = ALLOWED_CHAT_ID
  let count = 0

  const categories: Array<[keyof ConsolidationResult, string]> = [
    ['projects', 'project'],
    ['people', 'people'],
    ['preferences', 'preference'],
    ['corrections', 'correction'],
    ['journal', 'journal'],
  ]

  for (const [key, topicKey] of categories) {
    const raw = result[key]
    if (!raw) continue

    // Flatten: handle both ["fact"] and {"SubKey": ["fact"]} shapes
    let facts: string[] = []
    if (Array.isArray(raw)) {
      facts = raw
    } else if (typeof raw === 'object') {
      for (const subFacts of Object.values(raw as Record<string, string[]>)) {
        if (Array.isArray(subFacts)) facts.push(...subFacts)
      }
    }

    for (const fact of facts) {
      if (!fact || fact.trim().length < 5) continue

      // Check for near-duplicates before inserting
      const existing = getDb()
        .prepare(
          "SELECT id FROM memories WHERE chat_id = ? AND sector = 'semantic' AND content LIKE ? LIMIT 1"
        )
        .get(chatId, `%${fact.slice(0, 50)}%`) as { id: number } | undefined

      if (existing) {
        logger.debug({ fact: fact.slice(0, 60) }, 'Skipping duplicate semantic memory')
        continue
      }

      insertMemory(chatId, `[${topicKey}] ${fact}`, 'semantic', topicKey)
      count++
    }
  }

  return count
}

interface EntityExtraction {
  name: string
  type: string
  facts: Record<string, unknown>
  notes?: string
}

/**
 * Extract entities from a batch of new semantic memories using Haiku
 */
async function extractEntitiesFromMemories(facts: string[]): Promise<void> {
  if (facts.length === 0) return

  const memoryText = facts.join('\n')

  const prompt = `Given this text, extract any specific people, projects, places, or organizations mentioned. For each one return a JSON array like:
[{"name": "Jordan", "type": "person", "facts": {"role": "teacher", "school": "the user's school"}, "notes": "had lunch last Tuesday"}]

Valid types: person, project, place, org, other

Text: ${memoryText}

Return ONLY the JSON array, nothing else. Return [] if no entities found.`

  let resultText: string | null = null

  try {
    const conversation = query({
      prompt,
      options: {
        cwd: PROJECT_ROOT,
        model: 'claude-haiku-4-5',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
      },
    })

    for await (const event of conversation) {
      if (event.type === 'result' && event.subtype === 'success') {
        resultText = event.result ?? null
      }
    }

    if (!resultText) return

    const jsonMatch = resultText.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return

    const entities = JSON.parse(jsonMatch[0]) as EntityExtraction[]

    for (const entity of entities) {
      if (!entity.name || !entity.type) continue
      const validTypes = ['person', 'project', 'place', 'org', 'other']
      const type = validTypes.includes(entity.type) ? entity.type : 'other'
      upsertEntity(entity.name, type, entity.facts ?? {}, entity.notes)
    }

    logger.info({ count: entities.length }, 'Entity extraction complete')
  } catch (e) {
    logger.warn({ error: e }, 'Entity extraction failed (non-fatal)')
  }
}

/**
 * Run the full consolidation pipeline
 */
export async function runConsolidation(): Promise<{ processed: number; extracted: number }> {
  initConsolidationTable()

  const memories = getUnconsolidatedMemories()

  if (memories.length < 3) {
    logger.info({ count: memories.length }, 'Too few memories to consolidate, skipping')
    return { processed: 0, extracted: 0 }
  }

  logger.info({ count: memories.length }, 'Starting memory consolidation')

  try {
    const result = await distillMemories(memories)
    const rawOutput = JSON.stringify(result)
    logger.info({ result: rawOutput }, 'Consolidation distillation output')
    const factsExtracted = persistFacts(result)

    // Extract entities from the new semantic memories (non-blocking, non-fatal)
    const allNewFacts: string[] = []
    for (const key of ['projects', 'people', 'preferences', 'corrections', 'journal'] as const) {
      const raw = result[key]
      if (Array.isArray(raw)) allNewFacts.push(...raw)
    }
    await extractEntitiesFromMemories(allNewFacts)

    logConsolidation(memories.length, factsExtracted, rawOutput)

    logger.info(
      { processed: memories.length, extracted: factsExtracted },
      'Memory consolidation complete'
    )

    return { processed: memories.length, extracted: factsExtracted }
  } catch (e) {
    logger.error({ error: e, message: (e as Error)?.message, stack: (e as Error)?.stack }, 'Memory consolidation failed')
    return { processed: 0, extracted: 0 }
  }
}

/**
 * Check if consolidation should run (at least 12 hours since last run)
 */
export function shouldConsolidate(): boolean {
  initConsolidationTable()
  const lastRun = getLastConsolidationTime()
  const hoursSince = (Date.now() / 1000 - lastRun) / 3600
  return hoursSince >= 12
}
