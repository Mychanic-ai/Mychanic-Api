import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * GET /api/invites/pending
 * Returns the most recent valid pending invite for the authenticated user's email.
 * Used by the /invite page after a new user authenticates via Supabase invite email
 * (where no token was present in the URL — only the bare /invite redirect).
 */
export const GET = withApiLogger(async () => {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user || !user.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    logger.setContext({ userId: user.id })

    const adminClient = createAdminClient()

    const { data: invite, error } = await adminClient
      .from('invites')
      .select('id, email, role, shop_id, expires_at, token, shops(name)')
      .eq('email', user.email.toLowerCase())
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      logger.error({ event: 'supabase_error', table: 'invites', operation: 'select', code: error.code, message: error.message })
      return NextResponse.json({ error: 'Failed to look up invite' }, { status: 500 })
    }

    if (!invite) {
      return NextResponse.json({ invite: null })
    }

    const shopName = (invite.shops as { name?: string } | null)?.name ?? null

    return NextResponse.json({
      invite: {
        token: invite.token,
        role: invite.role,
        shop_name: shopName,
        expires_at: invite.expires_at,
      },
    })
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
})
