import { Bot, Context, InputFile } from 'grammy'
import { readFileSync } from 'fs'
import { basename as pathBasename } from 'path'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
} from './config.js'
import { getSession, setSession, clearSession, getMemoriesForChat, createTask, getAllTasks, deleteTask, pauseTask, resumeTask, logConversation, getAllConversations, updateChatTier } from './db.js'
import { runAgent, stopAgent, isAgentRunning, type AgentProgress } from './agent.js'
import { buildMemoryContext, saveConversationTurn, ingestDocument } from './memory.js'
import { classifyMessage, classifyWithContext, modelForTier, tierLabel } from './router.js'
import { incrementTurns, shouldCompress, compressAndReset, resetTurns } from './compression.js'
import { transcribeAudio, textToSpeech, voiceCapabilities } from './voice.js'
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, buildVideoMessage } from './media.js'
import { createLilaTools } from './tools.js'
import { computeNextRun } from './scheduler.js'
import { CronExpressionParser } from 'cron-parser'
import { randomUUID } from 'crypto'
import { logger } from './logger.js'

// --- Telegram formatting ---

export function formatForTelegram(text: string): string {
  // Extract code blocks and protect them
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.trimEnd())
    const tag = lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`
    codeBlocks.push(tag)
    return `\x00CODE${codeBlocks.length - 1}\x00`
  })

  // Inline code
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    codeBlocks.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00CODE${codeBlocks.length - 1}\x00`
  })

  // Escape HTML in remaining text (but not inside our placeholders)
  const parts = result.split(/(\x00CODE\d+\x00)/)
  result = parts.map(part => {
    if (part.startsWith('\x00CODE')) return part
    return escapeHtmlText(part)
  }).join('')

  // Headings
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')

  // Italic
  result = result.replace(/\*(.+?)\*/g, '<i>$1</i>')
  result = result.replace(/_(.+?)_/g, '<i>$1</i>')

  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Checkboxes
  result = result.replace(/- \[ \]/g, '☐')
  result = result.replace(/- \[x\]/g, '☑')

  // Strip horizontal rules
  result = result.replace(/^[-*]{3,}$/gm, '')

  // Restore code blocks
  result = result.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)])

  return result.trim()
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > limit) {
    let splitIdx = remaining.lastIndexOf('\n', limit)
    if (splitIdx === -1 || splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf(' ', limit)
    }
    if (splitIdx === -1 || splitIdx < limit * 0.3) {
      splitIdx = limit
    }
    chunks.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx).trimStart()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

function isAuthorised(chatId: number): boolean {
  if (!ALLOWED_CHAT_ID) return true
  return String(chatId) === ALLOWED_CHAT_ID
}

// --- Progress message manager ---

class ProgressMessage {
  private messageId: number | null = null
  private currentText = ''
  private steps: string[] = []
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private pendingUpdate = false
  private readonly chatId: number
  private readonly api: Bot['api']
  private readonly minInterval = 2000 // Telegram rate limit guard

  constructor(chatId: number, api: Bot['api']) {
    this.chatId = chatId
    this.api = api
  }

  async addStep(step: string): Promise<void> {
    this.steps.push(step)
    this.pendingUpdate = true
    await this.flush()
  }

  private async flush(): Promise<void> {
    if (!this.pendingUpdate) return

    // Debounce: don't edit faster than minInterval
    if (this.updateTimer) return
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null
      if (this.pendingUpdate) this.flush()
    }, this.minInterval)

    this.pendingUpdate = false
    const text = this.steps.map(s => `${s}`).join('\n')

    try {
      if (!this.messageId) {
        const msg = await this.api.sendMessage(this.chatId, text)
        this.messageId = msg.message_id
      } else if (text !== this.currentText) {
        await this.api.editMessageText(this.chatId, this.messageId, text)
      }
      this.currentText = text
    } catch (err) {
      logger.debug({ err }, 'Progress message update failed')
    }
  }

  async finish(): Promise<void> {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer)
      this.updateTimer = null
    }
    // Delete progress message when done
    if (this.messageId) {
      try {
        await this.api.deleteMessage(this.chatId, this.messageId)
      } catch {
        // ignore
      }
    }
  }
}

