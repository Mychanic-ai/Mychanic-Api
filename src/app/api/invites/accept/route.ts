import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    // 1. Authenticate the user
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    logger.setContext({ userId: user.id })

    // 2. Parse input
    const body = await request.json()
    const { token } = body

    if (!token) {
      return NextResponse.json(
        { error: 'Token is required' },
        { status: 400 }
      )
    }

    // Validate token format
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      return NextResponse.json(
        { error: 'Invalid token format' },
        { status: 400 }
      )
    }

    const adminClient = createAdminClient()

    // 3. Fetch invite by token
    const { data: invite, error: inviteError } = await adminClient
      .from('invites')
      .select('id, email, role, shop_id, expires_at, used_at, invited_by')
      .eq('token', token)
      .maybeSingle()

    if (inviteError) {
      logger.error({ event: 'supabase_error', table: 'invites', operation: 'select', code: inviteError.code, message: inviteError.message })
      return NextResponse.json(
        { error: 'Failed to process invite' },
        { status: 500 }
      )
    }

    if (!invite) {
      return NextResponse.json(
        { error: 'Invite not found' },
        { status: 404 }
      )
    }

    // 4. Validate invite state
    if (invite.used_at) {
      return NextResponse.json(
        { error: 'This invite has already been used' },
        { status: 410 }
      )
    }

    if (new Date(invite.expires_at) < new Date()) {
      return NextResponse.json(
        { error: 'This invite has expired' },
        { status: 410 }
      )
    }

    logger.setContext({ userId: user.id, shopId: invite.shop_id })

    // 5. Email must match — critical security check
    if (user.email?.toLowerCase() !== invite.email.toLowerCase()) {
      return NextResponse.json(
        { error: 'This invite was sent to a different email address' },
        { status: 403 }
      )
    }

    // 6. Check if user already has access to this shop
    const { data: existingAccess } = await adminClient
      .from('user_shop_access')
      .select('id, role')
      .eq('user_id', user.id)
      .eq('shop_id', invite.shop_id)
      .maybeSingle()

    if (existingAccess) {
      // If they have an active record, it's a conflict
      return NextResponse.json(
        { error: 'You already have access to this shop', existing_role: existingAccess.role },
        { status: 409 }
      )
    }

    // 7. Verify shop still exists and is active
    const { data: shop } = await adminClient
      .from('shops')
      .select('id, name, status')
      .eq('id', invite.shop_id)
      .eq('status', 'active')
      .maybeSingle()

    if (!shop) {
      return NextResponse.json(
        { error: 'The shop associated with this invite is no longer available' },
        { status: 404 }
      )
    }

    // 8. Determine access level and permissions based on role
    const roleConfig = getRoleConfig(invite.role)

    // 9. Insert into user_shop_access — this is the ONLY place roles are assigned
    const { error: insertError } = await adminClient
      .from('user_shop_access')
      .insert({
        user_id: user.id,
        shop_id: invite.shop_id,
        role: invite.role,
        access_level: roleConfig.access_level,
        can_view_metrics: roleConfig.can_view_metrics,
        can_manage_settings: roleConfig.can_manage_settings,
        can_invite_users: roleConfig.can_invite_users,
        is_active: true,
        is_primary: false,
        granted_by: invite.invited_by,
        access_type: 'web',
      })

    if (insertError) {
      // Handle unique constraint violation
      if (insertError.code === '23505') {
        return NextResponse.json(
          { error: 'You already have access to this shop' },
          { status: 409 }
        )
      }
      logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'insert', code: insertError.code, message: insertError.message })
      return NextResponse.json(
        { error: 'Failed to grant shop access' },
        { status: 500 }
      )
    }

    logger.info({ event: 'shop_access_granted', userId: user.id, shopId: invite.shop_id, role: invite.role, grantedBy: invite.invited_by })

    // 10. Mark invite as used — single-use enforcement
    const { error: updateError } = await adminClient
      .from('invites')
      .update({ used_at: new Date().toISOString() })
      .eq('id', invite.id)
      .is('used_at', null) // Extra safety: only update if still unused (prevents race condition)

    if (updateError) {
      logger.error({ event: 'supabase_error', table: 'invites', operation: 'update', code: updateError.code, message: updateError.message })
      // Access was already granted — log but don't fail
    }

    // 11. Ensure user exists in public.users table
    const { data: publicUser } = await adminClient
      .from('users')
      .select('id')
      .eq('id', user.id)
      .maybeSingle()

    if (!publicUser) {
      // Create public.users record for users who arrived via Supabase invite email
      const metadata = user.user_metadata || {}
      const firstName =
        metadata.first_name ||
        metadata.given_name ||
        (user.email ?? invite.email).split('@')[0] ||
        'User'
      const lastName = metadata.last_name || metadata.family_name || ''

      const { error: profileError } = await adminClient
        .from('users')
        .insert({
          id: user.id,
          email: user.email ?? invite.email,
          first_name: firstName,
          last_name: lastName,
          role: invite.role,
          is_active: true,
          shop_id: null,
        })

      if (profileError) {
        logger.error({ event: 'supabase_error', table: 'users', operation: 'insert', code: profileError.code, message: profileError.message })
        // Don't block — shop access was granted successfully
      }
    }

    return NextResponse.json({
      success: true,
      shop: {
        id: shop.id,
        name: shop.name,
      },
      role: invite.role,
    })

  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
})

/**
 * Map invite role to user_shop_access permissions.
 * All role assignment happens here — server-side only.
 */
function getRoleConfig(role: string) {
  switch (role) {
    case 'manager':
      return {
        access_level: 'full_access',
        can_view_metrics: true,
        can_manage_settings: true,
        can_invite_users: true,
      }
    case 'technician':
      return {
        access_level: 'read_write',
        can_view_metrics: false,
        can_manage_settings: false,
        can_invite_users: false,
      }
    default:
      return {
        access_level: 'read_only',
        can_view_metrics: false,
        can_manage_settings: false,
        can_invite_users: false,
      }
  }
}
