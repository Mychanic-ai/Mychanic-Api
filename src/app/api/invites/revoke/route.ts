import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    logger.setContext({ userId: user.id })

    const body = await request.json()
    const { invite_id } = body

    if (!invite_id) {
      return NextResponse.json({ error: 'invite_id is required' }, { status: 400 })
    }

    const adminClient = createAdminClient()

    // Fetch the invite
    const { data: invite, error: fetchError } = await adminClient
      .from('invites')
      .select('id, shop_id, used_at, invited_by')
      .eq('id', invite_id)
      .maybeSingle()

    if (fetchError || !invite) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
    }

    if (invite.used_at) {
      return NextResponse.json({ error: 'Cannot revoke a used invite' }, { status: 409 })
    }

    // Global admins can revoke any invite.
    // Managers can only revoke invites for shops they manage.
    const { data: globalAdmin } = await adminClient
      .from('user_shop_access')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .eq('is_active', true)
      .limit(1)

    const isGlobalAdmin = globalAdmin && globalAdmin.length > 0

    if (!isGlobalAdmin) {
      const { data: access } = await adminClient
        .from('user_shop_access')
        .select('role')
        .eq('user_id', user.id)
        .eq('shop_id', invite.shop_id)
        .eq('is_active', true)
        .eq('role', 'manager')
        .maybeSingle()

      if (!access) {
        return NextResponse.json(
          { error: 'You do not have permission to revoke this invite' },
          { status: 403 }
        )
      }
    }

    // Hard delete — pending invites with no data impact
    const { error: deleteError } = await adminClient
      .from('invites')
      .delete()
      .eq('id', invite_id)

    if (deleteError) {
      logger.error({ event: 'supabase_error', table: 'invites', operation: 'delete', code: deleteError.code, message: deleteError.message })
      return NextResponse.json({ error: 'Failed to revoke invite' }, { status: 500 })
    }

    logger.info({ event: 'shop_access_revoked', revokedBy: user.id, shopId: invite.shop_id, inviteId: invite_id })

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
})
