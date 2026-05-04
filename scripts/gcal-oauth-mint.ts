#!/usr/bin/env tsx
/**
 * One-shot helper to mint a Google OAuth refresh token for the Calendar
 * connector, using Desktop OAuth client credentials.
 *
 * Desktop OAuth clients use a loopback redirect (http://127.0.0.1:<port>)
 * rather than a hosted redirect URI — which means you cannot use the
 * Google OAuth Playground with a Desktop client. This script implements
 * the loopback flow directly: spins up a temporary local server, opens
 * the consent screen in your browser, captures the auth code, exchanges
 * it for tokens, and prints the refresh token.
 *
 * Run once. Save the refresh token to GitHub secrets as
 * GOOGLE_OAUTH_REFRESH_TOKEN. Refresh tokens don't expire so long as
 * you keep using them; revoke from your Google account settings.
 *
 * Usage:
 *   GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… \
 *     npm run gcal:oauth:mint
 */

import { createServer } from 'http'
import { exec } from 'child_process'
import { AddressInfo } from 'net'

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

function requireEnv(name: string): string {
    const v = process.env[name]
    if (!v) {
        console.error(`${name} is not set`)
        process.exit(1)
    }
    return v
}

async function main() {
    const clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID')
    const clientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET')

    // Listen on an OS-assigned port so we don't collide with anything.
    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
        (resolve, reject) => {
            let redirectUri = ''
            const server = createServer((req, res) => {
                const url = new URL(req.url ?? '/', 'http://localhost')
                if (url.pathname !== '/callback') {
                    res.writeHead(404).end()
                    return
                }
                const code = url.searchParams.get('code')
                const error = url.searchParams.get('error')
                if (error) {
                    res.writeHead(400, { 'Content-Type': 'text/html' })
                    res.end(`<h1>OAuth error</h1><p>${escapeHtml(error)}</p>`)
                    server.close()
                    reject(new Error(`google returned error: ${error}`))
                    return
                }
                if (!code) {
                    res.writeHead(400, { 'Content-Type': 'text/html' })
                    res.end(`<h1>Missing code</h1>`)
                    server.close()
                    reject(new Error('no code in callback'))
                    return
                }
                res.writeHead(200, { 'Content-Type': 'text/html' })
                res.end(
                    `<h1>Done.</h1><p>You can close this tab and return to the terminal.</p>`,
                )
                server.close()
                resolve({ code, redirectUri })
            })

            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as AddressInfo).port
                redirectUri = `http://127.0.0.1:${port}/callback`
                const url = new URL(AUTH_URL)
                url.searchParams.set('client_id', clientId)
                url.searchParams.set('redirect_uri', redirectUri)
                url.searchParams.set('response_type', 'code')
                url.searchParams.set('scope', SCOPE)
                url.searchParams.set('access_type', 'offline')
                url.searchParams.set('prompt', 'consent')

                console.error(`[oauth] listening on ${redirectUri}`)
                console.error(`[oauth] opening consent screen…`)
                console.error(`[oauth] if your browser doesn't open, paste this URL:\n  ${url.toString()}`)
                tryOpen(url.toString())
            })

            server.on('error', reject)
        },
    )

    console.error(`[oauth] code received, exchanging for tokens…`)

    const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        }),
    })

    if (!tokenRes.ok) {
        const text = await tokenRes.text()
        console.error(`[oauth] token exchange failed (${tokenRes.status}): ${text}`)
        process.exit(1)
    }

    const json = (await tokenRes.json()) as {
        access_token: string
        refresh_token?: string
        expires_in: number
        scope: string
    }

    if (!json.refresh_token) {
        console.error(
            `[oauth] google did not return a refresh_token. This usually means ` +
                `you've consented to this client before. Revoke access at ` +
                `https://myaccount.google.com/permissions and re-run.`,
        )
        process.exit(1)
    }

    console.log(`\n━━━ refresh token ━━━\n`)
    console.log(json.refresh_token)
    console.log(`\n━━━ end ━━━\n`)
    console.log(`scope:   ${json.scope}`)
    console.log(`save as: GOOGLE_OAUTH_REFRESH_TOKEN`)
}

function tryOpen(url: string) {
    const cmd =
        process.platform === 'darwin' ? `open "${url}"`
        : process.platform === 'win32' ? `start "" "${url}"`
        : `xdg-open "${url}"`
    exec(cmd, (err) => {
        if (err) {
            // Browser open is best-effort; the URL is already printed above.
        }
    })
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&': return '&amp;'
            case '<': return '&lt;'
            case '>': return '&gt;'
            case '"': return '&quot;'
            case "'": return '&#39;'
            default: return c
        }
    })
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
