import { createClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    logger.setContext({ userId: user.id })

    const body = await request.json()
    const { shopCode } = body
    
    if (!shopCode) {
      return NextResponse.json(
        { error: 'Shop code is required' }, 
        { status: 400 }
      )
    }
    
    const codeUpper = shopCode.toUpperCase().trim()
    
    // Web interface ONLY accepts shop_code (not mobile_shop_code)
    const { data: shop, error: shopError } = await supabase
      .from('shops')
      .select('*')
      .eq('shop_code', codeUpper)
      .single()
    
    if (shopError || !shop) {
      return NextResponse.json(
        { error: 'Invalid shop code. Please check and try again.' }, 
        { status: 404 }
      )
    }
    
    // Web access always has 'web' access type
    const accessType = 'web'
    
    // Get current user record
    const { data: currentUser } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single()
    
    // Check if user already has access to this shop
    const { data: existingAccess } = await supabase
      .from('user_shop_access')
      .select('*')
      .eq('user_id', user.id)
      .eq('shop_id', shop.id)
      .single()
    
    if (existingAccess) {
      // Update existing access with new access_type if needed
      const { error: updateError } = await supabase
        .from('user_shop_access')
        .update({
          access_type: accessType,
          is_active: true,
          last_accessed_at: new Date().toISOString()
        })
        .eq('id', existingAccess.id)
      
      if (updateError) {
        logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'update', code: updateError.code, message: updateError.message })
      }
    } else {
      // Create new user_shop_access record with web permissions
      const { error: accessError } = await supabase
        .from('user_shop_access')
        .insert({
          user_id: user.id,
          shop_id: shop.id,
          role: currentUser?.role || 'viewer',
          access_level: 'read_write',
          access_type: accessType,
          can_view_metrics: true, // Web users can view metrics
          can_manage_settings: false,
          can_invite_users: false,
          is_active: true,
          is_primary: true,
          granted_at: new Date().toISOString()
        })
      
      if (accessError) {
        logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'insert', code: accessError.code, message: accessError.message })
        return NextResponse.json(
          { 
            error: 'Failed to create shop access',
            details: accessError.message,
            hint: accessError.hint
          }, 
          { status: 400 }
        )
      }
    }
    
    // Update user's shop_id and platform_access
    const { error: userError } = await supabase
      .from('users')
      .update({ 
        shop_id: shop.id,
        platform_access: accessType
      })
      .eq('id', user.id)
    
    if (userError) {
      logger.error({ event: 'supabase_error', table: 'users', operation: 'update', code: userError.code, message: userError.message })
      return NextResponse.json(
        { error: userError.message }, 
        { status: 400 }
      )
    }
    
    return NextResponse.json({ 
      shop,
      accessType,
      message: 'Connected to shop with full web access'
    })
  } catch (error: any) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: error.message || 'An unexpected error occurred' },
      { status: 500 }
    )
  }
})