// Voice mode tracking
const voiceModeChats = new Set<string>()

async function handleMessage(
  ctx: Context,
  rawText: string,
  bot: Bot,
  forceVoiceReply = false,
): Promise<void> {
  const chatId = String(ctx.chat!.id)
  const numericChatId = ctx.chat!.id

  if (!isAuthorised(numericChatId)) {
    await ctx.reply(`Unauthorized. Your chat ID is ${numericChatId}`)
    return
  }

  // Route to the right model based on message complexity (with tier inertia)
  const tier = classifyWithContext(rawText, chatId)
  const model = modelForTier(tier)

  // Build memory context
  const memoryContext = await buildMemoryContext(chatId, rawText)
  const fullMessage = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText

  // Log user message to conversation history
  logConversation(chatId, 'user', rawText)

  // Get existing session
  const sessionId = getSession(chatId)

  // Create MCP tools with access to this chat
  const lilaTools = createLilaTools({
    sendMessage: async (targetChatId: string, text: string) => {
      const formatted = formatForTelegram(text)
      const chunks = splitMessage(formatted)
      for (const chunk of chunks) {
        try {
          await bot.api.sendMessage(Number(targetChatId), chunk, { parse_mode: 'HTML' })
        } catch {
          await bot.api.sendMessage(Number(targetChatId), chunk.replace(/<[^>]+>/g, ''))
        }
      }
    },
    chatId,
  })

  // Progress tracking
  const progress = new ProgressMessage(numericChatId, bot.api)
  let toolCount = 0

  // Start typing indicator
  const typingInterval = setInterval(async () => {
    try {
      await bot.api.sendChatAction(numericChatId, 'typing')
    } catch { /* ignore */ }
  }, TYPING_REFRESH_MS)

  try {
    await bot.api.sendChatAction(numericChatId, 'typing')

    const { text, newSessionId, stopped } = await runAgent(fullMessage, {
      sessionId,
      model,
      chatId,
      mcpServers: { 'lila-tools': lilaTools },
      onProgress: (p: AgentProgress) => {
        if (p.type === 'tool' && p.summary) {
          toolCount++
          // Only show progress after 2+ tool uses (short tasks don't need it)
          if (toolCount >= 2) {
            progress.addStep(p.summary)
          }
        }
      },
    })

    clearInterval(typingInterval)
    await progress.finish()

    // If user sent /stop, don't send any response
    if (stopped) return

    // Update per-chat tier score for inertia tracking
    updateChatTier(chatId, tier)

    // Update session
    if (newSessionId) {
      setSession(chatId, newSessionId)
    }

    if (!text) {
      await ctx.reply('(no response)')
      return
    }

    // Log assistant response and save to memory
    logConversation(chatId, 'assistant', text)
    await saveConversationTurn(chatId, rawText, text)

    // Track turns and auto-compress if session is getting long
    incrementTurns(chatId)
    if (shouldCompress(chatId)) {
      // Run compression in background so it doesn't block the response
      compressAndReset(chatId).catch(err =>
        logger.error({ err }, 'Background compression failed')
      )
    }

    // Check if we should send voice reply
    const shouldSendVoice = forceVoiceReply || voiceModeChats.has(chatId)

    if (shouldSendVoice) {
      try {
        await bot.api.sendChatAction(numericChatId, 'record_voice')
        const audioPath = await textToSpeech(text)
        if (audioPath) {
          await ctx.replyWithVoice(new InputFile(audioPath))
          const formatted = formatForTelegram(text)
          const chunks = splitMessage(formatted)
          for (const chunk of chunks) {
            try {
              await ctx.reply(chunk, { parse_mode: 'HTML' })
            } catch {
              await ctx.reply(chunk.replace(/<[^>]+>/g, ''))
            }
          }
          return
        }
      } catch (err) {
        logger.error({ err }, 'TTS failed, falling back to text')
      }
    }

    // Send text response
    const formatted = formatForTelegram(text)
    const chunks = splitMessage(formatted)

    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: 'HTML' })
      } catch {
        await ctx.reply(chunk.replace(/<[^>]+>/g, ''))
      }
    }
  } catch (err) {
    clearInterval(typingInterval)
    await progress.finish()
    logger.error({ err, chatId }, 'Message handling failed')
    await ctx.reply('Something went wrong. Check logs.')
  }
}

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN not set. Run npm run setup or add it to .env')
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN)

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id
    await ctx.reply(
      `Hey! Lila is running.\n\nYour chat ID: <code>${chatId}</code>\n\nCommands:\n/newchat \u2014 Start fresh session\n/stop \u2014 Stop current task\n/memory \u2014 View recent memories\n/voice \u2014 Toggle voice replies\n/schedule \u2014 Manage scheduled tasks\n/ingest &lt;path&gt; \u2014 Embed file into memory\n/export \u2014 Export conversation history\n/chatid \u2014 Show your chat ID`,
      { parse_mode: 'HTML' },
    )
  })

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Your chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' })
  })

  bot.command('newchat', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return
    clearSession(chatId)
    resetTurns(chatId)
    await ctx.reply('Session cleared. Starting fresh.')
  })

  bot.command('forget', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return
    clearSession(chatId)
    resetTurns(chatId)
    await ctx.reply('Session cleared. Starting fresh.')
  })

  bot.command('stop', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return
    if (stopAgent(chatId)) {
      await ctx.reply('Stopped.')
    } else {
      await ctx.reply('Nothing running.')
    }
  })

  bot.command('memory', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return
    const memories = getMemoriesForChat(chatId, 10)
    if (memories.length === 0) {
      await ctx.reply('No memories stored yet.')
      return
    }
    const lines = memories.map((m, i) =>
      `${i + 1}. [${m.sector}] ${m.content.slice(0, 120)}... (salience: ${m.salience.toFixed(2)})`
    )
    await ctx.reply(lines.join('\n\n'))
  })

  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return
    const caps = voiceCapabilities()
    if (!caps.tts) {
      await ctx.reply('TTS is not configured. Voice replies are not available.')
      return
    }
    if (voiceModeChats.has(chatId)) {
      voiceModeChats.delete(chatId)
      await ctx.reply('Voice replies disabled.')
    } else {
      voiceModeChats.add(chatId)
      await ctx.reply('Voice replies enabled.')
    }
  })

  bot.command('schedule', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return

    const text = ctx.message?.text ?? ''
    const parts = text.replace(/^\/schedule\s*/, '').trim()

    if (!parts || parts === 'list') {
      const tasks = getAllTasks()
      if (tasks.length === 0) {
        await ctx.reply('No scheduled tasks.\n\nCreate one:\n/schedule create "prompt" "cron"')
        return
      }
      const lines = tasks.map(t => {
        const next = new Date(t.next_run * 1000).toLocaleString()
        return `<b>${t.id}</b> [${t.status}]\n${t.prompt.slice(0, 80)}\nNext: ${next}`
      })
      await ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML' })
      return
    }

    const createMatch = parts.match(/^create\s+"([^"]+)"\s+"([^"]+)"$/i)
    if (createMatch) {
      const [, prompt, cron] = createMatch
      try {
        CronExpressionParser.parse(cron)
      } catch {
        await ctx.reply(`Invalid cron: ${cron}`)
        return
      }
      const id = randomUUID().slice(0, 8)
      const nextRun = computeNextRun(cron)
      createTask(id, chatId, prompt, cron, nextRun)
      await ctx.reply(`Task created: ${id}\nNext run: ${new Date(nextRun * 1000).toLocaleString()}`)
      return
    }

    const deleteMatch = parts.match(/^delete\s+(\S+)$/i)
    if (deleteMatch) {
      await ctx.reply(deleteTask(deleteMatch[1]) ? 'Deleted.' : 'Not found.')
      return
    }

    const pauseMatch = parts.match(/^pause\s+(\S+)$/i)
    if (pauseMatch) {
      await ctx.reply(pauseTask(pauseMatch[1]) ? 'Paused.' : 'Not found.')
      return
    }

    const resumeMatch = parts.match(/^resume\s+(\S+)$/i)
    if (resumeMatch) {
      await ctx.reply(resumeTask(resumeMatch[1]) ? 'Resumed.' : 'Not found.')
      return
    }

    await ctx.reply('Usage:\n/schedule list\n/schedule create "prompt" "0 9 * * *"\n/schedule delete <id>\n/schedule pause <id>\n/schedule resume <id>')
  })

  // #8 - /ingest <filepath> — embed a file into semantic memory
  bot.command('ingest', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return

    const filePath = ctx.message?.text?.replace(/^\/ingest\s*/, '').trim()
    if (!filePath) {
      await ctx.reply('Usage: /ingest /path/to/file.md')
      return
    }

    try {
      const content = readFileSync(filePath, 'utf-8')
      const title = pathBasename(filePath)
      const docId = Date.now()
      await ctx.reply(`Ingesting "${title}" (${content.length} chars)...`)
      await ingestDocument(docId, title, content, 'document', chatId)
      await ctx.reply(`Done. "${title}" is now in semantic memory.`)
    } catch (err) {
      logger.error({ err, filePath }, '/ingest failed')
      await ctx.reply(`Failed to ingest: ${err instanceof Error ? err.message : err}`)
    }
  })

  // #10 - /export — dump conversation history as JSONL file
  bot.command('export', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return

    try {
      const rows = getAllConversations(chatId)
      if (rows.length === 0) {
        await ctx.reply('No conversation history to export.')
        return
      }

      const jsonl = rows
        .map(r => JSON.stringify({
          id: r.id,
          role: r.role,
          content: r.content,
          timestamp: new Date(r.created_at * 1000).toISOString(),
        }))
        .join('\n')

      const buf = Buffer.from(jsonl, 'utf-8')
      const filename = `lila-export-${new Date().toISOString().slice(0, 10)}.jsonl`
      await ctx.replyWithDocument(new InputFile(buf, filename), {
        caption: `${rows.length} messages exported.`,
      })
    } catch (err) {
      logger.error({ err }, '/export failed')
      await ctx.reply('Export failed. Check logs.')
    }
  })

  // Text messages
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return
    await handleMessage(ctx, ctx.message.text, bot)
  })

  // Voice messages
  bot.on('message:voice', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return

    const caps = voiceCapabilities()
    if (!caps.stt) {
      await ctx.reply('Voice transcription is not configured.')
      return
    }

    try {
      await ctx.api.sendChatAction(ctx.chat.id, 'typing')
      const fileId = ctx.message.voice.file_id
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, fileId, 'voice.oga')
      const transcript = await transcribeAudio(localPath)
      await handleMessage(ctx, `[Voice transcribed]: ${transcript}`, bot, true)
    } catch (err) {
      logger.error({ err }, 'Voice handling failed')
      await ctx.reply('Failed to transcribe voice message.')
    }
  })

  // Photos
  bot.on('message:photo', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    try {
      const photos = ctx.message.photo
      const largest = photos[photos.length - 1]
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, largest.file_id, 'photo.jpg')
      const message = buildPhotoMessage(localPath, ctx.message.caption)
      await handleMessage(ctx, message, bot)
    } catch (err) {
      logger.error({ err }, 'Photo handling failed')
      await ctx.reply('Failed to process photo.')
    }
  })

  // Documents
  bot.on('message:document', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    try {
      const doc = ctx.message.document
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, doc.file_id, doc.file_name)
      const message = buildDocumentMessage(localPath, doc.file_name ?? 'document', ctx.message.caption)
      await handleMessage(ctx, message, bot)
    } catch (err) {
      logger.error({ err }, 'Document handling failed')
      await ctx.reply('Failed to process document.')
    }
  })

  // Video
  bot.on('message:video', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    try {
      const video = ctx.message.video
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, video.file_id, 'video.mp4')
      const message = buildVideoMessage(localPath, ctx.message.caption)
      await handleMessage(ctx, message, bot)
    } catch (err) {
      logger.error({ err }, 'Video handling failed')
      await ctx.reply('Failed to process video.')
    }
  })

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, 'Bot error')
  })

  return bot
}
