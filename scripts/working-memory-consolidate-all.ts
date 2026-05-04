#!/usr/bin/env tsx
/**
 * Run consolidation for every active user in one pass.
 *
 * "Active" = has at least one source-table row in the last
 * `--lookback` days. Users with no recent activity are skipped to
 * keep the LLM bill honest.
 *
 * Used by the nightly GitHub Actions workflow. Also runnable by hand:
 *
 *   ANTHROPIC_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npm run wm:consolidate:all
 *
 * Per user, looks up `first_name` from `auth.users.user_metadata`,
 * falling back to the local-part of the email, then to "there".
 *
 * Failures on one user do not abort the run. Each user's outcome
 * is logged. The exit code is 0 if at least one user succeeded
 * and no user errored, 1 if any user errored.
 */

import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  DEFAULT_MODEL,
  runConsolidation,
} from '../src/memory/consolidation.js'
import {
  loadConsolidationInput,
  makeServiceClient,
  writeWorkingMemory,
} from '../src/memory/supabase.js'
import type { SupabaseClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const PROMPT_DIR = join(REPO_ROOT, 'prompts', 'working-memory')

interface CliArgs {
  lookbackDays: number
  currentDate: string
  model: string
  dryRun: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    lookbackDays: 7,
    currentDate: new Date().toISOString().slice(0, 10),
    model: DEFAULT_MODEL,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--lookback' && argv[i + 1]) args.lookbackDays = Number(argv[++i])
    else if (a === '--date' && argv[i + 1]) args.currentDate = argv[++i]!
    else if (a === '--model' && argv[i + 1]) args.model = argv[++i]!
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--help' || a === '-h') {
      console.log(
        `Usage: npm run wm:consolidate:all -- ` +
          `[--lookback 7] [--date YYYY-MM-DD] [--model NAME] [--dry-run]`,
      )
      process.exit(0)
    }
  }
  return args
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`${name} is not set`)
    process.exit(1)
  }
  return v
}

async function listActiveUserIds(client: SupabaseClient, sinceISO: string): Promise<string[]> {
  // One query per source table. The Supabase JS client doesn't expose a
  // distinct-on helper, so we collect all user_ids and dedupe locally.
  const tables = ['captures', 'tasks', 'reflections', 'messages', 'events'] as const
  const ids = new Set<string>()
  for (const t of tables) {
    const { data, error } = await client
      .from(t)
      .select('user_id')
      .gte(t === 'events' ? 'starts_at' : 'created_at', sinceISO)
    if (error) {
      console.warn(`[wm] could not enumerate ${t}: ${error.message}`)
      continue
    }
    for (const row of data ?? []) {
      const uid = (row as { user_id: string }).user_id
      if (uid) ids.add(uid)
    }
  }
  return [...ids]
}

interface UserProfile {
  id: string
  email: string | null
  firstName: string
}

async function loadUserProfile(client: SupabaseClient, userId: string): Promise<UserProfile> {
  const { data, error } = await client.auth.admin.getUserById(userId)
  if (error || !data.user) throw new Error(`could not load auth.users for ${userId}: ${error?.message}`)
  const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>
  const fromMeta = typeof meta.first_name === 'string' ? meta.first_name.trim() : ''
  const email = data.user.email ?? null
  const fromEmail =
    fromMeta || !email
      ? ''
      : capitalize(email.split('@')[0]!.split('.')[0]!.split('+')[0]!)
  const firstName = fromMeta || fromEmail || 'there'
  return { id: userId, email, firstName }
}

function capitalize(s: string): string {
  if (!s) return s
  return s[0]!.toUpperCase() + s.slice(1).toLowerCase()
}

interface RunOutcome {
  userId: string
  email: string | null
  status: 'wrote' | 'skipped' | 'error'
  detail: string
}

async function consolidateOne(
  client: SupabaseClient,
  userId: string,
  systemPrompt: string,
  consolidateTemplate: string,
  apiKey: string,
  args: CliArgs,
): Promise<RunOutcome> {
  let profile: UserProfile
  try {
    profile = await loadUserProfile(client, userId)
  } catch (e) {
    return { userId, email: null, status: 'error', detail: (e as Error).message }
  }

  let input
  try {
    input = await loadConsolidationInput({
      client,
      userId,
      firstName: profile.firstName,
      currentDate: args.currentDate,
      lookbackDays: args.lookbackDays,
    })
  } catch (e) {
    return { userId, email: profile.email, status: 'error', detail: `loadInput: ${(e as Error).message}` }
  }

  if (input.recent_activity.length === 0) {
    return { userId, email: profile.email, status: 'skipped', detail: 'no recent activity' }
  }

  let result
  try {
    result = await runConsolidation({
      systemPrompt,
      consolidateTemplate,
      input,
      apiKey,
      model: args.model,
    })
  } catch (e) {
    return { userId, email: profile.email, status: 'error', detail: `runConsolidation: ${(e as Error).message}` }
  }

  if (result.issues.length > 0) {
    return {
      userId,
      email: profile.email,
      status: 'error',
      detail: `schema invalid: ${result.issues.map((i) => `${i.path}:${i.message}`).join(', ')}`,
    }
  }

  if (args.dryRun) {
    return { userId, email: profile.email, status: 'skipped', detail: 'dry-run' }
  }

  try {
    const written = await writeWorkingMemory({ client, userId, output: result.output })
    return { userId, email: profile.email, status: 'wrote', detail: written.id }
  } catch (e) {
    return { userId, email: profile.email, status: 'error', detail: `write: ${(e as Error).message}` }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = requireEnv('ANTHROPIC_API_KEY')
  const supabaseUrl = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

  const since = new Date(args.currentDate + 'T00:00:00Z')
  since.setUTCDate(since.getUTCDate() - args.lookbackDays)
  const sinceISO = since.toISOString()

  const client = makeServiceClient({ url: supabaseUrl, serviceRoleKey })
  const userIds = await listActiveUserIds(client, sinceISO)
  console.error(`[wm] date=${args.currentDate}  lookback=${args.lookbackDays}d  active_users=${userIds.length}`)

  if (userIds.length === 0) {
    console.error('[wm] nothing to do')
    return
  }

  const systemPrompt = readFileSync(join(PROMPT_DIR, 'system.md'), 'utf-8').trim()
  const consolidateTemplate = readFileSync(join(PROMPT_DIR, 'consolidate.md'), 'utf-8').trim()

  const outcomes: RunOutcome[] = []
  for (const uid of userIds) {
    const outcome = await consolidateOne(client, uid, systemPrompt, consolidateTemplate, apiKey, args)
    outcomes.push(outcome)
    const tag = outcome.email ?? outcome.userId.slice(0, 8)
    console.log(`[wm] ${outcome.status.padEnd(7)} ${tag}  ${outcome.detail}`)
  }

  const wrote = outcomes.filter((o) => o.status === 'wrote').length
  const skipped = outcomes.filter((o) => o.status === 'skipped').length
  const errored = outcomes.filter((o) => o.status === 'error').length
  console.log(`\n[wm] summary: wrote=${wrote}  skipped=${skipped}  errored=${errored}`)

  if (errored > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
