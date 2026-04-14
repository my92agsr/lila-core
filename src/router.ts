import { logger } from './logger.js'
import { getChatTier } from './db.js'

export type ModelTier = 'haiku' | 'sonnet' | 'opus'

/**
 * Smart model routing: classify incoming messages to pick the cheapest
 * model that can handle them well.
 *
 * Haiku  - greetings, acknowledgments, trivial back-and-forth
 * Sonnet - default for most conversations, tool use, Q&A
 * Opus   - code work, multi-step reasoning, analysis, strategy
 */

// Messages that need zero deep thinking
const TRIVIAL_PATTERNS = [
  /^(hey|hi|hello|yo|sup|thanks|thank you|thx|ok|okay|k|got it|sure|yes|no|yep|nah|nope|cool|nice|great|perfect|awesome|sounds good|word|bet|lol|lmao|haha|gm|gn|morning|night)\.?!?\s*$/i,
  /^(what'?s? up|how'?s? it going|how are you)\??\s*$/i,
  /^[\p{Emoji}\s]{1,10}$/u,
  /^\s*\/?start\s*$/i,
]

// Messages that signal complex reasoning is needed
const COMPLEX_SIGNALS: Array<[RegExp, number]> = [
  // Code work (strong signal)
  [/\b(implement|refactor|debug|fix (the|this|my|a)|build|deploy|scaffold)\b/i, 2],
  [/\b(write (a |the )?(function|class|component|module|script|test|code|feature|endpoint|api|hook))\b/i, 2],
  [/\b(check out|look at|review|audit|examine|evaluate) .*(code|file|repo|codebase|project|implementation)\b/i, 2],

  // Architecture and planning (strong signal)
  [/\b(plan|architect|design|strategy|roadmap)\b/i, 2],

  // Analysis (moderate signal)
  [/\b(analyze|compare|investigate|research|break down|think through)\b/i, 1],
  [/\b(step.by.step|thorough|comprehensive|detailed|in.depth)\b/i, 1],

  // File/code references (moderate signal)
  [/\.(ts|tsx|js|jsx|py|swift|json|yaml|yml|css|html|sql|sh|go|rs|rb)\b/, 1],
  [/```/, 1],
  [/\b(src\/|dist\/|node_modules|package\.json|tsconfig)\b/, 1],

  // System/infra work (moderate signal)
  [/\b(create|set up|configure|install|migrate|provision|deploy)\b/i, 1],
  [/\b(docker|kubernetes|terraform|nginx|systemd|cron|ssh|git)\b/i, 1],
]

export function classifyMessage(message: string): ModelTier {
  const trimmed = message.trim()

  // Strip voice transcription prefix for classification
  const cleaned = trimmed.replace(/^\[Voice transcribed\]:\s*/i, '').trim()

  // Trivial messages → Haiku
  if (cleaned.length < 50) {
    for (const pattern of TRIVIAL_PATTERNS) {
      if (pattern.test(cleaned)) {
        logger.debug({ tier: 'haiku', msg: cleaned.slice(0, 40) }, 'Model routing')
        return 'haiku'
      }
    }
  }

  // Score complexity signals
  let score = 0
  for (const [pattern, weight] of COMPLEX_SIGNALS) {
    if (pattern.test(cleaned)) score += weight
  }

  // Long messages with any complexity signal → Opus
  if (score >= 3 || (score >= 2 && cleaned.length > 200)) {
    logger.debug({ tier: 'opus', score, msg: cleaned.slice(0, 40) }, 'Model routing')
    return 'opus'
  }

  // Very long messages are usually complex requests
  if (cleaned.length > 800) {
    logger.debug({ tier: 'opus', msg: cleaned.slice(0, 40) }, 'Model routing (long)')
    return 'opus'
  }

  // Default → Sonnet
  logger.debug({ tier: 'sonnet', score, msg: cleaned.slice(0, 40) }, 'Model routing')
  return 'sonnet'
}

/**
 * Context-aware classification: applies tier inertia so short messages mid-complex-work
 * don't incorrectly route to Haiku.
 */
export function classifyWithContext(message: string, chatId: string): ModelTier {
  const messageTier = classifyMessage(message)
  const chatTierData = getChatTier(chatId)

  if (chatTierData && messageTier === 'haiku') {
    if (chatTierData.score >= 2.0) {
      logger.debug({ chatId, score: chatTierData.score, original: 'haiku', upgraded: 'sonnet' }, 'Tier inertia: upgrading haiku to sonnet')
      return 'sonnet'
    }
  }

  return messageTier
}

export function modelForTier(tier: ModelTier): string {
  switch (tier) {
    case 'haiku': return 'claude-haiku-4-5'
    case 'sonnet': return 'claude-sonnet-4-6'
    case 'opus': return 'claude-opus-4-6'
  }
}

/** Human-readable label for logging/progress */
export function tierLabel(tier: ModelTier): string {
  switch (tier) {
    case 'haiku': return '⚡ Haiku'
    case 'sonnet': return '🎵 Sonnet'
    case 'opus': return '🎼 Opus'
  }
}
