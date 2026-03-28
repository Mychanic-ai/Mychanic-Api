import { NextRequest, NextResponse } from 'next/server'
import { logger, runWithRequestContext, getRequestContext } from './logger'

type RouteHandler = (req: NextRequest) => Promise<Response>

/**
 * Higher-order function that wraps a Next.js App Router handler with
 * structured JSON request/response logging.
 *
 * Logged fields:
 *   event, method, path, status, durationMs
 *   + userId/shopId if logger.setContext() was called inside the handler
 *
 * Log level is derived from status: 5xx → error, 4xx → warn, 2xx/3xx → info
 */
export function withApiLogger(handler: RouteHandler): RouteHandler {
  return async (req: NextRequest): Promise<Response> => {
    const start = Date.now()
    const method = req.method
    const path = new URL(req.url).pathname

    let finalResponse!: Response

    await runWithRequestContext(async () => {
      let response: Response
      try {
        response = await handler(req)
      } catch (err) {
        logger.error({
          event: 'api_request',
          method,
          path,
          status: 500,
          durationMs: Date.now() - start,
          ...getRequestContext(),
          error: err instanceof Error ? err.message : String(err),
        })
        finalResponse = NextResponse.json({ error: 'Internal server error' }, { status: 500 })
        return
      }

      const status = response.status
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'

      let errorMessage: string | undefined
      if (status >= 400) {
        try {
          const body = await response.clone().json()
          errorMessage = body?.error ?? body?.message ?? JSON.stringify(body)
        } catch {
          errorMessage = await response.clone().text().catch(() => undefined)
        }
      }

      logger[level]({
        event: 'api_request',
        method,
        path,
        platform: 'web',
        status,
        durationMs: Date.now() - start,
        ...getRequestContext(),
        ...(errorMessage ? { errorMessage } : {}),
      })

      finalResponse = response
    })

    return finalResponse
  }
}
