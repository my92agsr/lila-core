// OAuth: refresh_token → access_token. Single-user dogfood model.
//
// When multi-user lands we'll store per-user refresh tokens in Supabase
// and pass the user id in here; for now one refresh token in env covers
// the only person using the app.

export interface GoogleOAuthConfig {
    clientId: string
    clientSecret: string
    refreshToken: string
}

export interface AccessToken {
    token: string
    expiresAt: number
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export async function exchangeRefreshToken(cfg: GoogleOAuthConfig): Promise<AccessToken> {
    const body = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        grant_type: 'refresh_token',
    })
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(`google oauth ${res.status}: ${text}`)
    }
    const json = (await res.json()) as { access_token: string; expires_in: number }
    return {
        token: json.access_token,
        expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    }
}
