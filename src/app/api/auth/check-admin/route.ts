import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * Check if the current user has admin role and get their user role
 * Returns: { isAdmin: boolean, userRole: 'admin' | 'manager' | 'technician' | 'apprentice', userId: string, userEmail: string }
 */
export const GET = withApiLogger(async () => {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({
        isAdmin: false,
        userRole: 'technician',
        debug: 'No authenticated user'
      }, { status: 401 })
    }

    logger.setContext({ userId: user.id })

    const adminClient = createAdminClient()

    // Get user's role from the users table
    const { data: userData, error: userError } = await adminClient
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (userError) {
      logger.error({ event: 'supabase_error', table: 'users', operation: 'select', code: userError.code, message: userError.message })
      return NextResponse.json({
        isAdmin: false,
        userRole: 'technician',
        debug: `Error querying user role: ${userError.message}`
      }, { status: 500 })
    }

    // Check if user has admin role in any shop
    const { data: adminAccess, error: accessError } = await adminClient
      .from('user_shop_access')
      .select('role, shop_id')
      .eq('user_id', user.id)
      .order('shop_id') // Ensure consistent ordering

    if (accessError) {
      logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'select', code: accessError.code, message: accessError.message })
      return NextResponse.json({
        isAdmin: false,
        userRole: userData?.role || 'technician',
        debug: `Error querying user access: ${accessError.message}`
      }, { status: 500 })
    }

    // Determine isAdmin: only if user has admin role in users table OR admin role in any shop
    const isAdmin = userData?.role === 'admin' || (adminAccess && adminAccess.some(access => access.role === 'admin'))
    
    // Determine user's actual role: prioritize shop access role, fallback to users table
    const userRole = (adminAccess?.[0]?.role) || userData?.role || 'technician'

    return NextResponse.json({ 
      isAdmin,
      userId: user.id,
      userEmail: user.email,
      userRole
    })
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({
      isAdmin: false,
      userRole: 'technician',
      debug: `Server error: ${error}`
    }, { status: 500 })
  }
})
