import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(join(STORE_DIR, 'lila.db'))
    db.pragma('journal_mode = WAL')
    // Load sqlite-vec extension for vector operations
    sqliteVec.load(db)
    logger.info('sqlite-vec extension loaded')
  }
  return db
}

export function initDatabase(): void {
  const d = getDb()

  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Full memory system
  d.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content_rowid='id'
    )
  `)

  // Triggers to keep FTS in sync
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)

  // Scheduler
  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run)
  `)

  // Heartbeat event log
  d.exec(`
    CREATE TABLE IF NOT EXISTS heartbeat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      surfaced_at INTEGER NOT NULL
    )
  `)
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_heartbeat_log ON heartbeat_log(trigger_id, surfaced_at)
  `)

  // Plans system
  d.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed','archived')),
      due_date TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','skipped')),
      executable INTEGER NOT NULL DEFAULT 0,
      due_date TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, sort_order)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)`)

  // Add continuation_prompt column to sessions (migration-safe)
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN continuation_prompt TEXT')
  } catch {
    // Column already exists on subsequent startups
  }

  // Per-chat conversation tier tracking (tier inertia)
  d.exec(`
    CREATE TABLE IF NOT EXISTS conversation_tiers (
      chat_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'sonnet',
      tier_score REAL NOT NULL DEFAULT 0.0,
      last_updated INTEGER NOT NULL
    )
  `)

  // Conversation log for searchable history
  initConversationLog()

  // Bookmarks
  initBookmarks()

  // Embeddings for semantic search (Voyage 4)
  initEmbeddings()

  // Structured entity graph
  initEntities()

  logger.info('Database initialized')
}

// --- Sessions ---

export function getSession(chatId: string): string | undefined {
  const row = getDb().prepare('SELECT session_id FROM sessions WHERE chat_id = ?').get(chatId) as { session_id: string } | undefined
  return row?.session_id
}

export function setSession(chatId: string, sessionId: string): void {
  getDb().prepare(
    'INSERT INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at'
  ).run(chatId, sessionId, Math.floor(Date.now() / 1000))
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// --- Continuation Prompts ---

export function saveContinuationPrompt(chatId: string, text: string): void {
  getDb().prepare(
    'INSERT INTO sessions (chat_id, session_id, updated_at, continuation_prompt) VALUES (?, \'\', ?, ?) ON CONFLICT(chat_id) DO UPDATE SET continuation_prompt = excluded.continuation_prompt, updated_at = excluded.updated_at'
  ).run(chatId, Math.floor(Date.now() / 1000), text)
}

export function getContinuationPrompt(chatId: string): string | null {
  const row = getDb().prepare('SELECT continuation_prompt FROM sessions WHERE chat_id = ?').get(chatId) as { continuation_prompt: string | null } | undefined
  return row?.continuation_prompt ?? null
}

export function clearContinuationPrompt(chatId: string): void {
  getDb().prepare('UPDATE sessions SET continuation_prompt = NULL WHERE chat_id = ?').run(chatId)
}

// --- Conversation Tier Tracking ---

export function getChatTier(chatId: string): { tier: string; score: number } | null {
  const row = getDb().prepare('SELECT tier, tier_score FROM conversation_tiers WHERE chat_id = ?').get(chatId) as { tier: string; tier_score: number } | undefined
  if (!row) return null
  return { tier: row.tier, score: row.tier_score }
}

export function updateChatTier(chatId: string, tier: string): void {
  const increment = tier === 'haiku' ? 0 : tier === 'sonnet' ? 1 : 2
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO conversation_tiers (chat_id, tier, tier_score, last_updated) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET tier = excluded.tier, tier_score = MIN(tier_score + ?, 10.0), last_updated = excluded.last_updated'
  ).run(chatId, tier, increment, now, increment)
}

