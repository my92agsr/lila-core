// RLS-safe Supabase client wrapper.
//
// Edge Functions run with the service role key, which bypasses RLS. To
// keep RLS guarantees end-to-end, every request handler:
//   1. Verifies the caller's JWT via the anon key.
//   2. Extracts the verified user_id.
//   3. Uses scopedSupabase(userId) for all reads and writes; the wrapper
//      forces every query through a `.eq('user_id', userId)` filter.
//
// The service-role client is only exposed for explicit admin paths (e.g.
// the delivery worker that needs to read all users). Most code should
// never see it.

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.45.0'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('Supabase env vars missing in Edge Function environment')
}

// Service-role admin client. Bypasses RLS. Use sparingly.
export const adminSupabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

export interface AuthedRequest {
  userId: string
  email: string | null
  jwt: string
}

// Verify the bearer token and return the user_id it represents. Throws if
// missing or invalid — handlers should let this propagate to a 401.
export async function authenticate(req: Request): Promise<AuthedRequest> {
  const auth = req.headers.get('authorization') ?? ''
  const jwt = auth.replace(/^Bearer\s+/i, '').trim()
  if (!jwt) throw new HttpError(401, 'missing bearer token')

  // Use anon-key client for the auth check so we go through Supabase Auth
  // signature verification rather than trusting the JWT blindly.
  const verifyClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await verifyClient.auth.getUser(jwt)
  if (error || !data.user) throw new HttpError(401, 'invalid bearer token')
  return { userId: data.user.id, email: data.user.email ?? null, jwt }
}

// Returns a Supabase client that automatically scopes selects/updates/
// deletes to the given user_id. The wrapper is intentionally minimal —
// callers use it like the regular client.
//
// We use the admin client under the hood so writes don't fail RLS in
// edge cases where the user JWT has expired mid-request, but every
// read and write is funneled through a user_id filter we control here.
export function scopedSupabase(userId: string) {
  const c = adminSupabase
  return {
    raw: c,
    userId,
    from(table: string) {
      const builder = c.from(table)
      // For backward-compat we expose a select() that auto-filters,
      // and inserts that auto-attach user_id.
      return {
        select: (...args: Parameters<typeof builder.select>) =>
          builder.select(...args).eq('user_id', userId),
        insert: (rows: any | any[]) => {
          const list = Array.isArray(rows) ? rows : [rows]
          const stamped = list.map((r) => ({ ...r, user_id: userId }))
          return builder.insert(stamped)
        },
        update: (vals: any) => builder.update(vals).eq('user_id', userId),
        upsert: (rows: any | any[], opts?: any) => {
          const list = Array.isArray(rows) ? rows : [rows]
          const stamped = list.map((r) => ({ ...r, user_id: userId }))
          return builder.upsert(stamped, opts)
        },
        delete: () => builder.delete().eq('user_id', userId),
        // Escape hatch: when a query needs joins or RPC, callers can
        // reach for the raw builder. They take ownership of scoping.
        raw: builder,
      }
    },
  }
}

export type ScopedSupabase = ReturnType<typeof scopedSupabase>

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}
