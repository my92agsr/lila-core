#!/usr/bin/env tsx
/**
 * Working memory consolidation — local CLI for prompt iteration.
 *
 * Renders prompts/working-memory/{system,consolidate}.md against an input
 * JSON file (default: prompts/working-memory/sample-input.json), runs the
 * result through Claude with prompt caching on the system prompt, validates
 * the output against schema.json, and pretty-prints it.
 *
 * Usage:
 *   npm run wm:consolidate
 *   npm run wm:consolidate -- --input path/to/data.json
 *   npm run wm:consolidate -- --model claude-opus-4-7
 *   npm run wm:consolidate -- --show-prompt
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const PROMPT_DIR = join(REPO_ROOT, 'prompts', 'working-memory')

const DEFAULT_MODEL = 'claude-sonnet-4-6'

interface SampleInput {
  first_name: string
  current_date: string
  lookback_window_days: number
  previous_working_memory: unknown
  recent_activity: unknown[]
  retrieved_memories: unknown[]
}

interface CliArgs {
  inputPath: string
  model: string
  showPrompt: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inputPath: join(PROMPT_DIR, 'sample-input.json'),
    model: DEFAULT_MODEL,
    showPrompt: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--input' && argv[i + 1]) {
      args.inputPath = resolve(argv[++i]!)
    } else if (a === '--model' && argv[i + 1]) {
      args.model = argv[++i]!
    } else if (a === '--show-prompt') {
      args.showPrompt = true
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: npm run wm:consolidate -- [--input PATH] [--model NAME] [--show-prompt]`)
      process.exit(0)
    }
  }
  return args
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in vars)) {
      throw new Error(`Template references {{${key}}} but no value was provided`)
    }
    return vars[key]!
  })
}

function buildVars(input: SampleInput): Record<string, string> {
  return {
    first_name: input.first_name,
    current_date: input.current_date,
    lookback_window_days: String(input.lookback_window_days),
    recent_activity_json: JSON.stringify(input.recent_activity, null, 2),
    previous_working_memory_json: JSON.stringify(input.previous_working_memory, null, 2),
    retrieved_memories_json: JSON.stringify(input.retrieved_memories, null, 2),
    retrieved_memory_count: String(input.retrieved_memories.length),
  }
}

function extractJson(text: string): string {
  // Tolerate accidental ```json fences even though we asked for none.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1]!.trim()
  const objMatch = text.match(/\{[\s\S]*\}/)
  if (objMatch) return objMatch[0]
  throw new Error('No JSON object found in model output')
}

interface ValidationIssue {
  path: string
  message: string
}

function validate(parsed: unknown, schema: any): ValidationIssue[] {
  // Lightweight structural check — not a full JSON Schema validator. Catches
  // the failure modes that matter most: missing required fields, max-array
  // overruns, missing source_ids, malformed source entries. For a real
  // validator wire in ajv when this moves to Railway.
  const issues: ValidationIssue[] = []
  const root = parsed as Record<string, unknown>
  if (typeof parsed !== 'object' || parsed === null) {
    issues.push({ path: '$', message: 'output is not a JSON object' })
    return issues
  }

  for (const req of schema.required as string[]) {
    if (!(req in root)) issues.push({ path: `$.${req}`, message: 'required field missing' })
  }

  const focus = root.focus_items
  if (Array.isArray(focus)) {
    if (focus.length > 4) issues.push({ path: '$.focus_items', message: `length ${focus.length} > max 4` })
    focus.forEach((item: any, i) => {
      const p = `$.focus_items[${i}]`
      if (!item || typeof item !== 'object') return issues.push({ path: p, message: 'not an object' })
      if (typeof item.text !== 'string' || !item.text.length) issues.push({ path: `${p}.text`, message: 'missing or empty' })
      if (!Array.isArray(item.source_ids) || item.source_ids.length === 0) {
        issues.push({ path: `${p}.source_ids`, message: 'must contain at least one source' })
      }
      if (typeof item.salience !== 'number' || item.salience < 0 || item.salience > 1) {
        issues.push({ path: `${p}.salience`, message: 'must be a number in [0,1]' })
      }
    })
  } else {
    issues.push({ path: '$.focus_items', message: 'must be an array' })
  }

  const threads = root.people_threads
  if (Array.isArray(threads)) {
    if (threads.length > 2) issues.push({ path: '$.people_threads', message: `length ${threads.length} > max 2` })
    threads.forEach((t: any, i) => {
      const p = `$.people_threads[${i}]`
      if (!t || typeof t !== 'object') return issues.push({ path: p, message: 'not an object' })
      if (typeof t.person !== 'string' || !t.person.length) issues.push({ path: `${p}.person`, message: 'missing' })
      if (!Array.isArray(t.items) || t.items.length === 0) {
        issues.push({ path: `${p}.items`, message: 'must contain at least one item' })
      } else if (t.items.length > 3) {
        issues.push({ path: `${p}.items`, message: `length ${t.items.length} > max 3` })
      }
    })
  } else {
    issues.push({ path: '$.people_threads', message: 'must be an array' })
  }

  const quiet = root.quiet_items
  if (Array.isArray(quiet)) {
    if (quiet.length > 4) issues.push({ path: '$.quiet_items', message: `length ${quiet.length} > max 4` })
    quiet.forEach((q: any, i) => {
      const p = `$.quiet_items[${i}]`
      if (!q || typeof q !== 'object') return issues.push({ path: p, message: 'not an object' })
      if (typeof q.text !== 'string' || !q.text.length) issues.push({ path: `${p}.text`, message: 'missing' })
      if (!Array.isArray(q.source_ids) || q.source_ids.length === 0) {
        issues.push({ path: `${p}.source_ids`, message: 'must contain at least one source' })
      }
      if (typeof q.last_active_at !== 'string') issues.push({ path: `${p}.last_active_at`, message: 'must be a string' })
    })
  } else {
    issues.push({ path: '$.quiet_items', message: 'must be an array' })
  }

  return issues
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set')
    process.exit(1)
  }

  const system = readFileSync(join(PROMPT_DIR, 'system.md'), 'utf-8').trim()
  const consolidateTemplate = readFileSync(join(PROMPT_DIR, 'consolidate.md'), 'utf-8').trim()
  const schema = JSON.parse(readFileSync(join(PROMPT_DIR, 'schema.json'), 'utf-8'))
  const input = JSON.parse(readFileSync(args.inputPath, 'utf-8')) as SampleInput

  const userMessage = render(consolidateTemplate, buildVars(input))

  if (args.showPrompt) {
    console.log('━━━ system ━━━\n')
    console.log(system)
    console.log('\n━━━ user ━━━\n')
    console.log(userMessage)
    console.log('\n━━━ end prompt ━━━\n')
  }

  const client = new Anthropic({ apiKey })

  console.error(`[wm] model=${args.model}  input=${args.inputPath}`)
  const t0 = Date.now()

  const response = await client.messages.create({
    model: args.model,
    max_tokens: 2048,
    // Cache the system prompt — voice rarely changes, structure prompt iterates more.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  })

  const elapsed = Date.now() - t0

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    console.error('No text content in response')
    process.exit(1)
  }
  const raw = textBlock.text

  let jsonText: string
  let parsed: unknown
  try {
    jsonText = extractJson(raw)
    parsed = JSON.parse(jsonText)
  } catch (e) {
    console.error('Failed to parse JSON from model output:')
    console.error(raw)
    throw e
  }

  const issues = validate(parsed, schema)

  console.log('\n━━━ output ━━━\n')
  console.log(JSON.stringify(parsed, null, 2))
  console.log('\n━━━ rendering preview ━━━\n')
  printRendering(parsed as any, input.first_name, input.current_date)

  console.log('\n━━━ stats ━━━')
  const u = response.usage as any
  console.log(`elapsed:           ${elapsed}ms`)
  console.log(`input tokens:      ${u.input_tokens}`)
  console.log(`output tokens:     ${u.output_tokens}`)
  if (u.cache_creation_input_tokens != null) {
    console.log(`cache write:       ${u.cache_creation_input_tokens}`)
  }
  if (u.cache_read_input_tokens != null) {
    console.log(`cache read:        ${u.cache_read_input_tokens}`)
  }
  console.log(`stop reason:       ${response.stop_reason}`)

  if (issues.length > 0) {
    console.log('\n━━━ schema issues ━━━')
    for (const i of issues) console.log(`  ${i.path}: ${i.message}`)
    process.exit(2)
  } else {
    console.log('\n[wm] schema OK')
  }
}

function printRendering(out: any, firstName: string, currentDate: string) {
  const hour = new Date(currentDate + 'T08:00:00Z').getUTCHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const ctx = out.greeting_context ? ` — ${out.greeting_context}` : ''
  console.log(`${greeting}, ${firstName}.${ctx}\n`)

  console.log("This week, you're focused on:")
  if (!out.focus_items?.length) {
    console.log("  Quiet day. Nothing pressing on Lila's mind.")
  } else {
    for (const f of out.focus_items) console.log(`  • ${f.text}`)
  }

  if (out.people_threads?.length) {
    for (const t of out.people_threads) {
      console.log(`\nOpen with ${t.person}:`)
      for (const item of t.items) console.log(`  • ${item.text}`)
    }
  }

  if (out.quiet_items?.length) {
    console.log('\nQuiet but not forgotten:')
    for (const q of out.quiet_items) console.log(`  • ${q.text}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
