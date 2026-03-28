import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import type { ShopType } from '@/types/shop'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

// Generate unique shop code
function generateShopCode(): string {
  // Use only non-confusing characters (no 0, O, 1, I)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = 'SHOP-'
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const adminClient = createAdminClient()

    // Support both cookie-based (web) and Bearer token (mobile) auth
    let user: any = null
    const authHeader = request.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const { data } = await adminClient.auth.getUser(token)
      user = data.user
    } else {
      const supabase = await createClient()
      const { data } = await supabase.auth.getUser()
      user = data.user
    }

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    logger.setContext({ userId: user.id })

    // Only admins can create shops (via role or shop ownership)
    const { data: adminAccess } = await adminClient
      .from('user_shop_access')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .limit(1)

    const { data: ownedShop } = await adminClient
      .from('shops')
      .select('id')
      .eq('owner_id', user.id)
      .limit(1)

    const isAdmin =
      (adminAccess && adminAccess.length > 0) ||
      (ownedShop && ownedShop.length > 0)

    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden: only admins can create shops' }, { status: 403 })
    }

    const body = await request.json()
    const { shopName, shopType, address, city, state, zip, phone } = body
    
    // Validate required fields
    if (!shopName || !shopType) {
      return NextResponse.json(
        { error: 'Shop name and type are required' }, 
        { status: 400 }
      )
    }
    
    // Generate unique shop code (retry if collision)
    let shopCode = generateShopCode()
    let attempts = 0
    
    while (attempts < 5) {
      const { data: existing } = await adminClient
        .from('shops')
        .select('id')
        .eq('shop_code', shopCode)
        .maybeSingle()
      
      if (!existing) break
      shopCode = generateShopCode()
      attempts++
    }
    
    if (attempts >= 5) {
      return NextResponse.json(
        { error: 'Failed to generate unique shop code. Please try again.' },
        { status: 500 }
      )
    }
    
    // Create shop in database — use adminClient to bypass RLS
    const { data: shop, error: shopError } = await adminClient
      .from('shops')
      .insert({
        name: shopName,
        shop_type: shopType || 'auto_repair',
        address: address || 'TBD',
        city: city || 'TBD',
        state: state || 'TBD',
        zip_code: zip || '00000',
        phone_number: phone,
        shop_code: shopCode,
        owner_id: user.id,
        country: 'United States'
      })
      .select()
      .single()
    
    if (shopError) {
      logger.error({ event: 'supabase_error', table: 'shops', operation: 'insert', code: shopError.code, message: shopError.message })
      return NextResponse.json(
        { error: shopError.message },
        { status: 400 }
      )
    }

    return NextResponse.json({ shop })
  } catch (error: any) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: error.message || 'An unexpected error occurred' },
      { status: 500 }
    )
  }
})

