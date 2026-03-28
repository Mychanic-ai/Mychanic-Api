import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * GET /api/shops/accessible
 * Returns all shops the authenticated user has access to.
 * Admins receive every active shop in the system.
 */
export const GET = withApiLogger(async () => {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    logger.setContext({ userId: user.id })

    const adminClient = createAdminClient()

    // Check if user is an admin (via role or shop ownership)
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

    if (isAdmin) {
      // Admins see every active shop — return in the same shape as the RPC
      const { data: allShops, error: shopsError } = await adminClient
        .from('shops')
        .select('id, name, shop_type, shop_code, owner_id, is_active, city, state')
        .eq('status', 'active')
        .order('name', { ascending: true })

      if (shopsError) {
        logger.error({ event: 'supabase_error', table: 'shops', operation: 'select', code: shopsError.code, message: shopsError.message })
        return NextResponse.json({ error: 'Failed to fetch shops' }, { status: 500 })
      }

      const shops = (allShops || []).map((s) => ({
        shop_id: s.id,
        shop_name: s.name,
        shop_type: s.shop_type ?? 'auto_repair',
        shop_code: s.shop_code,
        role: 'admin',
        access_level: 'full_access',
        is_primary: false,
        is_owner: s.owner_id === user.id,
        is_active: s.is_active ?? true,
        last_accessed_at: null,
      }))

      return NextResponse.json({ shops })
    }

    // Non-admin: use the RPC which returns only shops they have access to
    const { data: shops, error } = await supabase
      .rpc('get_user_accessible_shops', { p_user_id: user.id })

    if (error) {
      logger.error({ event: 'supabase_error', operation: 'rpc', table: 'get_user_accessible_shops', code: error.code, message: error.message })
      return NextResponse.json(
        {
          error: 'Failed to fetch shops',
          details: error.message,
          hint: error.hint
        },
        { status: 500 }
      )
    }

    return NextResponse.json({ shops: shops || [] })
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    )
  }
})

