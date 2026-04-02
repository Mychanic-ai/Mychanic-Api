import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { logger } from '@/lib/logger'

/**
 * GET /api/auth/callback
 * OAuth callback handler — exchanges code for session, creates user record if needed,
 * then redirects to the site.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const next = request.nextUrl.searchParams.get('next') || '/dashboard'
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:8080'

  if (!code) {
    return NextResponse.redirect(`${siteUrl}/login?message=Missing authorization code`)
  }

  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (error || !data.user) {
      logger.error({ event: 'oauth_callback_error', message: error?.message })
      return NextResponse.redirect(`${siteUrl}/login?message=Authentication failed`)
    }

    // Create user record if it doesn't exist
    const admin = createAdminClient()
    const { data: existingUser } = await admin
      .from('users')
      .select('id')
      .eq('id', data.user.id)
      .single()

    if (!existingUser) {
      const metadata = data.user.user_metadata || {}
      await admin.from('users').insert({
        id: data.user.id,
        shop_id: null,
        first_name: metadata.full_name?.split(' ')[0] || metadata.first_name || '',
        last_name: metadata.full_name?.split(' ').slice(1).join(' ') || metadata.last_name || '',
        email: data.user.email,
        role: 'technician',
        is_active: true,
      })
    }

    logger.info({ event: 'oauth_login', userId: data.user.id, provider: 'google' })

    return NextResponse.redirect(`${siteUrl}${next}`)
  } catch (error) {
    logger.error({ event: 'oauth_callback_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.redirect(`${siteUrl}/login?message=Authentication failed`)
  }
}
