import { createClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

const signoutHandler = async (_request: NextRequest): Promise<Response> => {
  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      logger.setContext({ userId: user.id })
      logger.info({ event: 'user_signout', userId: user.id })
    }

    // Sign out from Supabase
    const { error } = await supabase.auth.signOut()

    if (error) {
      logger.error({ event: 'supabase_error', operation: 'signOut', message: error.message })
      // Continue with cookie clearing even if Supabase signout fails
    }

    // Return 200 — the client (site) is responsible for redirecting after signout
    const response = NextResponse.json({ success: true })

    // Clear all auth-related cookies
    const cookiesToClear = [
      'sb-access-token',
      'sb-refresh-token',
      'mychanic-auth'
    ]

    cookiesToClear.forEach(cookieName => {
      response.cookies.delete(cookieName)
      response.cookies.set(cookieName, '', {
        maxAge: 0,
        path: '/',
      })
    })

    return response
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ success: false }, { status: 500 })
  }
}

export const POST = withApiLogger(signoutHandler)
export const GET = withApiLogger(signoutHandler)
