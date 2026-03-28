import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

const EXCLUDED_SHOP_IDS = [
  '31832d5e-7e74-427d-b7b3-54441bca1636',
  '0da3f815-5c55-4db7-8e0b-e634775e571e',
  '47f25305-18e3-4c98-9aa5-56206e74e037'
]


interface ShopMetrics {
  id: string
  name: string
  address?: string
  city?: string
  state?: string
  phone_number?: string
  session_count: number
}

/**
 * GET /api/admin/shops-metrics
 * Fetches all shops with diagnostic session counts for a given time range
 * Query params:
 *   - daysBack: number of days to look back (default: 7)
 */
export const GET = withApiLogger(async (request: NextRequest) => {
  try {
    const supabase = await createClient()

    // ---------- Auth ----------
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ---------- Admin check ----------
    const { data: adminAccess, error: accessError } = await supabase
      .from('user_shop_access')
      .select('role, shop_id')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .limit(1)
      .maybeSingle()

    logger.setContext({ userId: user.id, ...(adminAccess?.shop_id ? { shopId: adminAccess.shop_id } : {}) })

    if (accessError || !adminAccess) {
      return NextResponse.json(
        { error: 'Forbidden - Admin access required' },
        { status: 403 }
      )
    }


    // ---------- Time range ----------
    const url = new URL(request.url)
    const daysBack = Number(url.searchParams.get('daysBack') ?? 7)

    // IMPORTANT: UTC-safe date math (no manual hour mutation)
    const endDate = new Date()
    const startDate = new Date(
      Date.now() - daysBack * 24 * 60 * 60 * 1000
    )

    // ---------- Fetch shops ----------
    const { data: shops, error: shopsError } = await supabase
      .from('shops')
      .select('id, name, address, city, state, phone_number')
      .not('id', 'in', `(${EXCLUDED_SHOP_IDS.join(',')})`)
      .order('name')

    if (shopsError) {
      logger.error({ event: 'supabase_error', table: 'shops', operation: 'select', code: shopsError.code, message: shopsError.message })
      return NextResponse.json(
        { error: 'Failed to fetch shops' },
        { status: 500 }
      )
    }


    if (!shops || shops.length === 0) {
      return NextResponse.json({
        shops: [],
        timeRange: {
          startDate,
          endDate,
          daysBack,
        },
        totalShops: 0,
        totalSessions: 0,
      })
    }

    // ---------- Fetch session counts (SINGLE QUERY) ----------
    
    // Convert to ISO string without timezone for comparison with 'timestamp without time zone' column
    const startDateStr = startDate.toISOString().split('Z')[0]
    const endDateStr = endDate.toISOString().split('Z')[0]
    
    // First, check if there are ANY sessions at all
    const { data: allSessions, error: allError } = await supabase
      .from('diagnostic_sessions')
      .select('id, shop_id, created_at')
      .limit(5)
    
    
    const { data: sessionCounts, error: countError } = await supabase
      .from('diagnostic_sessions')
      .select('shop_id, created_at')
      .gte('created_at', startDateStr)
      .lte('created_at', endDateStr)

    if (countError) {
      logger.error({ event: 'supabase_error', table: 'diagnostic_sessions', operation: 'select', code: countError.code, message: countError.message })
      return NextResponse.json(
        { error: 'Failed to count diagnostic sessions' },
        { status: 500 }
      )
    }

    // Use admin client to bypass RLS for cross-user queries
    const adminSupabase = createAdminClient()

    // Fetch all users grouped by shop so we can count their interactive sessions
    const shopIds = shops.map((s) => s.id)
    const { data: shopUsers, error: shopUsersError } = await adminSupabase
      .from('users')
      .select('id, shop_id')
      .in('shop_id', shopIds)

    if (shopUsersError) {
      logger.error({ event: 'supabase_error', table: 'users', operation: 'select', code: shopUsersError.code, message: shopUsersError.message })
      return NextResponse.json({ error: 'Failed to fetch shop users' }, { status: 500 })
    }

    // Build user_id → shop_id map
    const userShopMap: Record<string, string> = {}
    for (const u of shopUsers ?? []) {
      if (u.shop_id) userShopMap[u.id] = u.shop_id
    }

    const allUserIds = Object.keys(userShopMap)

    // Fetch interactive sessions for those users within the time range
    const interactiveSessionsByShop: Record<string, number> = {}
    if (allUserIds.length > 0) {
      const { data: interactiveSessions, error: interactiveError } = await adminSupabase
        .from('interactive_diagnostic_sessions')
        .select('user_id')
        .in('user_id', allUserIds)
        .gte('created_at', startDate.toISOString())
        .lte('created_at', endDate.toISOString())

      if (interactiveError) {
        logger.error({ event: 'supabase_error', table: 'interactive_diagnostic_sessions', operation: 'select', code: interactiveError.code, message: interactiveError.message })
        return NextResponse.json({ error: 'Failed to count interactive diagnostic sessions' }, { status: 500 })
      }

      for (const session of interactiveSessions ?? []) {
        const shopId = userShopMap[session.user_id]
        if (shopId) {
          interactiveSessionsByShop[shopId] = (interactiveSessionsByShop[shopId] ?? 0) + 1
        }
      }
    }

    // Group diagnostic_sessions by shop_id and count them
    const countsByShop: Record<string, number> = {}
    for (const session of sessionCounts ?? []) {
      if (session.shop_id) {
        countsByShop[session.shop_id] = (countsByShop[session.shop_id] ?? 0) + 1
      }
    }

    // Merge interactive session counts into countsByShop
    for (const [shopId, count] of Object.entries(interactiveSessionsByShop)) {
      countsByShop[shopId] = (countsByShop[shopId] ?? 0) + count
    }
    

    // ---------- Merge ----------
    const shopsWithMetrics: ShopMetrics[] = shops.map((shop) => ({
      id: shop.id,
      name: shop.name,
      address: shop.address,
      city: shop.city,
      state: shop.state,
      phone_number: shop.phone_number,
      session_count: countsByShop[shop.id] ?? 0,
    }))

    return NextResponse.json({
      shops: shopsWithMetrics,
      timeRange: {
        startDate,
        endDate,
        daysBack,
      },
      totalShops: shopsWithMetrics.length,
      totalSessions: shopsWithMetrics.reduce(
        (sum, shop) => sum + shop.session_count,
        0
      ),
    })
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
})