export function decayTierScores(): void {
  const db = getDb()
  db.prepare('UPDATE conversation_tiers SET tier_score = tier_score * 0.7').run()
  const deleted = db.prepare('DELETE FROM conversation_tiers WHERE tier_score < 0.5').run()
  if (deleted.changes > 0) {
    logger.info({ deleted: deleted.changes }, 'Decayed tier scores pruned')
  }
}

// --- Memories ---

export interface MemoryRow {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: string
  salience: number
  created_at: number
  accessed_at: number
}

export function insertMemory(chatId: string, content: string, sector: 'semantic' | 'episodic', topicKey?: string): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, 1.0, ?, ?)'
  ).run(chatId, topicKey ?? null, content, sector, now, now)
}

export function searchMemories(query: string, chatId: string, limit = 3): MemoryRow[] {
  const sanitized = query.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean).map(w => w + '*').join(' ')
  if (!sanitized) return []
  try {
    return getDb().prepare(
      `SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.content MATCH ? AND m.chat_id = ? ORDER BY rank LIMIT ?`
    ).all(sanitized, chatId, limit) as MemoryRow[]
  } catch {
    return []
  }
}

export function getRecentMemories(chatId: string, limit = 5): MemoryRow[] {
  return getDb().prepare(
    'SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?'
  ).all(chatId, limit) as MemoryRow[]
}

export function getMemoriesSince(chatId: string, sinceHours = 24, limit = 50): MemoryRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - (sinceHours * 3600)
  return getDb().prepare(
    'SELECT * FROM memories WHERE chat_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?'
  ).all(chatId, cutoff, limit) as MemoryRow[]
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?'
  ).run(now, id)
}

export function decayMemories(): void {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400
  const db = getDb()
  // #9 - Differentiated decay: episodic fades faster, semantic persists longer
  db.prepare("UPDATE memories SET salience = salience * 0.98 WHERE sector = 'episodic' AND created_at < ?").run(oneDayAgo)
  db.prepare("UPDATE memories SET salience = salience * 0.995 WHERE sector = 'semantic' AND created_at < ?").run(oneDayAgo)
  const deleted = db.prepare('DELETE FROM memories WHERE salience < 0.1').run()
  if (deleted.changes > 0) {
    logger.info({ deleted: deleted.changes }, 'Decayed memories pruned')
  }
}

export function getMemoriesForChat(chatId: string, limit = 20): MemoryRow[] {
  return getDb().prepare(
    'SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?'
  ).all(chatId, limit) as MemoryRow[]
}

export function deleteMemoriesForChat(chatId: string): void {
  getDb().prepare('DELETE FROM memories WHERE chat_id = ?').run(chatId)
}

// --- Scheduled Tasks ---

export interface TaskRow {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: string
  model: string | null
  created_at: number
}

export function createTask(id: string, chatId: string, prompt: string, schedule: string, nextRun: number, model?: string): void {
  const now = Math.floor(Date.now() / 1000)
  // Ensure model column exists (migration for existing DBs)
  try { getDb().exec('ALTER TABLE scheduled_tasks ADD COLUMN model TEXT') } catch { /* already exists */ }
  getDb().prepare(
    'INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, chatId, prompt, schedule, nextRun, 'active', model ?? null, now)
}

export function getDueTasks(): TaskRow[] {
  const now = Math.floor(Date.now() / 1000)
  return getDb().prepare(
    "SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?"
  ).all(now) as TaskRow[]
}

export function updateTaskAfterRun(id: string, lastResult: string, nextRun: number): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'UPDATE scheduled_tasks SET last_run = ?, last_result = ?, next_run = ? WHERE id = ?'
  ).run(now, lastResult, nextRun, id)
}

export function getAllTasks(): TaskRow[] {
  return getDb().prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as TaskRow[]
}

export function deleteTask(id: string): boolean {
  return getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0
}

export function pauseTask(id: string): boolean {
  return getDb().prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id).changes > 0
}

export function resumeTask(id: string): boolean {
  return getDb().prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id).changes > 0
}

