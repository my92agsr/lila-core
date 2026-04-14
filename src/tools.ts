import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { CronExpressionParser } from 'cron-parser'
import { createTask, searchConversations, logHeartbeatEvent, getHeartbeatLog, upsertEntity, getEntity, getAllEntities, deleteEntity, createPlan, addPlanStep, getPlan, getActivePlans, updatePlanStep, updatePlan } from './db.js'
import { buildMemoryContext, loadWorkingMemory, updateWorkingMemorySection } from './memory.js'
import { computeNextRun } from './scheduler.js'
import { logger } from './logger.js'
import { readEnvFile } from './env.js'

const _env = readEnvFile()
if (_env['EXA_API_KEY']) process.env['EXA_API_KEY'] = _env['EXA_API_KEY']
if (_env['FIRECRAWL_API_KEY']) process.env['FIRECRAWL_API_KEY'] = _env['FIRECRAWL_API_KEY']

const execFileAsync = promisify(execFile)

const GMAIL_SCRIPT = `${process.env.HOME}/.claude/skills/gmail/gmail.js`
const CALENDAR_SCRIPT = `${process.env.HOME}/.claude/skills/google-calendar/calendar.js`

async function runSkillScript(script: string, args: string[], timeoutMs = 15000): Promise<string> {
  const { stdout, stderr } = await execFileAsync('node', [script, ...args], {
    timeout: timeoutMs,
    env: { ...process.env },
  })
  if (stderr) logger.debug({ stderr: stderr.slice(0, 200) }, 'Skill script stderr')
  return stdout.trim()
}

export type ChatSender = (chatId: string, text: string) => Promise<void>

