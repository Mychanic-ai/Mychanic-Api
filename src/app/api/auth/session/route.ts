import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

/**
 * GET /api/auth/session
 * Returns the current session if one exists
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { session }, error } = await supabase.auth.getSession()

  if (error || !session) {
    return NextResponse.json({ error: 'No active session' }, { status: 401 })
  }

  return NextResponse.json({ session: { user: session.user } })
}
