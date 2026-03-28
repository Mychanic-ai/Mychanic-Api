import { createAdminClient } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const body = await request.json()
    const { firstName, lastName, password, token } = body

    // Validate all required fields
    if (!firstName || !lastName || !password || !token) {
      return NextResponse.json(
        { error: 'Missing required fields: firstName, lastName, password, token' },
        { status: 400 }
      )
    }

    // Get authenticated user
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user?.email) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    logger.setContext({ userId: user.id })

    // Use admin client for all operations
    const admin = createAdminClient()

    // 1. Fetch and validate the invite by token AND email
    // This ensures the invite belongs to the authenticated user
    const cleanToken = token.trim()
    const { data: invite, error: inviteError } = await admin
      .from('invites')
      .select('*')
      .eq('token', cleanToken)
      .eq('email', user.email.toLowerCase())
      .maybeSingle()

    if (inviteError) {
      logger.error({ event: 'supabase_error', table: 'invites', operation: 'select', code: inviteError.code, message: inviteError.message })
      return NextResponse.json(
        { error: 'Failed to process invite' },
        { status: 500 }
      )
    }

    if (!invite) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
    }

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

    const inviteEmail = invite.email.toLowerCase()

    // 2. Check if auth user already exists (created by generateLink)
    // If it does, just update with password. Otherwise create new.
    const { data: existingUsers } = await admin.auth.admin.listUsers()
    const existingUser = existingUsers?.users?.find(
      (u) => u.email?.toLowerCase() === inviteEmail
    )

    let userId: string

    if (existingUser) {
      // User already exists, just update password and metadata
      userId = existingUser.id
      const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
        password: password,
        user_metadata: {
          first_name: firstName,
          last_name: lastName,
        },
      })

      if (updateError) {
        return NextResponse.json(
          { error: updateError.message || 'Failed to update account' },
          { status: 400 }
        )
      }
    } else {
      // Create new auth user with email and password
      const { data: authData, error: authError } = await admin.auth.admin.createUser({
        email: inviteEmail,
        password: password,
        user_metadata: {
          first_name: firstName,
          last_name: lastName,
        },
        email_confirm: true,
      })

      if (authError) {
        return NextResponse.json(
          { error: authError.message || 'Failed to create account' },
          { status: 400 }
        )
      }

      userId = authData.user.id
    }

    // 3. Grant shop access
    const { error: accessError } = await admin
      .from('user_shop_access')
      .insert({
        user_id: userId,
        shop_id: invite.shop_id,
        role: invite.role,
        access_level: invite.role === 'manager' ? 'full_access' : 'read_write',
        can_view_metrics: invite.role === 'manager',
        can_manage_settings: invite.role === 'manager',
        can_invite_users: invite.role === 'manager',
        is_active: true,
        is_primary: true,
        granted_by: invite.invited_by,
        access_type: 'web',
      })

    if (accessError) {
      return NextResponse.json(
        { error: 'Failed to grant shop access' },
        { status: 500 }
      )
    }

    // 4. Create user in public.users table
    // For safety, also store shop_id and role here as a backup reference
    const { error: userError } = await admin.from('users').insert({
      id: userId,
      email: inviteEmail,
      first_name: firstName,
      last_name: lastName,
      shop_id: invite.shop_id,  // Store for quick reference and safety
      role: invite.role,        // Store for quick reference and safety
      is_active: true,
    })

    if (userError) {
      return NextResponse.json(
        { error: 'Failed to create user profile' },
        { status: 500 }
      )
    }

    // 5. Mark invite as used
    await admin
      .from('invites')
      .update({ used_at: new Date().toISOString() })
      .eq('id', invite.id)

    logger.setContext({ userId, shopId: invite.shop_id })
    logger.info({ event: 'invite_setup_completed', userId, shopId: invite.shop_id, role: invite.role })

    return NextResponse.json({
      success: true,
      user: {
        id: userId,
        email: inviteEmail,
        firstName,
        lastName,
      },
      shop: {
        id: invite.shop_id,
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
