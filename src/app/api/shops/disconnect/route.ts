import { createClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * POST /api/shops/disconnect
 * Disconnects a user from a shop by removing their user_shop_access record
 * Industry standard: Soft delete via is_active flag, with option for hard delete
 */
export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { shopId } = body

    logger.setContext({ userId: user.id, shopId })
    
    if (!shopId) {
      return NextResponse.json(
        { error: 'Shop ID is required' },
        { status: 400 }
      )
    }
    
    // Get the shop access record
    const { data: accessRecord, error: fetchError } = await supabase
      .from('user_shop_access')
      .select('*, shops!inner(owner_id)')
      .eq('user_id', user.id)
      .eq('shop_id', shopId)
      .single()
    
    if (fetchError) {
      logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'select', code: fetchError.code, message: fetchError.message })
      return NextResponse.json(
        { error: 'Shop access not found', details: fetchError.message },
        { status: 404 }
      )
    }
    
    if (!accessRecord) {
      return NextResponse.json(
        { error: 'Shop access not found' },
        { status: 404 }
      )
    }
    
    // Check if user is the shop owner
    const isOwner = accessRecord.shops.owner_id === user.id
    
    // Industry standard approach: Soft delete for team members, hard delete option for owners
    // Soft delete: Set is_active = false (preserves history, can be restored)
    // Hard delete: Permanently remove record (only if user is owner or shop is being deleted)
    
    if (isOwner) {
      // Owner disconnecting from their own shop - this is unusual
      // We'll soft delete to preserve the relationship history
      // To fully delete the shop, they would need a separate "delete shop" action
      const { error: deleteError } = await supabase
        .from('user_shop_access')
        .update({
          is_active: false,
          is_primary: false, // Can't be primary if inactive
        })
        .eq('user_id', user.id)
        .eq('shop_id', shopId)
      
      if (deleteError) {
        logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'update', code: deleteError.code, message: deleteError.message })
        return NextResponse.json(
          { 
            error: 'Failed to disconnect from shop',
            details: deleteError.message,
            hint: deleteError.hint
          },
          { status: 500 }
        )
      }
      
      logger.info({ event: 'shop_access_revoked', revokedBy: user.id, affectedUser: user.id, shopId })

      return NextResponse.json({
        success: true,
        message: 'Disconnected from shop (soft delete - can be restored)'
      })
    } else {
      // Team member leaving a shop - hard delete is appropriate
      // This is the clean way to leave a shop you don't own
      const { error: deleteError } = await supabase
        .from('user_shop_access')
        .delete()
        .eq('user_id', user.id)
        .eq('shop_id', shopId)
      
      if (deleteError) {
        logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'delete', code: deleteError.code, message: deleteError.message })
        return NextResponse.json(
          { 
            error: 'Failed to remove shop access',
            details: deleteError.message,
            hint: deleteError.hint
          },
          { status: 500 }
        )
      }
      
      // If this was their primary shop, we need to set another shop as primary
      if (accessRecord.is_primary) {
        // Get remaining shops
        const { data: remainingShops } = await supabase
          .from('user_shop_access')
          .select('id')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .limit(1)
        
        // Set the first remaining shop as primary
        if (remainingShops && remainingShops.length > 0) {
          await supabase
            .from('user_shop_access')
            .update({ is_primary: true })
            .eq('id', remainingShops[0].id)
        }
      }
      
      logger.info({ event: 'shop_access_revoked', revokedBy: user.id, affectedUser: user.id, shopId })

      return NextResponse.json({
        success: true,
        message: 'Successfully removed from shop'
      })
    }
  } catch (error: any) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: error.message || 'An unexpected error occurred' },
      { status: 500 }
    )
  }
})

