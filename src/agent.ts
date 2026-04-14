import { query, type McpSdkServerConfigWithInstance, type Query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

export interface AgentProgress {
  type: 'tool' | 'text'
  toolName?: string
  summary?: string
  text?: string
}

export interface AgentOptions {
  sessionId?: string
  model?: string
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>
  onProgress?: (progress: AgentProgress) => void
}

// Track active queries per chat so /stop can interrupt them
const activeQueries = new Map<string, Query>()

export function stopAgent(chatId: string): boolean {
  const q = activeQueries.get(chatId)
  if (q) {
    q.close()
    activeQueries.delete(chatId)
    logger.info({ chatId }, 'Agent stopped by user')
    return true
  }
  return false
}

export function isAgentRunning(chatId: string): boolean {
  return activeQueries.has(chatId)
}

export async function runAgent(
  message: string,
  opts: AgentOptions & { chatId?: string } = {},
): Promise<{ text: string | null; newSessionId?: string; stopped?: boolean }> {
  const { sessionId, model, mcpServers, onProgress, chatId } = opts
  let newSessionId: string | undefined
  let resultText: string | null = null
  let stopped = false

  try {
    const conversation = query({
      prompt: message,
      options: {
        cwd: PROJECT_ROOT,
        model: model ?? 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user', 'local'],
        ...(mcpServers ? { mcpServers } : {}),
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })

    // Track active query so /stop can kill it
    if (chatId) activeQueries.set(chatId, conversation)

    for await (const event of conversation) {
      switch (event.type) {
        case 'system':
          if (event.subtype === 'init') {
            newSessionId = event.session_id
            logger.debug({ sessionId: newSessionId }, 'Session initialized')
          }
          break

        case 'assistant': {
          // Extract tool use info for progress updates
          const msg = event.message
          if (msg?.content && onProgress) {
            for (const block of msg.content) {
              if (block.type === 'tool_use') {
                onProgress({
                  type: 'tool',
                  toolName: block.name,
                  summary: formatToolSummary(block.name, block.input as Record<string, unknown>),
                })
              }
            }
          }
          break
        }

        case 'result':
          if (event.subtype === 'success') {
            resultText = event.result ?? null
          } else {
            logger.warn({ subtype: event.subtype }, 'Agent returned non-success result')
            if ('errors' in event && Array.isArray(event.errors)) {
              resultText = `Error: ${event.errors.join(', ')}`
            }
          }
          break
      }
    }
  } catch (err) {
    // If stopped by user, don't log as error
    if (chatId && !activeQueries.has(chatId)) {
      stopped = true
      resultText = null
    } else {
      // #7 - Classify error type for better recovery
      const errMsg = String(err)
      const errType = classifyAgentError(errMsg)

      if (errType === 'context_overflow') {
        logger.warn({ err, chatId }, 'Context overflow detected')
        resultText = 'Context window full. Try /newchat to start a fresh session.'
      } else if (errType === 'rate_limit') {
        logger.warn({ err, chatId }, 'Rate limit hit')
        resultText = 'Rate limited. Give it a moment and try again.'
      } else if (errType === 'auth_fail') {
        logger.error({ err, chatId }, 'Auth failure in agent')
        resultText = 'Auth error talking to Anthropic. Check the API key in .env.'
      } else {
        logger.error({ err }, 'Agent query failed')
        resultText = 'Something went wrong running that. Check the logs.'
      }
    }
  } finally {
    if (chatId) activeQueries.delete(chatId)
  }

  return { text: resultText, newSessionId, stopped }
}

type AgentErrorType = 'context_overflow' | 'rate_limit' | 'auth_fail' | 'unknown'

function classifyAgentError(errMsg: string): AgentErrorType {
  const lower = errMsg.toLowerCase()
  if (lower.includes('context') && (lower.includes('length') || lower.includes('window') || lower.includes('too long'))) {
    return 'context_overflow'
  }
  if (lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('429') || lower.includes('overloaded')) {
    return 'rate_limit'
  }
  if (lower.includes('401') || lower.includes('403') || lower.includes('authentication') || lower.includes('api key') || lower.includes('unauthorized')) {
    return 'auth_fail'
  }
  return 'unknown'
}

function formatToolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return `Reading ${basename(String(input.file_path ?? ''))}`
    case 'Edit':
      return `Editing ${basename(String(input.file_path ?? ''))}`
    case 'Write':
      return `Writing ${basename(String(input.file_path ?? ''))}`
    case 'Bash':
      return `Running command`
    case 'Grep':
      return `Searching for "${String(input.pattern ?? '').slice(0, 40)}"`
    case 'Glob':
      return `Finding files: ${String(input.pattern ?? '').slice(0, 40)}`
    case 'WebSearch':
      return `Searching: ${String(input.query ?? '').slice(0, 50)}`
    case 'WebFetch':
      return `Fetching URL`
    case 'Agent':
      return `Spawning subagent`
    default:
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__')
        return `Using ${parts.slice(1, -1).join(' ')}`
      }
      return `Using ${toolName}`
  }
}

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}
