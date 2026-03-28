import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase-admin'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

interface RegisterRequest {
  userId: string
  firstName: string
  lastName: string
  email: string
}

/**
 * POST /api/auth/register
 * Creates a user record in public.users after signup
 * Uses service role to bypass RLS timing issues
 */
export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const body: RegisterRequest = await request.json()
    const { userId, firstName, lastName, email } = body

    // Validate required fields
    if (!userId || !firstName || !lastName || !email) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    const supabase = createAdminClient()

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single()

    logger.setContext({ userId })

    if (existingUser) {
      // User already exists, return success
      return NextResponse.json({ success: true, message: 'User already exists' })
    }

    // Create user record
    const { error: insertError } = await supabase.from('users').insert({
      id: userId,
      shop_id: null,
      first_name: firstName,
      last_name: lastName,
      email: email,
      role: 'technician',
      is_active: true,
    })

    if (insertError) {
      logger.error({ event: 'supabase_error', table: 'users', operation: 'insert', code: insertError.code, message: insertError.message })
      return NextResponse.json(
        { error: 'Failed to create user record', details: insertError.message },
        { status: 500 }
      )
    }

    logger.info({ event: 'user_signup', userId, email })

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
})
