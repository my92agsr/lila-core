#!/usr/bin/env tsx
/**
 * Google Calendar → public.events sync.
 *
 * Pulls events from one user's Google Calendar (default: primary) for
 * a window around today and reconciles them against public.events.
 * Idempotent — re-running is a no-op.
 *
 * Single-user dogfood model: one OAuth refresh token per CLI run = one
 * Google account → one Supabase user. Per-user OAuth storage in
 * Supabase comes when there's more than one user.
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY      (service role, bypasses RLS)
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REFRESH_TOKEN
 *
 * Usage:
 *   npm run gcal:sync -- --user <uuid-or-email>
 *     [--calendar primary] [--past 7] [--future 30]
 *     [--date 2026-05-01] [--dry-run]
 */

import {
    exchangeRefreshToken,
    fetchCalendarEvents,
    mapEvents,
    reconcile,
} from '../src/connectors/google-calendar/index.js'
import { makeServiceClient, resolveUserId } from '../src/memory/supabase.js'

interface CliArgs {
    user: string
    calendar: string
    pastDays: number
    futureDays: number
    currentDate: string
    dryRun: boolean
}

function parseArgs(argv: string[]): CliArgs {
    const args: Partial<CliArgs> = {
        calendar: 'primary',
        pastDays: 7,
        futureDays: 30,
        currentDate: new Date().toISOString().slice(0, 10),
        dryRun: false,
    }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--user' && argv[i + 1]) args.user = argv[++i]!
        else if (a === '--calendar' && argv[i + 1]) args.calendar = argv[++i]!
        else if (a === '--past' && argv[i + 1]) args.pastDays = Number(argv[++i])
        else if (a === '--future' && argv[i + 1]) args.futureDays = Number(argv[++i])
        else if (a === '--date' && argv[i + 1]) args.currentDate = argv[++i]!
        else if (a === '--dry-run') args.dryRun = true
        else if (a === '--help' || a === '-h') {
            console.log(
                `Usage: npm run gcal:sync -- --user <uuid-or-email> ` +
                    `[--calendar primary] [--past 7] [--future 30] ` +
                    `[--date YYYY-MM-DD] [--dry-run]`,
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
    const supabaseUrl = requireEnv('SUPABASE_URL')
    const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
    const clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID')
    const clientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET')
    const refreshToken = requireEnv('GOOGLE_OAUTH_REFRESH_TOKEN')

    const client = makeServiceClient({ url: supabaseUrl, serviceRoleKey })
    const userId = await resolveUserId({ client, userIdOrEmail: args.user })

    const center = new Date(args.currentDate + 'T00:00:00Z')
    const timeMin = new Date(center)
    timeMin.setUTCDate(timeMin.getUTCDate() - args.pastDays)
    const timeMax = new Date(center)
    timeMax.setUTCDate(timeMax.getUTCDate() + args.futureDays)

    console.error(
        `[gcal] user=${userId}  calendar=${args.calendar}  ` +
            `window=${timeMin.toISOString()}..${timeMax.toISOString()}`,
    )

    const access = await exchangeRefreshToken({ clientId, clientSecret, refreshToken })
    console.error(`[gcal] access token acquired (expires in ${Math.round((access.expiresAt - Date.now()) / 1000)}s)`)

    const raw = await fetchCalendarEvents({
        accessToken: access.token,
        calendarId: args.calendar,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
    })
    console.error(`[gcal] fetched ${raw.length} events from google`)

    const { mapped, skipped: mapSkipped } = mapEvents(raw)
    console.error(`[gcal] mapped ${mapped.length} (skipped ${mapSkipped} cancelled/no-start)`)

    if (args.dryRun) {
        console.log(`[gcal] --dry-run set, not writing`)
        for (const m of mapped.slice(0, 10)) {
            console.log(`  ${m.starts_at}  ${m.title}`)
        }
        if (mapped.length > 10) console.log(`  … and ${mapped.length - 10} more`)
        return
    }

    const outcome = await reconcile(client, userId, mapped)
    console.log(
        `[gcal] inserted=${outcome.inserted}  updated=${outcome.updated}  ` +
            `unchanged=${outcome.unchanged}`,
    )
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
