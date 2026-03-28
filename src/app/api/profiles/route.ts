import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

/**
 * GET /api/profiles?shop_id=...
 * Returns all profiles for a given shop
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const shopId = request.nextUrl.searchParams.get('shop_id')
  if (!shopId) {
    return NextResponse.json({ error: 'shop_id is required' }, { status: 400 })
  }

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('shop_id', shopId)

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch profiles' }, { status: 500 })
  }

  return NextResponse.json({ profiles })
}

/**
 * POST /api/profiles
 * Creates a new profile
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { shopId, firstName, lastName, role, avatarColor, avatarEmoji } = await request.json()

  if (!shopId || !firstName || !lastName) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .insert({
      user_id: user.id,
      shop_id: shopId,
      first_name: firstName,
      last_name: lastName,
      role: role || 'technician',
      avatar_color: avatarColor,
      avatar_emoji: avatarEmoji,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: 'Failed to create profile' }, { status: 500 })
  }

  return NextResponse.json({ profile })
}