export function createLilaTools(opts: {
  sendMessage: ChatSender
  chatId: string
}) {
  const server = createSdkMcpServer({
    name: 'lila-tools',
    version: '1.0.0',
    tools: [
      tool(
        'send_telegram_message',
        'Send a proactive message to the configured chat transport. Use this to notify, update, or surface information without being asked.',
        {
          message: z.string().describe('The message text to send'),
        },
        async ({ message }) => {
          try {
            await opts.sendMessage(opts.chatId, message)
            return { content: [{ type: 'text' as const, text: 'Message sent.' }] }
          } catch (err) {
            logger.error({ err }, 'send_telegram_message failed')
            return { content: [{ type: 'text' as const, text: `Failed to send: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'set_reminder',
        'Set a reminder or scheduled task. The prompt will be executed by an agent at the scheduled time and the result sent through the configured chat transport.',
        {
          prompt: z.string().describe('What to do when the reminder fires. This gets executed by an agent.'),
          delay_minutes: z.number().optional().describe('Minutes from now for a one-time reminder. Mutually exclusive with cron.'),
          cron: z.string().optional().describe('Cron expression for recurring tasks (e.g. "0 9 * * *" for daily 9am). Mutually exclusive with delay_minutes.'),
          label: z.string().optional().describe('Short label for the task'),
          model: z.string().optional().describe('Model to use for this task. Options: "claude-haiku-4-5" (cheap/fast), "claude-sonnet-4-6" (default), "claude-opus-4-6" (complex). Defaults to sonnet.'),
        },
        async ({ prompt, delay_minutes, cron, label, model }) => {
          try {
            let schedule: string
            if (cron) {
              CronExpressionParser.parse(cron)
              schedule = cron
            } else if (delay_minutes) {
              const target = new Date(Date.now() + delay_minutes * 60_000)
              schedule = `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`
            } else {
              return { content: [{ type: 'text' as const, text: 'Provide either delay_minutes or cron.' }], isError: true }
            }

            const id = randomUUID().slice(0, 8)
            const nextRun = computeNextRun(schedule)
            createTask(id, opts.chatId, prompt, schedule, nextRun, model)

            const when = new Date(nextRun * 1000).toLocaleString()
            const desc = label ?? prompt.slice(0, 50)
            return { content: [{ type: 'text' as const, text: `Reminder set: "${desc}" (${id})\nNext: ${when}` }] }
          } catch (err) {
            logger.error({ err }, 'set_reminder failed')
            return { content: [{ type: 'text' as const, text: `Failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'search_memory',
        'Search the memory system for past conversations, facts, and context about the user. Use this when you need to recall something specific from prior interactions.',
        {
          query: z.string().describe('What to search for in memory'),
        },
        async ({ query }) => {
          try {
            const context = await buildMemoryContext(opts.chatId, query)
            if (!context) {
              return { content: [{ type: 'text' as const, text: 'No relevant memories found.' }] }
            }
            return { content: [{ type: 'text' as const, text: context }] }
          } catch (err) {
            logger.error({ err }, 'search_memory failed')
            return { content: [{ type: 'text' as const, text: `Memory search failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'get_calendar_today',
        'Get today\'s calendar events. Fast lookup, no skill overhead.',
        {
          days: z.number().optional().describe('Number of days to look ahead (default 1)'),
        },
        async ({ days }) => {
          try {
            const output = await runSkillScript(CALENDAR_SCRIPT, ['list', String(days ?? 1)])
            return { content: [{ type: 'text' as const, text: output || 'No events found.' }] }
          } catch (err) {
            logger.error({ err }, 'get_calendar_today failed')
            return { content: [{ type: 'text' as const, text: `Calendar fetch failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'search_conversations',
        'Search past conversation history. Use this to find what was discussed about a specific topic, when a decision was made, or what was said in a previous session. Returns full message text with timestamps.',
        {
          query: z.string().describe('What to search for in conversation history'),
          limit: z.number().optional().describe('Max results to return (default 10)'),
        },
        async ({ query, limit }) => {
          try {
            const results = searchConversations(query, opts.chatId, limit ?? 10)
            if (results.length === 0) {
              return { content: [{ type: 'text' as const, text: 'No matching conversations found.' }] }
            }
            const formatted = results.map(r => {
              const date = new Date(r.created_at * 1000).toLocaleString()
              const role = r.role === 'user' ? 'User' : 'Lila'
              return `[${date}] ${role}: ${r.content.slice(0, 500)}`
            }).join('\n\n---\n\n')
            return { content: [{ type: 'text' as const, text: formatted }] }
          } catch (err) {
            logger.error({ err }, 'search_conversations failed')
            return { content: [{ type: 'text' as const, text: `Search failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'update_working_memory',
        'Update a section of the working memory at the configured working-memory path. Use this when the user shares something significant such as a new project, a decision, a preference correction, a new person, or a priority shift. Sections: Identity, Active Projects, Current Priorities, Open Threads, People, Preferences & Notes.',
        {
          section: z.string().describe('The section name to update, e.g. "Current Priorities", "Open Threads", "People"'),
          content: z.string().describe('The new content for this section (full replacement). Use markdown bullets.'),
        },
        async ({ section, content }) => {
          try {
            const success = updateWorkingMemorySection(section, content)
            if (success) {
              logger.info({ section }, 'Working memory section updated')
              return { content: [{ type: 'text' as const, text: `Working memory updated: ${section}` }] }
            } else {
              return { content: [{ type: 'text' as const, text: 'Failed to update working memory.' }], isError: true }
            }
          } catch (err) {
            logger.error({ err }, 'update_working_memory failed')
            return { content: [{ type: 'text' as const, text: `Update failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'get_unread_emails',
        'Get unread emails from the primary inbox. Returns sender, subject, date, and snippet for each unread message.',
        {
          count: z.number().optional().describe('Max emails to return (default 10)'),
          query: z.string().optional().describe('Optional Gmail search query to filter results (e.g. "from:boss@company.com", "subject:urgent")'),
        },
        async ({ count, query }) => {
          try {
            const args = query
              ? ['search', `is:unread ${query}`]
              : ['unread']
            const output = await runSkillScript(GMAIL_SCRIPT, args)
            return { content: [{ type: 'text' as const, text: output || 'No unread emails.' }] }
          } catch (err) {
            logger.error({ err }, 'get_unread_emails failed')
            return { content: [{ type: 'text' as const, text: `Email fetch failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'get_business_inbox_emails',
        'Read emails from a configured business inbox account.',
        {
          count: z.number().optional().describe('Number of recent emails to list (default 10)'),
          message_id: z.number().optional().describe('Specific message ID to read the full body of'),
          folder: z.string().optional().describe('Folder to read from (default: INBOX)'),
        },
        async ({ count = 10, message_id, folder }) => {
          try {
            let result: string
            if (message_id) {
              const { stdout, stderr } = await execFileAsync(
                'himalaya',
                ['message', 'read', '--account', 'zoho', String(message_id)],
                { timeout: 15000, env: { ...process.env } }
              )
              if (stderr && !stderr.includes('WARN')) logger.debug({ stderr: stderr.slice(0, 200) })
              result = stdout.trim()
            } else {
              const args = ['envelope', 'list', '--account', 'zoho', '--page-size', String(count)]
              if (folder) args.push('--folder', folder)
              const { stdout, stderr } = await execFileAsync('himalaya', args, {
                timeout: 15000,
                env: { ...process.env },
              })
              if (stderr && !stderr.includes('WARN')) logger.debug({ stderr: stderr.slice(0, 200) })
              result = stdout.trim()
            }
            return { content: [{ type: 'text' as const, text: result || 'No emails found.' }] }
          } catch (err) {
            logger.error({ err }, 'get_business_inbox_emails failed')
            return { content: [{ type: 'text' as const, text: `Business inbox fetch failed: ${err}` }], isError: true }
          }
        }
      ),
      tool(
        'log_heartbeat_event',
        'Log an event to the heartbeat log so it won\'t be re-surfaced. Call this before sending a proactive message about something you found, so future runs know it was already handled.',
        {
          trigger_id: z.string().describe('The heartbeat trigger ID, e.g. "hb-apple-check"'),
          event_key: z.string().describe('Brief description of the event, e.g. "Apple approval email received 2024-04-11"'),
        },
        async ({ trigger_id, event_key }) => {
          try {
            logHeartbeatEvent(trigger_id, event_key)
            return { content: [{ type: 'text' as const, text: `Logged: [${trigger_id}] ${event_key}` }] }
          } catch (err) {
            logger.error({ err }, 'log_heartbeat_event failed')
            return { content: [{ type: 'text' as const, text: `Failed to log: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'get_heartbeat_log',
        'Check what events were already surfaced for a heartbeat trigger in the recent past. Use this at the start of every heartbeat run to avoid re-surfacing things that were already messaged.',
        {
          trigger_id: z.string().describe('The heartbeat trigger ID, e.g. "hb-apple-check"'),
          hours: z.number().optional().describe('How many hours back to check (default 48)'),
        },
        async ({ trigger_id, hours }) => {
          try {
            const events = getHeartbeatLog(trigger_id, hours ?? 48)
            if (events.length === 0) {
              return { content: [{ type: 'text' as const, text: `No events logged for ${trigger_id} in the last ${hours ?? 48} hours.` }] }
            }
            const formatted = events.map(e => {
              const date = new Date(e.surfaced_at * 1000).toLocaleString()
              return `[${date}] ${e.event_key}`
            }).join('\n')
            return { content: [{ type: 'text' as const, text: `Recent events for ${trigger_id}:\n${formatted}` }] }
          } catch (err) {
            logger.error({ err }, 'get_heartbeat_log failed')
            return { content: [{ type: 'text' as const, text: `Failed to fetch log: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'get_entity',
        'Look up a known entity (person, project, place, org) by name from the structured entity graph. Returns facts, notes, and last mention time.',
        {
          name: z.string().describe('The entity name to look up'),
        },
        async ({ name }) => {
          try {
            const entity = getEntity(name)
            if (!entity) {
              return { content: [{ type: 'text' as const, text: `Entity not found: ${name}` }] }
            }
            const typeLabel = entity.type.charAt(0).toUpperCase() + entity.type.slice(1)
            let factsStr = ''
            try {
              const factsObj = JSON.parse(entity.facts) as Record<string, unknown>
              factsStr = Object.entries(factsObj).map(([k, v]) => `  ${k}: ${v}`).join('\n')
            } catch { /* ignore */ }
            let aliasesStr = ''
            try {
              const aliases: string[] = JSON.parse(entity.aliases)
              if (aliases.length > 0) aliasesStr = `\nAliases: ${aliases.join(', ')}`
            } catch { /* ignore */ }
            const lastMentioned = entity.last_mentioned
              ? new Date(entity.last_mentioned * 1000).toLocaleString()
              : 'never'
            const lines = [
              `[${typeLabel}] ${entity.name}${aliasesStr}`,
              factsStr ? `Facts:\n${factsStr}` : '',
              entity.notes ? `Notes: ${entity.notes}` : '',
              `Last mentioned: ${lastMentioned}`,
            ].filter(Boolean).join('\n')
            return { content: [{ type: 'text' as const, text: lines }] }
          } catch (err) {
            logger.error({ err }, 'get_entity failed')
            return { content: [{ type: 'text' as const, text: `Failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'update_entity',
        'Create or update an entity in the structured entity graph. Use this to store persistent profiles for people, projects, places, and orgs. Facts are merged (not replaced) on updates.',
        {
          name: z.string().describe('Entity name, e.g. "Jordan", "Project Atlas", "ExampleTown"'),
          type: z.enum(['person', 'project', 'place', 'org', 'other']).describe('Entity type'),
          facts: z.record(z.string(), z.string()).describe('Key-value facts about this entity, e.g. {"role": "math teacher", "school": "Example School"}'),
          notes: z.string().optional().describe('Optional freeform notes to append'),
        },
        async ({ name, type, facts, notes }) => {
          try {
            upsertEntity(name, type, facts as Record<string, unknown>, notes)
            return { content: [{ type: 'text' as const, text: `Entity updated: ${name}` }] }
          } catch (err) {
            logger.error({ err }, 'update_entity failed')
            return { content: [{ type: 'text' as const, text: `Failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'list_entities',
        'List all known entities in the structured entity graph, optionally filtered by type.',
        {
          type: z.enum(['person', 'project', 'place', 'org', 'other']).optional().describe('Filter by entity type'),
        },
        async ({ type }) => {
          try {
            const entities = getAllEntities(type)
            if (entities.length === 0) {
              return { content: [{ type: 'text' as const, text: type ? `No ${type} entities found.` : 'No entities found.' }] }
            }
            const lines = entities.map(e => {
              const typeLabel = e.type.charAt(0).toUpperCase() + e.type.slice(1)
              let factsStr = ''
              try {
                const factsObj = JSON.parse(e.facts) as Record<string, unknown>
                const keys = Object.keys(factsObj)
                factsStr = keys.length > 0 ? ` — ${keys.slice(0, 3).map(k => `${k}: ${factsObj[k]}`).join(', ')}` : ''
              } catch { /* ignore */ }
              return `[${typeLabel}] ${e.name}${factsStr}`
            })
            return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
          } catch (err) {
            logger.error({ err }, 'list_entities failed')
            return { content: [{ type: 'text' as const, text: `Failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'get_secondary_inbox_emails',
        'Read emails from a configured secondary inbox. Use for triage alongside the primary and business accounts.',
        {
          count: z.number().optional().describe('Number of recent emails to list (default 10)'),
          message_id: z.number().optional().describe('Specific message ID to read the full body of'),
          query: z.string().optional().describe('Search query to filter emails. Uses himalaya query syntax: "from thestudiodirector.biz", "subject gymnastics", "from noreply@greenhouse-mail.io", "from x and subject y". Can also combine: "from x or subject y".'),
          folder: z.string().optional().describe('Folder to read from (default: INBOX). Use "[Gmail]/All Mail" to search archived emails too.'),
        },
        async ({ count = 10, message_id, query, folder }) => {
          try {
            let result: string
            if (message_id) {
              const { stdout } = await execFileAsync(
                'himalaya',
                ['message', 'read', '--account', 'secondary', String(message_id)],
                { timeout: 15000, env: { ...process.env } }
              )
              result = stdout.trim()
            } else if (query) {
              const args = ['envelope', 'list', '--account', 'secondary', '--page-size', String(count)]
              if (folder) args.push('--folder', folder)
              // query is passed as positional args (split by space)
              args.push(...query.split(' '))
              const { stdout, stderr } = await execFileAsync('himalaya', args, {
                timeout: 15000,
                env: { ...process.env },
              })
              if (stderr && !stderr.includes('WARN')) logger.debug({ stderr: stderr.slice(0, 200) })
              result = stdout.trim()
            } else {
              const args = ['envelope', 'list', '--account', 'secondary', '--page-size', String(count)]
              if (folder) args.push('--folder', folder)
              const { stdout, stderr } = await execFileAsync('himalaya', args, {
                timeout: 15000,
                env: { ...process.env },
              })
              if (stderr && !stderr.includes('WARN')) logger.debug({ stderr: stderr.slice(0, 200) })
              result = stdout.trim()
            }
            return { content: [{ type: 'text' as const, text: result || 'No emails found.' }] }
          } catch (err) {
            logger.error({ err }, 'get_secondary_inbox_emails failed')
            return { content: [{ type: 'text' as const, text: `Secondary inbox fetch failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'exa_search',
        'Search the web using Exa AI-native search. Returns highly relevant results for research queries, news, technical topics, and more. Better than Firecrawl for finding the right pages -- use Exa to find, Firecrawl to extract.',
        {
          query: z.string().describe('Search query'),
          num_results: z.number().optional().describe('Number of results (default 5)'),
          include_contents: z.boolean().optional().describe('Include page content/summary in results (default true)'),
          type: z.enum(['auto', 'neural', 'keyword']).optional().describe('Search type: auto (default), neural (semantic), keyword (exact)'),
        },
        async ({ query, num_results = 5, include_contents = true, type = 'auto' }) => {
          try {
            const apiKey = process.env.EXA_API_KEY
            if (!apiKey) return { content: [{ type: 'text' as const, text: 'EXA_API_KEY not set' }], isError: true }

            const body: Record<string, unknown> = { query, numResults: num_results, type }
            if (include_contents) body.contents = { text: { maxCharacters: 2000 } }

            const res = await fetch('https://api.exa.ai/search', {
              method: 'POST',
              headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            })
            if (!res.ok) throw new Error(`Exa API error: ${res.status} ${res.statusText}`)
            const data = await res.json() as { results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string; author?: string }> }
            if (!data.results?.length) return { content: [{ type: 'text' as const, text: 'No results found.' }] }

            const formatted = data.results.map((r, i) => {
              const meta = [r.publishedDate, r.author].filter(Boolean).join(' · ')
              return `## ${i + 1}. ${r.title ?? 'Untitled'}${meta ? `\n*${meta}*` : ''}\n**URL:** ${r.url}${r.text ? `\n\n${r.text}` : ''}`
            }).join('\n\n---\n\n')

            return { content: [{ type: 'text' as const, text: formatted }] }
          } catch (err) {
            logger.error({ err, query }, 'exa_search failed')
            return { content: [{ type: 'text' as const, text: `Exa search failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'firecrawl_scrape',
        'Scrape a URL using Firecrawl and get clean markdown content. Best for extracting full page content from any website including JavaScript-rendered pages. Use for research, reading articles, scraping structured data.',
        {
          url: z.string().describe('The URL to scrape'),
          only_main_content: z.boolean().optional().describe('Return only main content, stripping nav/footer (default true)'),
        },
        async ({ url, only_main_content = true }) => {
          try {
            const apiKey = process.env.FIRECRAWL_API_KEY
            if (!apiKey) return { content: [{ type: 'text' as const, text: 'FIRECRAWL_API_KEY not set' }], isError: true }

            const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: only_main_content }),
            })
            if (!res.ok) throw new Error(`Firecrawl API error: ${res.status} ${res.statusText}`)
            const data = await res.json() as { success: boolean; data?: { markdown?: string; title?: string } }
            if (!data.success || !data.data?.markdown) throw new Error('No content returned')
            const title = data.data.title ? `# ${data.data.title}\n\n` : ''
            return { content: [{ type: 'text' as const, text: `${title}${data.data.markdown}` }] }
          } catch (err) {
            logger.error({ err, url }, 'firecrawl_scrape failed')
            return { content: [{ type: 'text' as const, text: `Scrape failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'firecrawl_search',
        'Search the web using Firecrawl and get results with full page content. Returns top results with clean markdown. Use for research tasks, finding articles, checking current information.',
        {
          query: z.string().describe('Search query'),
          limit: z.number().optional().describe('Number of results (default 5, max 10)'),
        },
        async ({ query, limit = 5 }) => {
          try {
            const apiKey = process.env.FIRECRAWL_API_KEY
            if (!apiKey) return { content: [{ type: 'text' as const, text: 'FIRECRAWL_API_KEY not set' }], isError: true }

            const res = await fetch('https://api.firecrawl.dev/v1/search', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ query, limit: Math.min(limit, 10) }),
            })
            if (!res.ok) throw new Error(`Firecrawl API error: ${res.status} ${res.statusText}`)
            const data = await res.json() as { success: boolean; data?: Array<{ title?: string; url?: string; markdown?: string; description?: string }> }
            if (!data.success || !data.data?.length) return { content: [{ type: 'text' as const, text: 'No results found.' }] }

            const formatted = data.data.map((r, i) =>
              `## ${i + 1}. ${r.title ?? 'Untitled'}\n**URL:** ${r.url}\n\n${r.markdown ?? r.description ?? ''}`
            ).join('\n\n---\n\n')

            return { content: [{ type: 'text' as const, text: formatted }] }
          } catch (err) {
            logger.error({ err, query }, 'firecrawl_search failed')
            return { content: [{ type: 'text' as const, text: `Search failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'create_plan',
        'Create a multi-step plan for tracking work over time. Use this when the user mentions a project, goal, or multi-step task. Steps marked executable can be performed by Lila directly.',
        {
          title: z.string().describe('Short plan title, e.g. "Prep for parent conferences"'),
          description: z.string().optional().describe('Optional plan description or context'),
          due_date: z.string().optional().describe('ISO date string for plan due date, e.g. "2026-04-20"'),
          steps: z.array(z.object({
            title: z.string().describe('Step title'),
            description: z.string().optional().describe('Step detail'),
            executable: z.boolean().optional().describe('True if Lila can do this step herself'),
            due_date: z.string().optional().describe('ISO date string for step due date'),
          })).optional().describe('Initial steps for the plan'),
        },
        async ({ title, description, due_date, steps }) => {
          try {
            const planId = createPlan(title, description, due_date)
            if (steps) {
              steps.forEach((s, i) => {
                addPlanStep(planId, s.title, {
                  description: s.description,
                  executable: s.executable,
                  dueDate: s.due_date,
                  sortOrder: i,
                })
              })
            }
            const result = getPlan(planId)
            if (!result) throw new Error('Plan not found after creation')
            const { plan, steps: planSteps } = result
            const due = plan.due_date ? ` (due: ${plan.due_date})` : ''
            const stepLines = planSteps.map((s, i) => {
              const exec = s.executable ? ' [executable]' : ''
              return `  ${i + 1}. ${s.title}${exec}`
            }).join('\n')
            const summary = `Plan created: ${plan.title}${due}\nID: ${plan.id}${stepLines ? `\n\nSteps:\n${stepLines}` : ''}`
            return { content: [{ type: 'text' as const, text: summary }] }
          } catch (err) {
            logger.error({ err }, 'create_plan failed')
            return { content: [{ type: 'text' as const, text: `Failed to create plan: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'get_plans',
        'Get active plans with their steps and current status. Optionally retrieve a specific plan by ID.',
        {
          plan_id: z.string().optional().describe('Specific plan ID to retrieve. Omit to get all active plans.'),
        },
        async ({ plan_id }) => {
          try {
            if (plan_id) {
              const result = getPlan(plan_id)
              if (!result) return { content: [{ type: 'text' as const, text: `Plan not found: ${plan_id}` }] }
              const { plan, steps } = result
              const due = plan.due_date ? ` (due: ${plan.due_date})` : ''
              const stepLines = steps.map((s, i) => {
                const icon = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▶' : s.status === 'skipped' ? '—' : '○'
                const exec = s.executable ? ' [executable]' : ''
                const stepDue = s.due_date ? ` (due: ${s.due_date})` : ''
                return `  ${icon} ${i + 1}. ${s.title}${exec}${stepDue}\n     ID: ${s.id}`
              }).join('\n')
              const text = `[Plan: ${plan.title}${due}] — ${plan.status}\nID: ${plan.id}${plan.description ? `\n${plan.description}` : ''}\n\n${stepLines || '  (no steps)'}`
              return { content: [{ type: 'text' as const, text: text }] }
            } else {
              const plans = getActivePlans()
              if (plans.length === 0) return { content: [{ type: 'text' as const, text: 'No active plans.' }] }
              const formatted = plans.map(({ plan, steps }) => {
                const due = plan.due_date ? ` (due: ${plan.due_date})` : ''
                const done = steps.filter(s => s.status === 'done').length
                const stepLines = steps.map(s => {
                  const icon = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▶' : s.status === 'skipped' ? '—' : '○'
                  const exec = s.executable ? ' [executable]' : ''
                  return `  ${icon} ${s.title}${exec} — ID: ${s.id}`
                }).join('\n')
                return `[Plan: ${plan.title}${due}] — ${done}/${steps.length} done — ID: ${plan.id}\n${stepLines || '  (no steps)'}`
              }).join('\n\n')
              return { content: [{ type: 'text' as const, text: formatted }] }
            }
          } catch (err) {
            logger.error({ err }, 'get_plans failed')
            return { content: [{ type: 'text' as const, text: `Failed to get plans: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'update_plan_step',
        'Update the status of a plan step. Use this as steps are completed, started, or skipped.',
        {
          step_id: z.string().describe('The step ID to update'),
          status: z.enum(['pending', 'in_progress', 'done', 'skipped']).describe('New status for the step'),
        },
        async ({ step_id, status }) => {
          try {
            updatePlanStep(step_id, status)
            return { content: [{ type: 'text' as const, text: `Step updated: ${step_id} -> ${status}` }] }
          } catch (err) {
            logger.error({ err }, 'update_plan_step failed')
            return { content: [{ type: 'text' as const, text: `Failed to update step: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'update_plan',
        'Update a plan\'s metadata or status. Use to mark a plan completed, paused, or archived, or to edit its title/description.',
        {
          plan_id: z.string().describe('The plan ID to update'),
          status: z.enum(['active', 'paused', 'completed', 'archived']).optional().describe('New plan status'),
          title: z.string().optional().describe('New plan title'),
          description: z.string().optional().describe('New plan description'),
        },
        async ({ plan_id, status, title, description }) => {
          try {
            const before = getPlan(plan_id)
            if (!before) return { content: [{ type: 'text' as const, text: `Plan not found: ${plan_id}` }] }
            updatePlan(plan_id, { status, title, description })
            const updated = getPlan(plan_id)
            return { content: [{ type: 'text' as const, text: `Plan updated: ${updated?.plan.title ?? plan_id}` }] }
          } catch (err) {
            logger.error({ err }, 'update_plan failed')
            return { content: [{ type: 'text' as const, text: `Failed to update plan: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'add_plan_step',
        'Add a new step to an existing plan.',
        {
          plan_id: z.string().describe('The plan ID to add a step to'),
          title: z.string().describe('Step title'),
          description: z.string().optional().describe('Step detail or context'),
          executable: z.boolean().optional().describe('True if Lila can perform this step herself'),
          due_date: z.string().optional().describe('ISO date string for step due date'),
        },
        async ({ plan_id, title, description, executable, due_date }) => {
          try {
            const planResult = getPlan(plan_id)
            if (!planResult) return { content: [{ type: 'text' as const, text: `Plan not found: ${plan_id}` }] }
            const nextOrder = planResult.steps.length
            addPlanStep(plan_id, title, { description, executable, dueDate: due_date, sortOrder: nextOrder })
            return { content: [{ type: 'text' as const, text: `Step added to ${planResult.plan.title}` }] }
          } catch (err) {
            logger.error({ err }, 'add_plan_step failed')
            return { content: [{ type: 'text' as const, text: `Failed to add step: ${err}` }], isError: true }
          }
        }
      ),

      // --- Paperclip Agent Fleet Integration ---

      tool(
        'paperclip_dashboard',
        'Get a high-level dashboard of one or all external agent-fleet companies. Shows agent count, open or blocked issues, running agents, and spend.',
        {
          company: z.string().optional().describe('Company name or prefix (e.g. "OPS", "ALPHA", "CORE"). Omit for all companies.'),
        },
        async ({ company }) => {
          try {
            const base = 'http://127.0.0.1:3100/api'
            const companiesRes = await fetch(`${base}/companies`)
            if (!companiesRes.ok) throw new Error(`Paperclip not reachable (${companiesRes.status})`)
            const companies = await companiesRes.json() as Array<{ id: string; name: string; issuePrefix: string }>

            const targets = company
              ? companies.filter(c =>
                  c.name.toLowerCase().includes(company.toLowerCase()) ||
                  c.issuePrefix.toLowerCase() === company.toLowerCase()
                )
              : companies

            if (targets.length === 0) return { content: [{ type: 'text' as const, text: `No company matching "${company}" found. Available: ${companies.map(c => `${c.issuePrefix} (${c.name})`).join(', ')}` }] }

            const dashboards = await Promise.all(targets.map(async (c) => {
              const dRes = await fetch(`${base}/companies/${c.id}/dashboard`)
              if (!dRes.ok) return `**${c.issuePrefix}: ${c.name}** — dashboard unavailable`
              const d = await dRes.json() as { agents: { active: number; running: number; error: number }; tasks: { open: number; inProgress: number; blocked: number; done: number }; pendingApprovals: number }
              return [
                `**${c.issuePrefix}: ${c.name}**`,
                `  Agents: ${d.agents.active} active, ${d.agents.running} running, ${d.agents.error} error`,
                `  Issues: ${d.tasks.open} open, ${d.tasks.inProgress} in progress, ${d.tasks.blocked} blocked, ${d.tasks.done} done`,
                d.pendingApprovals > 0 ? `  ⚠ ${d.pendingApprovals} pending approvals` : null,
              ].filter(Boolean).join('\n')
            }))

            return { content: [{ type: 'text' as const, text: dashboards.join('\n\n') }] }
          } catch (err) {
            logger.error({ err }, 'paperclip_dashboard failed')
            return { content: [{ type: 'text' as const, text: `Paperclip dashboard failed: ${err}. Is the server running? (paperclipai run)` }], isError: true }
          }
        }
      ),

      tool(
        'paperclip_issues',
        'List issues for a Paperclip company, optionally filtered by status. Use to check open work, blocked tasks, or what\'s been completed.',
        {
          company: z.string().describe('Company name or prefix (e.g. "OPS", "ALPHA", "CORE")'),
          status: z.enum(['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled']).optional().describe('Filter by issue status. Omit for all non-done issues.'),
          limit: z.number().optional().describe('Max issues to return (default 20)'),
        },
        async ({ company, status, limit = 20 }) => {
          try {
            const base = 'http://127.0.0.1:3100/api'
            const companiesRes = await fetch(`${base}/companies`)
            if (!companiesRes.ok) throw new Error(`Paperclip not reachable`)
            const companies = await companiesRes.json() as Array<{ id: string; name: string; issuePrefix: string }>
            const match = companies.find(c =>
              c.name.toLowerCase().includes(company.toLowerCase()) ||
              c.issuePrefix.toLowerCase() === company.toLowerCase()
            )
            if (!match) return { content: [{ type: 'text' as const, text: `No company matching "${company}". Available: ${companies.map(c => c.issuePrefix).join(', ')}` }] }

            const url = status
              ? `${base}/companies/${match.id}/issues?status=${status}`
              : `${base}/companies/${match.id}/issues`
            const issuesRes = await fetch(url)
            if (!issuesRes.ok) throw new Error(`Issues fetch failed: ${issuesRes.status}`)
            let issues = await issuesRes.json() as Array<{ identifier: string; title: string; status: string; priority: string; assigneeAgentId: string | null }>

            // If no status filter, exclude done/cancelled for readability
            if (!status) {
              issues = issues.filter(i => i.status !== 'done' && i.status !== 'cancelled')
            }
            issues = issues.slice(0, limit)

            if (issues.length === 0) return { content: [{ type: 'text' as const, text: `No ${status ?? 'open'} issues for ${match.name}.` }] }

            // Fetch agents for name resolution
            const agentsRes = await fetch(`${base}/companies/${match.id}/agents`)
            const agents = agentsRes.ok
              ? await agentsRes.json() as Array<{ id: string; urlKey: string; title: string | null }>
              : []
            const agentMap = new Map(agents.map(a => [a.id, a.title ?? a.urlKey]))

            const lines = issues.map(i => {
              const assignee = i.assigneeAgentId ? (agentMap.get(i.assigneeAgentId) ?? 'unknown') : 'unassigned'
              return `${i.identifier} [${i.status}] ${i.title} → ${assignee}`
            })

            return { content: [{ type: 'text' as const, text: `**${match.issuePrefix}: ${match.name}** — ${issues.length} issues\n\n${lines.join('\n')}` }] }
          } catch (err) {
            logger.error({ err }, 'paperclip_issues failed')
            return { content: [{ type: 'text' as const, text: `Failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'paperclip_agents',
        'List agents for a Paperclip company with their status and role. Use to check who\'s idle, running, or in error state.',
        {
          company: z.string().describe('Company name or prefix (e.g. "OPS", "ALPHA", "CORE")'),
        },
        async ({ company }) => {
          try {
            const base = 'http://127.0.0.1:3100/api'
            const companiesRes = await fetch(`${base}/companies`)
            if (!companiesRes.ok) throw new Error(`Paperclip not reachable`)
            const companies = await companiesRes.json() as Array<{ id: string; name: string; issuePrefix: string }>
            const match = companies.find(c =>
              c.name.toLowerCase().includes(company.toLowerCase()) ||
              c.issuePrefix.toLowerCase() === company.toLowerCase()
            )
            if (!match) return { content: [{ type: 'text' as const, text: `No company matching "${company}".` }] }

            const agentsRes = await fetch(`${base}/companies/${match.id}/agents`)
            if (!agentsRes.ok) throw new Error(`Agents fetch failed`)
            const agents = await agentsRes.json() as Array<{ id: string; urlKey: string; title: string | null; status: string; role: string; model: string | null; lastHeartbeatAt: string | null }>

            if (agents.length === 0) return { content: [{ type: 'text' as const, text: `No agents for ${match.name}.` }] }

            const lines = agents.map(a => {
              const statusIcon = a.status === 'running' ? '▶' : a.status === 'error' ? '✗' : a.status === 'idle' ? '○' : '⏸'
              const lastBeat = a.lastHeartbeatAt
                ? new Date(a.lastHeartbeatAt).toLocaleDateString()
                : 'never'
              return `${statusIcon} **${a.title ?? a.urlKey}** [${a.status}] — last heartbeat: ${lastBeat}`
            })

            return { content: [{ type: 'text' as const, text: `**${match.issuePrefix}: ${match.name}** — ${agents.length} agents\n\n${lines.join('\n')}` }] }
          } catch (err) {
            logger.error({ err }, 'paperclip_agents failed')
            return { content: [{ type: 'text' as const, text: `Failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'paperclip_issue_detail',
        'Get full details on a specific Paperclip issue including description. Use the issue identifier like "THI-10" or "STE-5".',
        {
          identifier: z.string().describe('Issue identifier, e.g. "OPS-10", "ALPHA-5", "CORE-1"'),
        },
        async ({ identifier }) => {
          try {
            const base = 'http://127.0.0.1:3100/api'
            // Extract prefix to find company
            const prefix = identifier.split('-')[0]
            const companiesRes = await fetch(`${base}/companies`)
            if (!companiesRes.ok) throw new Error(`Paperclip not reachable`)
            const companies = await companiesRes.json() as Array<{ id: string; name: string; issuePrefix: string }>
            const match = companies.find(c => c.issuePrefix.toLowerCase() === prefix.toLowerCase())
            if (!match) return { content: [{ type: 'text' as const, text: `No company with prefix "${prefix}".` }] }

            const issuesRes = await fetch(`${base}/companies/${match.id}/issues`)
            if (!issuesRes.ok) throw new Error(`Issues fetch failed`)
            const issues = await issuesRes.json() as Array<{ id: string; identifier: string; title: string; description: string | null; status: string; priority: string; assigneeAgentId: string | null; createdAt: string; updatedAt: string }>
            const issue = issues.find(i => i.identifier.toLowerCase() === identifier.toLowerCase())
            if (!issue) return { content: [{ type: 'text' as const, text: `Issue ${identifier} not found.` }] }

            // Resolve assignee name
            let assigneeName = 'unassigned'
            if (issue.assigneeAgentId) {
              const agentRes = await fetch(`${base}/companies/${match.id}/agents`)
              if (agentRes.ok) {
                const agents = await agentRes.json() as Array<{ id: string; urlKey: string; title: string | null }>
                const agent = agents.find(a => a.id === issue.assigneeAgentId)
                if (agent) assigneeName = agent.title ?? agent.urlKey
              }
            }

            const created = new Date(issue.createdAt).toLocaleDateString()
            const updated = new Date(issue.updatedAt).toLocaleDateString()
            const desc = issue.description ? `\n\n${issue.description}` : ''

            return { content: [{ type: 'text' as const, text: `**${issue.identifier}: ${issue.title}**\nStatus: ${issue.status} | Priority: ${issue.priority} | Assigned: ${assigneeName}\nCreated: ${created} | Updated: ${updated}${desc}` }] }
          } catch (err) {
            logger.error({ err }, 'paperclip_issue_detail failed')
            return { content: [{ type: 'text' as const, text: `Failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'paperclip_comment',
        'Post a board-level comment on an agent-fleet issue. Can also reopen done issues.',
        {
          identifier: z.string().describe('Issue identifier, e.g. "THI-10"'),
          body: z.string().describe('Comment text to post'),
          reopen: z.boolean().optional().describe('Reopen the issue if it\'s done/cancelled (default false)'),
        },
        async ({ identifier, body, reopen = false }) => {
          try {
            const args = ['issue', 'comment', '--body', body]
            if (reopen) args.push('--reopen')

            // Need to resolve identifier to UUID first
            const base = 'http://127.0.0.1:3100/api'
            const prefix = identifier.split('-')[0]
            const companiesRes = await fetch(`${base}/companies`)
            const companies = await companiesRes.json() as Array<{ id: string; issuePrefix: string }>
            const match = companies.find(c => c.issuePrefix.toLowerCase() === prefix.toLowerCase())
            if (!match) return { content: [{ type: 'text' as const, text: `No company with prefix "${prefix}".` }] }

            const issuesRes = await fetch(`${base}/companies/${match.id}/issues`)
            const issues = await issuesRes.json() as Array<{ id: string; identifier: string }>
            const issue = issues.find(i => i.identifier.toLowerCase() === identifier.toLowerCase())
            if (!issue) return { content: [{ type: 'text' as const, text: `Issue ${identifier} not found.` }] }

            const { stdout, stderr } = await execFileAsync('paperclipai', ['issue', 'comment', issue.id, '--body', body, ...(reopen ? ['--reopen'] : [])], {
              timeout: 15000,
              env: { ...process.env },
            })
            if (stderr && !stderr.includes('WARN')) logger.debug({ stderr: stderr.slice(0, 200) })

            return { content: [{ type: 'text' as const, text: `Comment posted on ${identifier}${reopen ? ' (reopened)' : ''}` }] }
          } catch (err) {
            logger.error({ err }, 'paperclip_comment failed')
            return { content: [{ type: 'text' as const, text: `Failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'paperclip_create_issue',
        'Create a new issue on an agent-fleet company and optionally assign it to an agent.',
        {
          company: z.string().describe('Company name or prefix (e.g. "OPS", "CORE")'),
          title: z.string().describe('Issue title'),
          description: z.string().optional().describe('Issue description/instructions for the agent'),
          priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Priority level (default medium)'),
          assignee: z.string().optional().describe('Agent urlKey to assign to (e.g. "ceo", "research-director", "engineer")'),
        },
        async ({ company: companyName, title, description, priority = 'medium', assignee }) => {
          try {
            const base = 'http://127.0.0.1:3100/api'
            const companiesRes = await fetch(`${base}/companies`)
            const companies = await companiesRes.json() as Array<{ id: string; name: string; issuePrefix: string }>
            const match = companies.find(c =>
              c.name.toLowerCase().includes(companyName.toLowerCase()) ||
              c.issuePrefix.toLowerCase() === companyName.toLowerCase()
            )
            if (!match) return { content: [{ type: 'text' as const, text: `No company matching "${companyName}".` }] }

            // Resolve assignee urlKey to agent UUID if provided
            let assigneeId: string | undefined
            if (assignee) {
              const agentsRes = await fetch(`${base}/companies/${match.id}/agents`)
              if (agentsRes.ok) {
                const agents = await agentsRes.json() as Array<{ id: string; urlKey: string }>
                const agentMatch = agents.find(a => a.urlKey === assignee)
                if (agentMatch) assigneeId = agentMatch.id
                else return { content: [{ type: 'text' as const, text: `Agent "${assignee}" not found in ${match.name}. Available: ${agents.map(a => a.urlKey).join(', ')}` }] }
              }
            }

            const args = ['issue', 'create', '-C', match.id, '--title', title, '--priority', priority]
            if (description) args.push('--description', description)
            if (assigneeId) args.push('--assignee-agent-id', assigneeId)

            const { stdout } = await execFileAsync('paperclipai', args, {
              timeout: 15000,
              env: { ...process.env },
            })

            return { content: [{ type: 'text' as const, text: `Issue created on ${match.name}: ${title}${assignee ? ` → ${assignee}` : ''}\n${stdout.trim()}` }] }
          } catch (err) {
            logger.error({ err }, 'paperclip_create_issue failed')
            return { content: [{ type: 'text' as const, text: `Failed: ${err}` }], isError: true }
          }
        }
      ),

      tool(
        'paperclip_agent_memory',
        'Read an agent\'s heartbeat memory files. These are dated markdown files that capture what the agent did on each heartbeat. Use to understand what an agent has been working on.',
        {
          company: z.string().describe('Company name or prefix (e.g. "OPS", "ALPHA")'),
          agent: z.string().describe('Agent urlKey (e.g. "ceo", "research-director")'),
          date: z.string().optional().describe('Specific date to read (YYYY-MM-DD). Omit for latest.'),
        },
        async ({ company: companyName, agent, date }) => {
          try {
            const base = 'http://127.0.0.1:3100/api'
            const companiesRes = await fetch(`${base}/companies`)
            const companies = await companiesRes.json() as Array<{ id: string; name: string; issuePrefix: string }>
            const match = companies.find(c =>
              c.name.toLowerCase().includes(companyName.toLowerCase()) ||
              c.issuePrefix.toLowerCase() === companyName.toLowerCase()
            )
            if (!match) return { content: [{ type: 'text' as const, text: `No company matching "${companyName}".` }] }

            // Find agent ID
            const agentsRes = await fetch(`${base}/companies/${match.id}/agents`)
            const agents = await agentsRes.json() as Array<{ id: string; urlKey: string; title: string | null }>
            const agentMatch = agents.find(a => a.urlKey === agent)
            if (!agentMatch) return { content: [{ type: 'text' as const, text: `No agent "${agent}" in ${match.name}. Available: ${agents.map(a => a.urlKey).join(', ')}` }] }

            const memDir = `${process.env.HOME}/.paperclip/instances/default/workspaces/${agentMatch.id}/memory`
            const { readdir, readFile } = await import('fs/promises')

            try {
              const files = (await readdir(memDir)).filter(f => f.endsWith('.md')).sort().reverse()
              if (files.length === 0) return { content: [{ type: 'text' as const, text: `No memory files for ${agentMatch.title ?? agent}.` }] }

              const target = date ? `${date}.md` : files[0]
              const content = await readFile(`${memDir}/${target}`, 'utf-8')
              return { content: [{ type: 'text' as const, text: `**${agentMatch.title ?? agent} memory — ${target.replace('.md', '')}**\n\n${content}` }] }
            } catch {
              return { content: [{ type: 'text' as const, text: `No memory directory found for ${agentMatch.title ?? agent}.` }] }
            }
          } catch (err) {
            logger.error({ err }, 'paperclip_agent_memory failed')
            return { content: [{ type: 'text' as const, text: `Failed: ${err}` }], isError: true }
          }
        }
      ),
    ],
  })

  return server
}