// --- Conversation Log (full searchable history) ---

export interface ConversationLogRow {
  id: number
  chat_id: string
  role: string
  content: string
  created_at: number
}

function initConversationLog(): void {
  const d = getDb()

  d.exec(`
    CREATE TABLE IF NOT EXISTS conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_log_fts USING fts5(
      content,
      content_rowid='id'
    )
  `)

  // FTS sync triggers
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS convo_log_ai AFTER INSERT ON conversation_log BEGIN
      INSERT INTO conversation_log_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS convo_log_ad AFTER DELETE ON conversation_log BEGIN
      INSERT INTO conversation_log_fts(conversation_log_fts, rowid, content) VALUES('delete', old.id, old.content);
    END
  `)

  d.exec(`CREATE INDEX IF NOT EXISTS idx_convo_log_chat ON conversation_log(chat_id, created_at)`)
}

export function logConversation(chatId: string, role: 'user' | 'assistant', content: string): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO conversation_log (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(chatId, role, content, now)
}

export function searchConversations(searchQuery: string, chatId: string, limit = 10): ConversationLogRow[] {
  const sanitized = searchQuery
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w + '*')
    .join(' ')
  if (!sanitized) return []

  try {
    return getDb().prepare(`
      SELECT c.* FROM conversation_log c
      JOIN conversation_log_fts f ON c.id = f.rowid
      WHERE f.content MATCH ? AND c.chat_id = ?
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(sanitized, chatId, limit) as ConversationLogRow[]
  } catch {
    return []
  }
}

