#!/usr/bin/env npx tsx
/**
 * Backfill existing memories with Voyage embeddings
 * Run once to migrate FTS-only memories to semantic search
 *
 * Usage: npx tsx scripts/backfill-embeddings.ts
 */

import { getDb, initDatabase, insertEmbedding, type MemoryRow } from '../src/db.js'
import { embedForIndex, chunkText, isVoyageAvailable } from '../src/voyage.js'
import { logger } from '../src/logger.js'

const BATCH_SIZE = 10 // Embed 10 memories at a time to respect rate limits

async function backfillEmbeddings() {
  if (!isVoyageAvailable()) {
    console.error('VOYAGE_API_KEY not set. Cannot backfill embeddings.')
    process.exit(1)
  }

  initDatabase()
  const db = getDb()

  // Get all memories that don't have embeddings yet
  const memories = db.prepare(`
    SELECT m.*
    FROM memories m
    LEFT JOIN embeddings e ON e.source_table = 'memories' AND e.source_id = m.id
    WHERE e.id IS NULL
    ORDER BY m.created_at DESC
  `).all() as MemoryRow[]

  console.log(`Found ${memories.length} memories to backfill`)

  if (memories.length === 0) {
    console.log('Nothing to backfill!')
    return
  }

  let processed = 0
  let failed = 0

  // Process in batches
  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE)

    // Prepare all chunks for this batch
    const allChunks: Array<{
      memory: MemoryRow
      chunkIndex: number
      text: string
    }> = []

    for (const memory of batch) {
      const chunks = chunkText(memory.content)
      for (let j = 0; j < chunks.length; j++) {
        allChunks.push({
          memory,
          chunkIndex: j,
          text: chunks[j],
        })
      }
    }

    try {
      // Embed all chunks in batch
      const embedResults = await embedForIndex(allChunks.map(c => c.text))

      // Store each embedding
      for (let j = 0; j < allChunks.length; j++) {
        const { memory, chunkIndex, text } = allChunks[j]
        const { embedding } = embedResults[j]
        const chunkId = `memories:${memory.id}:${chunkIndex}`

        insertEmbedding(
          chunkId,
          'memories',
          memory.id,
          chunkIndex,
          text,
          embedding,
          memory.salience,
          {
            chat_id: memory.chat_id,
            sector: memory.sector,
            topic_key: memory.topic_key,
            original_created_at: memory.created_at,
          }
        )
      }

      processed += batch.length
      console.log(`Processed ${processed}/${memories.length} memories (${allChunks.length} chunks)`)

      // Small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 200))
    } catch (e) {
      console.error(`Failed to process batch starting at ${i}:`, e)
      failed += batch.length
    }
  }

  console.log(`\nBackfill complete!`)
  console.log(`  Processed: ${processed}`)
  console.log(`  Failed: ${failed}`)
  console.log(`  Total embeddings: ${db.prepare('SELECT COUNT(*) as count FROM embeddings').get()}`)
}

backfillEmbeddings().catch(e => {
  console.error('Backfill failed:', e)
  process.exit(1)
})
