#!/usr/bin/env tsx
/**
 * Working memory consolidation — local CLI for prompt iteration.
 *
 * Renders prompts/working-memory/{system,consolidate}.md against an input
 * JSON file (default: prompts/working-memory/sample-input.json), runs the
 * result through Claude with prompt caching on the system prompt, validates
 * the output against schema.json, and pretty-prints it.
 *
 * For consolidating a real user against Supabase data, see
 * working-memory-consolidate-supabase.ts.
 *
 * Usage:
 *   npm run wm:consolidate
 *   npm run wm:consolidate -- --input path/to/data.json
 *   npm run wm:consolidate -- --model claude-opus-4-7
 *   npm run wm:consolidate -- --show-prompt
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
import type { ConsolidationInput } from '../src/memory/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const PROMPT_DIR = join(REPO_ROOT, 'prompts', 'working-memory')

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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set')
    process.exit(1)
  }

  const systemPrompt = readFileSync(join(PROMPT_DIR, 'system.md'), 'utf-8').trim()
  const consolidateTemplate = readFileSync(join(PROMPT_DIR, 'consolidate.md'), 'utf-8').trim()
  const input = JSON.parse(readFileSync(args.inputPath, 'utf-8')) as ConsolidationInput

  if (args.showPrompt) {
    console.log('━━━ system ━━━\n')
    console.log(systemPrompt)
    console.log('\n━━━ user ━━━\n')
    console.log(render(consolidateTemplate, buildVars(input)))
    console.log('\n━━━ end prompt ━━━\n')
  }

  console.error(`[wm] model=${args.model}  input=${args.inputPath}`)
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
    process.exit(2)
  } else {
    console.log('\n[wm] schema OK')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
