#!/usr/bin/env tsx
/**
 * Working memory consolidation, end-to-end against Supabase.
 *
 * Reads recent activity for one user from the source tables, reads the
 * previous working_memory row, runs the consolidation prompt, validates
 * the output, and writes a new working_memory row. The iOS client picks
 * the new row up the next time it queries.
 *
 * For prompt iteration against synthetic data, use working-memory-consolidate.ts.
 *
 * Required env:
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY      (server-side, bypasses RLS — never ship to client)
 *
 * Usage:
 *   npm run wm:consolidate:supabase -- --user <uuid-or-email> [--first-name Matt]
 *     [--lookback 7] [--date 2026-05-01] [--model claude-sonnet-4-6]
 *     [--dry-run] [--show-input] [--show-prompt]
 */

import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  DEFAULT_MODEL,
  buildVars,
  printRendering,
  render,
  runConsolidation,
} from '../src/memory/consolidation.js'
import {
  loadConsolidationInput,
  makeServiceClient,
  resolveUserId,
  writeWorkingMemory,
} from '../src/memory/supabase.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const PROMPT_DIR = join(REPO_ROOT, 'prompts', 'working-memory')

interface CliArgs {
  user: string
  firstName: string
  lookbackDays: number
  currentDate: string
  model: string
  dryRun: boolean
  showInput: boolean
  showPrompt: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    firstName: 'there',
    lookbackDays: 7,
    currentDate: new Date().toISOString().slice(0, 10),
    model: DEFAULT_MODEL,
    dryRun: false,
    showInput: false,
    showPrompt: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--user' && argv[i + 1]) args.user = argv[++i]!
    else if (a === '--first-name' && argv[i + 1]) args.firstName = argv[++i]!
    else if (a === '--lookback' && argv[i + 1]) args.lookbackDays = Number(argv[++i])
    else if (a === '--date' && argv[i + 1]) args.currentDate = argv[++i]!
    else if (a === '--model' && argv[i + 1]) args.model = argv[++i]!
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--show-input') args.showInput = true
    else if (a === '--show-prompt') args.showPrompt = true
    else if (a === '--help' || a === '-h') {
      console.log(
        `Usage: npm run wm:consolidate:supabase -- --user <uuid-or-email> ` +
          `[--first-name Matt] [--lookback 7] [--date YYYY-MM-DD] ` +
          `[--model NAME] [--dry-run] [--show-input] [--show-prompt]`,
      )
      process.exit(0)
    }
  }
  if (!args.user) {
    console.error('Missing required --user')
    process.exit(1)
  }
  return args as CliArgs
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`${name} is not set`)
    process.exit(1)
  }
  return v
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = requireEnv('ANTHROPIC_API_KEY')
  const supabaseUrl = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

  const client = makeServiceClient({ url: supabaseUrl, serviceRoleKey })
  const userId = await resolveUserId({ client, userIdOrEmail: args.user })
  console.error(`[wm] user=${userId}  date=${args.currentDate}  lookback=${args.lookbackDays}d  model=${args.model}`)

  const input = await loadConsolidationInput({
    client,
    userId,
    firstName: args.firstName,
    currentDate: args.currentDate,
    lookbackDays: args.lookbackDays,
  })
  console.error(`[wm] loaded ${input.recent_activity.length} recent records, previous_wm=${input.previous_working_memory ? 'yes' : 'none'}`)

  if (args.showInput) {
    console.log('━━━ consolidation input ━━━\n')
    console.log(JSON.stringify(input, null, 2))
    console.log('\n━━━ end input ━━━\n')
  }

  const systemPrompt = readFileSync(join(PROMPT_DIR, 'system.md'), 'utf-8').trim()
  const consolidateTemplate = readFileSync(join(PROMPT_DIR, 'consolidate.md'), 'utf-8').trim()

  if (args.showPrompt) {
    console.log('━━━ system ━━━\n')
    console.log(systemPrompt)
    console.log('\n━━━ user ━━━\n')
    console.log(render(consolidateTemplate, buildVars(input)))
    console.log('\n━━━ end prompt ━━━\n')
  }

  const result = await runConsolidation({
    systemPrompt,
    consolidateTemplate,
    input,
    apiKey,
    model: args.model,
  })

  console.log('\n━━━ output ━━━\n')
  console.log(JSON.stringify(result.output, null, 2))
  console.log('\n━━━ rendering preview ━━━\n')
  printRendering(result.output, input.first_name, input.current_date)

  console.log('\n━━━ stats ━━━')
  const u = result.usage as any
  console.log(`elapsed:           ${result.elapsedMs}ms`)
  console.log(`input tokens:      ${u.input_tokens}`)
  console.log(`output tokens:     ${u.output_tokens}`)
  if (u.cache_creation_input_tokens != null) {
    console.log(`cache write:       ${u.cache_creation_input_tokens}`)
  }
  if (u.cache_read_input_tokens != null) {
    console.log(`cache read:        ${u.cache_read_input_tokens}`)
  }
  console.log(`stop reason:       ${result.stopReason}`)

  if (result.issues.length > 0) {
    console.log('\n━━━ schema issues ━━━')
    for (const i of result.issues) console.log(`  ${i.path}: ${i.message}`)
    console.log('\n[wm] aborting write — schema invalid')
    process.exit(2)
  }

  if (args.dryRun) {
    console.log('\n[wm] --dry-run set, not writing to working_memory')
    return
  }

  const written = await writeWorkingMemory({ client, userId, output: result.output })
  console.log(`\n[wm] wrote working_memory row ${written.id} at ${written.generated_at}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
