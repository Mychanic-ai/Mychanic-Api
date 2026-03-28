import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * Recovery token callback handler
 * Handles password recovery tokens and exchanges them for a session
 */
export const GET = withApiLogger(async (request: NextRequest) => {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const type = requestUrl.searchParams.get('type')

  // If we have a code parameter with recovery type, exchange it for a session
  if (code && type === 'recovery') {
    const cookieStore = await cookies()

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value
          },
          set(name: string, value: string, options: CookieOptions) {
            cookieStore.set({ name, value, ...options })
          },
          remove(name: string, options: CookieOptions) {
            cookieStore.set({ name, value: '', ...options })
          },
        },
      }
    )

    // Exchange the code for a session
    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code)

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || requestUrl.origin

    if (sessionError || !sessionData?.user) {
      logger.warn({ event: 'password_reset_callback', reason: sessionError?.message ?? 'no session returned' })
      return NextResponse.redirect(new URL('/login', siteUrl))
    }

    logger.setContext({ userId: sessionData.user.id })
    logger.info({ event: 'password_reset_callback', userId: sessionData.user.id })

    // Redirect to the site's reset-password page
    return NextResponse.redirect(new URL('/auth/reset-password', siteUrl))
  }

  // If no recovery token found, redirect to login on the site
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || requestUrl.origin
  logger.warn({ event: 'password_reset_callback', reason: 'missing code or type param' })
  return NextResponse.redirect(new URL('/login', siteUrl))
})
