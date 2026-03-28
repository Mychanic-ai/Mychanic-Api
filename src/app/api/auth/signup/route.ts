import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * POST /api/auth/signup
 * Full signup flow: creates auth user, logs terms acceptance, creates user record
 */
export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const { email, password, firstName, lastName, termsAccepted, clientIP } = await request.json()

    if (!email || !password || !firstName || !lastName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!termsAccepted) {
      return NextResponse.json({ error: 'You must accept the Terms of Service' }, { status: 400 })
    }

    const supabase = await createClient()

    // 1. Sign up with Supabase Auth
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
        },
      },
    })

    if (error) {
      logger.warn({ event: 'signup_failed', email, reason: error.message })
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    if (!data.user) {
      return NextResponse.json({ error: 'Failed to create account' }, { status: 500 })
    }

    // Check if email confirmation is required
    const requiresConfirmation = !data.session

    const admin = createAdminClient()

    // 2. Log terms acceptance
    await admin.from('terms_acceptance_log').insert({
      user_id: data.user.id,
      email: email.toLowerCase(),
      terms_version: '1.0',
      accepted_at: new Date().toISOString(),
      ip_address: clientIP || 'unknown',
      user_agent: request.headers.get('user-agent') || 'unknown',
    })

    // 3. Create user record in public.users
    const { error: insertError } = await admin.from('users').insert({
      id: data.user.id,
      shop_id: null,
      first_name: firstName,
      last_name: lastName,
      email: email.toLowerCase(),
      role: 'technician',
      is_active: true,
    })

    if (insertError) {
      logger.error({ event: 'supabase_error', table: 'users', operation: 'insert', code: insertError.code, message: insertError.message })
    }

    logger.info({ event: 'user_signup', userId: data.user.id, email })

    return NextResponse.json({
      success: true,
      userId: data.user.id,
      requiresConfirmation,
    })
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
})
