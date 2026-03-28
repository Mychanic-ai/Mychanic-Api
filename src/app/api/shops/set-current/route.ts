import { createClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * POST /api/shops/set-current
 * Updates the user's currently selected shop in user_settings
 * Also updates last_accessed_at timestamp for the shop
 */
export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { shopId } = await request.json()

    logger.setContext({ userId: user.id, shopId })
    
    if (!shopId) {
      return NextResponse.json(
        { error: 'Shop ID is required' },
        { status: 400 }
      )
    }
    
    // Verify user has access to this shop
    const { data: access, error: accessError } = await supabase
      .from('user_shop_access')
      .select('shop_id')
      .eq('user_id', user.id)
      .eq('shop_id', shopId)
      .eq('is_active', true)
      .single()
    
    if (accessError || !access) {
      return NextResponse.json(
        { error: 'Access denied to this shop' },
        { status: 403 }
      )
    }
    
    // Update current_shop_id in user_settings
    const { error: updateError } = await supabase
      .from('user_settings')
      .update({ current_shop_id: shopId })
      .eq('user_id', user.id)
    
    if (updateError) {
      logger.error({ event: 'supabase_error', table: 'user_settings', operation: 'update', code: updateError.code, message: updateError.message })
      return NextResponse.json(
        { error: 'Failed to update shop selection' },
        { status: 500 }
      )
    }
    
    // Update last_accessed_at for this shop
    await supabase
      .from('user_shop_access')
      .update({ last_accessed_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('shop_id', shopId)
    
    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
})

