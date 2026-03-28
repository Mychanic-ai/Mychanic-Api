import { createClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * POST /api/shops/create-additional
 * Create a new shop OR connect to existing shop via code
 * Called from onboarding wizard when adding additional shops
 * 
 * Body: { action: 'create' | 'connect', shopCode?: string, shopData?: object }
 */
export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    logger.setContext({ userId: user.id })

    const body = await request.json()
    const { action, shopCode, shopData } = body
    
    // Two modes: 'create' new shop OR 'connect' to existing via code
    if (action === 'connect') {
      return await handleConnectToShop(supabase, user.id, shopCode)
    } else if (action === 'create') {
      return await handleCreateNewShop(supabase, user.id, shopData)
    }
    
    return NextResponse.json(
      { error: 'Invalid action. Use "create" or "connect"' },
      { status: 400 }
    )
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
})

/**
 * Connect to existing shop via shop code
 */
async function handleConnectToShop(supabase: any, userId: string, shopCode: string) {
  if (!shopCode) {
    return NextResponse.json(
      { error: 'Shop code is required' },
      { status: 400 }
    )
  }
  
  // Find shop by code
  const { data: shop, error: shopError } = await supabase
    .from('shops')
    .select('*')
    .eq('shop_code', shopCode.toUpperCase().trim())
    .single()
  
  if (shopError || !shop) {
    return NextResponse.json(
      { error: 'Invalid shop code' },
      { status: 404 }
    )
  }
  
  // Check if user already has access
  const { data: existingAccess } = await supabase
    .from('user_shop_access')
    .select('id, is_active')
    .eq('user_id', userId)
    .eq('shop_id', shop.id)
    .single()
  
  if (existingAccess?.is_active) {
    return NextResponse.json(
      { error: 'You already have access to this shop' },
      { status: 400 }
    )
  }
  
  if (existingAccess && !existingAccess.is_active) {
    // Reactivate existing access
    const { error: updateError } = await supabase
      .from('user_shop_access')
      .update({ is_active: true })
      .eq('id', existingAccess.id)
    
    if (updateError) {
      return NextResponse.json(
        { error: 'Failed to reactivate shop access' },
        { status: 500 }
      )
    }
  } else {
    // Create new access record
    const { error: insertError } = await supabase
      .from('user_shop_access')
      .insert({
        user_id: userId,
        shop_id: shop.id,
        role: 'viewer',
        access_level: 'read_only',
        is_primary: false,
        is_active: true,
        granted_by: shop.owner_id
      })
    
    if (insertError) {
      logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'insert', code: insertError.code, message: insertError.message })
      return NextResponse.json(
        { 
          error: 'Failed to grant shop access',
          details: insertError.message,
          hint: insertError.hint
        },
        { status: 500 }
      )
    }
  }
  
  return NextResponse.json({ shop, message: 'Successfully connected to shop' })
}

/**
 * Create new shop and grant owner access
 */
async function handleCreateNewShop(supabase: any, userId: string, shopData: any) {
  if (!shopData?.name || !shopData?.shop_type) {
    return NextResponse.json(
      { error: 'Shop name and type are required' },
      { status: 400 }
    )
  }
  
  // Generate unique shop code
  const shopCode = await generateUniqueShopCode(supabase)
  
  // Create new shop
  const { data: newShop, error: createError } = await supabase
    .from('shops')
    .insert({
      name: shopData.name,
      shop_type: shopData.shop_type,
      owner_id: userId,
      shop_code: shopCode,
      is_active: true,
      // Required fields - use provided data or defaults
      address: shopData.address || 'TBD',
      city: shopData.city || 'TBD',
      state: shopData.state || 'TBD',
      zip_code: shopData.zip_code || '00000',
      country: shopData.country || 'United States'
    })
    .select()
    .single()
  
  if (createError) {
    logger.error({ event: 'supabase_error', table: 'shops', operation: 'insert', code: createError.code, message: createError.message })
    return NextResponse.json(
      { 
        error: 'Failed to create shop',
        details: createError.message
      },
      { status: 500 }
    )
  }
  
  // Create user_shop_access record with admin role
  const { error: accessError } = await supabase
    .from('user_shop_access')
    .insert({
      user_id: userId,
      shop_id: newShop.id,
      role: 'admin',
      access_level: 'full_access',
      is_primary: false, // New shops are not primary by default
      is_active: true,
      can_view_metrics: true,
      can_manage_settings: true,
      can_invite_users: true
    })
  
  if (accessError) {
    logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'insert', code: accessError.code, message: accessError.message })
    // Rollback: delete the shop
    await supabase.from('shops').delete().eq('id', newShop.id)
    return NextResponse.json(
      { error: 'Failed to create shop access' },
      { status: 500 }
    )
  }
  
  return NextResponse.json({ 
    shop: newShop, 
    message: 'Successfully created shop' 
  })
}

/**
 * Helper function to generate unique shop code
 */
async function generateUniqueShopCode(supabase: any): Promise<string> {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const length = 8
  
  for (let attempts = 0; attempts < 10; attempts++) {
    let code = ''
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    
    // Check if code exists
    const { data } = await supabase
      .from('shops')
      .select('id')
      .eq('shop_code', code)
      .single()
    
    if (!data) return code
  }
  
  throw new Error('Failed to generate unique shop code')
}