export function getRecentConversations(chatId: string, limit = 20): ConversationLogRow[] {
  return getDb().prepare(
    'SELECT * FROM conversation_log WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(chatId, limit) as ConversationLogRow[]
}

export function getAllConversations(chatId: string): ConversationLogRow[] {
  return getDb().prepare(
    'SELECT * FROM conversation_log WHERE chat_id = ? ORDER BY created_at ASC'
  ).all(chatId) as ConversationLogRow[]
}

// --- Bookmarks ---

export interface BookmarkRow {
  id: number
  url: string
  title: string | null
  tags: string | null
  notes: string | null
  created_at: number
}

export function initBookmarks(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      title TEXT,
      tags TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL
    )
  `)
}

export function addBookmark(url: string, title?: string, tags?: string[], notes?: string): number {
  const now = Math.floor(Date.now() / 1000)
  const tagStr = tags?.join(',') ?? null
  const result = getDb().prepare(
    'INSERT INTO bookmarks (url, title, tags, notes, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET title = excluded.title, tags = excluded.tags, notes = excluded.notes'
  ).run(url, title ?? null, tagStr, notes ?? null, now)
  return result.lastInsertRowid as number
}

export function searchBookmarks(query: string): BookmarkRow[] {
  const pattern = `%${query}%`
  return getDb().prepare(
    'SELECT * FROM bookmarks WHERE url LIKE ? OR title LIKE ? OR tags LIKE ? OR notes LIKE ? ORDER BY created_at DESC'
  ).all(pattern, pattern, pattern, pattern) as BookmarkRow[]
}

export function getAllBookmarks(limit = 50): BookmarkRow[] {
  return getDb().prepare('SELECT * FROM bookmarks ORDER BY created_at DESC LIMIT ?').all(limit) as BookmarkRow[]
}

export function deleteBookmark(id: number): boolean {
  return getDb().prepare('DELETE FROM bookmarks WHERE id = ?').run(id).changes > 0
}

// --- Embeddings (Voyage 4 semantic search) ---

export interface EmbeddingRow {
  id: number
  chunk_id: string
  source_table: string
  source_id: number
  chunk_index: number
  chunk_text: string
  embedding: Buffer
  salience: number
  created_at: string
  metadata: string | null
}

export function initEmbeddings(): void {
  const d = getDb()

  // Main embeddings table
  d.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL UNIQUE,
      source_table TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      chunk_text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      salience REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `)

  d.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_table, source_id)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_created ON embeddings(created_at)`)

  // Virtual table for vector similarity search (voyage-3-large = 1024 dims)
  try {
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
        embedding float[1024]
      )
    `)
  } catch (e) {
    // Table may already exist
    logger.debug('vec_embeddings table already exists or creation skipped')
  }

  // Mapping table to link embeddings.id to vec_embeddings.rowid
  // (sqlite-vec doesn't allow explicit rowid on insert)
  d.exec(`
    CREATE TABLE IF NOT EXISTS embedding_vec_map (
      embedding_id INTEGER PRIMARY KEY,
      vec_rowid INTEGER NOT NULL
    )
  `)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_vec_map_rowid ON embedding_vec_map(vec_rowid)`)

  logger.info('Embeddings tables initialized')
}

export function insertEmbedding(
  chunkId: string,
  sourceTable: string,
  sourceId: number,
  chunkIndex: number,
  chunkText: string,
  embedding: Float32Array,
  salience = 1.0,
  metadata?: Record<string, unknown>
): number {
  const d = getDb()
  const embeddingBuffer = Buffer.from(embedding.buffer)
  const metadataJson = metadata ? JSON.stringify(metadata) : null

  const result = d.prepare(`
    INSERT INTO embeddings (chunk_id, source_table, source_id, chunk_index, chunk_text, embedding, salience, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      chunk_text = excluded.chunk_text,
      embedding = excluded.embedding,
      salience = excluded.salience,
      metadata = excluded.metadata
  `).run(chunkId, sourceTable, sourceId, chunkIndex, chunkText, embeddingBuffer, salience, metadataJson)

  // Get the embedding id (handle both insert and update cases)
  let embeddingId: number
  if (result.changes > 0 && result.lastInsertRowid) {
    embeddingId = Number(result.lastInsertRowid)
  } else {
    // If it was an update, fetch the existing id
    const existing = d.prepare('SELECT id FROM embeddings WHERE chunk_id = ?').get(chunkId) as { id: number } | undefined
    embeddingId = existing?.id ?? 0
  }

  if (embeddingId > 0) {
    // Delete any existing vector entry for this embedding id
    d.prepare('DELETE FROM vec_embeddings WHERE rowid IN (SELECT vec_rowid FROM embedding_vec_map WHERE embedding_id = ?)').run(embeddingId)
    d.prepare('DELETE FROM embedding_vec_map WHERE embedding_id = ?').run(embeddingId)

    // Insert into vector index (sqlite-vec auto-generates rowid)
    const vecResult = d.prepare('INSERT INTO vec_embeddings(embedding) VALUES (?)').run(embedding)
    const vecRowid = Number(vecResult.lastInsertRowid)

    // Store the mapping
    d.prepare('INSERT INTO embedding_vec_map (embedding_id, vec_rowid) VALUES (?, ?)').run(embeddingId, vecRowid)
  }

  return embeddingId
}

export function searchEmbeddings(
  queryEmbedding: Float32Array,
  limit = 20,
  chatId?: string
): Array<EmbeddingRow & { distance: number }> {
  const d = getDb()

  // Vector similarity search with mapping table
  // sqlite-vec requires k=? in WHERE clause, not LIMIT on outer query
  const sql = `
    SELECT
      e.*,
      v.distance
    FROM vec_embeddings v
    JOIN embedding_vec_map m ON m.vec_rowid = v.rowid
    JOIN embeddings e ON e.id = m.embedding_id
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
  `

  const results = d.prepare(sql).all(queryEmbedding, limit) as Array<EmbeddingRow & { distance: number }>

  // Filter by chat_id if provided (stored in metadata)
  if (chatId) {
    return results.filter(r => {
      if (!r.metadata) return false
      try {
        const meta = JSON.parse(r.metadata)
        return meta.chat_id === chatId
      } catch {
        return false
      }
    })
  }

  return results
}

export function getEmbeddingsForSource(sourceTable: string, sourceId: number): EmbeddingRow[] {
  return getDb().prepare(
    'SELECT * FROM embeddings WHERE source_table = ? AND source_id = ? ORDER BY chunk_index'
  ).all(sourceTable, sourceId) as EmbeddingRow[]
}

export function deleteEmbeddingsForSource(sourceTable: string, sourceId: number): void {
  const d = getDb()
  // Get ids first for vec_embeddings cleanup
  const rows = d.prepare('SELECT id FROM embeddings WHERE source_table = ? AND source_id = ?').all(sourceTable, sourceId) as Array<{ id: number }>

  for (const row of rows) {
    d.prepare('DELETE FROM vec_embeddings WHERE rowid = ?').run(row.id)
  }
  d.prepare('DELETE FROM embeddings WHERE source_table = ? AND source_id = ?').run(sourceTable, sourceId)
}

// --- Heartbeat Log ---

export function logHeartbeatEvent(triggerId: string, eventKey: string): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO heartbeat_log (trigger_id, event_key, surfaced_at) VALUES (?, ?, ?)'
  ).run(triggerId, eventKey, now)
}

export function getHeartbeatLog(triggerId: string, hours = 48): Array<{ event_key: string; surfaced_at: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600
  return getDb().prepare(
    'SELECT event_key, surfaced_at FROM heartbeat_log WHERE trigger_id = ? AND surfaced_at > ? ORDER BY surfaced_at DESC'
  ).all(triggerId, cutoff) as Array<{ event_key: string; surfaced_at: number }>
}

export function taskExists(id: string): boolean {
  const row = getDb().prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(id)
  return row !== undefined
}

// --- Entities ---

export interface EntityRow {
  id: number
  name: string
  type: string
  aliases: string  // JSON array
  facts: string    // JSON object
  notes: string | null
  last_mentioned: number | null
  created_at: number
  updated_at: number
}

function initEntities(): void {
  const d = getDb()

  d.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'person' CHECK(type IN ('person','project','place','org','other')),
      aliases TEXT DEFAULT '[]',
      facts TEXT NOT NULL DEFAULT '{}',
      notes TEXT,
      last_mentioned INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  d.exec(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`)
}

