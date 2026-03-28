import { NextRequest, NextResponse } from 'next/server'

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:8080')
  .split(',')
  .map((o) => o.trim())

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin') ?? ''
  const isAllowed = ALLOWED_ORIGINS.includes(origin)

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(origin, isAllowed),
    })
  }

  const response = NextResponse.next()

  if (isAllowed) {
    const headers = corsHeaders(origin, true)
    Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value))
  }

  return response
}

function corsHeaders(origin: string, allowed: boolean): Record<string, string> {
  if (!allowed) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

export const config = {
  matcher: '/api/:path*',
}
