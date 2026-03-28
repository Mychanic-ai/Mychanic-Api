import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

/**
 * GET /api/user-settings
 * Returns the current user's settings
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('user_settings')
    .select('settings')
    .eq('user_id', user.id)
    .single()

  if (error || !data) {
    // Return defaults if no settings row exists
    return NextResponse.json({
      settings: { theme: 'light', notifications_enabled: true, language: 'en' },
    })
  }

  return NextResponse.json({ settings: data.settings })
}

/**
 * POST /api/user-settings
 * Upserts the current user's settings
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { settings } = await request.json()

  const { error } = await supabase
    .from('user_settings')
    .upsert({ user_id: user.id, settings }, { onConflict: 'user_id' })

  if (error) {
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
