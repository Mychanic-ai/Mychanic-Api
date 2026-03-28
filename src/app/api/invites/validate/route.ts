import { createAdminClient } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

export const GET = withApiLogger(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('token')

    if (!token) {
      return NextResponse.json(
        { valid: false, error: 'Token is required' },
        { status: 400 }
      )
    }

    // Validate token format (should be 64 hex chars = 32 bytes)
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return NextResponse.json(
        { valid: false, error: 'Invalid token format' },
        { status: 400 }
      )
    }

    const adminClient = createAdminClient()

    const { data: invite, error } = await adminClient
      .from('invites')
      .select('email, role, expires_at, used_at, shop_id')
      .eq('token', token)
      .maybeSingle()

    if (error) {
      logger.error({ event: 'supabase_error', table: 'invites', operation: 'select', code: error.code, message: error.message })
      return NextResponse.json(
        { valid: false, error: 'Failed to validate invite' },
        { status: 500 }
      )
    }

    if (!invite) {
      return NextResponse.json({ valid: false, error: 'Invite not found' })
    }

    if (invite.used_at) {
      return NextResponse.json({ valid: false, error: 'Invite has already been used' })
    }

    if (new Date(invite.expires_at) < new Date()) {
      return NextResponse.json({ valid: false, error: 'Invite has expired' })
    }

    // Fetch shop name for a friendlier response
    const { data: shop } = await adminClient
      .from('shops')
      .select('name')
      .eq('id', invite.shop_id)
      .maybeSingle()

    return NextResponse.json({
      valid: true,
      email: invite.email,
      role: invite.role,
      shop_name: shop?.name || null,
    })

  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { valid: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
})