export function upsertEntity(name: string, type: string, facts: Record<string, unknown>, notes?: string): void {
  const now = Math.floor(Date.now() / 1000)
  const d = getDb()

  const existing = d.prepare('SELECT * FROM entities WHERE name = ?').get(name) as EntityRow | undefined

  if (existing) {
    // Merge facts
    let existingFacts: Record<string, unknown> = {}
    try { existingFacts = JSON.parse(existing.facts) } catch { /* ignore */ }
    const mergedFacts = Object.assign({}, existingFacts, facts)

    // Append notes if provided
    let newNotes = existing.notes
    if (notes) {
      newNotes = existing.notes ? `${existing.notes}\n${notes}` : notes
    }

    d.prepare(
      'UPDATE entities SET type = ?, facts = ?, notes = ?, updated_at = ?, last_mentioned = ? WHERE name = ?'
    ).run(type, JSON.stringify(mergedFacts), newNotes, now, now, name)
  } else {
    d.prepare(
      'INSERT INTO entities (name, type, aliases, facts, notes, last_mentioned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name, type, '[]', JSON.stringify(facts), notes ?? null, now, now, now)
  }
}

export function getEntity(name: string): EntityRow | null {
  const d = getDb()

  // Check by name directly
  const direct = d.prepare('SELECT * FROM entities WHERE name = ?').get(name) as EntityRow | undefined
  if (direct) return direct

  // Check aliases (case-insensitive)
  const all = d.prepare('SELECT * FROM entities').all() as EntityRow[]
  const nameLower = name.toLowerCase()
  for (const entity of all) {
    try {
      const aliases: string[] = JSON.parse(entity.aliases)
      if (aliases.some(a => a.toLowerCase() === nameLower)) return entity
    } catch { /* ignore */ }
  }

  return null
}

export function getAllEntities(type?: string): EntityRow[] {
  if (type) {
    return getDb().prepare('SELECT * FROM entities WHERE type = ? ORDER BY name').all(type) as EntityRow[]
  }
  return getDb().prepare('SELECT * FROM entities ORDER BY name').all() as EntityRow[]
}

export function deleteEntity(name: string): boolean {
  return getDb().prepare('DELETE FROM entities WHERE name = ?').run(name).changes > 0
}

export function touchEntityMention(name: string): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare('UPDATE entities SET last_mentioned = ? WHERE name = ?').run(now, name)
}

