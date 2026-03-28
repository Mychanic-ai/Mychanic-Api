import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * POST /api/auth/login
 * Authenticates a user with email and password.
 * Handles session cookie setting server-side so login events can be logged.
 */
export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const { email, password } = await request.json()

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })

    if (error || !data.user) {
      logger.warn({
        event: 'login',
        email: email.toLowerCase().trim(),
        reason: error?.message ?? 'no user returned',
      })
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    logger.setContext({ userId: data.user.id })
    logger.info({ event: 'login', userId: data.user.id, method: 'password' })

    return NextResponse.json({ success: true, userId: data.user.id })
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
})
