import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

export const GET = withApiLogger(async () => {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    logger.setContext({ userId: user.id })

    const adminClient = createAdminClient()

    // Check if user is a system admin
    const { data: userData } = await adminClient
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    const isSystemAdmin = userData?.role === 'admin'

    // If system admin, fetch all invites. Otherwise, only fetch for managed shops
    if (isSystemAdmin) {
      const { data: invites, error: invitesError } = await adminClient
        .from('invites')
        .select(`
          id,
          email,
          role,
          shop_id,
          token,
          expires_at,
          used_at,
          created_at,
          invited_by,
          shops ( name )
        `)
        .order('created_at', { ascending: false })
        .limit(200)

      if (invitesError) {
        logger.error({ event: 'supabase_error', table: 'invites', operation: 'select', code: invitesError.code, message: invitesError.message })
        return NextResponse.json({ error: 'Failed to fetch invites' }, { status: 500 })
      }

      // Fetch inviter emails from public.users table
      const inviterIds = Array.from(new Set((invites || []).map((inv) => inv.invited_by).filter(Boolean)))
      const { data: inviters, error: invitersError } = await adminClient
        .from('users')
        .select('id, email')
        .in('id', inviterIds)

      if (invitersError) {
        logger.error({ event: 'supabase_error', table: 'users', operation: 'select', code: invitersError.code, message: invitersError.message })
        return NextResponse.json({ error: 'Failed to fetch inviter info' }, { status: 500 })
      }

      const inviterEmailMap = new Map((inviters || []).map((u) => [u.id, u.email]))

      const now = new Date()

      const formatted = (invites || []).map((invite) => {
        let status: 'pending' | 'used' | 'expired'
        if (invite.used_at) {
          status = 'used'
        } else if (new Date(invite.expires_at) < now) {
          status = 'expired'
        } else {
          status = 'pending'
        }

        return {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          shop_id: invite.shop_id,
          // @ts-expect-error — Supabase join typing
          shop_name: invite.shops?.name ?? null,
          status,
          created_at: invite.created_at,
          expires_at: invite.expires_at,
          used_at: invite.used_at,
          invited_by: invite.invited_by,
          invited_by_email: inviterEmailMap.get(invite.invited_by) ?? null,
        }
      })

      return NextResponse.json({ invites: formatted })
    }

    // Non-admin: Get all shops this user is a manager/owner/admin of
    const { data: managedShops, error: shopsError } = await adminClient
      .from('user_shop_access')
      .select('shop_id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .in('role', ['manager', 'admin'])

    if (shopsError) {
      logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'select', code: shopsError.code, message: shopsError.message })
      return NextResponse.json({ error: 'Failed to fetch shop access' }, { status: 500 })
    }

    if (!managedShops || managedShops.length === 0) {
      return NextResponse.json({ invites: [] })
    }

    const shopIds = managedShops.map((s) => s.shop_id)

    // Fetch invites for those shops
    const { data: invites, error: invitesError } = await adminClient
      .from('invites')
      .select(`
        id,
        email,
        role,
        shop_id,
        token,
        expires_at,
        used_at,
        created_at,
        invited_by,
        shops ( name )
      `)
      .in('shop_id', shopIds)
      .order('created_at', { ascending: false })
      .limit(200)

    if (invitesError) {
      logger.error({ event: 'supabase_error', table: 'invites', operation: 'select', code: invitesError.code, message: invitesError.message })
      return NextResponse.json({ error: 'Failed to fetch invites' }, { status: 500 })
    }

    // Fetch inviter emails from public.users table
    const inviterIds = Array.from(new Set((invites || []).map((inv) => inv.invited_by).filter(Boolean)))
    const { data: inviters, error: invitersError } = await adminClient
      .from('users')
      .select('id, email')
      .in('id', inviterIds)

    if (invitersError) {
      logger.error({ event: 'supabase_error', table: 'users', operation: 'select', code: invitersError.code, message: invitersError.message })
      return NextResponse.json({ error: 'Failed to fetch inviter info' }, { status: 500 })
    }

    const inviterEmailMap = new Map((inviters || []).map((u) => [u.id, u.email]))

    const now = new Date()

    const formatted = (invites || []).map((invite) => {
      let status: 'pending' | 'used' | 'expired'
      if (invite.used_at) {
        status = 'used'
      } else if (new Date(invite.expires_at) < now) {
        status = 'expired'
      } else {
        status = 'pending'
      }

      return {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        shop_id: invite.shop_id,
        // @ts-expect-error — Supabase join typing
        shop_name: invite.shops?.name ?? null,
        status,
        created_at: invite.created_at,
        expires_at: invite.expires_at,
        used_at: invite.used_at,
        invited_by: invite.invited_by,
        invited_by_email: inviterEmailMap.get(invite.invited_by) ?? null,
      }
    })

    return NextResponse.json({ invites: formatted })
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
})