export function getEmbeddingStats(): { total: number; bySource: Record<string, number> } {
  const d = getDb()
  const total = (d.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number }).count
  const bySourceRows = d.prepare('SELECT source_table, COUNT(*) as count FROM embeddings GROUP BY source_table').all() as Array<{ source_table: string; count: number }>
  const bySource: Record<string, number> = {}
  for (const row of bySourceRows) {
    bySource[row.source_table] = row.count
  }
  return { total, bySource }
}

// --- Plans ---

export interface PlanRow {
  id: string
  title: string
  description: string | null
  status: string
  due_date: string | null
  created_at: number
  updated_at: number
}

export interface PlanStepRow {
  id: string
  plan_id: string
  title: string
  description: string | null
  status: string
  executable: number
  due_date: string | null
  sort_order: number
  completed_at: number | null
  created_at: number
}

export function createPlan(title: string, description?: string, dueDate?: string): string {
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO plans (id, title, description, status, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, title, description ?? null, 'active', dueDate ?? null, now, now)
  return id
}

export function addPlanStep(planId: string, title: string, opts?: { description?: string; executable?: boolean; dueDate?: string; sortOrder?: number }): string {
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO plan_steps (id, plan_id, title, description, status, executable, due_date, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    planId,
    title,
    opts?.description ?? null,
    'pending',
    opts?.executable ? 1 : 0,
    opts?.dueDate ?? null,
    opts?.sortOrder ?? 0,
    now
  )
  return id
}

export function updatePlanStep(stepId: string, status: 'pending' | 'in_progress' | 'done' | 'skipped'): void {
  const now = Math.floor(Date.now() / 1000)
  const completedAt = status === 'done' ? now : null
  getDb().prepare(
    'UPDATE plan_steps SET status = ?, completed_at = ? WHERE id = ?'
  ).run(status, completedAt, stepId)
}

export function updatePlan(planId: string, updates: Partial<{ title: string; status: string; description: string; due_date: string }>): void {
  const now = Math.floor(Date.now() / 1000)
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [now]
  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title) }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status) }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description) }
  if (updates.due_date !== undefined) { fields.push('due_date = ?'); values.push(updates.due_date) }
  values.push(planId)
  getDb().prepare(`UPDATE plans SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function getPlan(planId: string): { plan: PlanRow; steps: PlanStepRow[] } | null {
  const d = getDb()
  const plan = d.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow | undefined
  if (!plan) return null
  const steps = d.prepare('SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY sort_order').all(planId) as PlanStepRow[]
  return { plan, steps }
}

export function getActivePlans(): { plan: PlanRow; steps: PlanStepRow[] }[] {
  const d = getDb()
  const plans = d.prepare("SELECT * FROM plans WHERE status = 'active' ORDER BY created_at DESC").all() as PlanRow[]
  return plans.map(plan => {
    const steps = d.prepare('SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY sort_order').all(plan.id) as PlanStepRow[]
    return { plan, steps }
  })
}

export function deletePlan(planId: string): boolean {
  return getDb().prepare('DELETE FROM plans WHERE id = ?').run(planId).changes > 0
}
