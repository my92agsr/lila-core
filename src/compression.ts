import { query } from '@anthropic-ai/claude-agent-sdk'
import { getMemoriesSince, insertMemory, clearSession, getDb, saveContinuationPrompt } from './db.js'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

/**
 * Context compression: when a session gets long, summarize the conversation
 * into a high-salience memory and start fresh. The summary persists as
 * semantic memory so the next session picks up where we left off.
 *
 * Inspired by Hermes's context_compressor, adapted for the Agent SDK.
 */

const TURN_THRESHOLD = 25
const turnCounts = new Map<string, number>()

export function incrementTurns(chatId: string): number {
  const count = (turnCounts.get(chatId) ?? 0) + 1
  turnCounts.set(chatId, count)
  return count
}

export function resetTurns(chatId: string): void {
  turnCounts.delete(chatId)
}

export function getTurnCount(chatId: string): number {
  return turnCounts.get(chatId) ?? 0
}

export function shouldCompress(chatId: string): boolean {
  return (turnCounts.get(chatId) ?? 0) >= TURN_THRESHOLD
}

/**
 * Compress the current session into a summary memory, then clear the session.
 * Returns the summary text, or null if compression wasn't possible.
 */
export async function compressAndReset(chatId: string): Promise<string | null> {
  const recent = getMemoriesSince(chatId, 8, 40) // last 8 hours, up to 40 memories
  if (recent.length < 3) {
    // Not enough to summarize meaningfully, just clear
    clearSession(chatId)
    resetTurns(chatId)
    logger.info({ chatId }, 'Session cleared (too few memories to compress)')
    return null
  }

  const memoryText = recent
    .map((m) => {
      const date = new Date(m.created_at * 1000).toLocaleString()
      return `[${date}] ${m.content}`
    })
    .join('\n---\n')

  try {
    // Use Haiku via Agent SDK for fast, cheap summarization
    let summary: string | null = null

    // Check for existing session summary to do incremental update
    const db = getDb()
    const prevSummary = db
      .prepare(
        "SELECT content FROM memories WHERE chat_id = ? AND topic_key = 'session_summary' ORDER BY created_at DESC LIMIT 1"
      )
      .get(chatId) as { content: string } | undefined

    const incrementalContext = prevSummary
      ? `\nPrevious session summary (update this, don't repeat it):\n${prevSummary.content}\n`
      : ''

    // #3 - Structured compression template
    const conversation = query({
      prompt: `You are compressing a long conversation into a structured session summary. Do NOT use any tools. Just analyze and summarize.

${incrementalContext}
New conversation to integrate:
${memoryText}

Return a structured summary using EXACTLY these sections (omit any section with nothing to report):

## Active Work
What's currently being worked on — specific projects, files, features, tasks in progress.

## Decisions Made
Concrete decisions, choices, or conclusions reached (with enough detail to recall them).

## Open Threads
Unresolved questions, pending tasks, things to follow up on.

## Key Context
Important facts, preferences, corrections, or background that should carry forward.

Be specific: include names, file paths, technical details. Keep each section tight — bullets preferred.`,
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
        summary = event.result ?? null
      }
    }

    if (summary) {
      // Save as high-salience semantic memory
      insertMemory(chatId, `[Session summary] ${summary}`, 'semantic', 'session_summary')

      // Boost salience so it surfaces in future context retrieval
      const d = getDb()
      const latest = d
        .prepare(
          "SELECT id FROM memories WHERE chat_id = ? AND topic_key = 'session_summary' ORDER BY created_at DESC LIMIT 1"
        )
        .get(chatId) as { id: number } | undefined

      if (latest) {
        d.prepare('UPDATE memories SET salience = 3.0 WHERE id = ?').run(latest.id)
      }

      // Generate a 1-sentence continuation prompt so the next session doesn't cold-start
      let continuationText: string | null = null
      const continuationConversation = query({
        prompt: `Based on the session summary below, write exactly ONE sentence describing what was mid-flight — what was being actively worked on and what immediate next step is pending. Format: "We were [doing X] in [file/project Y]; [Z] is still pending."

Session summary:
${summary}

Return only the single sentence. No preamble.`,
        options: {
          cwd: PROJECT_ROOT,
          model: 'claude-haiku-4-5',
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
        },
      })

      for await (const event of continuationConversation) {
        if (event.type === 'result' && event.subtype === 'success') {
          continuationText = event.result ?? null
        }
      }

      if (continuationText) {
        saveContinuationPrompt(chatId, continuationText.trim())
        logger.info({ chatId, continuationText: continuationText.slice(0, 120) }, 'Continuation prompt saved')
      }
    }

    clearSession(chatId)
    resetTurns(chatId)

    logger.info(
      { chatId, memories: recent.length, summary: summary?.slice(0, 120) },
      'Session compressed and cleared'
    )

    return summary
  } catch (err) {
    logger.error({ err }, 'Compression failed, clearing session without summary')
    clearSession(chatId)
    resetTurns(chatId)
    return null
  }
}
