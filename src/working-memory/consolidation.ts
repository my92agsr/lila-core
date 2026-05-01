// Pure consolidation logic — render prompts, call Claude, parse + validate
// the output. No filesystem reads, no Supabase. Inputs come from callers
// (CLI loads from JSON; the Supabase script loads from postgres).

import Anthropic from '@anthropic-ai/sdk'
import type { ConsolidationInput, ConsolidationOutput } from './types.js'

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

export interface RunConsolidationArgs {
  systemPrompt: string
  consolidateTemplate: string
  input: ConsolidationInput
  apiKey: string
  model?: string
}

export interface RunConsolidationResult {
  output: ConsolidationOutput
  raw: string
  elapsedMs: number
  usage: Anthropic.Messages.Usage
  stopReason: Anthropic.Messages.Message['stop_reason']
  issues: ValidationIssue[]
}

export async function runConsolidation(
  args: RunConsolidationArgs,
): Promise<RunConsolidationResult> {
  const userMessage = render(args.consolidateTemplate, buildVars(args.input))

  const client = new Anthropic({ apiKey: args.apiKey })
  const t0 = Date.now()

  const response = await client.messages.create({
    model: args.model ?? DEFAULT_MODEL,
    max_tokens: 2048,
    // Cache the system prompt — voice rarely changes; the structure prompt iterates more.
    system: [{ type: 'text', text: args.systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  })

  const elapsedMs = Date.now() - t0

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text content in Claude response')
  }
  const raw = textBlock.text
  const jsonText = extractJson(raw)
  const parsed = JSON.parse(jsonText) as ConsolidationOutput
  const issues = validate(parsed)

  return {
    output: parsed,
    raw,
    elapsedMs,
    usage: response.usage,
    stopReason: response.stop_reason,
    issues,
  }
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Template references {{${key}}} but no value was provided`)
    }
    return vars[key]!
  })
}

export function buildVars(input: ConsolidationInput): Record<string, string> {
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

export function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1]!.trim()
  const objMatch = text.match(/\{[\s\S]*\}/)
  if (objMatch) return objMatch[0]
  throw new Error('No JSON object found in model output')
}

export interface ValidationIssue {
  path: string
  message: string
}

// Lightweight structural check matching the constraints in consolidate.md /
// schema.json. Catches the failure modes that matter most: missing required
// fields, max-array overruns, missing source_ids, malformed source entries.
// For a real validator wire in ajv when this moves behind an HTTP endpoint.
export function validate(parsed: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof parsed !== 'object' || parsed === null) {
    issues.push({ path: '$', message: 'output is not a JSON object' })
    return issues
  }
  const root = parsed as Record<string, unknown>

  for (const req of ['focus_items', 'people_threads', 'quiet_items']) {
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

export function printRendering(out: ConsolidationOutput, firstName: string, currentDate: string): void {
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
