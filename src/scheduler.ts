import { CronExpressionParser } from 'cron-parser'
import { getDueTasks, updateTaskAfterRun } from './db.js'
import { runAgent } from './agent.js'
import { createLilaTools } from './tools.js'
import { logger } from './logger.js'

type Sender = (chatId: string, text: string) => Promise<void>

let sender: Sender | null = null
let intervalHandle: ReturnType<typeof setInterval> | null = null

export function computeNextRun(cronExpression: string): number {
  const next = CronExpressionParser.parse(cronExpression).next()
  return Math.floor(next.getTime() / 1000)
}

export async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks()
  if (tasks.length === 0) return

  logger.info({ count: tasks.length }, 'Running due scheduled tasks')

  for (const task of tasks) {
    try {
      const lilaTools = sender
        ? createLilaTools({ sendMessage: sender, chatId: task.chat_id })
        : undefined

      const { text } = await runAgent(task.prompt, {
        ...(task.model ? { model: task.model } : {}),
        ...(lilaTools ? { mcpServers: { 'lila-tools': lilaTools } } : {}),
      })
      const result = text ?? '(no output)'

      const nextRun = computeNextRun(task.schedule)
      updateTaskAfterRun(task.id, result.slice(0, 10000), nextRun)

      // Only send result if the agent didn't already handle delivery
      // (agents with send_telegram_message in their prompt handle their own output)
      const agentHandledDelivery = task.prompt.toLowerCase().includes('send_telegram_message')
      if (!agentHandledDelivery && sender) {
        await sender(task.chat_id, result)
      }

      logger.info({ taskId: task.id, nextRun }, 'Scheduled task completed')
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Scheduled task failed')
      if (sender) {
        await sender(task.chat_id, `Scheduled task failed: "${task.prompt.slice(0, 50)}". Check logs.`)
      }
    }
  }
}

export function initScheduler(send: Sender): void {
  sender = send
  intervalHandle = setInterval(runDueTasks, 60_000)
  logger.info('Scheduler started (60s polling)')

  // Run once immediately to catch anything overdue
  runDueTasks().catch(err => logger.error({ err }, 'Initial scheduler run failed'))
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
