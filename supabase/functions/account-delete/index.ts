// POST /account/delete
// Body: {} (authed user)
//
// Apple requires apps to offer in-app account deletion. We delete the
// auth.users row via admin; ON DELETE CASCADE on every table fans the
// delete out across the schema. The user is signed out client-side
// before invoking.

import { authenticate, adminSupabase } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse } from '../_shared/http.ts'

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  // Belt and suspenders: explicitly delete the profiles row first so any
  // RLS-only-deletable rows that don't cascade through auth.users are
  // also wiped. Cascade does the heavy lifting.
  await adminSupabase.from('profiles').delete().eq('id', userId)
  const { error } = await adminSupabase.auth.admin.deleteUser(userId)
  if (error) {
    return jsonResponse({ error: error.message }, 500)
  }
  return jsonResponse({ deleted: true })
}))
