import { createClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'


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


    // Group sessions by shop_id and count them
    const countsByShop: Record<string, number> = {}
    for (const session of sessionCounts ?? []) {
      if (session.shop_id) {
        countsByShop[session.shop_id] = (countsByShop[session.shop_id] ?? 0) + 1
      }
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
