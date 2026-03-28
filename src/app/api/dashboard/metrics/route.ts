import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * GET /api/dashboard/metrics
 * Fetches metrics for the authenticated user's diagnostic sessions
 * Query params:
 *   - timeRange: 'last_7_days' | 'last_30_days' | 'year_to_date' (default: 'last_7_days')
 *   - filter: 'completed' | 'all' (default: 'all')
 */
export const GET = withApiLogger(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url)
    const timeRange = searchParams.get('timeRange') || 'last_7_days'
    const filter = searchParams.get('filter') || 'all'

    // Validate time range
    const validTimeRanges = ['last_7_days', 'last_30_days', 'year_to_date']
    if (!validTimeRanges.includes(timeRange)) {
      return NextResponse.json(
        { error: 'Invalid time range. Must be: last_7_days, last_30_days, or year_to_date' },
        { status: 400 }
      )
    }

    // Validate filter
    const validFilters = ['completed', 'all']
    if (!validFilters.includes(filter)) {
      return NextResponse.json(
        { error: 'Invalid filter. Must be: completed or all' },
        { status: 400 }
      )
    }

    const cookieStore = await cookies()
    
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          },
        },
      }
    )

    // Get the current user
    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError || !userData.user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    logger.setContext({ userId: userData.user.id })

    // Call the database function to get user metrics
    const { data, error } = await supabase.rpc('get_user_metrics', {
      p_user_id: userData.user.id,
      p_time_range: timeRange,
      p_filter: filter,
    })

    if (error) {
      logger.error({ event: 'supabase_error', operation: 'rpc', table: 'get_user_metrics', code: error.code, message: error.message })
      return NextResponse.json(
        { error: 'Failed to fetch metrics' },
        { status: 500 }
      )
    }

    return NextResponse.json(data)
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
})
