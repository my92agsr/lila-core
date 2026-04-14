import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { PROJECT_ROOT, STORE_DIR, TELEGRAM_BOT_TOKEN } from './config.js'
import { initDatabase, decayMemories, decayTierScores } from './db.js'
import { createBot, splitMessage } from './bot.js'
import { initScheduler } from './scheduler.js'
import { initHeartbeat } from './heartbeat.js'
import { cleanupOldUploads } from './media.js'
import { runDecaySweep } from './memory.js'
import { runConsolidation, shouldConsolidate } from './consolidation.js'
import { startDashboard } from './dashboard.js'
import { logger } from './logger.js'

const BANNER = `
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
`

const PID_FILE = join(STORE_DIR, 'lila.pid')

function acquireLock(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true })
  }

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (oldPid && !isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0) // check if alive
        logger.warn({ oldPid }, 'Killing stale process with SIGTERM')
        process.kill(oldPid, 'SIGTERM')

        // Try for up to 1 second for graceful shutdown
        for (let i = 0; i < 10; i++) {
          try {
            process.kill(oldPid, 0)
            // Still alive, sleep and retry
            execSync('sleep 0.1')
          } catch {
            // Dead, break early
            break
          }
        }

        // If still alive, use SIGKILL
        try {
          process.kill(oldPid, 0)
          logger.warn({ oldPid }, 'SIGTERM failed, using SIGKILL')
          process.kill(oldPid, 'SIGKILL')
        } catch {
          // Already dead, all good
        }
      } catch {
        // Process not alive, stale PID file
      }
    }
  }

  writeFileSync(PID_FILE, String(process.pid))
}

function releaseLock(): void {
  try {
    unlinkSync(PID_FILE)
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  console.log(BANNER)

  // Check required config
  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN not set. Run: npm run setup')
    process.exit(1)
  }

  // Acquire PID lock
  acquireLock()

  // Initialize database
  initDatabase()

  // Run initial memory decay sweep
  runDecaySweep()
  // Schedule daily decay (memory + tier scores)
  setInterval(() => {
    runDecaySweep()
    decayTierScores()
  }, 24 * 60 * 60 * 1000)

  // Memory consolidation: distill episodic memories into semantic facts
  // Run on startup if overdue, then every 12 hours
  if (shouldConsolidate()) {
    runConsolidation().catch(err => logger.error({ err }, 'Startup consolidation failed'))
  }
  setInterval(async () => {
    if (shouldConsolidate()) {
      await runConsolidation().catch(err => logger.error({ err }, 'Scheduled consolidation failed'))
    }
  }, 12 * 60 * 60 * 1000)

  // Clean up old uploads
  cleanupOldUploads()

  // Create bot
  const bot = createBot()

  // Build shared send function for scheduler + heartbeat
  const sendToChat = async (chatId: string, text: string) => {
    try {
      const chunks = splitMessage(text)
      for (const chunk of chunks) {
        await bot.api.sendMessage(Number(chatId), chunk)
      }
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send message')
    }
  }

  // Initialize scheduler
  initScheduler(sendToChat)

  // Initialize proactive heartbeat system
  initHeartbeat()

  // Start Life Helm dashboard
  startDashboard()

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...')
    try {
      await bot.stop()
    } catch { /* ignore */ }
    releaseLock()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Start bot
  try {
    logger.info('Lila running')
    await bot.start()
  } catch (err) {
    logger.error({ err }, 'Bot failed to start. Check TELEGRAM_BOT_TOKEN in .env')
    releaseLock()
    process.exit(1)
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error')
  releaseLock()
  process.exit(1)
})
