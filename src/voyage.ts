import { readEnvFile } from './env.js'
import { logger } from './logger.js'

const env = readEnvFile(['VOYAGE_API_KEY'])
const VOYAGE_API_KEY = env.VOYAGE_API_KEY || process.env.VOYAGE_API_KEY

if (!VOYAGE_API_KEY) {
  logger.warn('VOYAGE_API_KEY not found in .env or environment')
}

// voyage-4-large for index-time (1024 dims, max fidelity)
// voyage-4 for query-time (faster, cheaper, same vector space)
const INDEX_MODEL = 'voyage-3-large'
const QUERY_MODEL = 'voyage-3'
const RERANK_MODEL = 'rerank-2'
const VOYAGE_API_URL = 'https://api.voyageai.com/v1'

export interface EmbedResult {
  embedding: Float32Array
  tokens: number
}

export interface RerankResult {
  index: number
  relevanceScore: number
}

/**
 * Call Voyage API directly (avoiding broken npm package)
 */
async function voyageEmbed(texts: string[], model: string, inputType: 'document' | 'query'): Promise<{ embeddings: number[][]; totalTokens: number }> {
  if (!VOYAGE_API_KEY) {
    throw new Error('Voyage API client not initialized - missing VOYAGE_API_KEY')
  }

  const response = await fetch(`${VOYAGE_API_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model,
      input_type: inputType,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Voyage embed failed: ${response.status} ${error}`)
  }

  const data = await response.json() as {
    data: Array<{ embedding: number[] }>
    usage: { total_tokens: number }
  }

  return {
    embeddings: data.data.map(d => d.embedding),
    totalTokens: data.usage.total_tokens,
  }
}

async function voyageRerank(query: string, documents: string[], model: string, topK: number): Promise<Array<{ index: number; relevanceScore: number }>> {
  if (!VOYAGE_API_KEY) {
    throw new Error('Voyage API client not initialized - missing VOYAGE_API_KEY')
  }

  const response = await fetch(`${VOYAGE_API_URL}/rerank`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      documents,
      model,
      top_k: topK,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Voyage rerank failed: ${response.status} ${error}`)
  }

  const data = await response.json() as {
    data: Array<{ index: number; relevance_score: number }>
  }

  return data.data.map(d => ({
    index: d.index,
    relevanceScore: d.relevance_score,
  }))
}

/**
 * Embed text for indexing (uses higher-fidelity model)
 */
export async function embedForIndex(texts: string[]): Promise<EmbedResult[]> {
  const { embeddings, totalTokens } = await voyageEmbed(texts, INDEX_MODEL, 'document')

  return embeddings.map(emb => ({
    embedding: new Float32Array(emb),
    tokens: Math.floor(totalTokens / texts.length),
  }))
}

/**
 * Embed text for querying (uses faster model, same vector space)
 */
export async function embedForQuery(text: string): Promise<EmbedResult> {
  const { embeddings, totalTokens } = await voyageEmbed([text], QUERY_MODEL, 'query')

  return {
    embedding: new Float32Array(embeddings[0]),
    tokens: totalTokens,
  }
}

/**
 * Rerank documents by relevance to query
 */
export async function rerank(
  query: string,
  documents: string[],
  topK = 5
): Promise<RerankResult[]> {
  return voyageRerank(query, documents, RERANK_MODEL, topK)
}

/**
 * Check if Voyage client is available
 */
export function isVoyageAvailable(): boolean {
  return !!VOYAGE_API_KEY
}

/**
 * Chunk text into ~300 token segments (rough approximation: 4 chars per token)
 */
export function chunkText(text: string, maxChars = 1200): string[] {
  const chunks: string[] = []
  const sentences = text.split(/(?<=[.!?])\s+/)
  let current = ''

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current += (current ? ' ' : '') + sentence
    }
  }

  if (current.trim()) {
    chunks.push(current.trim())
  }

  return chunks.length > 0 ? chunks : [text]
}

/**
 * Chunk conversation turn per speaker for finer retrieval
 */
export function chunkConversation(userMsg: string, assistantMsg: string): Array<{ text: string; speaker: 'user' | 'assistant' }> {
  const chunks: Array<{ text: string; speaker: 'user' | 'assistant' }> = []

  for (const chunk of chunkText(userMsg)) {
    chunks.push({ text: chunk, speaker: 'user' })
  }

  for (const chunk of chunkText(assistantMsg)) {
    chunks.push({ text: chunk, speaker: 'assistant' })
  }

  return chunks
}
