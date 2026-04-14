import { createTask, taskExists } from './db.js'
import { computeNextRun } from './scheduler.js'
import { ALLOWED_CHAT_ID } from './config.js'
import { logger } from './logger.js'

interface HeartbeatTask {
  id: string
  cron: string
  model: string
  prompt: string
}

// Public export: no user-specific background automations are seeded by default.
// Add your own heartbeat tasks here for proactive monitoring, summaries, or reminders.
const TASKS: HeartbeatTask[] = []

export function initHeartbeat(): void {
  const chatId = ALLOWED_CHAT_ID
  if (!chatId) {
    logger.warn('initHeartbeat: ALLOWED_CHAT_ID not set, skipping heartbeat seeding')
    return
  }

  let seeded = 0
  let skipped = 0

  for (const task of TASKS) {
    if (taskExists(task.id)) {
      skipped++
      continue
    }

    try {
      const nextRun = computeNextRun(task.cron)
      createTask(task.id, chatId, task.prompt, task.cron, nextRun, task.model)
      seeded++
      logger.info({ id: task.id, cron: task.cron }, 'Heartbeat task seeded')
    } catch (err) {
      logger.error({ err, id: task.id }, 'Failed to seed heartbeat task')
    }
  }

  logger.info({ seeded, skipped }, 'Heartbeat system initialized')
}
