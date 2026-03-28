import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

/**
 * GET /api/auth/oauth?provider=google&redirectTo=...
 * Initiates OAuth flow by redirecting to the provider
 */
export async function GET(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get('provider')
  const redirectTo = request.nextUrl.searchParams.get('redirectTo')

  if (!provider) {
    return NextResponse.json({ error: 'Missing provider' }, { status: 400 })
  }

  const supabase = await createClient()

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: provider as 'google',
    options: {
      redirectTo: redirectTo || `${process.env.NEXT_PUBLIC_API_URL}/api/auth/callback`,
    },
  })

  if (error || !data.url) {
    return NextResponse.json({ error: error?.message || 'Failed to initiate OAuth' }, { status: 500 })
  }

  return NextResponse.redirect(data.url)
}
