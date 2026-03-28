import { NextRequest, NextResponse } from 'next/server'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

interface WaitlistEntry {
  firstName: string
  lastName: string
  email: string
  shopName: string
  address: string
  city: string
  state: string
  zipCode: string
  phoneNumber: string
}

export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const body: WaitlistEntry = await request.json()

    // Validate required fields
    if (!body.firstName || !body.email || !body.shopName) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(body.email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      )
    }

    // TODO: Save to database (Supabase)
    // For now, we'll just log it and return success
    console.log('Waitlist entry:', {
      ...body,
      timestamp: new Date().toISOString(),
    })

    // TODO: Send confirmation email to the user

    return NextResponse.json(
      { 
        message: 'Successfully joined the waitlist',
        data: body 
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
})
