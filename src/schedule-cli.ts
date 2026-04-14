import { CronExpressionParser } from 'cron-parser'
import { randomUUID } from 'crypto'
import { initDatabase, createTask, getAllTasks, deleteTask, pauseTask, resumeTask } from './db.js'
import { computeNextRun } from './scheduler.js'

function usage(): void {
  console.log(`
Usage: node dist/schedule-cli.js <command> [args]

Commands:
  create "<prompt>" "<cron>" <chat_id>   Create a new scheduled task
  list                                    List all scheduled tasks
  delete <id>                             Delete a task
  pause <id>                              Pause a task
  resume <id>                             Resume a paused task

Cron examples:
  "0 9 * * *"       Daily at 9am
  "0 9 * * 1"       Every Monday at 9am
  "0 */4 * * *"     Every 4 hours
  "*/30 * * * *"    Every 30 minutes
`)
}

function main(): void {
  initDatabase()

  const [cmd, ...args] = process.argv.slice(2)

  switch (cmd) {
    case 'create': {
      const [prompt, cron, chatId] = args
      if (!prompt || !cron || !chatId) {
        console.error('Usage: create "<prompt>" "<cron>" <chat_id>')
        process.exit(1)
      }
      try {
        CronExpressionParser.parse(cron)
      } catch {
        console.error(`Invalid cron expression: ${cron}`)
        process.exit(1)
      }
      const id = randomUUID().slice(0, 8)
      const nextRun = computeNextRun(cron)
      createTask(id, chatId, prompt, cron, nextRun)
      console.log(`Created task ${id}`)
      console.log(`  Prompt: ${prompt}`)
      console.log(`  Schedule: ${cron}`)
      console.log(`  Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
      break
    }

    case 'list': {
      const tasks = getAllTasks()
      if (tasks.length === 0) {
        console.log('No scheduled tasks.')
        break
      }
      console.log(`${'ID'.padEnd(10)} ${'Status'.padEnd(8)} ${'Next Run'.padEnd(22)} Prompt`)
      console.log('-'.repeat(80))
      for (const t of tasks) {
        const next = new Date(t.next_run * 1000).toLocaleString()
        console.log(`${t.id.padEnd(10)} ${t.status.padEnd(8)} ${next.padEnd(22)} ${t.prompt.slice(0, 40)}`)
      }
      break
    }

    case 'delete': {
      const id = args[0]
      if (!id) { console.error('Usage: delete <id>'); process.exit(1) }
      console.log(deleteTask(id) ? `Deleted task ${id}` : `Task ${id} not found`)
      break
    }

    case 'pause': {
      const id = args[0]
      if (!id) { console.error('Usage: pause <id>'); process.exit(1) }
      console.log(pauseTask(id) ? `Paused task ${id}` : `Task ${id} not found`)
      break
    }

    case 'resume': {
      const id = args[0]
      if (!id) { console.error('Usage: resume <id>'); process.exit(1) }
      console.log(resumeTask(id) ? `Resumed task ${id}` : `Task ${id} not found`)
      break
    }

    default:
      usage()
      process.exit(cmd ? 1 : 0)
  }
}

main()
